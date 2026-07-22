// 数字生命体 — 状态持久化基础设施
// SQLite 数据库：人格、情绪、欲望、反思、交互记忆、关系度量、系统事件
import sqlite3 from 'sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.LIFE_DB_PATH || '/app/data/life.db';
const BACKUP_DIR = path.dirname(DB_PATH);

let db: sqlite3.Database | null = null;

// ── 数据库连接（带错误重试） ──
export function getLifeDb(): sqlite3.Database {
  if (db) return db;
  db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('[LifeDB] 连接失败:', err.message);
    else console.log('[LifeDB] 已连接:', DB_PATH);
  });
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  db.run('PRAGMA busy_timeout=5000');
  return db;
}

function retry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  return fn().catch(err => {
    if (maxRetries > 0) {
      console.warn(`[LifeDB] 重试 (剩余${maxRetries}次):`, err.message);
      return retry(fn, maxRetries - 1);
    }
    throw err;
  });
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
      id INTEGER PRIMARY KEY CHECK (id = 1),
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    name: 'relationship_state',
    sql: `CREATE TABLE IF NOT EXISTS relationship_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
];

// ── 自动迁移 ──
export async function migrateLifeTables(): Promise<{ success: boolean; tables: string[]; errors: string[] }> {
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

  console.log(`[LifeDB] 迁移完成: ${created.length} 张表, ${errors.length} 个错误`);
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

async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
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
}

// ── run/get 封装 ──
function run(sql: string, params: any[] = []): Promise<sqlite3.RunResult> {
  return retry(() => new Promise((resolve, reject) => {
    getLifeDb().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  }));
}

function get<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  return retry(() => new Promise((resolve, reject) => {
    getLifeDb().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve((row as T) || null);
    });
  }));
}

function all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return retry(() => new Promise((resolve, reject) => {
    getLifeDb().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  }));
}

// ═══════════════════════════════════════════════
// CRUD 操作
// ═══════════════════════════════════════════════

// ── Personality ──
export async function getPersonality(): Promise<any | null> {
  return get('SELECT * FROM personality ORDER BY id DESC LIMIT 1');
}

export async function updatePersonality(vector: number[]): Promise<number> {
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
  await run('UPDATE emotions SET intensity=MAX(0, intensity-0.03), updated_at=datetime("now") WHERE intensity > 0 AND created_at < datetime("now","-1 hour")');
  await run('DELETE FROM emotions WHERE intensity < 0.03');
}

export async function saveEmotionVector(vector: number[]): Promise<void> {
  const json = JSON.stringify(vector);
  await run(
    'INSERT OR REPLACE INTO emotion_state (id, vector_json, updated_at) VALUES (1, ?, datetime("now"))',
    [json]
  );
}

export async function loadEmotionVector(): Promise<number[] | null> {
  const row = await get<{ vector_json: string }>('SELECT vector_json FROM emotion_state WHERE id = 1');
  if (!row) return null;
  try {
    const v = JSON.parse(row.vector_json);
    if (Array.isArray(v) && v.length === 8) return v;
  } catch {}
  return null;
}

// ── Desires ──
export async function addDesire(text: string, priority: number, source = 'intrinsic'): Promise<number> {
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
  await run('UPDATE desires SET priority=MAX(0,MIN(1,priority+?)), updated_at=datetime("now") WHERE id=?', [delta, id]);
}

export async function updateDesireStatus(id: number, status: string): Promise<void> {
  await run('UPDATE desires SET status=?, updated_at=datetime("now") WHERE id=?', [status, id]);
}

export async function completeDesire(id: number, result = ''): Promise<void> {
  const extra = result ? ', desire_text=desire_text || ?' : '';
  const params: any[] = result ? ['completed', id, ` [完成: ${result}]`] : ['completed', id];
  await run(`UPDATE desires SET status=?, updated_at=datetime("now")${extra} WHERE id=?`, params);
}

export async function abandonDesire(id: number, reason = ''): Promise<void> {
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
    const database = getLifeDb();

    await new Promise<void>((resolve, reject) => {
      database.run(`VACUUM INTO '${backupPath}'`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

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
export async function saveRelationshipVector(vector: number[]): Promise<void> {
  const json = JSON.stringify(vector);
  await run(
    'INSERT OR REPLACE INTO relationship_state (id, vector_json, updated_at) VALUES (1, ?, datetime("now"))',
    [json]
  );
}

export async function loadRelationshipVector(): Promise<number[] | null> {
  const row = await get<{ vector_json: string }>('SELECT vector_json FROM relationship_state WHERE id = 1');
  if (!row) return null;
  try {
    const v = JSON.parse(row.vector_json);
    if (Array.isArray(v) && v.length === 4) return v;
  } catch {}
  return null;
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

// ── 关闭连接 ──
export function closeLifeDb(): void {
  if (db) {
    db.close((err) => {
      if (err) console.error('[LifeDB] 关闭失败:', err.message);
      else console.log('[LifeDB] 已关闭');
    });
    db = null;
  }
}
