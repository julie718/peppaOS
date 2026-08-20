import { Socket, Server } from "socket.io";
import { logger } from '../lib/logger';
import { enqueuePerceptionEvent } from '../perception/queue';
import { loadEmotionalState, saveEmotionalState, updateEmotionalState } from "../personality/state";

function socketGuard(fn: (...args: any[]) => void | Promise<void>) {
  return (...args: any[]) => {
    try {
      const ret = fn(...args);
      if (ret && typeof (ret as any).catch === 'function') {
        (ret as any).catch((e: any) => logger.error('[Perception] Handler error:', e.message || String(e)));
      }
    } catch (e: any) {
      logger.error('[Perception] Handler error:', e.message || String(e));
    }
  };
}

// Phase2 模块1 感知事件队列接入：所有感知事件经 enqueuePerceptionEvent 统一入队
// （内存队列 → 满则落 SQLite 后备表，空闲回捞，超时丢弃）。
// 日志策略：普通琐碎感知事件不写 perception.log（仅异常/越界/溢出/超时丢弃写该日志，
// 由 server/perception/queue.ts 统一输出）。

export function registerPerceptionHandlers(socket: Socket, getUserId: (s: Socket) => string, _io: Server) {
  socket.on("perception:visual_scene", socketGuard((data: { description: string; objects?: string[]; faces?: number }) => {
    const uid = getUserId(socket);
    enqueuePerceptionEvent(uid, {
      modality: 'visual',
      deviceId: socket.id,
      timestamp: new Date().toISOString(),
      data,
    });
  }));

  socket.on("perception:audio_emotion", socketGuard((data: { emotion: string; intensity?: number }) => {
    const uid = getUserId(socket);
    enqueuePerceptionEvent(uid, {
      modality: 'audio',
      deviceId: socket.id,
      timestamp: new Date().toISOString(),
      data,
    });

    if (uid !== 'anonymous') {
      const emotionImpact: Record<string, number> = {
        happy: 0.5, excited: 0.4, calm: 0.1,
        sad: -0.3, angry: -0.5, frustrated: -0.4,
        neutral: 0,
      };
      const intensity = (emotionImpact[data.emotion] || 0) * (data.intensity || 0.5);
      if (Math.abs(intensity) > 0.05) {
        const state = loadEmotionalState(uid);
        const eventType = intensity > 0 ? 'positive_feedback' : 'negative_feedback';
        const updated = updateEmotionalState(state, {
          type: eventType,
          intensity: Math.abs(intensity),
          userId: uid,
          timestamp: new Date().toISOString(),
        });
        saveEmotionalState(uid, updated);
      }
    }
  }));

  socket.on("perception:spatial_update", socketGuard((data: { roomType?: string; dimensions?: { x: number; y: number; z: number } }) => {
    const uid = getUserId(socket);
    enqueuePerceptionEvent(uid, {
      modality: 'spatial',
      deviceId: socket.id,
      timestamp: new Date().toISOString(),
      data,
    });
  }));
}
