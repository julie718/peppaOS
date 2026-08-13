// 数字生命体 — 状态持久化基础设施
// SQLite 数据库：人格、情绪、欲望、反思、交互记忆、关系度量、系统事件
import sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

// P2迁移：核心心智状态表（emotions/emotion_state/desires/personality/relationship_state）
// 写入守卫 — 旧 life TICK 路径被拦截（仅读取/计算/日志），仅 InnerTick 心智闭环可落库
import { guardP2MentalStateWrite, logParadigmP2Status } from '../../src/utils/paradigmGuard';

// 【重构·校验修复】默认路径回落数据根统一解析（Docker 内 LUMI_DATA_DIR=/app → /app/data/life.db 不变）
import { getDataPath } from '../config/data_path'; // E-3: 统一路径解析
const DB_PATH = process.env.LIFE_DB_PATH || getDataPath('life.db');
const BACKUP_DIR = path.dirname(DB_PATH);

let db: sqlite3.Database | null = null;
let dbOpen = false;

// ═══════════════════════════════════════════════════════════════════
// SQLite 并发安全层
// 1) 串行任务队列：任意时刻仅一个 SQLite 操作执行，杜绝语句/事务交错
// 2) 打开连接自动生效 PRAGMA：WAL + synchronous=NORMAL + busy_timeout（无需人工执行 sqlite 命令）
// 3) SQLITE_BUSY：有限次数指数退避重试
// 4) 连接健康校验：句柄关闭/异常 → 自动重开连接并重试，避免句柄关闭后继续调用导致 FATAL
// ═══════════════════════════════════════════════════════════════════
const BUSY_MAX_ATTEMPTS = 6;   // 含首次在内最多尝试次数
const BUSY_BASE_DELAY_MS = 50; // 指数退避基数：50 → 100 → 200 → 400 → 800ms
const PRAGMAS: string[] = [
  'PRAGMA journal_mode=WAL',   // WAL：读写互不阻塞，从根源降低锁竞争
  'PRAGMA synchronous=NORMAL', // 与 WAL 搭配的推荐持久性级别
  'PRAGMA foreign_keys=ON',
  'PRAGMA busy_timeout=5000',  // 驱动内部锁等待上限
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  return /SQLITE_BUSY|database is locked|database table is locked|database is busy/i.test(msg);
}

function isClosedHandleError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  return /SQLITE_MISUSE|handle is closed|database connection is not open|not open/i.test(msg);
}

// ── 数据库连接（带健康校验 + 自动重连 + PRAGMA 自动生效） ──
export function getLifeDb(): sqlite3.Database {
  if (db && dbOpen) return db;
  if (!db || !dbOpen) {
    const conn = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('[LifeDB] 连接失败:', err.message);
        if (db === conn) { dbOpen = false; db = null; }
      } else {
        if (db === conn) dbOpen = true;
        console.log('[LifeDB] 已连接:', DB_PATH);
      }
    });
    conn.on('error', (err) => {
      // 无回调语句的错误会以 'error' 事件抛出 → 不注册监听器会直接 FATAL。
      if (db !== conn) return; // 旧句柄迟到事件，不影响新句柄
      console.warn('[LifeDB] sqlite3 error 事件（自动重连）:', (err as any)?.message ?? err);
      dbOpen = false;
      db = null;
    });
    // 语句按 FIFO 顺序执行：连接创建后立即排队 PRAGMA → 先于后续任何业务语句生效
    for (const p of PRAGMAS) {
      conn.run(p, (err) => { if (err) console.warn('[LifeDB] PRAGMA 设置失败:', p, err.message); });
    }
    db = conn;
  }
  return db!;
}

/** 语句执行统一外壳：BUSY 指数退避重试 + 句柄关闭自动重开，抛错前充分重试 */
async function execWithRetry<T>(fn: (conn: sqlite3.Database) => Promise<T>, opName: string): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < BUSY_MAX_ATTEMPTS; attempt++) {
    const conn = getLifeDb();
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      if (isClosedHandleError(err)) {
        console.warn(`[LifeDB] ${opName} 句柄异常（${(err as any)?.message ?? err}），重开连接后重试`);
        if (db === conn) { dbOpen = false; db = null; }
        continue;
      }
      if (isBusyError(err) && attempt < BUSY_MAX_ATTEMPTS - 1) {
        const delay = BUSY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(`[LifeDB] ${opName} database locked，${delay}ms 后重试（${attempt + 1}/${BUSY_MAX_ATTEMPTS - 1}）`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── 表定义 ──
const TABLES: { name: string; sql: string }[] = [
  {
    name: 'personality',
    sql: `CREATE TABLE IF NOT EXISTS personality (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vector_json TEXT NOT NULL DEFAULT '[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'emotions',
    sql: `CREATE TABLE IF NOT EXISTS emotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emotion_type TEXT NOT NULL,
      intensity REAL NOT NULL DEFAULT 0.5 CHECK(intensity >= 0 AND intensity <= 1),
      context TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'emotion_state',
    sql: `CREATE TABLE IF NOT EXISTS emotion_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    // P2-4: 情绪历史归档附表 — 主表只保留近期记录，90 天前的记录定期迁移至此
    name: 'emotion_state_history',
    sql: `CREATE TABLE IF NOT EXISTS emotion_state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER,
      vector_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'desires',
    sql: `CREATE TABLE IF NOT EXISTS desires (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      desire_text TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0.5 CHECK(priority >= 0 AND priority <= 1),
      source TEXT DEFAULT 'intrinsic',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','in_progress','completed','abandoned')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'self_reflections',
    sql: `CREATE TABLE IF NOT EXISTS self_reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reflection_text TEXT NOT NULL,
      insight TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'interaction_memories',
    sql: `CREATE TABLE IF NOT EXISTS interaction_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      context_json TEXT DEFAULT '{}',
      significance_score REAL DEFAULT 0.5 CHECK(significance_score >= 0 AND significance_score <= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'proactive_observations',
    sql: `CREATE TABLE IF NOT EXISTS proactive_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_at TEXT NOT NULL,
      energy INTEGER DEFAULT 0,
      user_state TEXT DEFAULT '',
      message TEXT DEFAULT '',
      responded INTEGER DEFAULT 0,
      response_time INTEGER DEFAULT 0,
      response_length INTEGER DEFAULT 0,
      ignored INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'relationship_state',
    sql: `CREATE TABLE IF NOT EXISTS relationship_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_interaction_at INTEGER,
      last_decay_at INTEGER,
      total_interactions INTEGER DEFAULT 0
    )`,
  },
  {
    name: 'relationship_metrics',
    sql: `CREATE TABLE IF NOT EXISTS relationship_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trust_score REAL NOT NULL DEFAULT 0.4 CHECK(trust_score >= 0 AND trust_score <= 1),
      intimacy_score REAL NOT NULL DEFAULT 0.3 CHECK(intimacy_score >= 0 AND intimacy_score <= 1),
      understanding_score REAL NOT NULL DEFAULT 0.25 CHECK(understanding_score >= 0 AND understanding_score <= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'personality_evolution',
    sql: `CREATE TABLE IF NOT EXISTS personality_evolution (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vector_before TEXT NOT NULL,
      vector_after TEXT NOT NULL,
      delta_json TEXT NOT NULL,
      trigger TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'system_events',
    sql: `CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      data_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    // P1-17: 独立偏好标签表 — 权重可升可降（替代只增不减的单向累计）
    name: 'user_preference_tags',
    sql: `CREATE TABLE IF NOT EXISTS user_preference_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.3 CHECK(weight >= 0 AND weight <= 1),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, tag)
    )`,
  },
  {
    // 阶段一·模块1: travel-cal-mcp 行程库 — 行程内容 AES-256-GCM 加密存储（encrypted 字段），
    // remind_hours 为购票/出行提醒阈值（行程临近触发器按此批量拉取出行信息推送）
    name: 'travel_itineraries',
    sql: `CREATE TABLE IF NOT EXISTS travel_itineraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      encrypted TEXT NOT NULL,
      destination TEXT DEFAULT '',
      depart_at TEXT DEFAULT '',
      remind_hours INTEGER NOT NULL DEFAULT 24,
      status TEXT NOT NULL DEFAULT 'upcoming',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  {
    // Phase2: InnerTick 心智快照独立观测表 — 只读对比观测数据，与旧life状态表
    //（emotions/desires/personality/self_reflections/interaction_memories/relationship_* 等）完全隔离，互不覆盖。
    // inner_output 存储完整 InnerTickOutput JSON 文本（SQLite 无原生 JSONB，等同 JSONB 语义，JSON1 可查询）。
    // trigger_source 限定枚举：chat_turn（对话轮次触发）/ manual（手动/其他触发）。
    name: 'inner_tick_snapshot',
    sql: `CREATE TABLE IF NOT EXISTS inner_tick_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT '',
      user_uid TEXT NOT NULL DEFAULT '',
      turn_index INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      inner_output TEXT NOT NULL DEFAULT '{}',
      trigger_source TEXT NOT NULL DEFAULT 'manual' CHECK(trigger_source IN ('chat_turn','manual'))
    )`,
  },
];

// ── 全局迁移完成门（P1 修复：新库首启迁移竞态）──
// 全新库首次启动时，子系统查询与 migrateLifeTables 并发执行 → "no such table" unhandled rejection FATAL。
// 所有查询/写入（run/get/all）前置等待迁移完成再放行；迁移自身仅用裸 database.*（不经 run/get），
// 无自等死锁。migrateLifeTables 与 initLifeDb 复用同一 promise，启动仅执行一次迁移；
// 迁移异常时重置 gate，下次调用自动重试（与 run/get 原有 retry 逻辑叠加，行为不变）。
let migrationGate: Promise<{ success: boolean; tables: string[]; errors: string[] }> | null = null;

export function migrateLifeTables(): Promise<{ success: boolean; tables: string[]; errors: string[] }> {
  if (migrationGate) return migrationGate;
  const promise = migrateLifeTablesImpl();
  migrationGate = promise.catch((err: unknown) => {
    migrationGate = null; // 迁移失败 → 重置，允许下次调用重新迁移
    throw err;
  });
  return migrationGate;
}

async function migrateLifeTablesImpl(): Promise<{ success: boolean; tables: string[]; errors: string[] }> {
  const database = getLifeDb();
  const created: string[] = [];
  const errors: string[] = [];

  for (const table of TABLES) {
    try {
      await new Promise<void>((resolve, reject) => {
        database.run(table.sql, (err) => {
          if (err) reject(err);
          else { created.push(table.name); resolve(); }
        });
      });
    } catch (e: any) {
      errors.push(`${table.name}: ${e.message}`);
    }
  }

  // ── M5 情绪追加模式迁移：移除旧 emotion_state 的 CHECK(id=1) 单行约束 ──
  try {
    const hasOldSchema = await new Promise<boolean>((resolve) => {
      database.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='emotion_state'",
        (err, row: any) => resolve(row?.sql?.includes?.('CHECK') ?? false),
      );
    });
    if (hasOldSchema) {
      console.log('[LifeDB] Detected old emotion_state schema, migrating to append mode...');
      await new Promise<void>((resolve, reject) => {
        database.run('BEGIN', (err) => {
          if (err) { reject(err); return; }
          database.run(
            `CREATE TABLE IF NOT EXISTS emotion_state_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              vector_json TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )`,
            (err2) => {
              if (err2) { database.run('ROLLBACK', () => reject(err2)); return; }
              database.run(
                `INSERT INTO emotion_state_new (vector_json, created_at)
                 SELECT vector_json, IFNULL(updated_at, datetime('now'))
                 FROM emotion_state WHERE id = 1`,
                (err3) => {
                  if (err3) { database.run('ROLLBACK', () => reject(err3)); return; }
                  database.run('DROP TABLE emotion_state', (err4) => {
                    if (err4) { database.run('ROLLBACK', () => reject(err4)); return; }
                    database.run('ALTER TABLE emotion_state_new RENAME TO emotion_state', (err5) => {
                      if (err5) { database.run('ROLLBACK', () => reject(err5)); return; }
                      database.run('COMMIT', (err6) => {
                        if (err6) reject(err6); else resolve();
                      });
                    });
                  });
                },
              );
            },
          );
        });
      });
      console.log('[LifeDB] emotion_state migrated to append mode');
    }
  } catch (e: any) {
    console.warn('[LifeDB] emotion_state migration skipped:', e.message);
  }

  // ── P0-3: relationship_state 时间字段兼容迁移（已存在表仅补列，不破坏数据）──
  for (const col of ['last_interaction_at', 'last_decay_at', 'total_interactions']) {
    try {
      await new Promise<void>((resolve, reject) => {
        database.run(
          `ALTER TABLE relationship_state ADD COLUMN ${col} INTEGER${col === 'total_interactions' ? ' DEFAULT 0' : ''}`,
          (err) => {
            if (err && !String(err.message).includes('duplicate column')) {
              reject(err);
              return;
            }
            resolve();
          },
        );
      });
    } catch (e: any) {
      errors.push(`relationship_state.${col}: ${e.message}`);
    }
  }

  console.log(`[LifeDB] 迁移完成: ${created.length} 张表, ${errors.length} 个错误`);

  // [P2-MIGRATE] 启动时输出 P2 迁移守卫状态（部署核查点：确认 p2MigrateEnable 开/关）
  logParadigmP2Status();

  return { success: errors.length === 0, tables: created, errors };
}

// ── 事务辅助 ──
function begin(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => database.run('BEGIN', err => err ? reject(err) : resolve()));
}
function commit(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => database.run('COMMIT', err => err ? reject(err) : resolve()));
}
function rollback(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => database.run('ROLLBACK', () => resolve()));
}

// ── 全局串行排队锁（P0 修复：事务嵌套竞态）──
// 主循环 TICK（addDesire/addEmotion）与对话复盘（addEmotion）并发调用 withTransaction 时，
// 在同一 node-sqlite3 连接上 BEGIN/COMMIT 异步交错 → "cannot start a transaction within a transaction"。
// 所有事务进入 promise 链串行执行，杜绝 BEGIN 交错；事务流程本身（BEGIN/RUN/COMMIT）保持不变。
// 可重入：事务体（BEGIN…COMMIT 整体）作为单个队列任务，其内部 run/get/all 直接执行（不死锁）；
// 事务外的独立语句同样入队，外部并发操作必须等整个事务结束后才能执行。
let txQueue: Promise<unknown> = Promise.resolve();
let inQueue = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (inQueue > 0) return fn(); // 已持有串行槽位（事务体内部）→ 直接执行
  const runner = () => {
    inQueue++;
    return fn().finally(() => { inQueue--; });
  };
  const next = txQueue.then(runner, runner); // 前一事务失败（reject）不阻断后续事务入队
  txQueue = next.catch(() => {});            // 队列尾部吞错，避免 promise 链断裂
  return next;
}

async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    const database = getLifeDb();
    await begin(database);
    try {
      const result = await fn();
      await commit(database);
      return result;
    } catch (err) {
      await rollback(database);
      throw err;
    }
  });
}

// ── run/get 封装 ──
// P1 修复：所有查询/写入前置等待全局迁移完成（migrateLifeTables 门），杜绝新库首启竞态。
// 门只等待迁移落定；语句经串行任务队列 + BUSY 退避重试 + 句柄健康校验执行。
function run(sql: string, params: any[] = []): Promise<sqlite3.RunResult> {
  return migrateLifeTables().then(() => enqueue(() =>
    execWithRetry((conn) => new Promise<sqlite3.RunResult>((resolve, reject) => {
      conn.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    }), 'run')
  ));
}

function get<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  return migrateLifeTables().then(() => enqueue(() =>
    execWithRetry((conn) => new Promise<T | null>((resolve, reject) => {
      conn.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve((row as T) || null);
      });
    }), 'get')
  ));
}

function all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return migrateLifeTables().then(() => enqueue(() =>
    execWithRetry((conn) => new Promise<T[]>((resolve, reject) => {
      conn.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    }), 'all')
  ));
}

// ── P2迁移：核心心智状态写入守卫（[P2-MIGRATE] 埋点，单点拦截全部旧写入路径）──
// 拦截时：打印不节流的 [P2-MIGRATE] 日志 + 返回 false（调用方跳过 SQL，仅保留读取/计算/日志）；
// 放行时：照常执行。守卫判定（guardP2MentalStateWrite）：
//   p2MigrateEnable=false → 全部放行（维持原有 TICK 写库行为）；
//   p2MigrateEnable=true  → 仅 InnerTick 调用栈放行，其余（life TICK/旧模块/事件路径）拦截。
function p2GuardAllow(tableName: string, fnName: string): boolean {
  const allow = guardP2MentalStateWrite(tableName, `${fnName} @ server/db/lifeDb.ts`);
  if (!allow) {
    console.warn(`[P2-MIGRATE] lifeDb.${fnName} 写入「${tableName}」被 P2 迁移守卫拦截，跳过落库（旧 TICK 仅保留读取/计算/日志）`);
  }
  return allow;
}

// ═══════════════════════════════════════════════
// CRUD 操作
// ═══════════════════════════════════════════════

// ── Personality ──
export async function getPersonality(): Promise<any | null> {
  return get('SELECT * FROM personality ORDER BY id DESC LIMIT 1');
}

export async function updatePersonality(vector: number[]): Promise<number> {
  if (!p2GuardAllow('personality', 'updatePersonality')) return -1; // [P2-MIGRATE] 拦截：旧路径不再落库
  const existing = await get<{ id: number }>('SELECT id FROM personality ORDER BY id DESC LIMIT 1');
  const json = JSON.stringify(vector);
  if (existing) {
    await run('UPDATE personality SET vector_json=?, updated_at=datetime("now") WHERE id=?', [json, existing.id]);
    return existing.id;
  }
  const result = await run('INSERT INTO personality (vector_json) VALUES (?)', [json]);
  return result.lastID!;
}

// ── Emotions ──
export async function addEmotion(type: string, intensity: number, context = ''): Promise<number> {
  if (!p2GuardAllow('emotions', 'addEmotion')) return -1; // [P2-MIGRATE] 拦截：旧路径不再落库
  const result = await withTransaction(async () => {
    const r = await run(
      'INSERT INTO emotions (emotion_type, intensity, context) VALUES (?,?,?)',
      [type, intensity, context]
    );
    return r.lastID!;
  });
  return result;
}

export async function getRecentEmotions(limit = 20): Promise<any[]> {
  return all('SELECT * FROM emotions ORDER BY created_at DESC LIMIT ?', [limit]);
}

export async function getDominantEmotion(): Promise<any | null> {
  return get('SELECT emotion_type, MAX(intensity) as intensity FROM emotions WHERE created_at > datetime("now","-24 hours")');
}

export async function decayEmotions(): Promise<void> {
  if (!p2GuardAllow('emotions', 'decayEmotions')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  await run('UPDATE emotions SET intensity=MAX(0, intensity-0.03), updated_at=datetime("now") WHERE intensity > 0 AND created_at < datetime("now","-1 hour")');
  await run('DELETE FROM emotions WHERE intensity < 0.03');
}

// P2-4: 情绪记录分阶段归档 GC — 超过 ARCHIVE_DAYS 天的历史记录迁移至 emotion_state_history 附表，
// 主表只保留近期数据，避免单表逐年膨胀导致 ORDER BY DESC 查询性能下滑。
const EMOTION_ARCHIVE_DAYS = 90;
const EMOTION_ARCHIVE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 节流：至少间隔 6h 才执行一次
let lastEmotionArchiveAt = 0;

export async function archiveEmotionState(): Promise<{ archived: number }> {
  const now = Date.now();
  if (now - lastEmotionArchiveAt < EMOTION_ARCHIVE_INTERVAL_MS) return { archived: 0 };
  try {
    const migrated = await run(
      `INSERT INTO emotion_state_history (source_id, vector_json, created_at, archived_at)
       SELECT id, vector_json, created_at, datetime("now")
       FROM emotion_state
       WHERE created_at < datetime("now", ?)
         AND NOT EXISTS (SELECT 1 FROM emotion_state_history h WHERE h.source_id = emotion_state.id)`,
      [`-${EMOTION_ARCHIVE_DAYS} days`],
    );
    const archivedCount = migrated.changes || 0;
    if (archivedCount > 0) {
      await run('DELETE FROM emotion_state WHERE created_at < datetime("now", ?)', [`-${EMOTION_ARCHIVE_DAYS} days`]);
    }
    lastEmotionArchiveAt = now;
    if (archivedCount > 0) console.log(`[LifeDB] 情绪归档: ${archivedCount} 条 (>${EMOTION_ARCHIVE_DAYS}天) 已迁移至 emotion_state_history`);
    return { archived: archivedCount };
  } catch (e: any) {
    console.warn('[LifeDB] 情绪归档失败:', e?.message || e);
    return { archived: 0 };
  }
}

export async function saveEmotionVector(vector: number[]): Promise<void> {
  if (!p2GuardAllow('emotion_state', 'saveEmotionVector')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  // P2-4: 写入前顺带执行归档（节流 6h，不新增定时器）
  await archiveEmotionState();
  const json = JSON.stringify(vector);
  await run(
    'INSERT INTO emotion_state (vector_json, created_at) VALUES (?, datetime("now"))',
    [json]
  );
}

export async function loadEmotionVector(): Promise<number[] | null> {
  const row = await get<{ vector_json: string }>(
    'SELECT vector_json FROM emotion_state ORDER BY id DESC LIMIT 1'
  );
  if (!row) return null;
  try {
    const v = JSON.parse(row.vector_json);
    if (Array.isArray(v) && v.length === 8) return v;
  } catch {}
  return null;
}

// ── Desires ──
export async function addDesire(text: string, priority: number, source = 'intrinsic'): Promise<number> {
  if (!p2GuardAllow('desires', 'addDesire')) return -1; // [P2-MIGRATE] 拦截：旧路径不再落库
  const result = await withTransaction(async () => {
    const r = await run(
      'INSERT INTO desires (desire_text, priority, source) VALUES (?,?,?)',
      [text, priority, source]
    );
    return r.lastID!;
  });
  return result;
}

export async function getActiveDesires(): Promise<any[]> {
  return all('SELECT * FROM desires WHERE status="active" ORDER BY priority DESC');
}

export async function updateDesirePriority(id: number, delta: number): Promise<void> {
  if (!p2GuardAllow('desires', 'updateDesirePriority')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  await run('UPDATE desires SET priority=MAX(0,MIN(1,priority+?)), updated_at=datetime("now") WHERE id=?', [delta, id]);
}

export async function updateDesireStatus(id: number, status: string): Promise<void> {
  if (!p2GuardAllow('desires', 'updateDesireStatus')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  await run('UPDATE desires SET status=?, updated_at=datetime("now") WHERE id=?', [status, id]);
}

export async function completeDesire(id: number, result = ''): Promise<void> {
  if (!p2GuardAllow('desires', 'completeDesire')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  const extra = result ? ', desire_text=desire_text || ?' : '';
  const params: any[] = result ? ['completed', id, ` [完成: ${result}]`] : ['completed', id];
  await run(`UPDATE desires SET status=?, updated_at=datetime("now")${extra} WHERE id=?`, params);
}

export async function abandonDesire(id: number, reason = ''): Promise<void> {
  if (!p2GuardAllow('desires', 'abandonDesire')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  const extra = reason ? ', desire_text=desire_text || ?' : '';
  const params: any[] = reason ? ['abandoned', id, ` [放弃: ${reason}]`] : ['abandoned', id];
  await run(`UPDATE desires SET status=?, updated_at=datetime("now")${extra} WHERE id=?`, params);
}

export async function getTopDesire(): Promise<any | null> {
  return get('SELECT * FROM desires WHERE status="active" ORDER BY priority DESC LIMIT 1');
}

export async function countActiveDesires(): Promise<number> {
  const row = await get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM desires WHERE status="active"');
  return row?.cnt || 0;
}

export async function decayDesires(): Promise<void> {
  if (!p2GuardAllow('desires', 'decayDesires')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  await run('UPDATE desires SET priority=MAX(0,priority-0.02), updated_at=datetime("now") WHERE status="active" AND created_at < datetime("now","-1 hour")');
}

// ── Self Reflections ──
export async function addReflection(text: string, insight = ''): Promise<number> {
  const result = await run(
    'INSERT INTO self_reflections (reflection_text, insight) VALUES (?,?)',
    [text, insight]
  );
  return result.lastID!;
}

export async function getRecentReflections(limit = 10): Promise<any[]> {
  return all('SELECT * FROM self_reflections ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ── Interaction Memories ──
export async function addInteractionMemory(
  eventType: string, context: Record<string, any> = {}, significance = 0.5
): Promise<number> {
  const result = await run(
    'INSERT INTO interaction_memories (event_type, context_json, significance_score) VALUES (?,?,?)',
    [eventType, JSON.stringify(context), significance]
  );
  return result.lastID!;
}

export async function getSignificantMemories(minScore = 0.6, limit = 50): Promise<any[]> {
  return all(
    'SELECT * FROM interaction_memories WHERE significance_score >= ? ORDER BY created_at DESC LIMIT ?',
    [minScore, limit]
  );
}

export async function searchMemoriesByType(eventType: string): Promise<any[]> {
  return all(
    'SELECT * FROM interaction_memories WHERE event_type=? ORDER BY created_at DESC',
    [eventType]
  );
}

// ── L-4/L-18: 搁置思绪生命周期（跨轮接续 + 过期归档） ──

function parseThoughtContext(row: any): { thought?: string; source?: string; resolved?: boolean; expired?: boolean } {
  try {
    const ctx = typeof row.context_json === 'string' ? JSON.parse(row.context_json) : row.context_json;
    return ctx && typeof ctx === 'object' ? ctx : {};
  } catch {
    return {};
  }
}

/** L-4: 读取最近的未 resolved 搁置思绪（供下一轮 system prompt 接续） */
export async function getUnresolvedThoughts(limit = 3): Promise<any[]> {
  const rows = await all(
    'SELECT * FROM interaction_memories WHERE event_type=? ORDER BY created_at DESC LIMIT ?',
    ['internal_thought', Math.max(limit, 50)]
  );
  return rows
    .map((row: any) => ({ ...row, parsed: parseThoughtContext(row) }))
    .filter((r: any) => r.parsed.resolved === false)
    .slice(0, limit);
}

/** L-4: 思绪已在本轮被消费 → 标记 resolved=true（中断未消费时保留，下轮继续接续） */
export async function resolveThoughts(ids: number[]): Promise<void> {
  for (const id of ids) {
    try {
      const row = await get('SELECT context_json FROM interaction_memories WHERE id=?', [id]);
      if (!row) continue;
      const ctx = parseThoughtContext(row);
      if (ctx.resolved === true) continue;
      ctx.resolved = true;
      await run('UPDATE interaction_memories SET context_json=? WHERE id=?', [JSON.stringify(ctx), id]);
    } catch {}
  }
}

/** L-18: 搁置超过 maxAgeHours 的未 resolved 思绪自动归档清理（置 resolved，避免无限堆积） */
export async function expireStaleThoughts(maxAgeHours = 72): Promise<number> {
  let expired = 0;
  const rows = await all(
    'SELECT id, context_json, created_at FROM interaction_memories WHERE event_type=? AND created_at < datetime("now",?)',
    ['internal_thought', `-${maxAgeHours} hours`]
  );
  for (const row of rows) {
    try {
      const ctx = parseThoughtContext(row);
      if (ctx.resolved === true) continue;
      ctx.resolved = true;
      ctx.expired = true;
      await run('UPDATE interaction_memories SET context_json=? WHERE id=?', [JSON.stringify(ctx), row.id]);
      expired++;
    } catch {}
  }
  if (expired > 0) {
    console.log(`[LifeDB] 🧹 过期思绪归档: ${expired} 条（超 ${maxAgeHours}h 未接续）`);
  }
  return expired;
}

export async function decayMemories(): Promise<void> {
  await run('UPDATE interaction_memories SET significance_score=MAX(0,significance_score-0.01) WHERE significance_score > 0 AND created_at < datetime("now","-7 days")');
}

// ── Relationship Metrics ──
export async function addRelationshipSnapshot(
  trust: number, intimacy: number, understanding: number
): Promise<number> {
  const result = await run(
    'INSERT INTO relationship_metrics (trust_score, intimacy_score, understanding_score) VALUES (?,?,?)',
    [trust, intimacy, understanding]
  );
  return result.lastID!;
}

export async function getLatestRelationship(): Promise<any | null> {
  return get('SELECT * FROM relationship_metrics ORDER BY created_at DESC LIMIT 1');
}

export async function getRelationshipHistory(days = 30): Promise<any[]> {
  return all(
    'SELECT * FROM relationship_metrics WHERE created_at > datetime("now",?) ORDER BY created_at ASC',
    [`-${days} days`]
  );
}

// ── System Events ──
export async function logSystemEvent(eventType: string, data: Record<string, any> = {}): Promise<number> {
  const result = await run(
    'INSERT INTO system_events (event_type, data_json) VALUES (?,?)',
    [eventType, JSON.stringify(data)]
  );
  return result.lastID!;
}

export async function getRecentEvents(limit = 50): Promise<any[]> {
  return all('SELECT * FROM system_events ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ── Phase2: InnerTick 心智快照观测表（独立新表，与旧life状态表完全隔离）──
// 只做写入与只读观测，绝不改写 emotion/desire/personality/memory 等旧表数据。

export interface InnerTickSnapshotRow {
  id: number;
  session_id: string;
  user_uid: string;
  turn_index: number;
  created_at: string;
  inner_output: string; // 完整 InnerTickOutput JSON 文本
  trigger_source: 'chat_turn' | 'manual';
}

/** 写入一条 InnerTick 快照（仅允许写入 inner_tick_snapshot 观测表） */
export async function insertInnerTickSnapshot(params: {
  sessionId: string;
  userUid: string;
  turnIndex: number;
  innerOutput: Record<string, any>;
  triggerSource: 'chat_turn' | 'manual';
}): Promise<number> {
  const result = await run(
    `INSERT INTO inner_tick_snapshot (session_id, user_uid, turn_index, inner_output, trigger_source)
     VALUES (?,?,?,?,?)`,
    [params.sessionId, params.userUid, params.turnIndex, JSON.stringify(params.innerOutput), params.triggerSource],
  );
  return result.lastID!;
}

/** 统计某会话已有快照条数（用于推断下一轮 turn_index） */
export async function countInnerTickSnapshots(sessionId: string): Promise<number> {
  const row = await get<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM inner_tick_snapshot WHERE session_id = ?',
    [sessionId],
  );
  return row?.cnt || 0;
}

/** 读取最近 InnerTick 快照（观测/测试用，只读） */
export async function getRecentInnerTickSnapshots(limit = 20): Promise<InnerTickSnapshotRow[]> {
  return all<InnerTickSnapshotRow>('SELECT * FROM inner_tick_snapshot ORDER BY id DESC LIMIT ?', [limit]);
}

/** Phase3: 读取某会话最新一条 InnerTick 快照（只读，作为白名单会话的灰度心智源；无快照返回 null） */
export async function getLatestInnerTickSnapshot(sessionId: string): Promise<InnerTickSnapshotRow | null> {
  return get<InnerTickSnapshotRow | null>(
    'SELECT * FROM inner_tick_snapshot WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    [sessionId],
  );
}

// ── P1-17: 用户偏好标签（独立表，权重可升可降）──

const PREF_DROP_THRESHOLD = 0.05; // 权重低于该值视为无偏好，删除标签

/** 提升偏好权重（升：喜欢被再次提及）。缺标签则创建（默认权重 0.3）。 */
export async function bumpPreferenceTag(userId: string, tag: string, amount = 0.1): Promise<void> {
  await run(
    `INSERT INTO user_preference_tags (user_id, tag, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id, tag) DO UPDATE SET
       weight = MIN(1, weight + ?),
       updated_at = datetime('now')`,
    [userId, tag, amount],
  );
}

/** 降低偏好权重（降：反感被提及可下探到 0）。低于阈值则删除该标签。 */
export async function demotePreferenceTag(userId: string, tag: string, amount = 0.1): Promise<void> {
  await run(
    `UPDATE user_preference_tags SET weight = MAX(0, weight - ?), updated_at = datetime('now')
     WHERE user_id = ? AND tag = ?`,
    [amount, userId, tag],
  );
  await run(
    `DELETE FROM user_preference_tags WHERE user_id = ? AND tag = ? AND weight < ?`,
    [userId, tag, PREF_DROP_THRESHOLD],
  );
}

/** 读取用户偏好标签（按权重降序）。无数据返回空数组。 */
export async function getUserPreferenceTags(
  userId: string,
  minWeight = 0.1,
): Promise<{ tag: string; weight: number; updatedAt: string }[]> {
  const rows = await all<{ tag: string; weight: number; updated_at: string }>(
    `SELECT tag, weight, updated_at FROM user_preference_tags
     WHERE user_id = ? AND weight >= ?
     ORDER BY weight DESC, updated_at DESC`,
    [userId, minWeight],
  );
  return (rows || []).map(r => ({ tag: r.tag, weight: r.weight, updatedAt: r.updated_at || '' }));
}

export async function countEvents(eventType: string): Promise<number> {
  const row = await get<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM system_events WHERE event_type = ?',
    [eventType]
  );
  return row?.cnt || 0;
}

// ── Proactive Observations ──
export async function createProactiveObservation(energy: number, userState: string, message: string): Promise<number> {
  const result = await run(
    'INSERT INTO proactive_observations (triggered_at, energy, user_state, message) VALUES (datetime("now"),?,?,?)',
    [energy, userState, message]
  );
  return result.lastID!;
}

export async function getUnrespondedObservations(): Promise<any[]> {
  return all(
    'SELECT * FROM proactive_observations WHERE responded=0 AND ignored=0 ORDER BY created_at DESC'
  );
}

export async function markObservationResponded(id: number, responseTime: number, responseLength: number): Promise<void> {
  await run(
    'UPDATE proactive_observations SET responded=1, response_time=?, response_length=? WHERE id=?',
    [responseTime, responseLength, id]
  );
}

export async function markObservationsIgnored(timeoutMinutes: number = 10): Promise<number> {
  const result = await run(
    'UPDATE proactive_observations SET ignored=1 WHERE responded=0 AND ignored=0 AND created_at < datetime("now",?)',
    [`-${timeoutMinutes} minutes`]
  );
  return result.changes || 0;
}

// ═══════════════════════════════════════════════
// 备份与维护
// ═══════════════════════════════════════════════

let lastBackupTime = 0;

export async function autoBackup(): Promise<void> {
  const now = Date.now();
  if (now - lastBackupTime < 86400000) return; // 24小时内已备份
  lastBackupTime = now;

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `life_backup_${timestamp}.db`);

    // VACUUM INTO 经串行队列执行：不与其它语句/事务交错（VACUUM 不能在事务内执行）
    await enqueue(() =>
      execWithRetry((conn) => new Promise<void>((resolve, reject) => {
        conn.run(`VACUUM INTO '${backupPath}'`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }), 'VACUUM INTO')
    );

    console.log(`[LifeDB] 已备份: ${backupPath}`);

    // 只保留最近 7 个备份
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('life_backup_'))
      .sort()
      .reverse();
    for (const f of files.slice(7)) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch (e: any) {
    // VACUUM INTO 可能在旧版 SQLite 不可用，用文件拷贝降级
    if (e.message?.includes('VACUUM')) {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(BACKUP_DIR, `life_backup_${timestamp}.db`);
        fs.copyFileSync(DB_PATH, backupPath);
        console.log(`[LifeDB] 已备份(fallback): ${backupPath}`);
      } catch (e2: any) {
        console.error('[LifeDB] 备份失败:', e2.message);
      }
    } else {
      console.error('[LifeDB] 备份失败:', e.message);
    }
  }
}

// ── 数据完整性验证 ──
export async function verifyIntegrity(): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  try {
    const row = await get<{ ok: string }>('PRAGMA integrity_check');
    if (!row || row.ok !== 'ok') {
      issues.push(`integrity_check: ${row?.ok || 'unknown'}`);
    }
  } catch (e: any) {
    issues.push(`integrity_check failed: ${e.message}`);
  }
  return { ok: issues.length === 0, issues };
}

// ── 初始化（创建所有表 + 执行首次备份） ──
export async function initLifeDb(): Promise<void> {
  console.log('[LifeDB] 初始化...');
  const result = await migrateLifeTables();
  if (!result.success) {
    console.error('[LifeDB] 迁移错误:', result.errors);
  }
  await autoBackup();
  await logSystemEvent('life_db_init', { tables: result.tables });
  console.log('[LifeDB] 初始化完成');
}

// ── Relationship State ──
// P0-3: 关系时间统计字段（lastInteractionAt/lastDecayAt/totalInteractions）随向量一并持久化，
//       修复服务重启后时间重置导致 24h 衰减逻辑永久无法触发的问题。
export interface RelationshipStateMeta {
  lastInteractionAt?: number | null;
  lastDecayAt?: number | null;
  totalInteractions?: number | null;
}

export async function saveRelationshipVector(
  vector: number[],
  meta?: RelationshipStateMeta,
): Promise<void> {
  if (!p2GuardAllow('relationship_state', 'saveRelationshipVector')) return; // [P2-MIGRATE] 拦截：旧路径不再落库
  const json = JSON.stringify(vector);
  await run(
    `INSERT OR REPLACE INTO relationship_state
      (id, vector_json, updated_at, last_interaction_at, last_decay_at, total_interactions)
     VALUES (1, ?, datetime("now"), ?, ?, ?)`,
    [
      json,
      meta?.lastInteractionAt ?? null,
      meta?.lastDecayAt ?? null,
      meta?.totalInteractions ?? 0,
    ]
  );
}

export async function loadRelationshipState(): Promise<
  { vector: number[] | null } & RelationshipStateMeta
> {
  const row = await get<{
    vector_json: string;
    last_interaction_at: number | null;
    last_decay_at: number | null;
    total_interactions: number | null;
  }>(
    'SELECT vector_json, last_interaction_at, last_decay_at, total_interactions FROM relationship_state WHERE id = 1'
  );
  if (!row) return { vector: null, lastInteractionAt: null, lastDecayAt: null, totalInteractions: null };
  let vector: number[] | null = null;
  try {
    const v = JSON.parse(row.vector_json);
    if (Array.isArray(v) && v.length === 4) vector = v;
  } catch {}
  return {
    vector,
    lastInteractionAt: row.last_interaction_at,
    lastDecayAt: row.last_decay_at,
    totalInteractions: row.total_interactions,
  };
}

export async function loadRelationshipVector(): Promise<number[] | null> {
  const state = await loadRelationshipState();
  return state.vector;
}

// ── Personality Evolution ──
export async function recordPersonalityEvolution(
  before: number[], after: number[], delta: number[], trigger: string
): Promise<number> {
  const result = await run(
    'INSERT INTO personality_evolution (vector_before, vector_after, delta_json, trigger) VALUES (?,?,?,?)',
    [JSON.stringify(before), JSON.stringify(after), JSON.stringify(delta), trigger]
  );
  return result.lastID!;
}

export async function getPersonalityEvolutionHistory(limit = 20): Promise<any[]> {
  return all('SELECT * FROM personality_evolution ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ── 阶段一·模块1: travel-cal-mcp 行程库 CRUD ──
// 行程详情由 travel_cal 模块 AES-256-GCM 加密后写入 encrypted 字段，此处只做存取，不接触明文。

export interface TravelItineraryRow {
  id: number;
  user_id: string;
  title: string;
  encrypted: string;
  destination: string;
  depart_at: string;
  remind_hours: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function addTravelItinerary(
  userId: string,
  data: { title: string; encrypted: string; destination?: string; departAt?: string; remindHours?: number },
): Promise<number> {
  const result = await run(
    `INSERT INTO travel_itineraries (user_id, title, encrypted, destination, depart_at, remind_hours)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, data.title, data.encrypted, data.destination || '', data.departAt || '', data.remindHours ?? 24],
  );
  return result.lastID!;
}

export async function listTravelItineraries(userId: string, status?: string): Promise<TravelItineraryRow[]> {
  if (status) {
    return all<TravelItineraryRow>('SELECT * FROM travel_itineraries WHERE user_id = ? AND status = ? ORDER BY depart_at', [userId, status]);
  }
  return all<TravelItineraryRow>('SELECT * FROM travel_itineraries WHERE user_id = ? ORDER BY depart_at', [userId]);
}

export async function getTravelItinerary(id: number): Promise<TravelItineraryRow | null> {
  return get<TravelItineraryRow>('SELECT * FROM travel_itineraries WHERE id = ?', [id]);
}

export async function updateTravelItinerary(id: number, patch: Partial<Pick<TravelItineraryRow, 'title' | 'encrypted' | 'destination' | 'depart_at' | 'remind_hours' | 'status'>>): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  for (const key of ['title', 'encrypted', 'destination', 'depart_at', 'remind_hours', 'status'] as const) {
    const v = (patch as any)[key];
    if (v !== undefined) { sets.push(`${key} = ?`); params.push(v); }
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = datetime('now')`);
  params.push(id);
  await run(`UPDATE travel_itineraries SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function deleteTravelItinerary(id: number): Promise<void> {
  await run('DELETE FROM travel_itineraries WHERE id = ?', [id]);
}

/** 行程临近查询：未来 withinHours 小时内出发、且已到提醒窗口上限（depart_at - now <= MAX(remind_hours, withinHours)）的未完成行程 */
export async function getUpcomingTravels(userId: string, withinHours: number): Promise<TravelItineraryRow[]> {
  return all<TravelItineraryRow>(
    `SELECT * FROM travel_itineraries
     WHERE user_id = ? AND status = 'upcoming' AND depart_at != ''
       AND julianday(depart_at) - julianday('now') BETWEEN 0 AND ?
       AND julianday(depart_at) - julianday('now') <= MAX(remind_hours / 24.0, ?)
     ORDER BY depart_at`,
    [userId, withinHours / 24.0, withinHours / 24.0],
  );
}

// ── 关闭连接 ──
export function closeLifeDb(): void {
  if (db) {
    db.close((err) => {
      if (err) console.error('[LifeDB] 关闭失败:', err.message);
      else console.log('[LifeDB] 已关闭');
    });
    db = null;
    dbOpen = false; // 句柄失效标记：后续 getLifeDb/语句自动重开连接，避免 SQLITE_MISUSE
  }
}
