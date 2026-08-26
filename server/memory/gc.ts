// server/memory/gc.ts
// T80 记忆降噪 — TICK 步骤 10
// 长期低频记忆降权重、重复记忆合并、过期 TTL 清理、低分记忆冬眠
// P0-5: 按真实业务用户 ID 逐用户执行；降权原地修改；合并后物理删除旧记忆；TTL 真删；
// Bug 修复：冬眠仅标记（hibernated=1，记录永不删除 — 铁则1）

import { logger } from '../lib/logger';
import { queryMemories, removeMemory, setMemoryImportance, hibernateMemory, getMemoryScore, MEMORY_HIBERNATE_THRESHOLD } from './store';

// ── 配置 ──
const CONFIG = {
  LOW_FREQ_DAYS: 30,           // 30 天未检索视为低频
  LOW_FREQ_DECAY_FACTOR: 0.5,  // 低频记忆 importance 折半
  DUPLICATE_SIMILARITY: 0.9,   // 词级/Bigram Jaccard 相似度阈值（O-4: 实际生效 0.9×0.8=0.72，见下方合并逻辑）
  TTL_EXPIRY_DAYS: 7,          // TTL 过期天数
};

// L-5: 取消每用户 50 条上限 — 全量扫描全部记忆（内存 JSON 存储，一次性取出后分步处理）
const ALL_MEMORIES_LIMIT = 100000;

// L-5: 核心/成长层豁免 — 身份与成长记忆不参与低频降权、重复合并与 TTL 清理
const CORE_TIERS = ['core_identity', 'growth'];

/** L-5: 获取某用户全部记忆（含核心层，由调用方按需豁免） */
function queryAllForUser(userId: string): any[] {
  return queryMemories({ userId, limit: ALL_MEMORIES_LIMIT, noTouch: true });
}

// ── TTL 到期检查辅助 ──
function isTTLExpired(memory: any): boolean {
  if (!memory.content) return false;
  // 检测 TTL 标记格式: [TTL:7d]
  const ttlMatch = String(memory.content).match(/\[TTL:(\d+)d\]/);
  if (!ttlMatch) return false;

  const ttlDays = parseInt(ttlMatch[1], 10);
  const createdAt = memory.createdAt ? new Date(memory.createdAt).getTime() : 0;
  if (createdAt === 0) return false;

  const expiryMs = createdAt + ttlDays * 86400000;
  return Date.now() > expiryMs;
}

/** 归一化内容用于精确重复判定（去 TTL 标记 / 空白 / 大小写；空串永不判重） */
function normalizeContent(text: string): string {
  return String(text || '')
    .replace(/\[TTL:\d+d\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 词级/Bigram Jaccard 相似度（P2-12: 由字符级升级）
 * 中文无空格分词，以相邻字符对（bigram）为最小语义特征单元；
 * 英文连续字母数字串按单词计。较字符级更抗单字噪声（如"我喜欢猫" vs "我讨厌猫"）。
 */
function tokenizeForSimilarity(text: string): Set<string> {
  const s = String(text || '')
    .replace(/\[TTL:\d+d\]/g, '')          // 去除 TTL 标记干扰
    .replace(/[^\p{L}\p{N}]/gu, '')        // 去标点/空白
    .toLowerCase()
    .slice(0, 200);
  if (!s) return new Set();

  const tokens = new Set<string>();
  const enWords = s.match(/[a-z0-9]{2,}/g) || [];
  for (const w of enWords) tokens.add(`w:${w}`);

  const cjkOnly = s.replace(/[a-z0-9]/g, '');
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    const gram = cjkOnly.slice(i, i + 2);
    if (/[一-鿿]{2}/.test(gram)) tokens.add(`b:${gram}`);
  }
  return tokens;
}

function jaccardSimilarity(a: string, b: string): number {
  const aSet = tokenizeForSimilarity(a);
  const bSet = tokenizeForSimilarity(b);
  if (aSet.size === 0 && bSet.size === 0) return 0;
  const intersection = [...aSet].filter(w => bSet.has(w)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union > 0 ? intersection / union : 0;
}

/** 对单个用户执行一轮记忆降噪 */
async function gcForUser(userId: string, result: { downweighted: number; merged: number; cleaned: number; hibernated: number }): Promise<void> {
  // 1. 低频记忆降权（原地修改 importance，支持真实下降）
  // L-5: 全量扫描（取消 50 条上限）+ core_identity/growth 核心层豁免
  const lowFreqMemories = queryAllForUser(userId).filter(mem => {
    if (CORE_TIERS.includes(mem.tier)) return false; // 核心层不降权
    const lastRetrieved = mem.lastRetrievedAt ? new Date(mem.lastRetrievedAt).getTime() : 0;
    const daysSinceLastRetrieval = (Date.now() - lastRetrieved) / 86400000;
    return daysSinceLastRetrieval > CONFIG.LOW_FREQ_DAYS && (mem.importance || 0) > 0.2;
  });

  for (const mem of lowFreqMemories) {
    try {
      const newImportance = Math.max(0.1, (mem.importance || 0.5) * CONFIG.LOW_FREQ_DECAY_FACTOR);
      if (setMemoryImportance(mem.id, newImportance)) {
        result.downweighted++;
      }
    } catch {}
  }

  if (result.downweighted > 0) {
    logger.info(`[MemoryGC] ${userId} 低频降权: ${result.downweighted} 条`);
  }

  // 2. 重复记忆合并（保留较新一条并小幅提升权重，物理删除旧副本）
  const allMemories = queryAllForUser(userId);
  const processed = new Set<string>();

  for (let i = 0; i < allMemories.length; i++) {
    const a = allMemories[i];
    if (processed.has(a.id)) continue;
    if (CORE_TIERS.includes(a.tier)) continue; // L-5: 核心层不参与合并

    for (let j = i + 1; j < allMemories.length; j++) {
      const b = allMemories[j];
      if (processed.has(b.id)) continue;
      if (a.tier !== b.tier) continue;
      if (CORE_TIERS.includes(b.tier)) continue; // L-5: 核心层不参与合并

      const jaccard = jaccardSimilarity(a.content, b.content);
      // Bug 修复：精确重复快速通道 —— 归一化内容完全一致即确定重复，不再受 0.72 近似阈值
      // 限制（bigram Jaccard 下同义改写很难过阈值，全量重复却因「非 1.0 即不合并」漏掉）。
      // 原语义化近似阈值策略（>0.72）完整保留，两者并行。
      const isExactDuplicate = a.content !== '' && b.content !== '' && normalizeContent(a.content) === normalizeContent(b.content);
      if (isExactDuplicate || jaccard > CONFIG.DUPLICATE_SIMILARITY * 0.8) {
        // 保留较新的，删除较旧的（物理删除，不再产生第三份）
        const newer = a.createdAt > b.createdAt ? a : b;
        const older = a.createdAt > b.createdAt ? b : a;
        const mergedImportance = Math.min(1, (newer.importance || 0.5) + 0.05);
        setMemoryImportance(newer.id, mergedImportance);
        if (removeMemory(older.id)) {
          result.merged++;
          processed.add(older.id);
          logger.info(`[MemoryGC] ${userId} 重复合并: 保留 "${String(newer.content).slice(0, 30)}…" 删除旧副本`);
        }
        processed.add(newer.id);
        break; // 每条最多合并一次
      }
    }
  }

  if (result.merged > 0) {
    logger.info(`[MemoryGC] ${userId} 重复合并: ${result.merged} 对`);
  }

  // 3. TTL 过期清理（物理删除，不再仅计数）
  // L-5: 全量扫描 + 核心层豁免（L-6: 生产链路已写入 [TTL:n天] 标记，此处开始真实触发）
  const ttlMemories = queryAllForUser(userId).filter(m => !CORE_TIERS.includes(m.tier) && isTTLExpired(m));
  for (const mem of ttlMemories) {
    if (removeMemory(mem.id)) {
      result.cleaned++;
      logger.info(`[MemoryGC] ${userId} TTL 清理: "${String(mem.content).slice(0, 30)}…"`);
    }
  }

  // Bug 修复：无效记忆清理 —— 内容为空/纯空白的记忆属于写入异常产物（正常写入必有内容），
  // 明确排除（TTL 分支此前仅匹配 [TTL:n天] 标记、对无标记垃圾无处理，清理链路近乎不触发）
  const invalidMemories = queryAllForUser(userId).filter(m =>
    !CORE_TIERS.includes(m.tier) && !String(m.content || '').trim()
  );
  for (const mem of invalidMemories) {
    if (removeMemory(mem.id)) {
      result.cleaned++;
      logger.info(`[MemoryGC] ${userId} 无效记忆清理: "${mem.id}"（内容为空/纯空白）`);
    }
  }

  if (result.cleaned > 0) {
    logger.info(`[MemoryGC] ${userId} 清理: ${result.cleaned} 条（TTL 过期 + 无效内容）`);
  }

  // 4. 低分记忆冬眠（Phase2 铁则1：记录永不删除 — 仅标记 hibernated=1，日常检索排除）
  // Bug 修复：此前没有任何分支触发冬眠（唯一来源是 score 慢速衰减触达 0.2，长时间归零），
  // 新增 GC 冬眠分支。严格沿用原有阈值策略（MEMORY_HIBERNATE_THRESHOLD=0.2 不变）：
  // score ≤ 0.2 且足够陈旧（≥ LOW_FREQ_DAYS 天）的非核心层记忆标记休眠，不做任何删除。
  const hibernatable = queryAllForUser(userId).filter(m =>
    !CORE_TIERS.includes(m.tier) &&
    getMemoryScore(m) <= MEMORY_HIBERNATE_THRESHOLD &&
    (m.createdAt ? (Date.now() - new Date(m.createdAt).getTime()) / 86400000 : 0) >= CONFIG.LOW_FREQ_DAYS
  );
  for (const mem of hibernatable) {
    try {
      if (hibernateMemory(mem.id, userId)) {
        result.hibernated++;
        logger.info(`[MemoryGC] ${userId} 记忆冬眠（记录保留不删除）: "${String(mem.content).slice(0, 30)}…"`);
      }
    } catch {}
  }

  if (result.hibernated > 0) {
    logger.info(`[MemoryGC] ${userId} 冬眠: ${result.hibernated} 条（score ≤ ${MEMORY_HIBERNATE_THRESHOLD} 且 ≥${CONFIG.LOW_FREQ_DAYS} 天）`);
  }
}

// ── 主 GC 函数（P0-5: 按真实业务用户 ID 逐用户执行）──
export async function runMemoryGC(userIds: string[] = []): Promise<{ downweighted: number; merged: number; cleaned: number; hibernated: number }> {
  const result = { downweighted: 0, merged: 0, cleaned: 0, hibernated: 0 };

  try {
    const targets = userIds.length > 0 ? userIds : ['anonymous'];

    for (const userId of targets) {
      try {
        await gcForUser(userId, result);
      } catch (e: any) {
        logger.warn(`[MemoryGC] ${userId} 执行异常:`, e?.message || e);
      }
    }

    // 汇总（Bug 修复：无条件打印 + 补冬眠计数 —— 此前全 0 时静默，无法观测链路是否跑通）
    logger.info(`[MemoryGC] 完成: 降权${result.downweighted} 合并${result.merged} 清理${result.cleaned} 冬眠${result.hibernated}`);

    return result;
  } catch (e: any) {
    logger.error('[MemoryGC] 异常:', e?.message || e);
    return result;
  }
}
