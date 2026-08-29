import { SensoryContext } from "../personality/types";
import { deviceRegistry } from "../devices";
import { fuseContext, RawModalityInput } from "../context/fusion";

export const sounds = {
  notification: '/sounds/notification.mp3',
  tool_exec: '/sounds/tool_exec.mp3',
};

// Perception events buffer (per user)
export const perceptionEvents: Map<string, RawModalityInput[]> = new Map();
export const MAX_PERCEPTION_EVENTS = 20;

// ── 用户级心智独占互斥表（数字生命体架构，方案2）──
// 同一用户同一时刻只能拥有一套正在运行的思考心智：key 为 userId，
// value 记录发起请求的 requestId（WebSocket agent:chat 透传，可选）与登记时间戳 startedAt。
// 锁生命周期绑定单次对话处理流程：WebSocket agent:chat 入口 set 登记、finally 块 delete 释放；
// REST /api/ai/chat 兜底请求读取本表，命中未过期锁 → 409 拒绝，杜绝双通路并行执行 runWithTools。
// 不做消息级 requestId 幂等（方案1 明确不实现）。
export interface ChatInFlightEntry {
  requestId?: string;
  startedAt: number;
}

export const chatInFlight: Map<string, ChatInFlightEntry> = new Map();

// 锁最大存活时间 60s：进程异常悬挂（runWithTools 崩溃、finally 未执行等）时锁自动过期失效，
// 防止用户会话被永久锁死。
export const CHAT_IN_FLIGHT_LOCK_TTL_MS = 60000;

// 内置过期判断：锁存在且未超过 TTL 视为活跃；锁过期则立即清除并视为不活跃（放行）。
export function isChatInFlightLockActive(userId: string, now: number = Date.now()): boolean {
  const entry = chatInFlight.get(userId);
  if (!entry) return false;
  if (now - entry.startedAt >= CHAT_IN_FLIGHT_LOCK_TTL_MS) {
    chatInFlight.delete(userId);
    return false;
  }
  return true;
}

export function getSensory(userId: string, locationTag?: string): SensoryContext {
  const ds = deviceRegistry.getSensoryContext(userId);
  const recentEvents = perceptionEvents.get(userId) || [];

  if (recentEvents.length > 0) {
    const fused = fuseContext(recentEvents, userId, locationTag);
    return fused.sensory;
  }

  return {
    audio: ds.hasAudio,
    visual: ds.hasVideo,
    spatial: ds.hasSpatial,
    haptic: ds.hasHaptic,
    holographic: ds.hasHolographic,
    activeDeviceTypes: ds.activeDeviceTypes,
    deviceCount: ds.deviceCount,
    locationTag,
  };
}
