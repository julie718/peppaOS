// 项目通用 SQLite 底层封装（server/db/dbBase.ts）
// ── 职责：进程级单例共享连接池（按 DB 文件路径注册）──
// 背景：NAS 高并发调度任务 / LifeSystem 主循环 / Retriever 检索任务并行时，
//       多处各自 new sqlite3.Database + 任务结束手动 close → SQLITE_MISUSE:
//       Database handle is closed 随机 FATAL（docker 容器自动重启）。
// 本文件作为业务层与驱动之间的唯一连接获取入口：
// 1) 同一 DB 文件 → 进程内仅一个共享句柄（单例复用，业务路径禁止自行 open/close）
// 2) 打开模式显式 serialized 串行（OPEN_FULLMUTEX），适配多任务并发访问
// 3) 连接创建后立即生效 PRAGMA：WAL + synchronous=NORMAL + busy_timeout（无需人工执行）
// 4) 注册 'error' 事件监听：无回调语句的错误不会以未捕获事件 FATAL
// 5) 句柄异常 → 自动失效标记，下次获取自动重开连接
import sqlite3 from 'sqlite3';
import { getPeppaDbPath, getDataPath } from '../config/data_path';

// 打开模式：READWRITE | CREATE | FULLMUTEX（FULLMUTEX = SQLite serialized 串行模式，
// 任意时刻仅一个线程访问连接，杜绝多调度任务并发打开/关闭竞态）
const OPEN_FLAGS = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;

const PRAGMAS: string[] = [
  'PRAGMA journal_mode=WAL',   // WAL：读写互不阻塞，从根源降低锁竞争
  'PRAGMA synchronous=NORMAL', // 与 WAL 搭配的推荐持久性级别（适配 NAS 磁盘 IO）
  'PRAGMA busy_timeout=5000',  // 驱动内部锁等待上限
  'PRAGMA foreign_keys=ON',
];

interface DbEntry {
  conn: sqlite3.Database | null;
  open: boolean;
  label: string;
}

const registry = new Map<string, DbEntry>();

/**
 * 获取（或创建）某 DB 文件的进程级单例连接。
 * 多次调用同一路径返回同一句柄；句柄异常失效后再次调用自动重开新句柄。
 * 调用方禁止对该句柄调用 .close() —— 生命周期归应用进程，退出时由系统回收。
 */
export function getSharedSqlite(dbPath: string, label = 'SharedDB'): sqlite3.Database {
  let entry = registry.get(dbPath);
  if (!entry) {
    entry = { conn: null, open: false, label };
    registry.set(dbPath, entry);
  }
  // 单例复用：连接对象一旦创建即返回（无论 open 是否完成——node-sqlite3 语句在驱动
  // 队列中等待 open 完成后自动执行，不会丢失）。若以 open 完成作为复用条件，
  // 首波并发下每个调用方都会各自 new 句柄，违背单例目标。
  if (entry.conn) return entry.conn;

  const conn = new sqlite3.Database(dbPath, OPEN_FLAGS, (err) => {
    // 带回调构造：打开失败时错误进回调而非未捕获 'error' 事件
    if (err) {
      console.error(`[${label}] 连接失败:`, err.message);
      if (entry!.conn === conn) { entry!.open = false; entry!.conn = null; }
    } else {
      if (entry!.conn === conn) entry!.open = true;
    }
  });
  conn.on('error', (err) => {
    // 无回调语句的错误会以 'error' 事件抛出 → 不注册监听器会直接 FATAL。
    // 记录并标记句柄失效，后续获取自动重连。
    if (entry!.conn !== conn) return; // 旧句柄迟到事件，不影响新句柄
    console.warn(`[${label}] sqlite3 error 事件（自动重连）:`, (err as any)?.message ?? err);
    entry!.open = false;
    entry!.conn = null;
  });
  // 语句按 FIFO 顺序执行：连接创建后立即排队 PRAGMA → 先于后续任何业务语句生效
  for (const p of PRAGMAS) {
    conn.run(p, (err) => {
      if (err) console.warn(`[${label}] PRAGMA 设置失败: ${p} ${(err as any)?.message ?? err}`);
    });
  }
  entry.conn = conn;
  return conn;
}

/** peppa.db 共享单例连接（记忆/检索/时间线等业务复用，禁止 close） */
export function getSharedPeppaDb(): sqlite3.Database {
  return getSharedSqlite(getPeppaDbPath(), 'PeppaDB');
}

/** life.db 共享单例连接（自身状态/方向模块等复用，禁止 close） */
export function getSharedLifeDb(): sqlite3.Database {
  const lifePath = process.env.LIFE_DB_PATH || getDataPath('life.db');
  return getSharedSqlite(lifePath, 'LifeDB');
}
