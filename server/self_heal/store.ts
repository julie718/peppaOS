// 阶段二·自诊疗模块 — 独立持久化存储（self_heal.db）
// 隔离库：独立于 peppa.db / life.db，自检记录不污染业务数据。
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import type { SelfHealRecord, SelfHealReport } from './types';

const DB_REL = 'self_heal.db';
let db: sqlite3.Database | null = null;
let dbPath = '';

export function getSelfHealDbPath(): string {
  if (dbPath) return dbPath;
  dbPath = process.env.SELF_HEAL_DB_PATH || getDataPath(DB_REL);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dbPath;
}

function open(): sqlite3.Database {
  if (db) return db;
  db = new sqlite3.Database(getSelfHealDbPath());
  db.serialize(() => {
    db!.run(`CREATE TABLE IF NOT EXISTS self_heal_records (
      run_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      defect_count INTEGER DEFAULT 0,
      auto_repaired INTEGER DEFAULT 0,
      rollback_count INTEGER DEFAULT 0,
      health_score REAL DEFAULT 0,
      verdict TEXT DEFAULT 'healthy',
      summary TEXT DEFAULT ''
    )`);
    db!.run(`CREATE TABLE IF NOT EXISTS self_heal_defects (
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
    db!.run(`CREATE INDEX IF NOT EXISTS idx_defects_run ON self_heal_defects(run_id)`);
  });
  return db;
}

function all<T>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    open().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
  });
}

function get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
  return all<T>(sql, params).then(rows => rows[0]);
}

function run(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    open().run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
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
  if (db) { db.close(); db = null; }
}
