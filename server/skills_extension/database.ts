// 阶段三·自主技能拓展系统 — 独立持久层
// 独立数据库 skills_extension.db（与阶段一 life.db 完全隔离，不触碰其 14 张表）。
// 5 张表：sandbox_config / gateway_credentials / tool_approvals / tool_monitoring / skills_audit。

import sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getDataPath } from '../config/data_path';
import { logger } from '../lib/logger';
import type {
  ApprovalRecord, GatewayCredential, SkillsAuditEntry, ToolMetric, SandboxProject,
} from './types';

const DB_PATH = process.env.SKILLS_DB_PATH || getDataPath('skills_extension.db');

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
// 打开模式：READWRITE | CREATE | FULLMUTEX（FULLMUTEX = SQLite serialized 串行模式，
// 任意时刻仅一个线程访问连接，适配多线程/多调度任务并发访问）
const OPEN_FLAGS = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;
const PRAGMAS: string[] = [
  'PRAGMA journal_mode=WAL',   // WAL：读写互不阻塞，从根源降低锁竞争
  'PRAGMA synchronous=NORMAL', // 与 WAL 搭配的推荐持久性级别
  'PRAGMA busy_timeout=5000',  // 驱动内部锁等待上限
  'PRAGMA foreign_keys=ON',
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

function getDb(): sqlite3.Database {
  // 单例复用：连接对象一旦创建即返回（无论 open 是否完成——语句在驱动队列中等 open 后执行）。
  // 若以 open 完成作为复用条件，首波并发下每个调用方都会各自 new 句柄，违背单例目标。
  if (db) return db;
    // serialized 串行模式（OPEN_FULLMUTEX）+ 带回调构造：打开失败时错误进回调而非未捕获 'error' 事件
    const conn = new sqlite3.Database(DB_PATH, OPEN_FLAGS, (err) => {
      if (err) {
        console.error('[SkillsDB] 连接失败:', err.message);
        if (db === conn) { dbOpen = false; db = null; }
      } else {
        if (db === conn) dbOpen = true;
      }
    });
    conn.on('error', (err) => {
      // 无回调语句的错误会以 'error' 事件抛出 → 不注册监听器会直接 FATAL。
      if (db !== conn) return; // 旧句柄迟到事件，不影响新句柄
      logger.warn(`[SkillsDB] sqlite3 error 事件（自动重连）: ${(err as any)?.message ?? err}`);
      dbOpen = false;
      db = null;
    });
    // 语句按 FIFO 顺序执行：连接创建后立即排队 PRAGMA → 先于后续任何业务语句生效
    for (const p of PRAGMAS) {
      conn.run(p, (err) => { if (err) logger.warn(`[SkillsDB] PRAGMA 设置失败: ${p} ${err.message}`); });
    }
    db = conn;
  return db!;
}

// 串行任务队列：同一时刻仅允许一个 SQLite 操作执行（可重入：事务体内部直接执行，不死锁）
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
    const conn = getDb();
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      if (isClosedHandleError(err)) {
        console.warn(`[SkillsDB] ${opName} 句柄异常（${(err as any)?.message ?? err}），重开连接后重试`);
        if (db === conn) { dbOpen = false; db = null; }
        continue;
      }
      if (isBusyError(err) && attempt < BUSY_MAX_ATTEMPTS - 1) {
        const delay = BUSY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(`[SkillsDB] ${opName} database locked，${delay}ms 后重试（${attempt + 1}/${BUSY_MAX_ATTEMPTS - 1}）`);
        await sleep(delay);
        continue;
      }
      // 重试耗尽：日志降级后抛出，由调用方/全局兜底处理，不静默吞错
      logger.error(`[SkillsDB] ${opName} 执行失败（已充分重试）: ${(err as any)?.message ?? err}`);
      throw err;
    }
  }
  logger.error(`[SkillsDB] ${opName} 执行失败（${BUSY_MAX_ATTEMPTS} 次尝试均未成功）: ${(lastErr as any)?.message ?? lastErr}`);
  throw lastErr;
}

function run(sql: string, params: any[] = []): Promise<{ lastID?: number }> {
  return enqueueOp(() =>
    execWithRetry((conn) => new Promise<{ lastID?: number }>((resolve, reject) => {
      conn.run(sql, params, function (this: sqlite3.RunResult, err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID });
      });
    }), 'run')
  );
}

function all<T>(sql: string, params: any[] = []): Promise<T[]> {
  return enqueueOp(() =>
    execWithRetry((conn) => new Promise<T[]>((resolve, reject) => {
      conn.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows as T[]);
      });
    }), 'all')
  );
}

function get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  return enqueueOp(() =>
    execWithRetry((conn) => new Promise<T | undefined>((resolve, reject) => {
      conn.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row as T | undefined);
      });
    }), 'get')
  );
}

/** 表内列存在性检查（PRAGMA table_info），供 ALTER ADD COLUMN 幂等判断 */
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === column);
}

/** 阶段三 5 张数据表定义（完整迁移） */
const TABLES: Array<{ name: string; sql: string }> = [
  {
    name: 'sandbox_config',
    sql: `CREATE TABLE IF NOT EXISTS sandbox_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      service_name TEXT NOT NULL,
      dir TEXT NOT NULL,
      main_source TEXT NOT NULL,
      tsc_iterations INTEGER DEFAULT 0,
      tsc_passed INTEGER DEFAULT 0,
      pending_reason TEXT DEFAULT '',
      risk_level TEXT DEFAULT 'safe',
      status TEXT DEFAULT 'building',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'gateway_credentials',
    sql: `CREATE TABLE IF NOT EXISTS gateway_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name TEXT NOT NULL UNIQUE,
      encrypted_key TEXT NOT NULL,
      bound_tools TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      user_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'tool_approvals',
    sql: `CREATE TABLE IF NOT EXISTS tool_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      decided_by TEXT DEFAULT '',
      reject_reason TEXT DEFAULT '',
      decided_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'tool_monitoring',
    sql: `CREATE TABLE IF NOT EXISTS tool_monitoring (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER DEFAULT 0,
      user_negative INTEGER DEFAULT -1,
      source TEXT DEFAULT 'community',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  },
  {
    name: 'skills_audit',
    sql: `CREATE TABLE IF NOT EXISTS skills_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      subject TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  },
  {
    // 任务要求：独立数据表 mcp_skill_store — 存储元数据、来源、风险标记、成功率统计，不和旧业务表混杂
    name: 'mcp_skill_store',
    sql: `CREATE TABLE IF NOT EXISTS mcp_skill_store (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_name TEXT NOT NULL UNIQUE,
      version TEXT DEFAULT '1.0.0',
      source TEXT NOT NULL DEFAULT 'community',
      origin TEXT DEFAULT '',
      risk_level TEXT DEFAULT 'safe',
      security_level TEXT DEFAULT 'safe',
      compliance_domain TEXT DEFAULT 'none',
      needs_credential INTEGER DEFAULT 0,
      status TEXT DEFAULT 'installed',
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      total_calls INTEGER DEFAULT 0,
      success_rate REAL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      installed_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  },
];

/** 初始化全部阶段三数据表（幂等），返回迁移结果 */
export async function migrateSkillsTables(): Promise<{ success: boolean; tables: string[]; errors: string[] }> {
  const tables: string[] = [];
  const errors: string[] = [];
  for (const t of TABLES) {
    try {
      await run(t.sql);
      tables.push(t.name);
    } catch (e: any) {
      errors.push(`${t.name}: ${e.message}`);
    }
  }
  // P2-4/P2-2：既有数据库增量补列（CREATE TABLE IF NOT EXISTS 不作用于已存在表）。
  // 幂等修复：ADD COLUMN 前先 PRAGMA table_info 查列存在性，列已存在直接跳过 ALTER 语句，
  // 消除旧实现"先执行后 catch 吞错"在重启/重部署时产生的 duplicate column name 报错输出。
  const ALTERS: Array<{ table: string; column: string; sql: string }> = [
    { table: 'tool_monitoring', column: 'source', sql: `ALTER TABLE tool_monitoring ADD COLUMN source TEXT DEFAULT 'community'` },
    { table: 'sandbox_config', column: 'risk_level', sql: `ALTER TABLE sandbox_config ADD COLUMN risk_level TEXT DEFAULT 'safe'` },
  ];
  for (const a of ALTERS) {
    try {
      if (await columnExists(a.table, a.column)) {
        logger.info(`[SkillsDB] 增量迁移: ${a.table}.${a.column} 列已存在，跳过 ALTER`);
        continue;
      }
      await run(a.sql);
      logger.info(`[SkillsDB] 增量迁移: ${a.table} 补列 ${a.column} 完成`);
    } catch (e: any) {
      // 兜底：重复列已由列存在性检查前置排除，走到这里的是真实异常 → 显式告警，不再静默吞错
      logger.warn(`[SkillsDB] 增量迁移: ${a.table} 补列 ${a.column} 失败: ${e?.message ?? e}`);
    }
  }

  const success = errors.length === 0;
  if (success) {
    logger.info(`[SkillsDB] 迁移完成: ${tables.length} 张表, 0 个错误 (${DB_PATH})`);
  } else {
    logger.error(`[SkillsDB] 迁移失败: ${errors.join('; ')}`);
  }
  return { success, tables, errors };
}

export function getSkillsDbPath(): string {
  return DB_PATH;
}

// ── sandbox_config ──

export async function insertSandboxProject(p: Omit<SandboxProject, 'id' | 'createdAt'>): Promise<number> {
  const r = await run(
    `INSERT INTO sandbox_config (keyword, service_name, dir, main_source, tsc_iterations, tsc_passed, pending_reason, risk_level, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [p.keyword, p.serviceName, p.dir, p.mainSource, p.tscIterations, p.tscPassed ? 1 : 0, p.pendingReason || '', p.riskLevel || 'safe', p.status],
  );
  return r.lastID!;
}

export async function updateSandboxProject(id: number, patch: Partial<Pick<SandboxProject, 'tscIterations' | 'tscPassed' | 'pendingReason' | 'status'>>): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.tscIterations !== undefined) { sets.push('tsc_iterations=?'); params.push(patch.tscIterations); }
  if (patch.tscPassed !== undefined) { sets.push('tsc_passed=?'); params.push(patch.tscPassed ? 1 : 0); }
  if (patch.pendingReason !== undefined) { sets.push('pending_reason=?'); params.push(patch.pendingReason); }
  if (patch.status !== undefined) { sets.push('status=?'); params.push(patch.status); }
  if (sets.length === 0) return;
  params.push(id);
  await run(`UPDATE sandbox_config SET ${sets.join(',')} WHERE id=?`, params);
}

export async function listSandboxProjects(status?: string): Promise<SandboxProject[]> {
  const rows = await all<any>(
    status ? `SELECT * FROM sandbox_config WHERE status=? ORDER BY id DESC` : `SELECT * FROM sandbox_config ORDER BY id DESC`,
    status ? [status] : [],
  );
  return rows.map(r => ({
    id: r.id,
    keyword: r.keyword,
    serviceName: r.service_name,
    dir: r.dir,
    mainSource: r.main_source,
    tscIterations: r.tsc_iterations,
    tscPassed: !!r.tsc_passed,
    pendingReason: r.pending_reason,
    riskLevel: r.risk_level || 'safe',
    status: r.status,
    createdAt: r.created_at,
  }));
}

// ── gateway_credentials ──

export async function upsertCredential(c: Omit<GatewayCredential, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
  const r = await run(
    `INSERT INTO gateway_credentials (service_name, encrypted_key, bound_tools, enabled, user_id)
     VALUES (?,?,?,?,?)
     ON CONFLICT(service_name) DO UPDATE SET encrypted_key=excluded.encrypted_key, bound_tools=excluded.bound_tools, enabled=excluded.enabled, updated_at=datetime('now')`,
    [c.serviceName, c.encryptedKey, c.boundTools, c.enabled, c.userId || ''],
  );
  return r.lastID!;
}

export async function listCredentials(): Promise<GatewayCredential[]> {
  const rows = await all<any>('SELECT * FROM gateway_credentials ORDER BY id DESC');
  return rows.map(r => ({
    id: r.id,
    serviceName: r.service_name,
    encryptedKey: r.encrypted_key,
    boundTools: r.bound_tools,
    enabled: r.enabled,
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getCredentialByService(serviceName: string): Promise<GatewayCredential | undefined> {
  const r = await get<any>('SELECT * FROM gateway_credentials WHERE service_name=?', [serviceName]);
  if (!r) return undefined;
  return {
    id: r.id,
    serviceName: r.service_name,
    encryptedKey: r.encrypted_key,
    boundTools: r.bound_tools,
    enabled: r.enabled,
    userId: r.user_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function deleteCredential(serviceName: string): Promise<void> {
  await run('DELETE FROM gateway_credentials WHERE service_name=?', [serviceName]);
}

// ── tool_approvals ──

export async function insertApproval(a: Omit<ApprovalRecord, 'id' | 'createdAt'>): Promise<number> {
  const r = await run(
    `INSERT INTO tool_approvals (tool_name, project_id, status, decided_by, reject_reason, decided_at)
     VALUES (?,?,?,?,?,?)`,
    [a.toolName, a.projectId, a.status, a.decidedBy || '', a.rejectReason || '', a.decidedAt || ''],
  );
  return r.lastID!;
}

export async function updateApproval(id: number, patch: Partial<Pick<ApprovalRecord, 'status' | 'decidedBy' | 'rejectReason' | 'decidedAt'>>): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.status !== undefined) { sets.push('status=?'); params.push(patch.status); }
  if (patch.decidedBy !== undefined) { sets.push('decided_by=?'); params.push(patch.decidedBy); }
  if (patch.rejectReason !== undefined) { sets.push('reject_reason=?'); params.push(patch.rejectReason); }
  if (patch.decidedAt !== undefined) { sets.push('decided_at=?'); params.push(patch.decidedAt); }
  if (sets.length === 0) return;
  params.push(id);
  await run(`UPDATE tool_approvals SET ${sets.join(',')} WHERE id=?`, params);
}

export async function getApprovalById(id: number): Promise<ApprovalRecord | undefined> {
  const r = await get<any>('SELECT * FROM tool_approvals WHERE id=?', [id]);
  if (!r) return undefined;
  return {
    id: r.id,
    toolName: r.tool_name,
    projectId: r.project_id,
    status: r.status,
    decidedBy: r.decided_by,
    rejectReason: r.reject_reason,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

export async function listApprovals(status?: string): Promise<ApprovalRecord[]> {
  const rows = await all<any>(
    status ? `SELECT * FROM tool_approvals WHERE status=? ORDER BY id DESC` : `SELECT * FROM tool_approvals ORDER BY id DESC`,
    status ? [status] : [],
  );
  return rows.map(r => ({
    id: r.id,
    toolName: r.tool_name,
    projectId: r.project_id,
    status: r.status,
    decidedBy: r.decided_by,
    rejectReason: r.reject_reason,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }));
}

// ── tool_monitoring ──

export async function insertMetric(m: Omit<ToolMetric, 'id' | 'createdAt'>): Promise<void> {
  await run(
    `INSERT INTO tool_monitoring (tool_name, status, latency_ms, user_negative, source) VALUES (?,?,?,?,?)`,
    [m.toolName, m.status, m.latencyMs, m.userNegative, m.source || 'community'],
  );
}

export async function queryMetricStats(toolName: string, hours = 24 * 7): Promise<{
  toolName: string; errors: number; timeouts: number; total: number; avgLatencyMs: number; negativeCount: number;
}> {
  const rows = await all<any>(
    `SELECT * FROM tool_monitoring WHERE tool_name=? AND created_at >= datetime('now', ?)`,
    [toolName, `-${hours} hours`],
  );
  const errors = rows.filter(r => r.status === 'error').length;
  const timeouts = rows.filter(r => r.status === 'timeout').length;
  const total = rows.length;
  const avgLatencyMs = total > 0 ? Math.round(rows.reduce((s, r) => s + r.latency_ms, 0) / total) : 0;
  const negativeCount = rows.filter(r => r.user_negative > 0).length;
  return { toolName, errors, timeouts, total, avgLatencyMs, negativeCount };
}

export async function listMetricSummary(): Promise<Array<{ toolName: string; errors: number; timeouts: number; avgLatencyMs: number }>> {
  const rows = await all<any>(
    `SELECT tool_name, SUM(status='error') AS errors, SUM(status='timeout') AS timeouts, AVG(latency_ms) AS avg
     FROM tool_monitoring GROUP BY tool_name ORDER BY errors DESC`,
  );
  return rows.map(r => ({
    toolName: r.tool_name,
    errors: Number(r.errors) || 0,
    timeouts: Number(r.timeouts) || 0,
    avgLatencyMs: Math.round(Number(r.avg) || 0),
  }));
}

// ── skills_audit ──

export async function appendAudit(action: string, subject: string, detail = ''): Promise<number> {
  try {
    const r = await run('INSERT INTO skills_audit (action, subject, detail) VALUES (?,?,?)', [action, subject, detail]);
    return r.lastID!;
  } catch (e: any) {
    logger.warn(`[SkillsAudit] 写入失败: ${e.message}`);
    return 0;
  }
}

export async function listAudit(limit = 100): Promise<SkillsAuditEntry[]> {
  const rows = await all<any>('SELECT * FROM skills_audit ORDER BY id DESC LIMIT ?', [limit]);
  return rows.map(r => ({
    id: r.id,
    action: r.action,
    subject: r.subject,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

// ── mcp_skill_store（技能库：元数据/来源/风险标记/成功率统计） ──

function mapSkillStoreRow(r: any): import('./types').SkillStoreEntry {
  return {
    id: r.id,
    toolName: r.tool_name,
    version: r.version,
    source: r.source,
    origin: r.origin,
    riskLevel: r.risk_level,
    securityLevel: r.security_level,
    complianceDomain: r.compliance_domain,
    needsCredential: !!r.needs_credential,
    status: r.status,
    successCount: r.success_count,
    failCount: r.fail_count,
    totalCalls: r.total_calls,
    successRate: Number(r.success_rate) || 0,
    metadata: r.metadata || '{}',
    installedAt: r.installed_at,
    updatedAt: r.updated_at,
  };
}

export async function upsertSkillStoreEntry(e: {
  toolName: string; version: string; source: string; origin: string; riskLevel: string;
  securityLevel: string; complianceDomain: string; needsCredential: boolean; metadata: string;
}): Promise<void> {
  await run(
    `INSERT INTO mcp_skill_store (tool_name, version, source, origin, risk_level, security_level, compliance_domain, needs_credential, metadata)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tool_name) DO UPDATE SET
       version=excluded.version, source=excluded.source, origin=excluded.origin,
       risk_level=excluded.risk_level, security_level=excluded.security_level,
       compliance_domain=excluded.compliance_domain, needs_credential=excluded.needs_credential,
       metadata=excluded.metadata, updated_at=datetime('now')`,
    [e.toolName, e.version, e.source, e.origin, e.riskLevel, e.securityLevel, e.complianceDomain, e.needsCredential ? 1 : 0, e.metadata],
  );
}

export async function getSkillStoreEntry(toolName: string): Promise<import('./types').SkillStoreEntry | undefined> {
  const r = await get<any>('SELECT * FROM mcp_skill_store WHERE tool_name=?', [toolName]);
  return r ? mapSkillStoreRow(r) : undefined;
}

export async function listSkillStoreEntries(status?: string): Promise<import('./types').SkillStoreEntry[]> {
  const rows = await all<any>(
    status ? `SELECT * FROM mcp_skill_store WHERE status=? ORDER BY id DESC` : `SELECT * FROM mcp_skill_store ORDER BY id DESC`,
    status ? [status] : [],
  );
  return rows.map(mapSkillStoreRow);
}

/** 未卸载的安装总数（全局限额熔断计数源） */
export async function countInstalledSkills(): Promise<number> {
  const r = await get<any>(`SELECT COUNT(*) AS n FROM mcp_skill_store WHERE status != 'uninstalled'`);
  return Number(r?.n) || 0;
}

export async function updateSkillStoreStatus(toolName: string, status: string): Promise<void> {
  await run(`UPDATE mcp_skill_store SET status=?, updated_at=datetime('now') WHERE tool_name=?`, [status, toolName]);
}

/** 单次调用结果增量回写（成功率统计） */
export async function updateSkillStoreStats(toolName: string, ok: boolean): Promise<void> {
  if (ok) {
    await run(
      `UPDATE mcp_skill_store SET success_count=success_count+1, total_calls=total_calls+1,
       success_rate=CAST(success_count+1 AS REAL)/(total_calls+1), updated_at=datetime('now') WHERE tool_name=?`,
      [toolName],
    );
  } else {
    await run(
      `UPDATE mcp_skill_store SET fail_count=fail_count+1, total_calls=total_calls+1,
       success_rate=CAST(success_count AS REAL)/(total_calls+1), updated_at=datetime('now') WHERE tool_name=?`,
      [toolName],
    );
  }
}

/** 全量覆盖统计（从 tool_monitoring 重算同步用） */
export async function setSkillStoreStats(toolName: string, total: number, okCount: number): Promise<void> {
  const fail = Math.max(0, total - okCount);
  await run(
    `UPDATE mcp_skill_store SET success_count=?, fail_count=?, total_calls=?,
     success_rate=?, updated_at=datetime('now') WHERE tool_name=?`,
    [okCount, fail, total, total > 0 ? okCount / total : 1.0, toolName],
  );
}

// ── 沙箱目录（模块3） ──

export function getSandboxRoot(): string {
  // 独立隔离目录 /sandbox_auto_mcp/ 位于数据根下（Docker 内 LUMI_DATA_DIR=/app → /app/sandbox_auto_mcp）
  const root = process.env.SANDBOX_MCP_DIR || path.join(getDataPath('.'), 'sandbox_auto_mcp');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

// 关闭连接（仅供进程退出/测试脚本调用；业务路径禁止调用 — 句柄生命周期归进程）
// 防重复关闭 + 经串行队列关闭（关闭操作排在所有在途语句之后执行，杜绝关闭与语句交错）
export function closeSkillsDb(): void {
  if (!db) return; // 已关闭/未打开 → 幂等返回，避免对已关闭句柄二次 close（SQLITE_MISUSE）
  const conn = db;
  db = null;
  dbOpen = false; // 句柄失效标记：后续 getDb/语句自动重开连接，避免 SQLITE_MISUSE
  enqueueOp(() => new Promise<void>((resolve) => {
    conn.close((err) => {
      if (err) logger.warn(`[SkillsDB] 关闭失败: ${err.message}`);
      resolve();
    });
  })).catch(() => {});
}
