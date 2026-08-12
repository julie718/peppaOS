// server/llm/frequencyGate.ts
// InnerTick / life TICK 触发频率管控（任务4）— 降本关键
//
// 规则：
//   - 空闲状态（无用户交互的定时触发）InnerTick 最小间隔可配置（默认 1 小时）；
//   - 间隔内再次到达的空闲触发 → 直接跳过（不调用大模型做完整深度心智推演）。
//     轻量状态快照入库由旧 life TICK（logSystemEvent 快照路径）负责，本闸门只做调度控制，
//     不阉割任何心智能力；
//   - 仅以下触发源允许完整 InnerTick 大模型推演（不受本闸门约束）：
//       1. 用户消息交互（chat_turn，socket/chat.ts 触发）；
//       2. 重要状态变更（scheduler/idle_brain 收集了 derivedMentalEvents 的推演，任务完成/月度回顾等）；
//       3. 目标变更（archiveItems/desireEvolve 等心智事件落库链路）。
//   - 间隔设为 0 = 不限制（保持旧行为，灰度期可关）。

import { readDB, writeDB } from '../../db_layer';
import { logger } from '../lib/logger';
import { getRouterConfig } from './routerConfig';

const IDLE_TICK_KEY = 'llm_router_idle_tick';

interface IdleTickState {
  lastIdleInnerTickAt: string; // ISO 时间
}

/**
 * 空闲 InnerTick 频率闸门：返回 true = 允许触发本轮完整 InnerTick 大模型推演；
 * false = 间隔未到，跳过本轮（只记日志，不调用 LLM）。
 * 间隔配置 <= 0 时恒返回 true（保持旧行为）。
 */
export function allowIdleInnerTick(source: string): boolean {
  const cfg = getRouterConfig();
  if (!cfg.enabled || cfg.idleInnerTickIntervalMs <= 0) return true;

  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === IDLE_TICK_KEY);
    const lastAt = setting?.value ? (JSON.parse(setting.value) as IdleTickState).lastIdleInnerTickAt : null;

    const now = Date.now();
    if (lastAt && now - Date.parse(lastAt) < cfg.idleInnerTickIntervalMs) {
      const waitedMin = Math.round((now - Date.parse(lastAt)) / 60000);
      logger.info(
        `[FrequencyGate] 空闲InnerTick触发被频率管控拦截（source=${source}）：距离上次 ${waitedMin} 分钟 < 最小间隔 ` +
        `${Math.round(cfg.idleInnerTickIntervalMs / 60000)} 分钟 → 本轮不做大模型深度推演，仅保留轻量状态快照（life.db 数据不受影响）。`,
      );
      return false;
    }

    if (!db.settings) (db as any).settings = [];
    const idx = (db.settings as any[]).findIndex((s: any) => s.key === IDLE_TICK_KEY);
    const payload = JSON.stringify({ lastIdleInnerTickAt: new Date(now).toISOString() });
    if (idx >= 0) {
      (db.settings as any[])[idx].value = payload;
    } else {
      (db.settings as any[]).push({ key: IDLE_TICK_KEY, value: payload });
    }
    writeDB(db);
    return true;
  } catch (e: any) {
    // 持久化失败不阻断（放行，保持可用性）
    logger.warn(`[FrequencyGate] 状态读写失败，放行本轮: ${e?.message || e}`);
    return true;
  }
}

/** 最近一次空闲 InnerTick 时间（状态接口展示用） */
export function getLastIdleInnerTickAt(): string | null {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === IDLE_TICK_KEY);
    return setting?.value ? (JSON.parse(setting.value) as IdleTickState).lastIdleInnerTickAt : null;
  } catch {
    return null;
  }
}
