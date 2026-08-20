// server/perception/queue.ts
// Phase2 模块1：感知事件工作队列 — 内存工作队列 + SQLite 持久后备任务表
//
// 设计：
//   1) 内存队列：按用户持有（perceptionEvents，见 server/socket/shared.ts），
//      队列上限 PERCEPTION_MEMORY_QUEUE_MAX（默认 50/用户），防止内存暴涨；
//   2) 内存满：新事件不丢弃、不阻塞内存（同步内存操作），最旧溢出事件写入
//      SQLite 后备任务表 perception_event_queue 持久化；
//   3) 空闲回捞：维护定时器（默认 60s）在内存队列低于低水位时，从后备表
//      捞回最旧 pending 事件补处理（标记 drained）；
//   4) 超时丢弃：后备积压事件超过 PERCEPTION_BACKLOG_TIMEOUT_MINUTES（默认
//      45 分钟，.env 可配置）才丢弃，并写异常日志（perception.log）；
//   5) 日志策略：只有异常 / 越界（异常模态、超大 payload、溢出、超时丢弃）
//      才写 perception.log；普通琐碎感知事件不写该日志。
//
// ⚠️ 铁则遵守：本表是任务队列数据（非业务记忆数据）；「超时丢弃」仅丢弃
//    过期积压任务项，绝不触碰任何业务记忆数据（memories 等）。

import { logger } from '../lib/logger';
import { perceptionEvents, MAX_PERCEPTION_EVENTS } from '../socket/shared';
import { getSharedLifeDb } from '../db/dbBase';
import type { RawModalityInput } from '../context/fusion';

const TAG = '[PerceptionQueue]';

// ─────────────────────────────────────────────
// 1. 配置（.env 可配置；队列上限默认 50 —— 高于融合窗口 MAX_PERCEPTION_EVENTS=20，
//    保证融合拿到的最近事件完整，溢出部分落后备表等空闲回捞）
// ─────────────────────────────────────────────

/** 单用户内存感知队列上限（防止内存暴涨；超出部分落 SQLite 后备表，不丢弃） */
export const PERCEPTION_MEMORY_QUEUE_MAX = Math.max(
  MAX_PERCEPTION_EVENTS,
  Number(process.env.PERCEPTION_MEMORY_QUEUE_MAX) || 50,
);
/** 后备队列积压超时（分钟）：超过才丢弃过期事件并写异常日志；默认 45 分钟 */
export const PERCEPTION_BACKLOG_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.PERCEPTION_BACKLOG_TIMEOUT_MINUTES) || 45,
);
/** 回捞低水位：内存队列低于该值时从后备表捞回积压事件 */
export const PERCEPTION_DRAIN_LOW_WATERMARK = Math.max(
  1,
  Math.min(PERCEPTION_MEMORY_QUEUE_MAX - 1, Number(process.env.PERCEPTION_DRAIN_LOW_WATERMARK) || 20),
);
/** 维护定时器间隔（毫秒，默认 60s）：回捞 + 过期清扫 */
export const PERCEPTION_MAINTENANCE_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.PERCEPTION_MAINTENANCE_INTERVAL_MS) || 60_000,
);

const MODALITIES = new Set(['audio', 'visual', 'spatial', 'haptic']);
/** 单条事件序列化体积上限（超过视为越界/异常事件，写异常日志） */
const MAX_EVENT_JSON_BYTES = 8 * 1024;

// ─────────────────────────────────────────────
// 2. SQLite 后备表访问（经 dbBase 共享句柄，busy_timeout/WAL 已生效）
// ─────────────────────────────────────────────

const TABLE = 'perception_event_queue';

function runDb(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = getSharedLifeDb();
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function allDb<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const db = getSharedLifeDb();
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
  });
}

/** 幂等建表（lifeDb 迁移表清单中亦含本表；双保险，重复执行无副作用） */
export async function ensurePerceptionQueueTable(): Promise<void> {
  await runDb(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT '',
    modality TEXT NOT NULL DEFAULT 'unknown',
    device_id TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','drained')),
    drained_at TEXT
  )`);
  await runDb(`CREATE INDEX IF NOT EXISTS idx_perception_queue_user_status ON ${TABLE}(user_id, status, id)`);
}

// ─────────────────────────────────────────────
// 3. 异常判定（只有异常/越界事件才写 perception.log）
// ─────────────────────────────────────────────

export interface PerceptionEventAnomaly {
  code: 'unknown_modality' | 'oversize_payload' | 'missing_fields' | 'overflow_to_sqlite' | 'expired_dropped';
  detail: string;
}

function detectAnomaly(userId: string, event: RawModalityInput): PerceptionEventAnomaly | null {
  if (!MODALITIES.has(event.modality as string)) {
    return { code: 'unknown_modality', detail: `user=${userId} modality="${String(event.modality)}" 未知感知模态` };
  }
  if (!event.timestamp || !event.deviceId) {
    return { code: 'missing_fields', detail: `user=${userId} modality=${event.modality} 事件缺少 timestamp/deviceId` };
  }
  try {
    const size = Buffer.byteLength(JSON.stringify(event.data ?? {}));
    if (size > MAX_EVENT_JSON_BYTES) {
      return { code: 'oversize_payload', detail: `user=${userId} modality=${event.modality} payload=${size}B 超过上限 ${MAX_EVENT_JSON_BYTES}B` };
    }
  } catch {
    return { code: 'oversize_payload', detail: `user=${userId} modality=${event.modality} payload 序列化失败（疑似循环引用）` };
  }
  return null;
}

// ─────────────────────────────────────────────
// 4. 入队：内存优先 → 溢出落 SQLite 后备表（不丢弃、不阻塞）
// ─────────────────────────────────────────────

/**
 * 感知事件入队。返回 'memory'（进内存队列）或 'sqlite'（溢出落后备表）。
 * 内存队列满时：最旧事件写入 SQLite 后备表（异步不阻塞内存，失败则降级
 * shift 丢弃并写异常日志）；绝不丢新事件。
 */
export function enqueuePerceptionEvent(userId: string, event: RawModalityInput): 'memory' | 'sqlite' {
  // 异常判定（写 perception.log 的入口：仅异常/越界事件；普通琐碎事件不写）
  const anomaly = detectAnomaly(userId, event);
  if (anomaly) {
    logger.perception(`[Perception] ANOMALY ${anomaly.code}: ${anomaly.detail}`);
  }

  const events = perceptionEvents.get(userId) || [];
  events.push(event);
  perceptionEvents.set(userId, events);

  if (events.length > PERCEPTION_MEMORY_QUEUE_MAX) {
    // 溢出：最旧 (length - MAX) 条落后备表持久化（不丢弃）；异步执行不阻塞内存
    const overflowCount = events.length - PERCEPTION_MEMORY_QUEUE_MAX;
    const overflow = events.splice(0, overflowCount); // 从最旧开始移除
    void persistOverflow(userId, overflow, anomaly);
    return 'sqlite';
  }
  return 'memory';
}

/** 溢出事件落 SQLite（异步）。成功：异常日志记录溢出；失败：降级丢弃 + 异常日志。 */
async function persistOverflow(userId: string, overflow: RawModalityInput[], existingAnomaly: PerceptionEventAnomaly | null): Promise<void> {
  try {
    await ensurePerceptionQueueTable();
    for (const ev of overflow) {
      await runDb(
        `INSERT INTO ${TABLE} (user_id, modality, device_id, data_json, enqueued_at) VALUES (?, ?, ?, ?, ?)`,
        [userId, ev.modality, ev.deviceId, JSON.stringify(ev.data ?? {}), ev.timestamp || new Date().toISOString()],
      );
    }
    logger.perception(
      `[Perception] OVERFLOW user=${userId} 内存队列满（上限 ${PERCEPTION_MEMORY_QUEUE_MAX}），` +
      `${overflow.length} 条最旧事件已落 SQLite 后备表持久化，待空闲回捞补处理`,
    );
  } catch (e: any) {
    // 后备表写入失败：新事件已进内存，最旧事件只能丢弃（保新弃旧），写异常日志
    logger.perception(
      `[Perception] ANOMALY overflow_to_sqlite user=${userId} ${overflow.length} 条溢出事件落后备表失败，` +
      `已降级丢弃（保新弃旧）: ${e?.message || String(e)}`,
    );
  }
}

// ─────────────────────────────────────────────
// 5. 空闲回捞：内存低于低水位时，从后备表补处理积压事件
// ─────────────────────────────────────────────

export interface BacklogRow {
  id: number;
  user_id: string;
  modality: string;
  device_id: string;
  data_json: string;
  enqueued_at: string;
}

/** 将所有用户的 pending 积压按用户捞回内存（最旧优先），单次回捞总量受内存水位约束 */
export async function drainPerceptionBacklog(): Promise<number> {
  let drained = 0;
  try {
    await ensurePerceptionQueueTable();
    const rows = await allDb<BacklogRow>(
      `SELECT * FROM ${TABLE} WHERE status = 'pending' ORDER BY enqueued_at ASC, id ASC LIMIT 500`,
    );
    if (rows.length === 0) return 0;

    const byUser = new Map<string, BacklogRow[]>();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r);
    }

    for (const [userId, userRows] of byUser) {
      const memory = perceptionEvents.get(userId) || [];
      const free = PERCEPTION_MEMORY_QUEUE_MAX - memory.length;
      if (free <= 0) continue; // 内存仍满，本轮跳过
      const take = userRows.slice(0, free);
      for (const row of take) {
        memory.push({
          modality: row.modality as RawModalityInput['modality'],
          deviceId: row.device_id,
          timestamp: row.enqueued_at,
          data: safeParse(row.data_json),
        });
        await runDb(`UPDATE ${TABLE} SET status = 'drained', drained_at = datetime('now') WHERE id = ?`, [row.id]);
        drained++;
      }
      perceptionEvents.set(userId, memory);
    }
    if (drained > 0) {
      logger.info(`${TAG} 空闲回捞 ${drained} 条积压感知事件补处理（后备表 → 内存队列）`);
    }
  } catch (e: any) {
    logger.error(`${TAG} 回捞失败（不影响主流程）: ${e?.message || String(e)}`);
  }
  return drained;
}

function safeParse(text: string): any {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ─────────────────────────────────────────────
// 6. 超时丢弃：积压超过阈值才丢，写异常日志（默认 45 分钟，.env 可配置）
// ─────────────────────────────────────────────

/**
 * 清扫过期积压：删除 pending 超过超时阈值的事件（仅此场景允许丢弃队列任务项），
 * 每次清扫结果写 perception.log 异常日志（含丢弃数量/最老年龄）；返回丢弃数量。
 */
export async function sweepExpiredPerceptionBacklog(): Promise<number> {
  try {
    await ensurePerceptionQueueTable();
    const cutoffIso = new Date(Date.now() - PERCEPTION_BACKLOG_TIMEOUT_MINUTES * 60_000).toISOString();
    const expired = await allDb<BacklogRow>(
      `SELECT id, user_id, modality, enqueued_at FROM ${TABLE} WHERE status = 'pending' AND enqueued_at < ? ORDER BY enqueued_at ASC`,
      [cutoffIso],
    );
    if (expired.length === 0) return 0;

    for (const row of expired) {
      await runDb(`DELETE FROM ${TABLE} WHERE id = ?`, [row.id]);
    }

    const oldest = expired[0];
    const oldestAgeMin = Math.round((Date.now() - new Date(oldest.enqueued_at).getTime()) / 60_000);
    logger.perception(
      `[Perception] EXPIRED user=${oldest.user_id} ${expired.length} 条积压感知事件超过 ` +
      `${PERCEPTION_BACKLOG_TIMEOUT_MINUTES} 分钟未处理，已丢弃（最老 ${oldestAgeMin} 分钟，` +
      `modality=${oldest.modality}）; 丢弃数=${expired.length}`,
    );
    return expired.length;
  } catch (e: any) {
    logger.error(`${TAG} 过期清扫失败（不影响主流程）: ${e?.message || String(e)}`);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 7. 维护定时器：空闲回捞 + 过期清扫
// ─────────────────────────────────────────────

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

/** 启动感知队列维护定时器（默认 60s 一次：回捞积压 + 清扫过期）；幂等 */
export function startPerceptionQueueMaintenance(): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    void drainPerceptionBacklog();
    void sweepExpiredPerceptionBacklog();
  }, PERCEPTION_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
  logger.info(`${TAG} 维护定时器已启动（间隔 ${PERCEPTION_MAINTENANCE_INTERVAL_MS / 1000}s：空闲回捞 + 过期清扫）`);
}

/** 停止维护定时器（测试/热停用用）；幂等 */
export function stopPerceptionQueueMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

// ─────────────────────────────────────────────
// 8. 队列状态（调试后台接口 /api/debug/perception-queue 使用）
// ─────────────────────────────────────────────

export interface PerceptionQueueStatus {
  config: {
    memoryQueueMax: number;
    backlogTimeoutMinutes: number;
    drainLowWatermark: number;
    maintenanceIntervalMs: number;
  };
  memory: { userId: string; count: number; cap: number }[];
  sqlite: {
    pendingTotal: number;
    pendingByUser: { userId: string; count: number; oldestAt: string | null }[];
    drainedTotal: number;
  };
}

export async function getPerceptionQueueStatus(): Promise<PerceptionQueueStatus> {
  const memory: PerceptionQueueStatus['memory'] = [];
  for (const [userId, events] of perceptionEvents) {
    memory.push({ userId, count: events.length, cap: PERCEPTION_MEMORY_QUEUE_MAX });
  }
  memory.sort((a, b) => b.count - a.count);

  let pendingTotal = 0;
  let drainedTotal = 0;
  const pendingByUser: PerceptionQueueStatus['sqlite']['pendingByUser'] = [];
  try {
    await ensurePerceptionQueueTable();
    const pendingRows = await allDb<{ user_id: string; cnt: number; oldest_at: string | null }>(
      `SELECT user_id, COUNT(*) as cnt, MIN(enqueued_at) as oldest_at FROM ${TABLE} WHERE status = 'pending' GROUP BY user_id`,
    );
    for (const r of pendingRows) {
      pendingByUser.push({ userId: r.user_id, count: r.cnt, oldestAt: r.oldest_at });
      pendingTotal += r.cnt;
    }
    const drainedRow = await allDb<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${TABLE} WHERE status = 'drained'`);
    drainedTotal = Number(drainedRow[0]?.cnt || 0);
  } catch (e: any) {
    logger.error(`${TAG} 状态查询失败: ${e?.message || String(e)}`);
  }
  pendingByUser.sort((a, b) => b.count - a.count);

  return {
    config: {
      memoryQueueMax: PERCEPTION_MEMORY_QUEUE_MAX,
      backlogTimeoutMinutes: PERCEPTION_BACKLOG_TIMEOUT_MINUTES,
      drainLowWatermark: PERCEPTION_DRAIN_LOW_WATERMARK,
      maintenanceIntervalMs: PERCEPTION_MAINTENANCE_INTERVAL_MS,
    },
    memory,
    sqlite: { pendingTotal, pendingByUser, drainedTotal },
  };
}
