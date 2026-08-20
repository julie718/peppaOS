// Versioned database migrations — replaces the old silently-failing ALTER TABLE approach
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../lib/logger';
import { getDataPath } from '../config/data_path';
import { recordMigrationFailure, clearMigrationFailure } from './migrationState';

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  { version: 1, description: 'Add phone to users', sql: `ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''` },
  { version: 2, description: 'Add status to agents', sql: `ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'active'` },
  { version: 3, description: 'Add role to interactions', sql: `ALTER TABLE interactions ADD COLUMN role TEXT DEFAULT ''` },
  { version: 4, description: 'Add personality to interactions', sql: `ALTER TABLE interactions ADD COLUMN personality TEXT DEFAULT ''` },
  { version: 5, description: 'Add mode to interactions', sql: `ALTER TABLE interactions ADD COLUMN mode TEXT DEFAULT ''` },
  { version: 6, description: 'Add toolCalls to interactions', sql: `ALTER TABLE interactions ADD COLUMN toolCalls TEXT DEFAULT ''` },
  { version: 7, description: 'Add conversationId to interactions', sql: `ALTER TABLE interactions ADD COLUMN conversationId TEXT DEFAULT ''` },
  { version: 8, description: 'Add agent framework columns', sql: `ALTER TABLE agents ADD COLUMN personalityId TEXT DEFAULT 'peppa'` },
  { version: 9, description: 'Add modelPreference to agents', sql: `ALTER TABLE agents ADD COLUMN modelPreference TEXT DEFAULT ''` },
  { version: 10, description: 'Add memoryScope to agents', sql: `ALTER TABLE agents ADD COLUMN memoryScope TEXT DEFAULT 'shared'` },
  { version: 11, description: 'Add autonomyLevel to agents', sql: `ALTER TABLE agents ADD COLUMN autonomyLevel TEXT DEFAULT 'reactive'` },
  { version: 12, description: 'Add runtimeConfig to agents', sql: `ALTER TABLE agents ADD COLUMN runtimeConfig TEXT DEFAULT '{}'` },
  { version: 13, description: 'Add agentId to memories', sql: `ALTER TABLE memories ADD COLUMN agentId TEXT DEFAULT ''` },
  { version: 14, description: 'Add location to memories', sql: `ALTER TABLE memories ADD COLUMN location TEXT DEFAULT ''` },
  { version: 15, description: 'Add domain to memories', sql: `ALTER TABLE memories ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 16, description: 'Add orgId to memories', sql: `ALTER TABLE memories ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 17, description: 'Add domain to interactions', sql: `ALTER TABLE interactions ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 18, description: 'Add orgId to interactions', sql: `ALTER TABLE interactions ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 19, description: 'Add domain to agents', sql: `ALTER TABLE agents ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 20, description: 'Add orgId to agents', sql: `ALTER TABLE agents ADD COLUMN orgId TEXT DEFAULT ''` },
  { version: 21, description: 'Create memories table', sql: `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0.5,
    sourceInteractionId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    lastRetrievedAt TEXT, retrieveCount INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'episodic', perspective TEXT NOT NULL DEFAULT 'owner_trait',
    importance REAL NOT NULL DEFAULT 0.3, parentId TEXT, agentId TEXT DEFAULT '',
    nodeType TEXT NOT NULL DEFAULT 'leaf', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT ''
  )` },
  { version: 22, description: 'Add tier to memories', sql: `ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'` },
  { version: 23, description: 'Add perspective to memories', sql: `ALTER TABLE memories ADD COLUMN perspective TEXT NOT NULL DEFAULT 'owner_trait'` },
  { version: 24, description: 'Add importance to memories', sql: `ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.3` },
  { version: 25, description: 'Add parentId to memories', sql: `ALTER TABLE memories ADD COLUMN parentId TEXT` },
  { version: 26, description: 'Add nodeType to memories', sql: `ALTER TABLE memories ADD COLUMN nodeType TEXT NOT NULL DEFAULT 'leaf'` },
  { version: 27, description: 'Create token_usage table', sql: `CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    promptTokens INTEGER NOT NULL, completionTokens INTEGER NOT NULL, totalTokens INTEGER NOT NULL,
    mode TEXT DEFAULT 'chat', interactionId TEXT DEFAULT '', timestamp TEXT NOT NULL
  )` },
  { version: 28, description: 'Add cognitiveIntent to interactions', sql: `ALTER TABLE interactions ADD COLUMN cognitiveIntent TEXT DEFAULT ''` },
  { version: 29, description: 'Add llmWasCalled to interactions', sql: `ALTER TABLE interactions ADD COLUMN llmWasCalled INTEGER DEFAULT 0` },
  { version: 31, description: 'Create contacts table', sql: `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL,
    relationship TEXT DEFAULT 'other', tags TEXT DEFAULT '[]',
    notes TEXT DEFAULT '', traits TEXT DEFAULT '', preferences TEXT DEFAULT '',
    lastContacted TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )` },
  { version: 30, description: 'Create reminders table', sql: `CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, content TEXT NOT NULL, dueAt TEXT,
    status TEXT NOT NULL DEFAULT 'pending', sourceInteractionId TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL, firedAt TEXT
  )` },
  { version: 32, description: 'Create canvas_sessions table', sql: `CREATE TABLE IF NOT EXISTS canvas_sessions (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    cards TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]',
    taskText TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  )` },
  { version: 33, description: 'Add edges to canvas_sessions', sql: `ALTER TABLE canvas_sessions ADD COLUMN edges TEXT NOT NULL DEFAULT '[]'` },
  { version: 34, description: 'Add domain to canvas_sessions', sql: `ALTER TABLE canvas_sessions ADD COLUMN domain TEXT DEFAULT 'personal'` },
  { version: 35, description: 'Add orgId to canvas_sessions', sql: `ALTER TABLE canvas_sessions ADD COLUMN orgId TEXT DEFAULT ''` },
  // ── Phase2 模块4：长期记忆权重衰减 ──
  // score：记忆权重（0-1，默认 1.0 满权重；高权重记忆完整保留不受衰减影响）
  // hibernated：休眠标记（0=活跃 1=休眠；权重衰减到阈值后标记休眠，不再参与日常对话召回，
  //             数据库记录保留，后台接口可查询 —— 铁则1：绝不物理删除业务记忆数据）
  // hibernated_at：休眠时间
  // blur_summary：摘要模糊化后的梗概（普通日常琐事细节做摘要模糊压缩，保留核心梗概；记录不删除）
  { version: 36, description: 'Add score to memories', sql: `ALTER TABLE memories ADD COLUMN score REAL NOT NULL DEFAULT 1.0` },
  { version: 37, description: 'Add hibernated to memories', sql: `ALTER TABLE memories ADD COLUMN hibernated INTEGER NOT NULL DEFAULT 0` },
  { version: 38, description: 'Add hibernatedAt to memories', sql: `ALTER TABLE memories ADD COLUMN hibernatedAt TEXT` },
  { version: 39, description: 'Add blurSummary to memories', sql: `ALTER TABLE memories ADD COLUMN blurSummary TEXT` },
];

// Indexes are safe to create repeatedly
export const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_interactions_user_conv ON interactions(userId, conversationId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_type_tier ON memories(userId, type, tier)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(userId, agentId)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_parent ON memories(userId, parentId)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_status ON conversations(userId, status)`,
  `CREATE INDEX IF NOT EXISTS idx_token_usage_user_ts ON token_usage(userId, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_user_domain ON memories(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_user_domain ON interactions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_interactions_org ON interactions(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_user_domain ON agents(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(orgId, userId)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user ON canvas_sessions(userId)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user_domain ON canvas_sessions(userId, domain)`,
  `CREATE INDEX IF NOT EXISTS idx_canvas_sessions_org ON canvas_sessions(orgId, userId)`,
];

export interface MigrationRunResult {
  ok: boolean;                 // false = 存在失败迁移（调用方必须 fail-fast，铁则5）
  applied: number[];           // 本次成功应用的版本号列表
  failedVersion?: number;      // 失败版本（ok=false 时有值）
  error?: string;              // 失败错误信息（完整堆栈保留在服务日志，铁则3）
  backupPath: string | null;   // 迁移前备份文件路径（VACUUM INTO，回滚可用）
}

/**
 * 执行版本化迁移（Phase2 模块7 铁则5 硬化）：
 *   1) 迁移前自动备份：VACUUM INTO data/db_archive/pre-migration-v<next>.db
 *      （SQLite 安全快照，回滚/人工修复的数据底座）；
 *   2) 每条迁移独立事务执行（BEGIN IMMEDIATE → SQL → COMMIT / 失败 ROLLBACK），
 *      失败不残留半迁移状态；
 *   3) 幂等容错：duplicate column / already exists / no such table 视为已应用，
 *      记录版本继续（兼容旧版 ad-hoc ALTER 的存量库）；
 *   4) 真实失败：停止后续迁移 → 写失败标记（migrationState）→ 返回 ok=false，
 *      调用方 fail-fast（进程退出非零，容器绝不带残缺 schema 服务，回滚上一容器）。
 */
export function runMigrations(db: sqlite3.Database): Promise<MigrationRunResult> {
  return new Promise((resolve) => {
    // Create version table
    db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`, () => {
      db.get(`SELECT MAX(version) as current FROM schema_version`, (err, row: any) => {
        const current = row?.current || 0;
        const pending = MIGRATIONS.filter(m => m.version > current);
        const applied: number[] = [];
        let backupPath: string | null = null;

        if (pending.length === 0) {
          // 无待迁移 → 清除历史失败标记（上次失败已被修复/回滚），正常放行
          clearMigrationFailure();
          resolve({ ok: true, applied, backupPath });
          return;
        }

        // 迁移前自动备份（失败则拒绝继续迁移：宁可回滚容器也不在无备份下动 schema）
        const nextVersion = pending[0].version;
        try {
          const archiveDir = path.join(getDataPath(''), 'db_archive');
          fs.mkdirSync(archiveDir, { recursive: true });
          backupPath = path.join(archiveDir, `pre-migration-v${nextVersion}.db`);
          db.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`, (bakErr: Error | null) => {
            if (bakErr) {
              // 备份失败 → 迁移前失败处理（铁则5：不启动新版本）
              const msg = `迁移前备份失败（VACUUM INTO ${backupPath}）: ${bakErr?.message || bakErr}`;
              logger.error(`[Migration] ${msg}`);
              recordMigrationFailure(nextVersion, msg, null);
              resolve({ ok: false, applied, failedVersion: nextVersion, error: msg, backupPath: null });
              return;
            }
            logger.info(`[Migration] 迁移前备份完成: ${backupPath}`);
            applyNext(0);
          });
        } catch (e: any) {
          const msg = `迁移前备份失败: ${e?.message || String(e)}`;
          logger.error(`[Migration] ${msg}`);
          recordMigrationFailure(nextVersion, msg, null);
          resolve({ ok: false, applied, failedVersion: nextVersion, error: msg, backupPath: null });
          return;
        }

        function applyNext(i: number) {
          if (i >= pending.length) {
            // 全部成功 → 清除失败标记（若曾失败并被回滚修复）
            clearMigrationFailure();
            resolve({ ok: true, applied, backupPath });
            return;
          }
          const m = pending[i];
          // 每条迁移独立事务：失败 ROLLBACK 不残留半迁移状态
          db.run('BEGIN IMMEDIATE', (beginErr) => {
            if (beginErr) {
              finishFail(m.version, `开启事务失败: ${beginErr?.message || beginErr}`);
              return;
            }
            db.run(m.sql, (runErr) => {
              if (runErr) {
                // 幂等容错：列/表已存在（旧库已 ad-hoc 应用过）→ 视为已应用，回滚空事务后继续
                const msg = runErr?.message || String(runErr);
                if (msg.includes('duplicate column') || msg.includes('already exists') || msg.includes('no such table')) {
                  db.run('ROLLBACK', () => {
                    db.run(`INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)`, [m.version, new Date().toISOString()], () => {
                      applyNext(i + 1);
                    });
                  });
                  return;
                }
                // 真实失败：回滚 → 记录失败标记 → 停止后续迁移（铁则5）
                db.run('ROLLBACK', () => finishFail(m.version, `执行失败: ${msg}`));
                return;
              }
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  db.run('ROLLBACK', () => finishFail(m.version, `提交事务失败: ${commitErr?.message || commitErr}`));
                  return;
                }
                db.run(`INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (?, ?)`, [m.version, new Date().toISOString()], () => {
                  applied.push(m.version);
                  logger.info(`[Migration v${m.version}] ${m.description}`);
                  applyNext(i + 1);
                });
              });
            });
          });
        }

        function finishFail(version: number, error: string) {
          logger.error(`[Migration v${version}] ${error}`);
          recordMigrationFailure(version, error, backupPath);
          resolve({ ok: false, applied, failedVersion: version, error, backupPath });
        }
      });
    });
  });
}

export function createIndexes(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => {
    function applyNext(i: number) {
      if (i >= INDEXES.length) { resolve(); return; }
      db.run(INDEXES[i], () => applyNext(i + 1));
    }
    applyNext(0);
  });
}
