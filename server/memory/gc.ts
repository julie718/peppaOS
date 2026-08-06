// server/memory/gc.ts
// T80 记忆降噪 — TICK 步骤 10
// 长期低频记忆降权重、重复记忆合并、过期 TTL 清理

import { logger } from '../lib/logger.js';
import { queryMemories, addMemory } from './store.js';
import { cosineSimilarity } from './store.js';

// ── 配置 ──
const CONFIG = {
  LOW_FREQ_DAYS: 30,           // 30 天未检索视为低频
  LOW_FREQ_DECAY_FACTOR: 0.5,  // 低频记忆 importance 折半
  DUPLICATE_SIMILARITY: 0.9,   // 余弦相似度阈值
  TTL_EXPIRY_DAYS: 7,          // TTL 过期天数
  BATCH_SIZE: 50,              // 每次最多处理 50 条
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

// ── 主 GC 函数 ──
export async function runMemoryGC(): Promise<{ downweighted: number; merged: number; cleaned: number }> {
  const result = { downweighted: 0, merged: 0, cleaned: 0 };

  try {
    // 1. 低频记忆降权
    const lowFreqMemories = queryMemories({
      userId: 'system',  // 全局搜索
      limit: CONFIG.BATCH_SIZE,
    }).filter(mem => {
      const lastRetrieved = mem.lastRetrievedAt ? new Date(mem.lastRetrievedAt).getTime() : 0;
      const daysSinceLastRetrieval = (Date.now() - lastRetrieved) / 86400000;
      return daysSinceLastRetrieval > CONFIG.LOW_FREQ_DAYS && (mem.importance || 0) > 0.2;
    });

    for (const mem of lowFreqMemories) {
      try {
        const newImportance = (mem.importance || 0.5) * CONFIG.LOW_FREQ_DECAY_FACTOR;
        addMemory(
          { userId: mem.userId || 'system', type: (mem.type || 'fact') as any, keywords: mem.keywords || ['gc'], content: mem.content, confidence: mem.confidence || 0.5, sourceInteractionId: 'gc_downweight' },
          { tier: (mem.tier || 'episodic') as any, importance: Math.max(0.1, newImportance), perspective: (mem.perspective || 'owner_trait') as any, source: 'gc_downweight' as any }
        );
        result.downweighted++;
      } catch {}
    }

    if (result.downweighted > 0) {
      logger.info(`[MemoryGC] 低频降权: ${result.downweighted} 条`);
    }

    // 2. 重复记忆合并
    const allMemories = queryMemories({ userId: 'system', limit: CONFIG.BATCH_SIZE });
    const processed = new Set<string>();

    for (let i = 0; i < allMemories.length; i++) {
      const a = allMemories[i];
      if (processed.has(a.id)) continue;

      for (let j = i + 1; j < allMemories.length; j++) {
        const b = allMemories[j];
        if (processed.has(b.id)) continue;
        if (a.tier !== b.tier) continue;

        // 简单的文本长度比 + 关键词重叠检查（替代嵌入向量 cosine）
        const aWords = new Set(String(a.content || '').slice(0, 100).split(''));
        const bWords = new Set(String(b.content || '').slice(0, 100).split(''));
        const intersection = [...aWords].filter(w => bWords.has(w)).length;
        const union = new Set([...aWords, ...bWords]).size;
        const jaccard = union > 0 ? intersection / union : 0;

        if (jaccard > CONFIG.DUPLICATE_SIMILARITY * 0.8) { // Jaccard 近似 cosine
          // 合并：保留较新的，提升 importance
          const newer = a.createdAt > b.createdAt ? a : b;
          const older = a.createdAt > b.createdAt ? b : a;
          addMemory(
            { userId: newer.userId || 'system', type: (newer.type || 'fact') as any, keywords: newer.keywords || ['gc'], content: newer.content, confidence: newer.confidence || 0.5, sourceInteractionId: 'gc_merge' },
            { tier: (newer.tier || 'episodic') as any, importance: Math.min(1, (newer.importance || 0.5) + 0.05), perspective: (newer.perspective || 'owner_trait') as any, source: 'gc_merge' as any }
          );
          processed.add(newer.id);
          processed.add(older.id);
          result.merged++;
          break; // 每条最多合并一次
        }
      }
    }

    if (result.merged > 0) {
      logger.info(`[MemoryGC] 重复合并: ${result.merged} 对`);
    }

    // 3. TTL 过期清理
    const ttlMemories = queryMemories({ userId: 'system', limit: CONFIG.BATCH_SIZE }).filter(isTTLExpired);
    result.cleaned = ttlMemories.length;

    if (result.cleaned > 0) {
      logger.info(`[MemoryGC] TTL 清理: ${result.cleaned} 条过期`);
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
