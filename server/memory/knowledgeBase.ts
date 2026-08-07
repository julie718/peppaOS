/**
 * Knowledge Base — extracts reusable facts and patterns from conversations,
 * stores them in a dedicated SQLite table, and retrieves them for context injection.
 */
import { logger } from '../lib/logger';
import sqlite3 from 'sqlite3';
import { getPeppaDbPath } from '../config/data_path'; // E-3

// ── 类型 ──

export interface KnowledgeEntry {
  fact: string;
  type: string;
  confidence: number;
  created_at: string;
}

export interface ExtractedKnowledge {
  fact: string;
  type: string;
  confidence: number;
}

// ── DB 初始化 ──

const peppaDbPath = getPeppaDbPath(); // E-3

function ensureTable(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS knowledge_base (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'personal_fact',
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      (err) => {
        if (err) {
          logger.warn('[KnowledgeBase] 建表失败:', err.message);
        }
        // 创建索引
        db.run(
          `CREATE INDEX IF NOT EXISTS idx_kb_user_type ON knowledge_base(user_id, type)`,
          () => {},
        );
        resolve();
      },
    );
  });
}

// ── 知识提取规则 ──

interface ExtractionRule {
  regex: RegExp;
  type: string;
  confidence: number;
  extractFact: (m: RegExpMatchArray) => string;
}

const EXTRACTION_RULES: ExtractionRule[] = [
  // ── 个人事实 (personal_fact) ──
  { regex: /我是\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'personal_fact', confidence: 0.75, extractFact: m => `用户是${m[1].trim()}` },
  { regex: /我(?:的?职业|的?工作)?(?:是|做)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'personal_fact', confidence: 0.7, extractFact: m => `用户职业: ${m[1].trim()}` },
  { regex: /我在\s*(.+?)(?:工作|上班|任职)/g, type: 'personal_fact', confidence: 0.8, extractFact: m => `用户在${m[1].trim()}工作` },
  { regex: /我(?:住|家住)在\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'personal_fact', confidence: 0.7, extractFact: m => `用户住在${m[1].trim()}` },
  { regex: /我(?:今年|已经|刚)\s*(\d{1,3})\s*岁/g, type: 'personal_fact', confidence: 0.8, extractFact: m => `用户${m[1]}岁` },
  { regex: /我(?:是|来自)\s*(.+?人)/g, type: 'personal_fact', confidence: 0.7, extractFact: m => `用户是${m[1].trim()}` },

  // ── 偏好 (preference) ──
  { regex: /我(?:很|非常|特别|最|超级)?喜欢\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'preference', confidence: 0.7, extractFact: m => `用户喜欢${m[1].trim()}` },
  { regex: /我(?:很|非常|特别)?(?:讨厌|不喜欢|受不了)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'preference', confidence: 0.7, extractFact: m => `用户不喜欢${m[1].trim()}` },
  { regex: /我(?:最|特别)爱\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'preference', confidence: 0.65, extractFact: m => `用户热爱${m[1].trim()}` },
  { regex: /(?:对|对于)\s*(.+?)(?:感|有)兴趣/g, type: 'preference', confidence: 0.6, extractFact: m => `用户对${m[1].trim()}感兴趣` },

  // ── 关系 (relationship) ──
  { regex: /我(?:和|跟|与)\s*(.+?)(?:是|关系)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'relationship', confidence: 0.65, extractFact: m => `用户和${m[1].trim()}是${m[2].trim()}关系` },
  { regex: /(?:老婆|老公|女朋友|男朋友|对象|媳妇)(?:是|叫)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'relationship', confidence: 0.75, extractFact: m => `用户的伴侣是${m[1].trim()}` },
  { regex: /我家有(?:个|只|条)?\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'relationship', confidence: 0.6, extractFact: m => `用户家有${m[1].trim()}` },

  // ── 习惯 (habit) ──
  { regex: /(?:每天|经常|总是|习惯|通常|一般)(?:都会?|会|要|在)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'habit', confidence: 0.6, extractFact: m => `用户习惯${m[1].trim()}` },
  { regex: /(?:每次|每当)\s*(.+?)(?:的时候|时|就|都|会)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'habit', confidence: 0.65, extractFact: m => `每当${m[1].trim()}，用户就会${m[2].trim()}` },
  { regex: /我(?:的)?(?:日常|作息|routine)\s*(?:是|：|:)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'habit', confidence: 0.7, extractFact: m => `用户日常: ${m[1].trim()}` },

  // ── 洞察 (insight) ──
  { regex: /我(?:发现|意识到|明白了?|觉得|认为|感觉)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'insight', confidence: 0.5, extractFact: m => `用户意识到: ${m[1].trim()}` },
  { regex: /(?:原来|其实)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'insight', confidence: 0.45, extractFact: m => `用户领悟到: ${m[1].trim()}` },
  { regex: /我(?:越来越|慢慢|逐渐)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'insight', confidence: 0.5, extractFact: m => `用户趋势: ${m[1].trim()}` },

  // ── 声明性知识 (declarative) ──
  { regex: /(?:记住|别忘了?|记一下)\s*(.+?)(?:[，。,\.\s]|$)/g, type: 'declarative', confidence: 0.8, extractFact: m => m[1].trim() },
  { regex: /(?:这件事|这个)\s*(?:很|非常|特别)\s*(?:重要|关键)/g, type: 'declarative', confidence: 0.55, extractFact: m => m[0].trim() },
];

/**
 * Extract reusable facts and patterns from a user message + optional response.
 * Returns deduplicated knowledge entries with confidence scores.
 */
export function extractKnowledge(
  text: string,
  response?: string,
): ExtractedKnowledge[] {
  if (!text || text.length < 3) return [];

  const entries: ExtractedKnowledge[] = [];
  const seen = new Set<string>();
  const combinedText = text + (response ? ' ' + response : '');

  try {
    for (const rule of EXTRACTION_RULES) {
      rule.regex.lastIndex = 0;
      let match: RegExpMatchArray | null;
      while ((match = rule.regex.exec(text)) !== null) {
        const fact = rule.extractFact(match).trim();
        const dedupKey = `${rule.type}:${fact}`;
        if (fact.length >= 2 && fact.length <= 200 && !seen.has(dedupKey)) {
          seen.add(dedupKey);
          entries.push({ fact, type: rule.type, confidence: rule.confidence });
        }
      }
    }

    // Also scan response for reinforced facts ("雷哥喜欢XX", "用户是XX")
    if (response) {
      // Detect name + fact patterns in response
      const nameFactMatch = response.match(/(?:雷哥|用户|他|她)(?:是|喜欢|住在|在|有)(.+?)(?:[，。,\.\s]|$)/g);
      if (nameFactMatch) {
        for (const m of nameFactMatch) {
          const dedupKey = `personal_fact:${m.trim()}`;
          if (!seen.has(dedupKey)) {
            seen.add(dedupKey);
            entries.push({ fact: m.trim(), type: 'personal_fact', confidence: 0.4 });
          }
        }
      }
    }

    if (entries.length > 0) {
      logger.info(`[KnowledgeBase] 提取到 ${entries.length} 条知识`);
    }
  } catch (e: any) {
    logger.warn('[KnowledgeBase] 提取失败:', e.message);
  }

  return entries;
}

// ── 存储 ──

/**
 * Store extracted knowledge entries into the knowledge_base table.
 * Fails silently — never blocks the main flow.
 */
export async function storeKnowledge(
  userId: string,
  entries: ExtractedKnowledge[],
): Promise<void> {
  if (!entries || entries.length === 0) return;

  let db: sqlite3.Database | null = null;

  try {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        db?.close();
        resolve();
      }, 3000);

      try {
        db = new sqlite3.Database(peppaDbPath, async (err) => {
          if (err) {
            clearTimeout(timeout);
            logger.warn('[KnowledgeBase] DB 连接失败:', err.message);
            resolve();
            return;
          }

          await ensureTable(db!);

          let stored = 0;
          let completed = 0;
          const total = entries.length;

          for (const entry of entries) {
            db!.run(
              `INSERT INTO knowledge_base (user_id, fact, type, confidence)
               VALUES (?, ?, ?, ?)`,
              [userId, entry.fact, entry.type, entry.confidence],
              (err2) => {
                completed++;
                if (!err2) stored++;
                if (completed === total) {
                  clearTimeout(timeout);
                  db!.close();
                  if (stored > 0) {
                    logger.info(`[KnowledgeBase] 已存储 ${stored}/${total} 条知识`);
                  }
                  resolve();
                }
              },
            );
          }
        });
      } catch (e: any) {
        clearTimeout(timeout);
        logger.warn('[KnowledgeBase] 存储异常:', e.message);
        resolve();
      }
    });
  } catch {
    // 绝不抛异常
  }
}

// ── 检索 ──

/**
 * Retrieve knowledge entries for a user, optionally filtered by type.
 */
export async function getKnowledge(
  userId: string,
  options: {
    types?: string[];
    minConfidence?: number;
    limit?: number;
  } = {},
): Promise<KnowledgeEntry[]> {
  const { types = [], minConfidence = 0.3, limit = 20 } = options;
  let db: sqlite3.Database | null = null;

  try {
    const result = await new Promise<KnowledgeEntry[]>((resolve) => {
      const timeout = setTimeout(() => {
        db?.close();
        resolve([]);
      }, 3000);

      try {
        db = new sqlite3.Database(peppaDbPath, async (err) => {
          if (err) {
            clearTimeout(timeout);
            logger.warn('[KnowledgeBase] DB 连接失败:', err.message);
            resolve([]);
            return;
          }

          await ensureTable(db!);

          let sql: string;
          let params: any[];

          if (types.length > 0) {
            const placeholders = types.map(() => '?').join(', ');
            sql = `SELECT fact, type, confidence, created_at
                   FROM knowledge_base
                   WHERE user_id = ?
                     AND type IN (${placeholders})
                     AND confidence >= ?
                   ORDER BY confidence DESC, created_at DESC
                   LIMIT ?`;
            params = [userId, ...types, minConfidence, limit];
          } else {
            sql = `SELECT fact, type, confidence, created_at
                   FROM knowledge_base
                   WHERE user_id = ?
                     AND confidence >= ?
                   ORDER BY confidence DESC, created_at DESC
                   LIMIT ?`;
            params = [userId, minConfidence, limit];
          }

          db!.all(sql, params, (err2, rows: any[]) => {
            clearTimeout(timeout);
            db!.close();
            if (err2) {
              logger.warn('[KnowledgeBase] 查询失败:', err2.message);
              resolve([]);
              return;
            }
            const entries = (rows || []).map((r: any) => ({
              fact: r.fact || '',
              type: r.type || '',
              confidence: r.confidence || 0,
              created_at: r.created_at || '',
            }));
            if (entries.length > 0) {
              logger.info(`[KnowledgeBase] 检索到 ${entries.length} 条知识`);
            }
            resolve(entries);
          });
        });
      } catch (e: any) {
        clearTimeout(timeout);
        logger.warn('[KnowledgeBase] 检索异常:', e.message);
        resolve([]);
      }
    });
    return result;
  } catch {
    return [];
  }
}

/** Format knowledge entries for injection into system prompts */
export function formatKnowledgeForContext(entries: KnowledgeEntry[]): string {
  if (!entries || entries.length === 0) return '';

  const typeLabels: Record<string, string> = {
    personal_fact: '个人信息',
    preference: '偏好',
    relationship: '关系',
    habit: '习惯',
    insight: '洞察',
    declarative: '重要事项',
  };

  const lines = entries.map(e => {
    const label = typeLabels[e.type] || e.type;
    const confidence = e.confidence >= 0.7 ? '' : ` (置信度: ${(e.confidence * 100).toFixed(0)}%)`;
    return `- [${label}]${confidence} ${e.fact}`;
  });

  return '## 知识库（从对话中提炼的事实和规律）\n' + lines.join('\n');
}
