/**
 * Dual-path memory retrieval — keyword + semantic, fused by salience score.
 * Also: interaction history retrieval from peppa.db for context-aware conversations.
 */
import { queryMemories, queryMemoriesVector } from './store';
import { Memory } from './types';
import { logger } from '../lib/logger';
import sqlite3 from 'sqlite3';
import { getSharedPeppaDb } from '../db/dbBase'; // 进程级单例连接：业务路径禁止自行 open/close

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

  logger.info(`[Retriever] "${query.slice(0, 40)}" → ${ranked.slice(0, topN).length} results in ${elapsed}ms`);
  return ranked.slice(0, topN);
}

// ── 交互历史检索（从 peppa.db interactions 表）──

export interface InteractionMemory {
  id: string;
  message: string;
  response: string;
  timestamp: string;
  similarity: number;
}

/**
 * 基于关键词匹配从 interactions 表检索最相关的历史记录
 * - 超时 3 秒，超时返回空数组
 * - 关键词匹配失败时回退到最近 5 条记录
 * - interactions 表不存在或为空时返回空数组
 */
export async function retrieveRelevantMemories(
  text: string,
  limit: number = 5,
): Promise<InteractionMemory[]> {
  const start = Date.now();
  // 【句柄复用】进程级单例连接：复用 peppa.db 句柄，不再每次调用 open/close
  // （修复：原实现 per-call open + 超时/回调内 close → 并发任务下句柄关闭竞态
  //  随机 SQLITE_MISUSE: Database handle is closed FATAL）
  const db = getSharedPeppaDb();

  try {
    // 带超时的 Promise 包装（超时不关闭句柄：单例连接生命周期归进程，超时仅放弃本次结果）
    const result = await new Promise<InteractionMemory[]>((resolve) => {
      // P1-3 修复静默短路：原实现 3s 定时器直接 resolve([])，SQLite 繁忙时查询稍慢
      // → 3s 时已 resolve 空数组 → 稍后到达的真实结果被 Promise 丢弃 → 记忆上下文
      // 永久缺失且无任何日志（每次对话静默空上下文）。
      // 现在：3s 仅记录软警告并继续等待真实结果（由查询回调 resolve）；
      // 10s 硬上限兜底（驱动真正卡死才放弃，且保留警告日志）。
      let settled = false;
      const finish = (value: InteractionMemory[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimeout);
        clearTimeout(hardTimeout);
        resolve(value);
      };
      const softTimeout = setTimeout(() => {
        if (settled) return;
        logger.warn('[Retriever] interactions 查询超过 3s（SQLite 繁忙？），继续等待真实结果（硬上限 10s）');
      }, 3000);
      const hardTimeout = setTimeout(() => {
        if (settled) return;
        logger.warn('[Retriever] interactions 查询超过 10s 硬上限，放弃本轮检索（驱动异常，不影响对话）');
        finish([]);
      }, 10000);

      // E-3: 全新库静默降级 — interactions 表尚未创建时（首次启动未初始化）
      // 直接返回空数组，不产生 "no such table" WARN 噪音（修复前每轮对话刷 WARN）
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='interactions'",
        (tableErr, tableRow) => {
          if (tableErr || !tableRow) {
            finish([]);
            return;
          }

          // 提取关键词
          const keywords = extractKeywords(text);
          if (keywords.length === 0) {
            // 回退：返回最近 N 条记录
            fallbackRecent(db, limit, finish);
            return;
          }

          // 构建关键词 LIKE 查询
          const likeClauses = keywords.map(() => "message LIKE ?").join(' OR ');
          const likeParams = keywords.map(k => `%${k}%`);
          const sql = `SELECT id, message, response, timestamp FROM interactions WHERE ${likeClauses} AND role = 'user' ORDER BY timestamp DESC LIMIT ?`;
          const params = [...likeParams, Math.max(limit * 3, 20)];

          db.all(sql, params, (err2, rows: any[]) => {
            if (err2) {
              logger.warn('[Retriever] interactions 查询失败:', err2.message);
              finish([]);
              return;
            }

            if (!rows || rows.length === 0) {
              // 回退：返回最近 N 条记录
              fallbackRecent(db, limit, finish);
              return;
            }

            // 计算相似度并排序
            const scored = rows.map((row: any) => ({
              id: row.id,
              message: row.message || '',
              response: row.response || '',
              timestamp: row.timestamp || '',
              similarity: keywordSimilarity(text, row.message || ''),
            }));

            scored.sort((a, b) => b.similarity - a.similarity);
            finish(scored.slice(0, limit));
          });
        },
      );
    });

    const elapsed = Date.now() - start;
    if (elapsed > 1000) {
      logger.warn(`[Retriever] interactions retrieval took ${elapsed}ms`);
    }

    if (result.length > 0) {
      logger.info(`[Retriever] 交互历史检索: "${text.slice(0, 30)}" → ${result.length} 条 (${elapsed}ms)`);
    }
    return result;
  } catch (e: any) {
    logger.warn('[Retriever] 交互历史检索失败:', e.message);
    return [];
  }
}

/** 从中文/英文文本中提取关键词 */
function extractKeywords(text: string): string[] {
  const cleaned = text.replace(/[^\w一-鿿]/g, ' ').trim();
  if (!cleaned) return [];

  // 分词：中文按字分隔但保留2-4字词组，英文按空格分词
  const words: string[] = [];

  // 提取中文词组（2-4 字）
  const chineseChars = cleaned.match(/[一-鿿]+/g);
  if (chineseChars) {
    for (const segment of chineseChars) {
      if (segment.length <= 4) {
        words.push(segment);
      } else {
        // 滑动窗口提取 2-4 字词组
        for (let len = 4; len >= 2; len--) {
          for (let i = 0; i <= segment.length - len; i++) {
            words.push(segment.slice(i, i + len));
          }
        }
      }
    }
  }

  // 提取英文单词（>2 个字符）
  const englishWords = cleaned.match(/[a-zA-Z]{3,}/g);
  if (englishWords) {
    words.push(...englishWords.map(w => w.toLowerCase()));
  }

  // 去重 + 过滤停用词
  const stopWords = new Set(['这个', '那个', '什么', '怎么', '为什么', '能不能', '可以', '需要', '现在', '应该', 'the', 'and', 'for', 'that', 'this', 'what', 'how', 'can', 'you', 'are', 'was']);
  return [...new Set(words)]
    .filter(w => w.length >= 2 && !stopWords.has(w))
    .slice(0, 10); // 最多 10 个关键词
}

/** 计算关键词匹配相似度 */
function keywordSimilarity(query: string, target: string): number {
  const qLower = query.toLowerCase();
  const tLower = target.toLowerCase();

  // 精确子串匹配得分最高
  if (tLower.includes(qLower)) return 1.0;

  // 关键词匹配
  const qWords = extractKeywords(query);
  if (qWords.length === 0) return 0;

  let matchCount = 0;
  for (const word of qWords) {
    if (tLower.includes(word.toLowerCase())) {
      matchCount++;
    }
  }

  return matchCount / qWords.length;
}

/** 回退：返回最近 N 条用户消息（共享连接，不关闭句柄） */
function fallbackRecent(
  db: sqlite3.Database,
  limit: number,
  resolve: (value: InteractionMemory[]) => void,
): void {
  db.all(
    "SELECT id, message, response, timestamp FROM interactions WHERE role = 'user' ORDER BY timestamp DESC LIMIT ?",
    [limit],
    (err, rows: any[]) => {
      if (err || !rows) {
        logger.warn('[Retriever] 回退查询失败:', err?.message);
        resolve([]);
        return;
      }
      const result = rows.map((r: any) => ({
        id: r.id,
        message: r.message || '',
        response: r.response || '',
        timestamp: r.timestamp || '',
        similarity: 0,
      }));
      logger.info(`[Retriever] 关键词匹配失败，回退最近 ${result.length} 条记录`);
      resolve(result);
    },
  );
}
