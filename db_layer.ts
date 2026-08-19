import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { getDataPath, getDataRoot } from './server/config/data_path';

// Auto-migrate data from old location (project directory) to user directory on first run
function migrateDataFromOldLocation() {
  const oldDir = path.join(process.cwd(), 'data');
  const newDir = path.join(getDataRoot(), 'data');
  if (!fs.existsSync(oldDir)) return;
  if (fs.existsSync(newDir)) {
    const files = fs.readdirSync(newDir).filter(f => f !== '.gitkeep');
    if (files.length > 0) return; // already has data, skip
  }
  console.log('[Data] Migrating from', oldDir, 'to', newDir);
  try {
    fs.mkdirSync(newDir, { recursive: true });
    for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
      const src = path.join(oldDir, entry.name);
      const dest = path.join(newDir, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    console.log('[Data] Migration complete —', newDir);
  } catch (err) {
    console.warn('[Data] Migration failed (non-fatal):', (err as Error).message);
  }
}
migrateDataFromOldLocation();

const DB_PATH = getDataPath('peppa.db');

let db: sqlite3.Database | null = null;
let dbOpen = false;
let memoryDB: any = null;
const SYSTEM_FLAGS_SETTING = '__lumi_system_flags';
const SYSTEM_SNAPSHOTS_SETTING = '__lumi_system_snapshots';

// ═══════════════════════════════════════════════════════════════════
// SQLite 并发安全层（本文件全部数据库操作的唯一入口）
// 1) 串行任务队列：任意时刻仅一个 SQLite 操作在执行，杜绝多异步流语句/事务交错
// 2) 打开连接自动生效 PRAGMA：WAL + synchronous=NORMAL + busy_timeout（无需人工执行 sqlite 命令）
// 3) SQLITE_BUSY：有限次数指数退避重试，抛异常前充分重试
// 4) 连接健康校验：句柄关闭/异常 → 自动重开连接并重试，避免句柄关闭后继续调用导致 FATAL
// ═══════════════════════════════════════════════════════════════════
const BUSY_MAX_ATTEMPTS = 6;   // 含首次在内最多尝试次数（句柄重开与 BUSY 重试共用此上限）
const BUSY_BASE_DELAY_MS = 50; // 指数退避基数：50 → 100 → 200 → 400 → 800ms
const PRAGMAS: string[] = [
  'PRAGMA journal_mode=WAL',   // WAL：读写互不阻塞，从根源降低锁竞争
  'PRAGMA synchronous=NORMAL', // 与 WAL 搭配的推荐持久性级别
  'PRAGMA busy_timeout=5000',  // 驱动内部锁等待上限
  'PRAGMA foreign_keys = ON',
  // P1-1 锁竞争优化：页缓存放大到 20MB（负值=KiB），减少热点表页的重复读盘；
  // wal_autocheckpoint 提到 5000 页（≈20MB）→ checkpoint 触发频率降低，
  // 写事务持锁窗口更短，配合增量持久化（大部分表跳过）从根源缓解 SQLITE_BUSY
  'PRAGMA cache_size=-20000',
  'PRAGMA wal_autocheckpoint=5000',
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

let pragmaPromise: Promise<void> | null = null;

/** 自动应用连接 PRAGMA（幂等；句柄重开后自动重新应用） */
function ensurePragmas(conn: sqlite3.Database): Promise<void> {
  if (!pragmaPromise) {
    pragmaPromise = new Promise<void>((resolve, reject) => {
      const runNext = (i: number) => {
        if (i >= PRAGMAS.length) { resolve(); return; }
        conn.run(PRAGMAS[i], (err) => (err ? reject(err) : runNext(i + 1)));
      };
      runNext(0);
    }).catch((err) => {
      pragmaPromise = null; // 失败允许下次重试
      throw err;
    });
  }
  return pragmaPromise;
}

// 打开模式：READWRITE | CREATE | FULLMUTEX（FULLMUTEX = SQLite serialized 串行模式，
// 任意时刻仅一个线程访问连接，适配多线程/多调度任务并发访问）
const OPEN_FLAGS = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;

/** 打开（或重开）连接；句柄异常后再次调用自动创建新句柄 */
function openDb(): sqlite3.Database {
  // 单例复用：连接对象一旦创建即返回（无论 open 是否完成——语句在驱动队列中等 open 后执行）。
  // 若以 open 完成作为复用条件，首波并发下每个调用方都会各自 new 句柄，违背单例目标。
  if (db) return db;
  // serialized 串行模式（OPEN_FULLMUTEX）+ 带回调构造：打开失败时错误进回调而非未捕获 'error' 事件
  const conn = new sqlite3.Database(DB_PATH, OPEN_FLAGS, (err) => {
    if (err) {
      console.error('[DB] 连接失败:', err.message);
      if (db === conn) { dbOpen = false; db = null; }
    } else {
      if (db === conn) dbOpen = true;
    }
  });
  conn.on('error', (err) => {
    // 无回调语句的错误会以 'error' 事件抛出 → 不注册监听器会直接 FATAL。
    // 这里记录并标记句柄失效，后续操作自动重连。
    if (db !== conn) return; // 旧句柄迟到事件，不影响新句柄
    console.warn('[DB] sqlite3 error 事件（自动重连）:', (err as any)?.message ?? err);
    dbOpen = false;
    db = null;
    pragmaPromise = null;
  });
  db = conn;
  pragmaPromise = null; // 新句柄需重新应用 PRAGMA
  return conn;
}

// 串行任务队列：同一时刻仅允许一个 SQLite 操作执行。
// 可重入：事务体（BEGIN…COMMIT 整体）作为单个队列任务，其内部语句直接执行（不死锁），
// 外部并发请求排队等待整个事务结束后再执行，从根源杜绝事务/语句交错。
let opQueue: Promise<unknown> = Promise.resolve();
let inQueue = 0;

function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
  if (inQueue > 0) return fn(); // 已持有串行槽位（事务体内部）→ 直接执行
  const runner = () => {
    inQueue++;
    return fn().finally(() => { inQueue--; });
  };
  const next = opQueue.then(runner, runner);
  opQueue = next.catch(() => {});
  return next;
}

/**
 * 语句执行统一外壳：BUSY 指数退避重试 + 句柄关闭自动重开。
 * 抛错前最多 BUSY_MAX_ATTEMPTS 次尝试（含句柄重开），充分重试后才放行异常。
 */
async function execWithRetry<T>(fn: (conn: sqlite3.Database) => Promise<T>, opName: string): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < BUSY_MAX_ATTEMPTS; attempt++) {
    const conn = openDb();
    await ensurePragmas(conn);
    try {
      return await fn(conn);
    } catch (err) {
      lastErr = err;
      if (isClosedHandleError(err)) {
        console.warn(`[DB] ${opName} 句柄异常（${(err as any)?.message ?? err}），重开连接后重试`);
        dbOpen = false;
        db = null;
        pragmaPromise = null;
        continue;
      }
      if (isBusyError(err) && attempt < BUSY_MAX_ATTEMPTS - 1) {
        const delay = BUSY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(`[DB] ${opName} database locked，${delay}ms 后重试（${attempt + 1}/${BUSY_MAX_ATTEMPTS - 1}）`);
        await sleep(delay);
        continue;
      }
      // 重试耗尽：日志降级后抛出，由调用方/全局兜底处理，不静默吞错
      console.error(`[DB] ${opName} 执行失败（已充分重试）:`, (err as any)?.message ?? err);
      throw err;
    }
  }
  console.error(`[DB] ${opName} 执行失败（${BUSY_MAX_ATTEMPTS} 次尝试均未成功）:`, (lastErr as any)?.message ?? lastErr);
  throw lastErr;
}

function parseJsonSetting<T>(settings: any[], key: string, fallback: T): T {
  const row = settings.find((s: any) => s.key === key);
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function settingsRowsWithSystemState(): any[][] {
  const settings = Array.isArray(memoryDB?.settings) ? memoryDB.settings : [];
  const rows = settings
    .filter((s: any) => s?.key !== SYSTEM_FLAGS_SETTING && s?.key !== SYSTEM_SNAPSHOTS_SETTING)
    .map((s: any) => [s.key, s.value]);

  if (memoryDB?.systemFlags && Object.keys(memoryDB.systemFlags).length > 0) {
    rows.push([SYSTEM_FLAGS_SETTING, JSON.stringify(memoryDB.systemFlags)]);
  }

  if (Array.isArray(memoryDB?.systemSnapshots) && memoryDB.systemSnapshots.length > 0) {
    rows.push([SYSTEM_SNAPSHOTS_SETTING, JSON.stringify(memoryDB.systemSnapshots.slice(-120))]);
  }

  return rows;
}

export async function initDatabase(): Promise<void> {
  const conn = openDb();
  await ensurePragmas(conn); // 启动即自动生效 WAL / synchronous=NORMAL（无需人工执行 sqlite 命令）
  await createTables();
  await migrateSchema();
  await loadMemoryDB();
  // P0-1: 加载态即持久态 —— 填充指纹后启动期 flushDB 的比对全部命中，零 SQL
  seedPersistedFingerprints();
  // P2-4: 启动自动归档检查 + 例行定时器（阈值 100MB，每天最多一次，VACUUM INTO）
  scheduleDatabaseArchive();
}

function onAlter(err: Error | null) {
  if (
    err &&
    !err.message.includes('duplicate column name') &&
    !err.message.includes('already exists') &&
    !err.message.includes('no such table')
  ) {
    console.warn('[DB] Schema migration error:', err.message);
  }
}

// Add missing columns to existing tables (safe on old DB)
function migrateSchema(): Promise<void> {
  return new Promise((resolve) => {
    db!.serialize(() => {
    // Add 'phone' column to users if it doesn't exist (old DB lacks it)
    db!.run("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''", onAlter);
    // Add 'status' column to agents if it doesn't exist
    db!.run("ALTER TABLE agents ADD COLUMN status TEXT DEFAULT 'active'", onAlter);
    // Add 'role' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN role TEXT DEFAULT ''", onAlter);
    // Add 'personality' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN personality TEXT DEFAULT ''", onAlter);
    // Add 'mode' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN mode TEXT DEFAULT ''", onAlter);
    // Add 'toolCalls' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN toolCalls TEXT DEFAULT ''", onAlter);
    // Add 'conversationId' column to interactions if it doesn't exist
    db!.run("ALTER TABLE interactions ADD COLUMN conversationId TEXT DEFAULT ''", onAlter);
    // Add agent framework columns
    db!.run("ALTER TABLE agents ADD COLUMN personalityId TEXT DEFAULT 'peppa'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN modelPreference TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN memoryScope TEXT DEFAULT 'shared'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN autonomyLevel TEXT DEFAULT 'reactive'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN runtimeConfig TEXT DEFAULT '{}'", onAlter);
    // Add runtime + externalCommand to agents
    db!.run("ALTER TABLE agents ADD COLUMN runtime TEXT DEFAULT 'internal'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN externalCommand TEXT DEFAULT ''", onAlter);
    // Add agentId to memories for agent-private memory
    db!.run("ALTER TABLE memories ADD COLUMN agentId TEXT DEFAULT ''", onAlter);
    // Add location to memories for spatial context
    db!.run("ALTER TABLE memories ADD COLUMN location TEXT DEFAULT ''", onAlter);
    // Org: domain + orgId for data classification
    db!.run("ALTER TABLE memories ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE agents ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Add domain + orgId to conversations for personal/work isolation
    db!.run("ALTER TABLE conversations ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE conversations ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Canvas sessions: persisted workbench state with personal/work isolation
    db!.run(`CREATE TABLE IF NOT EXISTS canvas_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      cards TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      taskText TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      domain TEXT DEFAULT 'personal',
      orgId TEXT DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`, onAlter);
    db!.run("ALTER TABLE canvas_sessions ADD COLUMN edges TEXT NOT NULL DEFAULT '[]'", onAlter);
    db!.run("ALTER TABLE canvas_sessions ADD COLUMN domain TEXT DEFAULT 'personal'", onAlter);
    db!.run("ALTER TABLE canvas_sessions ADD COLUMN orgId TEXT DEFAULT ''", onAlter);
    // Add memories table if it doesn't exist
    db!.run(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      sourceInteractionId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastRetrievedAt TEXT,
      retrieveCount INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'episodic',
      perspective TEXT NOT NULL DEFAULT 'owner_trait',
      importance REAL NOT NULL DEFAULT 0.3,
      parentId TEXT,
      agentId TEXT DEFAULT '',
      nodeType TEXT NOT NULL DEFAULT 'leaf',
      domain TEXT DEFAULT 'personal',
      orgId TEXT DEFAULT ''
    )`, onAlter);
    // Migrate: add new columns to existing memories table
    db!.run("ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN perspective TEXT NOT NULL DEFAULT 'owner_trait'", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.3", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN parentId TEXT", onAlter);
    db!.run("ALTER TABLE memories ADD COLUMN nodeType TEXT NOT NULL DEFAULT 'leaf'", onAlter);
    // Add token_usage table if it doesn't exist
    db!.run(`CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      promptTokens INTEGER NOT NULL,
      completionTokens INTEGER NOT NULL,
      totalTokens INTEGER NOT NULL,
      mode TEXT DEFAULT 'chat',
      interactionId TEXT DEFAULT '',
      timestamp TEXT NOT NULL
    )`, onAlter);
    // DeepSeek 外部强制路由：每次模型调用记录持久表（任务7 — 模型/来源类型/token/耗时/缓存命中/是否降级）
    db!.run(`CREATE TABLE IF NOT EXISTS llm_router_calls (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      scene TEXT NOT NULL DEFAULT '(none)',
      tier TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      promptTokens INTEGER NOT NULL DEFAULT 0,
      completionTokens INTEGER NOT NULL DEFAULT 0,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      cacheHitTokens INTEGER NOT NULL DEFAULT 0,
      cacheHit INTEGER NOT NULL DEFAULT 0,
      durationMs INTEGER NOT NULL DEFAULT 0,
      degraded INTEGER NOT NULL DEFAULT 0,
      error TEXT DEFAULT ''
    )`, onAlter);
    // Add cognitiveIntent and llmWasCalled columns to interactions
    db!.run("ALTER TABLE interactions ADD COLUMN cognitiveIntent TEXT DEFAULT ''", onAlter);
    db!.run("ALTER TABLE interactions ADD COLUMN llmWasCalled INTEGER DEFAULT 0", onAlter);
    // Add reminders table if it doesn't exist
    db!.run(`CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      content TEXT NOT NULL,
      dueAt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sourceInteractionId TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      firedAt TEXT
    )`, onAlter);
    // Indexes — safe to create repeatedly with IF NOT EXISTS
    db!.run(`CREATE INDEX IF NOT EXISTS idx_interactions_user_conv ON interactions(userId, conversationId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agentId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_memories_user_type_tier ON memories(userId, type, tier)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_memories_user_agent ON memories(userId, agentId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_memories_user_parent ON memories(userId, parentId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_conversations_user_status ON conversations(userId, status)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_token_usage_user_ts ON token_usage(userId, timestamp)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_memories_user_domain ON memories(userId, domain)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(orgId, userId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_interactions_user_domain ON interactions(userId, domain)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_interactions_org ON interactions(orgId, userId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_agents_user_domain ON agents(userId, domain)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(orgId, userId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_conversations_user_domain ON conversations(userId, domain)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(orgId, userId)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_canvas_sessions_user_domain ON canvas_sessions(userId, domain)`, onAlter);
    db!.run(`CREATE INDEX IF NOT EXISTS idx_canvas_sessions_org ON canvas_sessions(orgId, userId)`, onAlter);
      db!.run('SELECT 1', () => resolve());
    });
  });
}

function createTables(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sql = `
      CREATE TABLE IF NOT EXISTS users (
        uid TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        balance REAL DEFAULT 0,
        phone TEXT DEFAULT '',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        config TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        userId TEXT,
        status TEXT DEFAULT 'active',
        personalityId TEXT DEFAULT 'peppa',
        modelPreference TEXT DEFAULT '',
        memoryScope TEXT DEFAULT 'shared',
        autonomyLevel TEXT DEFAULT 'reactive',
        runtimeConfig TEXT DEFAULT '{}',
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        module TEXT,
        message TEXT NOT NULL,
        response TEXT,
        role TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        mode TEXT DEFAULT '',
        toolCalls TEXT DEFAULT '',
        conversationId TEXT DEFAULT '',
        cognitiveIntent TEXT DEFAULT '',
        llmWasCalled INTEGER DEFAULT 0,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketplace_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        author TEXT NOT NULL,
        price REAL NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        session_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS founder_vision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        agentId TEXT,
        title TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        summary TEXT DEFAULT '',
        messageCount INTEGER DEFAULT 0,
        lastActiveAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        domain TEXT DEFAULT 'personal',
        orgId TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS voice_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT NOT NULL,
        voiceId TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        promptTokens INTEGER NOT NULL,
        completionTokens INTEGER NOT NULL,
        totalTokens INTEGER NOT NULL,
        mode TEXT DEFAULT 'chat',
        interactionId TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        ownerUid TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        name TEXT NOT NULL,
        parentId TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_memberships (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        departmentId TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        invitedBy TEXT,
        joinedAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(orgId, userId)
      );

      CREATE TABLE IF NOT EXISTS org_invitations (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        createdBy TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        departmentId TEXT,
        maxUses INTEGER DEFAULT 0,
        useCount INTEGER DEFAULT 0,
        expiresAt TEXT,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_kb_articles (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '[]',
        authorId TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'published',
        viewCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS org_kb_embeddings (
        id TEXT PRIMARY KEY,
        articleId TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        content TEXT NOT NULL,
        modelName TEXT NOT NULL DEFAULT 'text-embedding-3-small',
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_templates (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        config TEXT NOT NULL,
        icon TEXT DEFAULT 'Bot',
        version INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'draft',
        authorId TEXT NOT NULL,
        reviewedBy TEXT,
        reviewComment TEXT,
        downloadCount INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        read INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        orgId TEXT NOT NULL,
        userId TEXT NOT NULL,
        action TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        ipAddress TEXT,
        userAgent TEXT,
        timestamp TEXT NOT NULL
      );
    `;

    // Canvas sessions — infinite canvas workbench
    db!.run(`CREATE TABLE IF NOT EXISTS canvas_sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      cards TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      taskText TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      domain TEXT DEFAULT 'personal',
      orgId TEXT DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);

    db!.exec(sql, (err) => {
      if (err) { reject(err); return; }
      insertInitialData().then(resolve).catch(reject);
    });
  });
}

async function insertInitialData(): Promise<void> {
  const tables = ['users', 'agents', 'interactions', 'marketplace_skills', 'skills', 'founder_vision'];
  const counts: { [table: string]: number } = {};

  for (const table of tables) {
    const count = await query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
    counts[table] = count[0]?.cnt ?? 0;
  }

  if (counts.users === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const now = new Date().toISOString();
    await run(
      `INSERT INTO users (uid, username, password, role, balance, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['admin-uid', 'admin', hashedPassword, 'admin', 1000, '', now]
    );
  }

  if (counts.marketplace_skills === 0) {
    const defaultSkills = [
      ['skill-1', '财务报表分析 LoRA', 'LumiNode_01', 50, '针对企业财务报表的深度微调权重，支持自动化对账与异常检测。', 'Finance'],
      ['skill-2', '创意剧本创作 LoRA', 'CreativeMind', 30, '专注于科幻与悬疑风格的剧本创作，具备极强的逻辑连贯性。', 'Creative'],
      ['skill-3', '医疗辅助诊断 LoRA', 'HealthGuard', 100, '基于公开医疗数据集微调，辅助识别常见病症与用药建议。', 'Medical']
    ];
    for (const skill of defaultSkills) {
      await run(`INSERT INTO marketplace_skills (id, name, author, price, description, category) VALUES (?, ?, ?, ?, ?, ?)`, skill);
    }
  }

  if (counts.skills === 0) {
    const coreSkills = [
      ['vision', 'Vision Core', 'Advanced image recognition and spatial awareness.'],
      ['logic', 'Logic Engine', 'Complex reasoning and mathematical problem solving.'],
      ['empathy', 'Empathy Module', 'Emotional intelligence and nuanced conversation.']
    ];
    for (const skill of coreSkills) {
      await run(`INSERT INTO skills (id, name, description) VALUES (?, ?, ?)`, skill);
    }
  }

  if (counts.founder_vision === 0) {
    await run(
      `INSERT INTO founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
      [1, 'LumiAI 旨在构建一个去中心化的智能协议。我们追求空间存在感、边缘计算与数据主权。通过分布式节点，每一个用户都能拥有真正属于自己的、可进化的数字生命。', new Date().toISOString()]
    );
  }
}

// Load database and map old column names to field names server.ts expects
async function loadMemoryDB(): Promise<void> {
  const users = await query<any>('SELECT * FROM users');
  const agentsRaw = await query<any>('SELECT * FROM agents');
  const interactionsRaw = await query<any>('SELECT * FROM interactions');
  const marketplaceSkills = await query<any>('SELECT * FROM marketplace_skills');
  const skills = await query<any>('SELECT * FROM skills');
  const founderVisionRow = await query<any>('SELECT content FROM founder_vision WHERE id = 1');
  const founderVision = founderVisionRow[0]?.content || '';

  // Load memories
  const memoriesRaw = await query<any>('SELECT * FROM memories');
  const memories = memoriesRaw.map((m: any) => ({
    ...m,
    keywords: m.keywords ? JSON.parse(m.keywords) : [],
  }));

  // Load reminders
  const remindersRaw = await query<any>('SELECT * FROM reminders');

  // Load conversations
  const conversationsRaw = await query<any>('SELECT * FROM conversations');
  const canvasSessionsRaw = await query<any>('SELECT * FROM canvas_sessions');

  // Load token usage
  const tokenUsageRaw = await query<any>('SELECT * FROM token_usage');

  // Load router call records (DeepSeek 外部强制路由 — 任务7)
  const llmRouterCallsRaw = await query<any>('SELECT * FROM llm_router_calls');

  // Load org tables
  const organizations = await query<any>('SELECT * FROM organizations');
  const departments = await query<any>('SELECT * FROM departments');
  const orgMemberships = await query<any>('SELECT * FROM org_memberships');
  const orgInvitations = await query<any>('SELECT * FROM org_invitations');
  const orgKbArticles = await query<any>('SELECT * FROM org_kb_articles');
  const orgKbEmbeddings = await query<any>('SELECT * FROM org_kb_embeddings');
  const agentTemplates = await query<any>('SELECT * FROM agent_templates');
  const notificationsRaw = await query<any>('SELECT * FROM notifications');
  const notifications = notificationsRaw.map((n: any) => ({
    ...n,
    read: !!n.read,
  }));
  const auditLogEntries = await query<any>('SELECT * FROM audit_log');

  // Load settings
  const settingsRaw = await query<any>('SELECT * FROM settings');
  const settings = settingsRaw.map((s: any) => ({ key: s.key, value: s.value }));
  const systemFlags = parseJsonSetting(settings, SYSTEM_FLAGS_SETTING, {});
  const systemSnapshots = parseJsonSetting<any[]>(settings, SYSTEM_SNAPSHOTS_SETTING, []);

  // Load voice profiles and reconstruct userId-keyed map
  const voiceProfilesRaw = await query<any>('SELECT * FROM voice_profiles');
  const voiceProfiles: Record<string, any[]> = {};
  for (const vp of voiceProfilesRaw) {
    if (!voiceProfiles[vp.userId]) voiceProfiles[vp.userId] = [];
    voiceProfiles[vp.userId].push({
      voiceId: vp.voiceId,
      name: vp.name,
      provider: vp.provider,
      createdAt: vp.createdAt,
    });
  }

  // Map old column names to the field names that server.ts expects
  const agents = agentsRaw.map((a: any) => ({
    ...a,
    ownerUid: a.userId || a.ownerUid,
    data: a.config || a.data || '{}',
    personalityId: a.personalityId || 'peppa',
    modelPreference: a.modelPreference || '',
    memoryScope: a.memoryScope || 'shared',
    autonomyLevel: a.autonomyLevel || 'reactive',
    runtimeConfig: a.runtimeConfig || '{}',
    domain: a.domain || 'personal',
    orgId: a.orgId || '',
  }));

  const interactions = interactionsRaw.map((i: any) => ({
    ...i,
    content: i.message || i.content || '',
    role: i.role || '',
    personality: i.personality || i.module || '',
    mode: i.mode || '',
    toolCalls: i.toolCalls ? JSON.parse(i.toolCalls) : undefined,
    conversationId: i.conversationId || '',
    cognitiveIntent: i.cognitiveIntent || '',
    llmWasCalled: i.llmWasCalled ? true : false,
    domain: i.domain || 'personal',
    orgId: i.orgId || '',
  }));

  memoryDB = {
    users,
    agents,
    interactions,
    marketplaceSkills,
    skills,
    founderVision,
    memories: (memories || []).map((m: any) => ({ ...m, domain: m.domain || 'personal', orgId: m.orgId || '' })),
    reminders: remindersRaw || [],
    conversations: (conversationsRaw || []).map((c: any) => ({ ...c, domain: c.domain || 'personal', orgId: c.orgId || '' })),
    canvas_sessions: (canvasSessionsRaw || []).map((s: any) => ({ ...s, edges: s.edges || '[]', domain: s.domain || 'personal', orgId: s.orgId || '' })),
    settings: settings || [],
    systemFlags: systemFlags || {},
    systemSnapshots: Array.isArray(systemSnapshots) ? systemSnapshots : [],
    voiceProfiles: voiceProfiles || {},
    tokenUsage: tokenUsageRaw || [],
    // DeepSeek 外部强制路由调用记录（列名恢复 camelCase）
    llmRouterCalls: (llmRouterCallsRaw || []).map((c: any) => ({
      id: c.id,
      ts: c.ts,
      scene: c.scene || '(none)',
      tier: c.tier,
      provider: c.provider,
      model: c.model,
      promptTokens: c.promptTokens || 0,
      completionTokens: c.completionTokens || 0,
      totalTokens: c.totalTokens || 0,
      cacheHitTokens: c.cacheHitTokens || 0,
      cacheHit: !!c.cacheHit,
      durationMs: c.durationMs || 0,
      degraded: !!c.degraded,
      error: c.error || undefined,
    })),
    organizations: organizations || [],
    departments: departments || [],
    orgMemberships: orgMemberships || [],
    orgInvitations: orgInvitations || [],
    orgKbArticles: orgKbArticles || [],
    orgKbEmbeddings: orgKbEmbeddings || [],
    agentTemplates: agentTemplates || [],
    notifications: notifications || [],
    auditLog: auditLogEntries || [],
  };
}

function run(sql: string, params: any[] = []): Promise<void> {
  return enqueueOp(() =>
    execWithRetry(
      (conn) =>
        new Promise<void>((resolve, reject) => {
          conn.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve();
          });
        }),
      'run',
    ),
  );
}

function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return enqueueOp(() =>
    execWithRetry(
      (conn) =>
        new Promise<T[]>((resolve, reject) => {
          conn.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows as T[]);
          });
        }),
      'query',
    ),
  );
}

export function readDB(): any {
  if (!memoryDB) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return memoryDB;
}

// Prune old entries from memory + SQLite to prevent unbounded growth
export function pruneOldData(): void {
  if (!memoryDB || !db) return;
  const limits: Record<string, number> = { interactions: 20000, memories: 5000, tokenUsage: 5000 };
  const tableMap: Record<string, string> = { interactions: 'interactions', memories: 'memories', tokenUsage: 'token_usage' };
  for (const [key, max] of Object.entries(limits)) {
    const arr = memoryDB[key];
    if (arr && arr.length > max) {
      const excess = arr.length - max;
      const removed = arr.splice(0, excess); // trim oldest entries
      try {
        for (const entry of removed) {
          const id = entry.id || entry.uid || entry.interactionId;
          if (id) run(`DELETE FROM ${tableMap[key]} WHERE id = ?`, [id]).catch(() => {});
        }
      } catch { /* best-effort, memory is already trimmed */ }
      console.log(`[DB] Pruned ${excess} old ${key} (${max} kept)`);
    }
  }
  dbDirty = true;
}

// Write lock to prevent concurrent SQLite transactions
let writeLock: Promise<void> = Promise.resolve();

let writeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function writeDB(data: any): void {
  if (!db) {
    throw new Error('Database not initialized.');
  }
  memoryDB = data;
  dbDirty = true;

  // Debounce persistence: batch rapid writes into a single SQLite flush
  // 窗口 100ms → 2000ms：InnerTick/IdleBrain 写风暴时合并为一次全量持久化，
  // 避免每次写都触发 100MB 级全表重建（内存峰值 + SQLite 写风暴）。
  if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(() => {
    writeDebounceTimer = null;
    const ready = writeLock.catch((err) => {
      console.error('[DB] Previous write failed:', err);
    });
    writeLock = ready
      .then(() => persistMemoryDB())
      .then(() => { dbDirty = false; })
      .catch((err) => {
        console.error('[DB] Failed to persist database:', err);
        // 不做内存回滚：memoryDB 始终是内存真相。原实现 JSON 深拷贝回滚
        // 每次持久化多消耗 2×db 内存（100MB 级），且在并发写下会覆盖新数据；
        // persist 失败仅影响 SQLite 落盘，下次 writeDB/flushDB 会重试。
      });
  }, 2000);
}

/** Flush pending writes immediately — call before shutdown */
export async function flushDB(): Promise<void> {
  // P0-1 脏写门控：无 writeDB 标记的脏写直接返回，不再无条件触发全量持久化。
  // 修复前 bootstrap 启动期 flushDB() 无条件重建全部 22 张表 → NAS 上 100MB 库
  // 45MB/s 磁盘耗时 15+ 分钟（容器每次重启的致命启动窗口）。
  // 全仓审计结论：所有对 memoryDB 的原地修改（saveRouterConfig / persistDisabledState /
  // pruneOldData 等）都经 writeDB 置位，dbDirty 是可靠的脏写信号；
  // 且启动期指纹已 seed（seedPersistedFingerprints）→ 即使有写入，未变化表也零 SQL。
  if (!dbDirty) return;
  if (writeDebounceTimer) {
    clearTimeout(writeDebounceTimer);
    writeDebounceTimer = null;
  }
  try {
    await writeLock.catch((err) => {
      console.error('[DB] Previous write failed before flush:', err);
    });
    await persistMemoryDB();
    dbDirty = false;
  } catch (err) {
    console.error('[DB] flushDB failed:', err);
  }
}

let dbDirty = false;

export function isDbDirty(): boolean {
  return dbDirty;
}

// 持久化互斥队列：writeDB debounce 与 flushDB 两个入口共用，
// 保证任意时刻最多一个 SQLite 事务在运行。
// 根因修复：flushDB 此前绕过 writeLock 直接调用持久化，与 debounce 回调并发执行
// 两个 BEGIN TRANSACTION（SQLite 单连接不允许嵌套事务）→
// SQLITE_ERROR: cannot start a transaction within a transaction
let persistQueue: Promise<void> = Promise.resolve();

/**
 * Persist all in-memory data to SQLite using an atomic write-via-temp-table pattern.
 * Data is written to temp tables first, then the original tables are atomically
 * replaced. If the process crashes mid-write, the original data is preserved.
 * 所有调用方（writeDB debounce / flushDB）均经互斥队列串行执行。
 * 整个持久化事务（BEGIN…COMMIT）作为单个串行队列任务提交：内部语句经可重入队列
 * 直接执行（不死锁），外部并发操作必须等整个事务结束后才能执行，杜绝语句交错进入事务。
 */
function persistMemoryDB(): Promise<void> {
  const prev = persistQueue.catch(() => {});
  const job = prev.then(() => enqueueOp(() => runPersist()));
  persistQueue = job.catch(() => {});
  return job;
}

// ═══════════════════════════════════════════════════════════════════
// P0-1 增量表级持久化（消除全量写放大）
// 原实现每次持久化都对全部 22 张表执行「temp 表创建填充 → DROP 原表 → RENAME」
// 全量重写：100MB 库在 NAS 45MB/s 磁盘上耗时 15+ 分钟 → 每次容器重启/持久化都是灾难。
// 现在每次持久化周期先对每张表计算指纹（行数 + 紧凑行 FNV-1a 内容哈希），
// 与上次成功持久化指纹一致的表零 SQL 跳过，只有变化的表才走临时表重建。
// 启动期 seedPersistedFingerprints() 用加载态填充指纹 → 重启后首次 flushDB 全部命中
// → 容器重启秒级启动；写风暴下大部分表不再持有写事务，SQLite 锁竞争同步缓解。
// ═══════════════════════════════════════════════════════════════════

interface TableSpec {
  name: string;
  createSQL: string;
  insertSQL: string;
  rows: () => any[][];
}

/** 每张表上次成功持久化的指纹（行数 + FNV-1a 内容哈希） */
const lastPersistedFingerprints = new Map<string, string>();

/** FNV-1a 32bit 整表指纹：行数与每行内容同时参与哈希，任何增删改都能检出 */
function computeTableFingerprint(rows: any[][]): string {
  let h = 2166136261;
  for (const row of rows) {
    for (const v of row) {
      if (v != null) {
        const s = typeof v === 'string' ? v : String(v);
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
      }
      h ^= 0x1f; // 字段分隔
      h = Math.imul(h, 16777619);
    }
    h ^= 0x1e; // 行分隔
    h = Math.imul(h, 16777619);
  }
  return rows.length + ':' + (h >>> 0).toString(36);
}

// founder_vision 单行表：updatedAt 若每次生成新时间戳 → 指纹恒变 → 无条件重建。
// content 未变化时复用上次写入的 updatedAt，使指纹稳定、该表可被跳过。
let founderCachedContent: string | null = null;
let founderCachedAt: string | null = null;

function buildAllSpecs(): TableSpec[] {
  // Table definitions: [tableName, createSQL (must match the schema), insertSQL, rowMapper]
  const specs: TableSpec[] = [
    {
      name: 'users',
      createSQL: `CREATE TABLE _temp_users (uid TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'user', balance REAL DEFAULT 0, phone TEXT DEFAULT '', createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_users (uid, username, password, role, balance, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.users.map((u: any) => [u.uid, u.username, u.password, u.role, u.balance, u.phone || '', u.createdAt]),
    },
    {
      name: 'agents',
      createSQL: `CREATE TABLE _temp_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, config TEXT NOT NULL, createdAt TEXT NOT NULL, userId TEXT, status TEXT DEFAULT 'active', personalityId TEXT DEFAULT 'peppa', modelPreference TEXT DEFAULT '', memoryScope TEXT DEFAULT 'shared', autonomyLevel TEXT DEFAULT 'reactive', runtimeConfig TEXT DEFAULT '{}', runtime TEXT DEFAULT 'internal', externalCommand TEXT DEFAULT '', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_agents (id, name, category, config, createdAt, userId, status, personalityId, modelPreference, memoryScope, autonomyLevel, runtimeConfig, runtime, externalCommand, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.agents.map((a: any) => [a.id, a.name, a.category, a.data || a.config || '{}', a.createdAt, a.ownerUid || a.userId || null, a.status || 'active', a.personalityId || 'peppa', a.modelPreference || '', a.memoryScope || 'shared', a.autonomyLevel || 'reactive', a.runtimeConfig || '{}', a.runtime || 'internal', a.externalCommand || '', a.domain || 'personal', a.orgId || '']),
    },
    {
      name: 'interactions',
      createSQL: `CREATE TABLE _temp_interactions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, agentId TEXT, module TEXT, message TEXT NOT NULL, response TEXT, role TEXT DEFAULT '', personality TEXT DEFAULT '', mode TEXT DEFAULT '', toolCalls TEXT DEFAULT '', conversationId TEXT DEFAULT '', cognitiveIntent TEXT DEFAULT '', llmWasCalled INTEGER DEFAULT 0, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_interactions (id, userId, agentId, module, message, response, role, personality, mode, toolCalls, conversationId, cognitiveIntent, llmWasCalled, domain, orgId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.interactions.map((i: any) => [i.id, i.userId || 'unknown', i.agentId || null, i.personality || i.module || null, i.content || i.message || '', i.response || '', i.role || '', i.personality || '', i.mode || '', i.toolCalls ? JSON.stringify(i.toolCalls) : '', i.conversationId || '', i.cognitiveIntent || '', i.llmWasCalled ? 1 : 0, i.domain || 'personal', i.orgId || '', i.timestamp]),
    },
    {
      name: 'memories',
      createSQL: `CREATE TABLE _temp_memories (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL DEFAULT 0.5, sourceInteractionId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, lastRetrievedAt TEXT, retrieveCount INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'episodic', perspective TEXT NOT NULL DEFAULT 'owner_trait', importance REAL NOT NULL DEFAULT 0.3, parentId TEXT, agentId TEXT DEFAULT '', nodeType TEXT NOT NULL DEFAULT 'leaf', location TEXT DEFAULT '', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_memories (id, userId, type, content, keywords, confidence, sourceInteractionId, createdAt, updatedAt, lastRetrievedAt, retrieveCount, tier, perspective, importance, parentId, agentId, nodeType, location, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.memories || []).map((m: any) => [m.id, m.userId, m.type, m.content, JSON.stringify(m.keywords || []), m.confidence || 0.5, m.sourceInteractionId || '', m.createdAt, m.updatedAt, m.lastRetrievedAt, m.retrieveCount || 0, m.tier || 'episodic', m.perspective || 'owner_trait', m.importance ?? 0.3, m.parentId || null, m.agentId || '', m.nodeType || 'leaf', m.location || '', m.domain || 'personal', m.orgId || '']),
    },
    {
      name: 'reminders',
      createSQL: `CREATE TABLE _temp_reminders (id TEXT PRIMARY KEY, userId TEXT NOT NULL, content TEXT NOT NULL, dueAt TEXT, status TEXT NOT NULL DEFAULT 'pending', sourceInteractionId TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, firedAt TEXT)`,
      insertSQL: `INSERT INTO _temp_reminders (id, userId, content, dueAt, status, sourceInteractionId, createdAt, firedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.reminders || []).map((r: any) => [r.id, r.userId, r.content, r.dueAt || null, r.status || 'pending', r.sourceInteractionId || '', r.createdAt, r.firedAt || null]),
    },
    {
      name: 'conversations',
      createSQL: `CREATE TABLE _temp_conversations (id TEXT PRIMARY KEY, userId TEXT NOT NULL, agentId TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'active', summary TEXT DEFAULT '', messageCount INTEGER DEFAULT 0, lastActiveAt TEXT NOT NULL, createdAt TEXT NOT NULL, domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_conversations (id, userId, agentId, title, status, summary, messageCount, lastActiveAt, createdAt, domain, orgId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.conversations || []).map((c: any) => [c.id, c.userId, c.agentId || '', c.title || '', c.status || 'active', c.summary || '', c.messageCount || 0, c.lastActiveAt, c.createdAt, c.domain || 'personal', c.orgId || '']),
    },
    {
      name: 'canvas_sessions',
      createSQL: `CREATE TABLE _temp_canvas_sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', cards TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]', taskText TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', domain TEXT DEFAULT 'personal', orgId TEXT DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_canvas_sessions (id, userId, title, cards, edges, taskText, status, domain, orgId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.canvas_sessions || []).map((s: any) => [s.id, s.userId, s.title || '', s.cards || '[]', s.edges || '[]', s.taskText || '', s.status || 'active', s.domain || 'personal', s.orgId || '', s.createdAt, s.updatedAt]),
    },
    {
      name: 'marketplace_skills',
      createSQL: `CREATE TABLE _temp_marketplace_skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, author TEXT NOT NULL, price REAL NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_marketplace_skills (id, name, author, price, description, category) VALUES (?, ?, ?, ?, ?, ?)`,
      rows: () => memoryDB.marketplaceSkills.map((s: any) => [s.id, s.name, s.author, s.price, s.description, s.category]),
    },
    {
      name: 'skills',
      createSQL: `CREATE TABLE _temp_skills (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_skills (id, name, description) VALUES (?, ?, ?)`,
      rows: () => memoryDB.skills.map((s: any) => [s.id, s.name, s.description]),
    },
    {
      name: 'settings',
      createSQL: `CREATE TABLE _temp_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_settings (key, value) VALUES (?, ?)`,
      rows: settingsRowsWithSystemState,
    },
    {
      name: 'voice_profiles',
      createSQL: `CREATE TABLE _temp_voice_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, voiceId TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_voice_profiles (userId, voiceId, name, provider, createdAt) VALUES (?, ?, ?, ?, ?)`,
      rows: () => {
        const rows: any[][] = [];
        for (const [userId, profiles] of Object.entries(memoryDB.voiceProfiles || {})) {
          for (const vp of profiles as any[]) {
            rows.push([userId, vp.voiceId, vp.name, vp.provider, vp.createdAt]);
          }
        }
        return rows;
      },
    },
    {
      name: 'token_usage',
      createSQL: `CREATE TABLE _temp_token_usage (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, promptTokens INTEGER NOT NULL, completionTokens INTEGER NOT NULL, totalTokens INTEGER NOT NULL, mode TEXT DEFAULT 'chat', interactionId TEXT DEFAULT '', timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_token_usage (id, userId, provider, model, promptTokens, completionTokens, totalTokens, mode, interactionId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.tokenUsage || []).map((u: any) => [u.id, u.userId, u.provider, u.model, u.promptTokens, u.completionTokens, u.totalTokens, u.mode || 'chat', u.interactionId || '', u.timestamp]),
    },
    {
      name: 'llm_router_calls',
      createSQL: `CREATE TABLE _temp_llm_router_calls (id TEXT PRIMARY KEY, ts TEXT NOT NULL, scene TEXT NOT NULL DEFAULT '(none)', tier TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, promptTokens INTEGER NOT NULL DEFAULT 0, completionTokens INTEGER NOT NULL DEFAULT 0, totalTokens INTEGER NOT NULL DEFAULT 0, cacheHitTokens INTEGER NOT NULL DEFAULT 0, cacheHit INTEGER NOT NULL DEFAULT 0, durationMs INTEGER NOT NULL DEFAULT 0, degraded INTEGER NOT NULL DEFAULT 0, error TEXT DEFAULT '')`,
      insertSQL: `INSERT INTO _temp_llm_router_calls (id, ts, scene, tier, provider, model, promptTokens, completionTokens, totalTokens, cacheHitTokens, cacheHit, durationMs, degraded, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.llmRouterCalls || []).map((c: any) => [c.id, c.ts, c.scene || '(none)', c.tier, c.provider, c.model, c.promptTokens || 0, c.completionTokens || 0, c.totalTokens || 0, c.cacheHitTokens || 0, c.cacheHit ? 1 : 0, c.durationMs || 0, c.degraded ? 1 : 0, c.error || '']),
    },
    {
      name: 'organizations',
      createSQL: `CREATE TABLE _temp_organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, ownerUid TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_organizations (id, name, slug, ownerUid, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.organizations || []).map((o: any) => [o.id, o.name, o.slug, o.ownerUid, o.settings || '{}', o.createdAt, o.updatedAt]),
    },
    {
      name: 'departments',
      createSQL: `CREATE TABLE _temp_departments (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, name TEXT NOT NULL, parentId TEXT, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_departments (id, orgId, name, parentId, createdAt) VALUES (?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.departments || []).map((d: any) => [d.id, d.orgId, d.name, d.parentId || null, d.createdAt]),
    },
    {
      name: 'org_memberships',
      createSQL: `CREATE TABLE _temp_org_memberships (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', departmentId TEXT, status TEXT NOT NULL DEFAULT 'active', invitedBy TEXT, joinedAt TEXT, createdAt TEXT NOT NULL, UNIQUE(orgId, userId))`,
      insertSQL: `INSERT INTO _temp_org_memberships (id, orgId, userId, role, departmentId, status, invitedBy, joinedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgMemberships || []).map((m: any) => [m.id, m.orgId, m.userId, m.role || 'member', m.departmentId || null, m.status || 'active', m.invitedBy || null, m.joinedAt || null, m.createdAt]),
    },
    {
      name: 'org_invitations',
      createSQL: `CREATE TABLE _temp_org_invitations (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, code TEXT UNIQUE NOT NULL, createdBy TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', departmentId TEXT, maxUses INTEGER DEFAULT 0, useCount INTEGER DEFAULT 0, expiresAt TEXT, createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_invitations (id, orgId, code, createdBy, role, departmentId, maxUses, useCount, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgInvitations || []).map((inv: any) => [inv.id, inv.orgId, inv.code, inv.createdBy, inv.role || 'member', inv.departmentId || null, inv.maxUses || 0, inv.useCount || 0, inv.expiresAt || null, inv.createdAt]),
    },
    {
      name: 'org_kb_articles',
      createSQL: `CREATE TABLE _temp_org_kb_articles (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT DEFAULT 'general', tags TEXT DEFAULT '[]', authorId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', viewCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_kb_articles (id, orgId, title, content, category, tags, authorId, status, viewCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgKbArticles || []).map((a: any) => [a.id, a.orgId, a.title, a.content, a.category || 'general', a.tags || '[]', a.authorId, a.status || 'published', a.viewCount || 0, a.createdAt, a.updatedAt]),
    },
    {
      name: 'org_kb_embeddings',
      createSQL: `CREATE TABLE _temp_org_kb_embeddings (id TEXT PRIMARY KEY, articleId TEXT NOT NULL, chunkIndex INTEGER NOT NULL, embedding TEXT NOT NULL, content TEXT NOT NULL, modelName TEXT NOT NULL DEFAULT 'text-embedding-3-small', createdAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_org_kb_embeddings (id, articleId, chunkIndex, embedding, content, modelName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.orgKbEmbeddings || []).map((e: any) => [e.id, e.articleId, e.chunkIndex, e.embedding, e.content, e.modelName || 'text-embedding-3-small', e.createdAt]),
    },
    {
      name: 'agent_templates',
      createSQL: `CREATE TABLE _temp_agent_templates (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, config TEXT NOT NULL, icon TEXT DEFAULT 'Bot', version INTEGER DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', authorId TEXT NOT NULL, reviewedBy TEXT, reviewComment TEXT, downloadCount INTEGER DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_agent_templates (id, orgId, name, description, category, config, icon, version, status, authorId, reviewedBy, reviewComment, downloadCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.agentTemplates || []).map((t: any) => [t.id, t.orgId, t.name, t.description, t.category, t.config, t.icon || 'Bot', t.version || 1, t.status || 'draft', t.authorId, t.reviewedBy || null, t.reviewComment || null, t.downloadCount || 0, t.createdAt, t.updatedAt]),
    },
    {
      name: 'notifications',
      createSQL: `CREATE TABLE _temp_notifications (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL)`,
      insertSQL: `INSERT INTO _temp_notifications (id, userId, type, title, message, read, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.notifications || []).map((n: any) => [n.id, n.userId, n.type || 'info', n.title || '', n.message || '', n.read ? 1 : 0, n.timestamp]),
    },
    {
      name: 'audit_log',
      createSQL: `CREATE TABLE _temp_audit_log (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, userId TEXT NOT NULL, action TEXT NOT NULL, resourceType TEXT NOT NULL, resourceId TEXT NOT NULL, details TEXT DEFAULT '{}', ipAddress TEXT, userAgent TEXT, timestamp TEXT NOT NULL)`,
      insertSQL: `INSERT INTO _temp_audit_log (id, orgId, userId, action, resourceType, resourceId, details, ipAddress, userAgent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows: () => (memoryDB.auditLog || []).map((l: any) => [l.id, l.orgId, l.userId, l.action, l.resourceType, l.resourceId, l.details || '{}', l.ipAddress || null, l.userAgent || null, l.timestamp]),
    },
  ];

  // Special handling: founder_vision is a single row
  const founderSpec: TableSpec = {
    name: 'founder_vision',
    createSQL: `CREATE TABLE _temp_founder_vision (id INTEGER PRIMARY KEY CHECK (id = 1), content TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
    insertSQL: `INSERT INTO _temp_founder_vision (id, content, updatedAt) VALUES (?, ?, ?)`,
    rows: () => {
      if (!memoryDB.founderVision) return [];
      if (founderCachedContent !== memoryDB.founderVision) {
        founderCachedContent = memoryDB.founderVision;
        founderCachedAt = new Date().toISOString();
      }
      return [[1, memoryDB.founderVision, founderCachedAt!]];
    },
  };

  return [...specs, founderSpec];
}

/** 启动期调用：加载态即持久态，填充指纹后启动 flushDB 的比对全部命中（零 SQL） */
function seedPersistedFingerprints(): void {
  lastPersistedFingerprints.clear();
  for (const spec of buildAllSpecs()) {
    lastPersistedFingerprints.set(spec.name, computeTableFingerprint(spec.rows()));
  }
}

async function runPersist(): Promise<void> {
  const allSpecs = buildAllSpecs();
  // 快照取数：指纹与写入共用同一批行，避免取数期间数据漂移造成表内新旧混杂
  const plan: { spec: TableSpec; rows: any[][] }[] = [];
  for (const spec of allSpecs) {
    const rows = spec.rows();
    const fp = computeTableFingerprint(rows);
    if (fp === lastPersistedFingerprints.get(spec.name)) {
      continue; // 表内容未变化 → 零 SQL 跳过
    }
    lastPersistedFingerprints.set(spec.name, fp);
    plan.push({ spec, rows });
  }
  if (plan.length === 0) {
    // 全表无变化（重启首刷/静默期）→ 无事务、无写锁，秒级返回
    return;
  }
  if (plan.length < allSpecs.length) {
    console.log(`[DB] 增量持久化 ${plan.length}/${allSpecs.length} 张变化表: ${plan.map(p => p.spec.name).join(', ')}`);
  }

  await run('BEGIN TRANSACTION');
  try {
    // Phase 1: Create temp tables and populate them
    for (const { spec, rows } of plan) {
      await run(`DROP TABLE IF EXISTS _temp_${spec.name}`);
      await run(spec.createSQL);
      for (const row of rows) {
        await run(spec.insertSQL, row);
      }
    }

    // Phase 2: Drop original tables
    for (const { spec } of plan) {
      await run(`DROP TABLE IF EXISTS ${spec.name}`);
    }

    // Phase 3: Rename temp tables to original names (atomic in SQLite within a transaction)
    for (const { spec } of plan) {
      await run(`ALTER TABLE _temp_${spec.name} RENAME TO ${spec.name}`);
    }

    await run('COMMIT');
  } catch (err) {
    // On failure, clean up temp tables and rollback
    try {
      for (const { spec } of plan) {
        await run(`DROP TABLE IF EXISTS _temp_${spec.name}`);
      }
    } catch {}
    await run('ROLLBACK');
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// P2-4 SQLite 自动归档（防无限膨胀）
// 阈值 100MB + 每天最多一次 + 启动即检查。VACUUM INTO 生成完整一致的副本，
// 不触碰原库（归档 ≠ 清理），归档后原库继续增长，可手动把旧副本移走回收空间。
// ═══════════════════════════════════════════════════════════════════
const ARCHIVE_MIN_SIZE_BYTES = 100 * 1024 * 1024;     // 归档阈值 100MB
const ARCHIVE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 例行检查周期 6h
let archiveTimer: NodeJS.Timeout | null = null;

function archiveTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function archiveDatabase(): Promise<void> {
  try {
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(DB_PATH).size; } catch { return; } // 库文件不存在/不可读
    if (sizeBytes < ARCHIVE_MIN_SIZE_BYTES) return; // 未达阈值不归档
    const archiveDir = path.join(getDataRoot(), 'data', 'db_archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `peppa-${archiveTodayKey()}.db`);
    if (fs.existsSync(archivePath)) return; // 当天已归档过，避免重复膨胀
    // VACUUM INTO 必须在事务外执行；经串行队列独占连接（含 BUSY 指数退避外壳）
    await enqueueOp(() =>
      execWithRetry(
        (conn) =>
          new Promise<void>((resolve, reject) => {
            conn.run(`VACUUM INTO '${archivePath.replace(/'/g, "''")}'`, (err) => (err ? reject(err) : resolve()));
          }),
        'archive VACUUM INTO',
      ),
    );
    console.log(`[DB] 自动归档完成: ${archivePath} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB)`);
  } catch (err) {
    console.error('[DB] 自动归档失败（非致命，下次例行检查重试）:', (err as any)?.message ?? err);
  }
}

/** 启动即检查一次 + 每 6h 例行检查；unref 定时器不阻止进程退出 */
export function scheduleDatabaseArchive(): void {
  if (archiveTimer) return;
  void archiveDatabase();
  archiveTimer = setInterval(() => { void archiveDatabase(); }, ARCHIVE_CHECK_INTERVAL_MS);
  if (typeof archiveTimer.unref === 'function') archiveTimer.unref();
}

let initPromise: Promise<void> | null = null;
export function ensureDatabaseInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = initDatabase();
  }
  return initPromise;
}

export async function querySQL<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return query<T>(sql, params);
}

export async function runSQL(sql: string, params: any[] = []): Promise<void> {
  return run(sql, params);
}

/**
 * 写入事件到 event_log 表
 * @param eventType 事件类型（如 'USER_SAID', 'EMOTION_CHANGED', 'TICK' 等）
 * @param payload 事件数据（任意对象）
 * @param sessionId 会话ID（可选）
 */
export async function appendEvent(
  eventType: string,
  payload: any,
  sessionId?: string
): Promise<void> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const payloadStr = JSON.stringify(payload);

  const sql = `
    INSERT INTO event_log (id, timestamp, event_type, payload, session_id)
    VALUES (?, ?, ?, ?, ?)
  `;

  await runSQL(sql, [id, timestamp, eventType, payloadStr, sessionId || null]);
}
