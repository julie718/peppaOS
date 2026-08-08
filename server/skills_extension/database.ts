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

function getDb(): sqlite3.Database {
  if (db) return db;
  // 【重构·校验修复】带回调构造：打开失败时错误进回调而非未捕获 'error' 事件
  db = new sqlite3.Database(DB_PATH, () => {});
  return db;
}

function run(sql: string, params: any[] = []): Promise<{ lastID?: number }> {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) reject(err); else resolve({ lastID: this.lastID });
    });
  });
}

function all<T>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows as T[]);
    });
  });
}

function get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row as T | undefined);
    });
  });
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
    `INSERT INTO sandbox_config (keyword, service_name, dir, main_source, tsc_iterations, tsc_passed, pending_reason, status)
     VALUES (?,?,?,?,?,?,?,?)`,
    [p.keyword, p.serviceName, p.dir, p.mainSource, p.tscIterations, p.tscPassed ? 1 : 0, p.pendingReason || '', p.status],
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
    `INSERT INTO tool_monitoring (tool_name, status, latency_ms, user_negative) VALUES (?,?,?,?)`,
    [m.toolName, m.status, m.latencyMs, m.userNegative],
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

// ── 沙箱目录（模块3） ──

export function getSandboxRoot(): string {
  // 独立隔离目录 /sandbox_auto_mcp/ 位于数据根下（Docker 内 LUMI_DATA_DIR=/app → /app/sandbox_auto_mcp）
  const root = process.env.SANDBOX_MCP_DIR || path.join(getDataPath('.'), 'sandbox_auto_mcp');
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

export function closeSkillsDb(): void {
  if (db) { db.close(); db = null; }
}
