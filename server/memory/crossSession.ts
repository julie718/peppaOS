/**
 * Cross-session memory — persistent key-value store for facts about the user
 * that must survive across conversations (name, preferences, important context).
 */
import { logger } from '../lib/logger';
import sqlite3 from 'sqlite3';
import { bumpPreferenceTag, demotePreferenceTag } from '../db/lifeDb';
import { getSharedPeppaDb } from '../db/dbBase'; // 进程级单例连接：业务路径禁止自行 open/close

export interface CrossSessionMemory {
  key: string;
  value: string;
  timestamp: string;
}

// ── DB path & table init ──

function ensureTable(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS cross_session_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, key)
      )`,
      (err) => {
        if (err) {
          logger.warn('[CrossSession] 建表失败:', err.message);
        }
        resolve();
      },
    );
  });
}

// ── 存储跨会话记忆 ──

/**
 * Store or update a cross-session key-value fact about a user.
 * Fails silently — never throws, never blocks the main flow.
 */
export async function storeMemory(
  key: string,
  value: string,
  userId: string,
): Promise<void> {
  // 【句柄复用】进程级单例连接：不再每次调用 open/close
  // （修复：原实现 per-call open + 回调内 close → 并发任务下句柄关闭竞态
  //  随机 SQLITE_MISUSE: Database handle is closed FATAL）
  const db = getSharedPeppaDb();

  try {
    await new Promise<void>((resolve) => {
      // 超时不关闭句柄：单例连接生命周期归进程，超时仅放弃本次写入
      const timeout = setTimeout(() => {
        resolve();
      }, 3000);

      ensureTable(db).then(() => {
        db.run(
          `INSERT INTO cross_session_memories (user_id, key, value, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, key) DO UPDATE SET
             value = excluded.value,
             updated_at = datetime('now')`,
          [userId, key, value],
          (err2) => {
            clearTimeout(timeout);
            if (err2) {
              logger.warn('[CrossSession] 存储失败:', err2.message);
            } else {
              logger.info(`[CrossSession] 已记住: ${key} = "${value.slice(0, 40)}"`);
            }
            resolve();
          },
        );
      }).catch((e: any) => {
        clearTimeout(timeout);
        logger.warn('[CrossSession] 存储异常:', e.message);
        resolve();
      });
    });
  } catch {
    // 绝不抛异常
  }
}

// ── 获取用户的所有跨会话记忆 ──

/**
 * Retrieve all cross-session memories for a user.
 * Returns empty array on error — never throws.
 */
export async function getMemories(
  userId: string,
): Promise<CrossSessionMemory[]> {
  // 【句柄复用】进程级单例连接：不再每次调用 open/close
  const db = getSharedPeppaDb();

  try {
    const result = await new Promise<CrossSessionMemory[]>((resolve) => {
      // 超时不关闭句柄：单例连接生命周期归进程，超时仅放弃本次查询
      const timeout = setTimeout(() => {
        resolve([]);
      }, 3000);

      ensureTable(db).then(() => {
        db.all(
          `SELECT key, value, updated_at as timestamp
           FROM cross_session_memories
           WHERE user_id = ?
           ORDER BY updated_at DESC
           LIMIT 50`,
          [userId],
          (err2, rows: any[]) => {
            clearTimeout(timeout);
            if (err2) {
              logger.warn('[CrossSession] 查询失败:', err2.message);
              resolve([]);
              return;
            }
            const memories = (rows || []).map((r: any) => ({
              key: r.key || '',
              value: r.value || '',
              timestamp: r.timestamp || '',
            }));
            if (memories.length > 0) {
              logger.info(`[CrossSession] 加载 ${memories.length} 条跨会话记忆`);
            }
            resolve(memories);
          },
        );
      }).catch((e: any) => {
        clearTimeout(timeout);
        logger.warn('[CrossSession] 查询异常:', e.message);
        resolve([]);
      });
    });
    return result;
  } catch {
    return [];
  }
}

// ── 从用户消息中提取需要跨会话记住的关键信息 ──

export interface ExtractedFact {
  key: string;
  value: string;
}

const FACT_PATTERNS: Array<{ regex: RegExp; key: string; extract: (m: RegExpMatchArray) => string }> = [
  // 我叫 XXX / 我是 XXX / 我的名字是 XXX
  { regex: /我(?:的?名字)?(?:叫|是)\s*([一-龥a-zA-Z0-9_]{1,20})/g, key: 'name', extract: m => m[1] },
  // 我喜欢 XX / 我很喜欢 XX
  { regex: /我(?:很|非常|特别|最)?喜欢\s*(.+?)(?:[，。,\.\s]|$)/g, key: 'preference', extract: m => m[1].slice(0, 60) },
  // 我讨厌 / 我不喜欢 XX
  { regex: /我(?:很|非常)?(?:讨厌|不喜欢)\s*(.+?)(?:[，。,\.\s]|$)/g, key: 'dislike', extract: m => m[1].slice(0, 60) },
  // 我在 XX 工作 / 我的工作是 XX / 我是 XX 工程师
  { regex: /我(?:的?工作)?(?:在|是)\s*(.+?(?:公司|医院|学校|大学|工厂|银行|工作室|事务所|律所))/g, key: 'workplace', extract: m => m[1].slice(0, 60) },
  // 我住在 XX / 我家在 XX
  { regex: /我(?:住|家住)在\s*(.+?)(?:[，。,\.\s]|$)/g, key: 'location', extract: m => m[1].slice(0, 60) },
  // 我是 XX 的粉丝 / 我喜欢 XX 音乐/电影/游戏
  { regex: /我喜欢(?:听|看|玩)\s*(.+?)(?:[，。,\.\s]|$)/g, key: 'hobby', extract: m => m[1].slice(0, 60) },
  // 我养了 XX / 我家有只 XX（宠物）
  { regex: /我(?:养了|家(?:里)?有(?:只|个|条)?)\s*(.+?(?:猫|狗|鱼|鸟|兔|仓鼠|宠物))/g, key: 'pet', extract: m => m[1].slice(0, 60) },
];

/**
 * Extract key facts from user's message that should be remembered across sessions.
 * Returns empty array if nothing found or on error.
 */
export function extractKeyFacts(text: string, response?: string): ExtractedFact[] {
  if (!text || text.length < 2) return [];

  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  try {
    for (const pattern of FACT_PATTERNS) {
      // Reset regex lastIndex (global flag causes stateful matching)
      pattern.regex.lastIndex = 0;
      let match: RegExpMatchArray | null;
      while ((match = pattern.regex.exec(text)) !== null) {
        const value = pattern.extract(match).trim();
        if (value.length >= 1 && !seen.has(`${pattern.key}:${value}`)) {
          seen.add(`${pattern.key}:${value}`);
          facts.push({ key: pattern.key, value });
        }
      }
    }

    // Also check the combined (text + response) for "我叫" patterns that only appear in the first message
    const combined = text + (response ? ' ' + response : '');
    const nameMatch = combined.match(/你(?:可以)?叫我\s*([一-龥a-zA-Z0-9_]{1,20})/);
    if (nameMatch && !seen.has(`name:${nameMatch[1]}`)) {
      facts.push({ key: 'name', value: nameMatch[1].trim() });
    }

    if (facts.length > 0) {
      logger.info(`[CrossSession] 提取到 ${facts.length} 个关键信息: ${facts.map(f => `${f.key}=${f.value}`).join(', ')}`);
    }
  } catch (e: any) {
    logger.warn('[CrossSession] 提取失败:', e.message);
  }

  return facts;
}

// ── P1-17: 偏好标签权重应用 — 可升可降（替代只增不减的单向累计）──

/**
 * 将提取的关键事实同步到独立偏好标签表（lifeDb.user_preference_tags）：
 * - preference / hobby → 权重上升（喜欢被再次确认 → 更强偏好）
 * - dislike → 权重下降（反感提及 → 偏好弱化，可下探至移除）
 * - 其余 key（name/workplace/location/pet）无权重语义，仍由 storeMemory 存原文
 */
export async function applyPreferenceFacts(userId: string, facts: ExtractedFact[]): Promise<void> {
  for (const fact of facts) {
    if (fact.key === 'preference' || fact.key === 'hobby') {
      await bumpPreferenceTag(userId, fact.value, 0.1);
    } else if (fact.key === 'dislike') {
      await demotePreferenceTag(userId, fact.value, 0.1);
    }
  }
}

/** 格式化偏好标签为 System Prompt 前置约束文本 */
export function formatPreferenceTagsForPrompt(tags: { tag: string; weight: number }[]): string {
  if (tags.length === 0) return '';
  const ranked = tags
    .map(t => `- ${t.tag}（偏好强度 ${t.weight.toFixed(2)}）`)
    .join('\n');
  return '## 用户偏好（长期记忆，回答的前置约束）\n以下是你长期观察到的用户偏好，任何回答都应优先尊重：\n' + ranked;
}

// ── P1-16: 话题戒备 — 低亲密回避敏感话题 ──

/** 敏感话题清单：关系尚浅时不得主动发起或追问 */
export const SENSITIVE_TOPICS: string[] = [
  '收入', '薪水', '工资',
  '疾病', '病情', '医疗',
  '婚姻状况', '前任', '感情经历',
  '宗教', '政治立场',
  '家庭矛盾', '家庭纠纷',
  '身材', '体重', '身体缺陷',
];

/**
 * 生成话题戒备约束（System Prompt 前置约束，按关系亲密感分级）：
 * - 亲密感 ≥ 0.6：信任已建立，不做话题限制
 * - 0.35 ≤ 亲密感 < 0.6：轻度戒备，不主动发起敏感话题
 * - 亲密感 < 0.35：严格戒备，禁止主动发起/追问敏感话题
 */
export function getSensitiveTopicGuard(intimacy: number): string {
  if (intimacy >= 0.6) return '';
  if (intimacy >= 0.35) {
    return '## 话题边界（轻度戒备）\n你与用户的关系尚浅，不要主动提起收入、疾病、感情经历等敏感话题；若用户主动提起，尊重回应但不深入追问。';
  }
  return '## 话题边界（严格戒备）\n你与用户的关系尚浅（陌生/初识），严禁主动发起或追问以下敏感话题：收入、疾病、婚姻、前任、宗教、政治立场、家庭矛盾、身材体重。仅当用户主动明确提出时方可回应，且须克制、不深入探究。';
}
