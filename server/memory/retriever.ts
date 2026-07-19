/**
 * Dual-path memory retrieval — keyword + semantic, fused by salience score.
 */
import { queryMemories, queryMemoriesVector } from './store';
import { Memory, MemoryQuery } from './types';
import { logger } from '../lib/logger';

export interface RankedMemory {
  memory: Memory;
  salience: number;
  keywordScore: number;
  vectorScore: number;
  timeDecay: number;
}

/**
 * Fuse keyword and semantic recall, return Top-N ranked by salience:
 *   salience = (keywordScore * 0.4) + (vectorScore * 0.4) + (timeDecay * 0.2)
 */
export async function dualRetrieve(query: string, userId: string, topN = 3): Promise<RankedMemory[]> {
  const start = Date.now();

  const [keywordResults, vectorResults] = await Promise.all([
    queryMemories({ userId, query, limit: 10, useVector: false }),
    queryMemoriesVector({ userId, query, limit: 10 }).catch(() => [] as Memory[]),
  ]);

  // Score memory by keyword rank (higher = better match)
  const keywordScores = new Map<string, number>();
  keywordResults.forEach((m, i) => keywordScores.set(m.id, 1 - i / keywordResults.length));

  // Score memory by semantic rank
  const vectorScores = new Map<string, number>();
  vectorResults.forEach((m, i) => vectorScores.set(m.id, 1 - i / vectorResults.length));

  // Merge and score
  const allMemories = new Map<string, Memory>();
  for (const m of [...keywordResults, ...vectorResults]) allMemories.set(m.id, m);

  const ranked: RankedMemory[] = [];
  for (const mem of allMemories.values()) {
    const kw = keywordScores.get(mem.id) || 0;
    const vs = vectorScores.get(mem.id) || 0;
    const daysAgo = (Date.now() - new Date(mem.createdAt).getTime()) / 86400000;
    const timeDecay = Math.max(0, 1 - daysAgo / 30);
    const salience = (kw * 0.4) + (vs * 0.4) + (timeDecay * 0.2);

    ranked.push({ memory: mem, salience, keywordScore: kw, vectorScore: vs, timeDecay });
  }

  ranked.sort((a, b) => b.salience - a.salience);

  const elapsed = Date.now() - start;
  if (elapsed > 500) {
    logger.warn(`[Retriever] dual retrieval took ${elapsed}ms`);
  }

  return ranked.slice(0, topN);
}

async function safeQuery(fn: () => Memory[]): Promise<Memory[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}
