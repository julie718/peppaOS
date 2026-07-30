/**
 * Timeline memory retrieval — query interaction history by time range and event type.
 * Reads from peppa.db interactions table (SQLite).
 */
import { logger } from '../lib/logger';
import sqlite3 from 'sqlite3';

export interface TimelineEntry {
  timestamp: string;
  type: string;
  summary: string;
}

export interface TimelineOptions {
  /** Number of days to look back (default 7) */
  days?: number;
  /** Filter by event types (matches cognitiveIntent). Empty = all types. */
  eventTypes?: string[];
  /** Max entries to return (default 10) */
  limit?: number;
}

/**
 * Retrieve interaction history from the interactions table ordered by time,
 * filtered by time range and optional event types.
 *
 * - 3-second timeout → returns empty array
 * - interactions table missing → returns empty array
 * - eventTypes empty → returns all types
 */
export async function getTimeline(
  options: TimelineOptions = {},
): Promise<TimelineEntry[]> {
  const { days = 7, eventTypes = [], limit = 10 } = options;
  const start = Date.now();
  const peppaDbPath = process.env.DB_PATH || '/app/data/peppa.db';

  let db: sqlite3.Database | null = null;

  try {
    const result = await new Promise<TimelineEntry[]>((resolve) => {
      const timeout = setTimeout(() => {
        db?.close();
        resolve([]);
      }, 3000);

      try {
        db = new sqlite3.Database(peppaDbPath, (err) => {
          if (err) {
            clearTimeout(timeout);
            logger.warn('[Timeline] peppa.db 连接失败:', err.message);
            resolve([]);
            return;
          }

          const since = new Date(Date.now() - days * 86400000).toISOString();

          // Build query with optional event type filter
          let sql: string;
          let params: any[];

          if (eventTypes.length > 0) {
            const placeholders = eventTypes.map(() => '?').join(', ');
            sql = `SELECT id, message, response, timestamp, cognitiveIntent, role
                   FROM interactions
                   WHERE timestamp >= ?
                     AND cognitiveIntent IN (${placeholders})
                     AND role = 'user'
                   ORDER BY timestamp DESC
                   LIMIT ?`;
            params = [since, ...eventTypes, limit];
          } else {
            sql = `SELECT id, message, response, timestamp, cognitiveIntent, role
                   FROM interactions
                   WHERE timestamp >= ?
                     AND role = 'user'
                   ORDER BY timestamp DESC
                   LIMIT ?`;
            params = [since, limit];
          }

          db!.all(sql, params, (err2, rows: any[]) => {
            clearTimeout(timeout);
            db!.close();

            if (err2) {
              logger.warn('[Timeline] 查询失败:', err2.message);
              resolve([]);
              return;
            }

            if (!rows || rows.length === 0) {
              resolve([]);
              return;
            }

            const entries: TimelineEntry[] = rows.map((row: any) => ({
              timestamp: row.timestamp || '',
              type: classifyType(row.cognitiveIntent, row.message || ''),
              summary: buildSummary(row.message || '', row.response || ''),
            }));

            resolve(entries);
          });
        });
      } catch (e: any) {
        clearTimeout(timeout);
        logger.warn('[Timeline] 检索异常:', e.message);
        resolve([]);
      }
    });

    const elapsed = Date.now() - start;
    if (elapsed > 1000) {
      logger.warn(`[Timeline] retrieval took ${elapsed}ms`);
    }

    if (result.length > 0) {
      logger.info(`[Timeline] 最近${days}天时间线: ${result.length} 条 (${elapsed}ms)`);
    } else {
      logger.info(`[Timeline] 最近${days}天时间线: 无记录 (${elapsed}ms)`);
    }
    return result;
  } catch (e: any) {
    logger.warn('[Timeline] 检索失败:', e.message);
    return [];
  }
}

/** Classify an interaction into a human-readable event type */
function classifyType(cognitiveIntent: string, message: string): string {
  if (cognitiveIntent && cognitiveIntent.length > 0) {
    return cognitiveIntent;
  }

  // Fallback: derive type from message content
  const m = message.toLowerCase();
  if (/问|什么|怎么|为什么|如何|查|搜索|帮我看|告诉我/.test(m)) return 'question';
  if (/明天|提醒|日程|安排|计划|备忘|别忘了|记得/.test(m)) return 'reminder';
  if (/开心|难过|生气|沮丧|焦虑|害怕|高兴|伤心/.test(m)) return 'emotional';
  if (/设置|打开|关闭|启动|停止|运行|执行/.test(m)) return 'command';
  if (/谢谢|好|ok|嗯|知道了|明白|了解/.test(m)) return 'acknowledgment';
  return 'conversation';
}

/** Build a short summary from the user message and response */
function buildSummary(message: string, response: string): string {
  const msgPart = message.slice(0, 80).replace(/\n/g, ' ');
  const respPart = response ? ` → ${response.slice(0, 60).replace(/\n/g, ' ')}` : '';
  return `${msgPart}${msgPart.length >= 80 ? '...' : ''}${respPart}`;
}
