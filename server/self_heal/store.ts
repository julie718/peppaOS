// 阶段二·自诊疗模块 — 独立持久化存储（self_heal.db）
// 隔离库：独立于 peppa.db / life.db，自检记录不污染业务数据。
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import type { SelfHealRecord, SelfHealReport } from './types';

const DB_REL = 'self_heal.db';
let db: sqlite3.Database | null = null;
let dbOpen = false;
let dbPath = '';

export function getSelfHealDbPath(): string {
  if (dbPath) return dbPath;
  dbPath = process.env.SELF_HEAL_DB_PATH || getDataPath(DB_REL);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dbPath;
}

// ═══════════════════════════════════════════════════════════════════
// SQLite 并发安全层
// 1) 串行任务队列：任意时刻仅一个 SQLite 操作执行
// 2) 打开连接自动生效 PRAGMA：WAL + synchronous=NORMAL + busy_timeout（无需人工执行 sqlite 命令）
// 3) SQLITE_BUSY：有限次数指数退避重试
// 4) 连接健康校验：句柄关闭/异常 → 自动重开连接并重试，避免句柄关闭后继续调用导致 FATAL
// ═══════════════════════════════════════════════════════════════════
const BUSY_MAX_ATTEMPTS = 6;   // 含首次在内最多尝试次数
const BUSY_BASE_DELAY_MS = 50; // 指数退避基数：50 → 100 → 200 → 400 → 800ms
const PRAGMAS: string[] = [
  'PRAGMA journal_mode=WAL',   // WAL：读写互不阻塞，从根源降低锁竞争
  'PRAGMA synchronous=NORMAL', // 与 WAL 搭配的推荐持久性级别
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

function open(): sqlite3.Database {
  if (db && dbOpen) return db;
  if (!db || !dbOpen) {
    const conn = new sqlite3.Database(getSelfHealDbPath(), (err) => {
      if (err) {
        console.error('[SelfHealDB] 连接失败:', err.message);
        if (db === conn) { dbOpen = false; db = null; }
      } else {
        if (db === conn) dbOpen = true;
      }
    });
    conn.on('error', (err) => {
      // 无回调语句的错误会以 'error' 事件抛出 → 不注册监听器会直接 FATAL。
      if (db !== conn) return; // 旧句柄迟到事件，不影响新句柄
      console.warn('[SelfHealDB] sqlite3 error 事件（自动重连）:', (err as any)?.message ?? err);
      dbOpen = false;
      db = null;
    });
    // 语句按 FIFO 顺序执行：连接创建后立即排队 PRAGMA → 先于后续任何业务语句生效
    for (const p of PRAGMAS) {
      conn.run(p, (err) => { if (err) console.warn('[SelfHealDB] PRAGMA 设置失败:', p, err.message); });
    }
    conn.serialize(() => {
      conn.run(`CREATE TABLE IF NOT EXISTS self_heal_records (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        defect_count INTEGER DEFAULT 0,
        auto_repaired INTEGER DEFAULT 0,
        rollback_count INTEGER DEFAULT 0,
        health_score REAL DEFAULT 0,
        verdict TEXT DEFAULT 'healthy',
        summary TEXT DEFAULT ''
      )`);
      conn.run(`CREATE TABLE IF NOT EXISTS self_heal_defects (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        file TEXT DEFAULT '',
        line INTEGER DEFAULT 0,
        symptom TEXT DEFAULT '',
        template_id TEXT DEFAULT '',
        auto_repairable INTEGER DEFAULT 0,
        human_required INTEGER DEFAULT 0,
        resolved INTEGER DEFAULT 0,
        repaired_by TEXT DEFAULT '',
        repaired_at TEXT DEFAULT ''
      )`);
      conn.run(`CREATE INDEX IF NOT EXISTS idx_defects_run ON self_heal_defects(run_id)`);
    });
    db = conn;
  }
  return db!;
}

// 串行任务队列：同一时刻仅允许一个 SQLite 操作执行（可重入：内部直接执行，不死锁）
let opQueue: Promise<unknown> = Promise.resolve();
let inQueue = 0;

function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
  if (inQueue > 0) return fn();
  const runner = () => {
    inQueue++;
    return fn().finally(() => { inQueue--; });
  };
  const next = opQueue.then(runner, runner);
  opQueue = next.catch(() => {});
  return next;
}

/** 语句执行统一外壳：BUSY 指数退避重试 + 句柄关闭自动重开，抛错前充分重试 */
async function execWithRetry<T>(fn: (conn: sqlite3.Database) => Promise<T>, opName: string): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < BUSY_MAX_ATTEMPTS; attempt++) {
    const conn = open();
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      if (isClosedHandleError(err)) {
        console.warn(`[SelfHealDB] ${opName} 句柄异常（${(err as any)?.message ?? err}），重开连接后重试`);
        if (db === conn) { dbOpen = false; db = null; }
        continue;
      }
      if (isBusyError(err) && attempt < BUSY_MAX_ATTEMPTS - 1) {
        const delay = BUSY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(`[SelfHealDB] ${opName} database locked，${delay}ms 后重试（${attempt + 1}/${BUSY_MAX_ATTEMPTS - 1}）`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function all<T>(sql: string, params: any[] = []): Promise<T[]> {
  return enqueueOp(() =>
    execWithRetry((conn) => new Promise<T[]>((resolve, reject) => {
      conn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
    }), 'all')
  );
}

function get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  return enqueueOp(() =>
    execWithRetry((conn) => new Promise<T | undefined>((resolve, reject) => {
      conn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
    }), 'get')
  );
}

function run(sql: string, params: any[] = []): Promise<void> {
  return enqueueOp(() =>
    execWithRetry((conn) => new Promise<void>((resolve, reject) => {
      conn.run(sql, params, (err) => (err ? reject(err) : resolve()));
    }), 'run')
  );
}

/** 落库一次自检记录 */
export async function saveSelfHealRecord(report: SelfHealReport): Promise<void> {
  const summary =
    `断言 ${report.assertionPassed}/${report.assertionTotal} 通过，` +
    `缺陷 ${report.defects.filter(d => !d.resolved).length} 未解决，` +
    `自动修复 ${report.autoRepaired} 项，回滚 ${report.rollbackCount} 次`;
  await run(
    `INSERT OR REPLACE INTO self_heal_records
     (run_id, started_at, defect_count, auto_repaired, rollback_count, health_score, verdict, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [report.runId, report.startedAt, report.defects.length, report.autoRepaired, report.rollbackCount, report.healthScore, report.verdict, summary],
  );
  for (const d of report.defects) {
    await run(
      `INSERT OR REPLACE INTO self_heal_defects
       (id, run_id, source, category, severity, file, line, symptom, template_id, auto_repairable, human_required, resolved, repaired_by, repaired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, report.runId, d.source, d.category, d.severity, d.file, d.line || 0, d.symptom, d.templateId || '', d.autoRepairable ? 1 : 0, d.humanRequired ? 1 : 0, d.resolved ? 1 : 0, d.repairedBy || '', d.repairedAt || ''],
    );
  }
}

/** 历史自检记录（倒序） */
export async function listSelfHealRecords(limit = 20): Promise<SelfHealRecord[]> {
  return all<SelfHealRecord>(
    `SELECT run_id as runId, started_at as startedAt, defect_count as defectCount, auto_repaired as autoRepaired,
            rollback_count as rollbackCount, health_score as healthScore, verdict, summary
     FROM self_heal_records ORDER BY started_at DESC LIMIT ?`,
    [limit],
  );
}

/** 未解决缺陷数 / 待自动修复条目数 */
export async function countOpenDefects(): Promise<{ open: number; pendingAuto: number }> {
  const row = await get<{ open: number; pendingAuto: number }>(
    `SELECT SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END) as open,
            SUM(CASE WHEN resolved = 0 AND auto_repairable = 1 THEN 1 ELSE 0 END) as pendingAuto
     FROM self_heal_defects`,
  );
  return { open: row?.open || 0, pendingAuto: row?.pendingAuto || 0 };
}

/** 历史修复记录（成功/回滚均留痕） */
export async function listRepairHistory(limit = 20): Promise<any[]> {
  return all<any>(
    `SELECT id, run_id as runId, file, template_id as templateId, repaired_by as repairedBy,
            repaired_at as repairedAt, resolved, source, severity
     FROM self_heal_defects WHERE repaired_by != '' OR resolved = 1
     ORDER BY repaired_at DESC LIMIT ?`,
    [limit],
  );
}

/** 关闭连接（测试用） */
export function closeSelfHealDb(): void {
  if (db) { db.close(); db = null; dbOpen = false; }
}
