// server/memory/gc.ts
// T80 记忆降噪 — TICK 步骤 10
// 长期低频记忆降权重、重复记忆合并、过期 TTL 清理
// P0-5: 按真实业务用户 ID 逐用户执行；降权原地修改；合并后物理删除旧记忆；TTL 真删

import { logger } from '../lib/logger.js';
import { queryMemories, addMemory, removeMemory, setMemoryImportance } from './store.js';

// ── 配置 ──
const CONFIG = {
  LOW_FREQ_DAYS: 30,           // 30 天未检索视为低频
  LOW_FREQ_DECAY_FACTOR: 0.5,  // 低频记忆 importance 折半
  DUPLICATE_SIMILARITY: 0.9,   // 字符级 Jaccard 相似度阈值
  TTL_EXPIRY_DAYS: 7,          // TTL 过期天数
  BATCH_SIZE: 50,              // 每用户每次最多处理 50 条
};

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

/** 字符级 Jaccard 相似度（中文近似） */
function jaccardSimilarity(a: string, b: string): number {
  const aSet = new Set(String(a || '').slice(0, 100).split(''));
  const bSet = new Set(String(b || '').slice(0, 100).split(''));
  const intersection = [...aSet].filter(w => bSet.has(w)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union > 0 ? intersection / union : 0;
}

/** 对单个用户执行一轮记忆降噪 */
async function gcForUser(userId: string, result: { downweighted: number; merged: number; cleaned: number }): Promise<void> {
  // 1. 低频记忆降权（原地修改 importance，支持真实下降）
  const lowFreqMemories = queryMemories({
    userId,
    limit: CONFIG.BATCH_SIZE,
    noTouch: true, // P0-5: 巡检查询不刷新 lastRetrievedAt，保证低频判定真实
  }).filter(mem => {
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
  const allMemories = queryMemories({ userId, limit: CONFIG.BATCH_SIZE, noTouch: true });
  const processed = new Set<string>();

  for (let i = 0; i < allMemories.length; i++) {
    const a = allMemories[i];
    if (processed.has(a.id)) continue;

    for (let j = i + 1; j < allMemories.length; j++) {
      const b = allMemories[j];
      if (processed.has(b.id)) continue;
      if (a.tier !== b.tier) continue;

      const jaccard = jaccardSimilarity(a.content, b.content);
      if (jaccard > CONFIG.DUPLICATE_SIMILARITY * 0.8) {
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
  const ttlMemories = queryMemories({ userId, limit: CONFIG.BATCH_SIZE, noTouch: true }).filter(isTTLExpired);
  for (const mem of ttlMemories) {
    if (removeMemory(mem.id)) {
      result.cleaned++;
      logger.info(`[MemoryGC] ${userId} TTL 清理: "${String(mem.content).slice(0, 30)}…"`);
    }
  }

  if (result.cleaned > 0) {
    logger.info(`[MemoryGC] ${userId} TTL 清理: ${result.cleaned} 条过期`);
  }
}

// ── 主 GC 函数（P0-5: 按真实业务用户 ID 逐用户执行）──
export async function runMemoryGC(userIds: string[] = []): Promise<{ downweighted: number; merged: number; cleaned: number }> {
  const result = { downweighted: 0, merged: 0, cleaned: 0 };

  try {
    const targets = userIds.length > 0 ? userIds : ['anonymous'];

    for (const userId of targets) {
      try {
        await gcForUser(userId, result);
      } catch (e: any) {
        logger.warn(`[MemoryGC] ${userId} 执行异常:`, e?.message || e);
      }
    }

    // 汇总
    if (result.downweighted > 0 || result.merged > 0 || result.cleaned > 0) {
      logger.info(`[MemoryGC] 完成: 降权${result.downweighted} 合并${result.merged} 清理${result.cleaned}`);
    }

    return result;
  } catch (e: any) {
    logger.error('[MemoryGC] 异常:', e?.message || e);
    return result;
  }
}
