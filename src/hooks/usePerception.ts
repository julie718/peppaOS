import { useCallback, useEffect, useRef } from 'react';
import { useSocket } from './useSocket';

/**
 * Hook for pushing multimodal perception events to the server's fusion layer.
 * Components capture sensor data and push it here; the server fuses it into
 * the sensory context that Peppa sees in every system prompt.
 */
export function usePerception() {
  const socket = useSocket();

  const pushVisualScene = useCallback((description: string, objects?: string[], faces?: number) => {
    if (!socket?.connected) return;
    socket.emit('perception:visual_scene', { description, objects, faces });
  }, [socket]);

  const pushAudioEmotion = useCallback((emotion: string, intensity?: number) => {
    if (!socket?.connected) return;
    socket.emit('perception:audio_emotion', { emotion, intensity: intensity ?? 0.5 });
  }, [socket]);

  const pushSpatialUpdate = useCallback((roomType?: string, dimensions?: { x: number; y: number; z: number }) => {
    if (!socket?.connected) return;
    socket.emit('perception:spatial_update', { roomType, dimensions });
  }, [socket]);

  return { pushVisualScene, pushAudioEmotion, pushSpatialUpdate };
}

// ── 感知特征向量提取 Hook ──
// 12维固定顺序向量，通过 perception:update 发送到 NAS

interface HealthData {
  heartRate: number | null;
  hrv: number | null;
  steps: number | null;
  timestamp: string | null;
}

interface PerceptionVectorOptions {
  /** 健康数据源（来自 useHealth） */
  healthData: HealthData;
  /** 静息心率基线 */
  restingHRBaseline?: number;
  /** 场景标签: home/office/commute/sleep/mall/other */
  sceneLabel?: string;
  /** 环境类型: quiet/office/cafe/street/noisy */
  environmentType?: string;
  /** 过去5分钟亮屏时间占比 0-1 */
  screenActiveRatio?: number;
  /** 今日日历事件数 */
  calendarEvents?: number;
  /** 昨晚深睡占比 0-1 */
  deepSleepRatio?: number;
  /** 是否启用 */
  enabled?: boolean;
}

const IDLE_INTERVAL = 60000;
const ACTIVE_INTERVAL = 15000;

const SCENE_MAP: Record<string, number> = {
  home: 0.1, office: 0.2, commute: 0.3, sleep: 0.4, mall: 0.5,
};
const ENV_MAP: Record<string, number> = {
  quiet: 0.1, office: 0.2, cafe: 0.3, street: 0.4, noisy: 0.5,
};

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 提取 12 维感知特征向量 */
function extractVector(opts: {
  health: HealthData;
  restingHRBaseline: number;
  sceneLabel: string;
  environmentType: string;
  screenActiveRatio: number;
  calendarEvents: number;
  deepSleepRatio: number;
}): number[] {
  const { health, restingHRBaseline, sceneLabel, environmentType, screenActiveRatio, calendarEvents, deepSleepRatio } = opts;

  const hr = health.heartRate ?? 0;
  const hrv = health.hrv ?? 0;
  const steps = health.steps ?? 0;

  // [0] 心率归一化
  const hrNorm = clamp(hr / 200);
  // [1] HRV 归一化
  const hrvNorm = clamp(hrv / 100);
  // [2] 睡眠质量
  const sleepQuality = clamp(deepSleepRatio / 0.3);
  // [3] 静息心率偏离
  const restingHR = health.heartRate ?? restingHRBaseline;
  const restingHRDeviation = restingHRBaseline > 0
    ? clamp(Math.abs(restingHR - restingHRBaseline) / restingHRBaseline)
    : 0;
  // [4] 步数活跃度
  const stepActivity = clamp(steps / 10000);
  // [5] 场景标签编码
  const sceneCode = SCENE_MAP[sceneLabel] ?? 0.0;
  // [6] 环境类型编码
  const envCode = ENV_MAP[environmentType] ?? 0.0;
  // [7] 屏幕活跃度
  const screenActivity = clamp(screenActiveRatio);
  // [8] 时间周期编码
  const timePhase = new Date().getHours() / 24;
  // [9] 日历压力指数
  const calendarPressure = clamp(calendarEvents / 10);
  // [10] 情绪唤醒度：心率高 + HRV低 → 高唤醒
  const arousal = clamp((hrNorm * 0.6 + (1 - hrvNorm) * 0.4));
  // [11] 疲劳指数
  const fatigue = clamp((1 - sleepQuality) * 0.5 + stepActivity * 0.3 + hrNorm * 0.2);

  return [
    hrNorm, hrvNorm, sleepQuality, restingHRDeviation,
    stepActivity, sceneCode, envCode, screenActivity,
    timePhase, calendarPressure, arousal, fatigue,
  ];
}

function validateVector(v: number[]): boolean {
  if (v.length !== 12) return false;
  return v.every(x => typeof x === 'number' && !isNaN(x) && x >= 0 && x <= 1);
}

export function usePerceptionVector(opts: PerceptionVectorOptions) {
  const {
    healthData,
    restingHRBaseline = 65,
    sceneLabel = '',
    environmentType = '',
    screenActiveRatio = 0,
    calendarEvents = 0,
    deepSleepRatio = 0,
    enabled = false,
  } = opts;

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef = useRef(false);
  const errorCountRef = useRef(0);
  const socket = useSocket();

  const isActive = useCallback((): boolean => {
    const hr = healthData.heartRate ?? 0;
    const steps = healthData.steps ?? 0;
    return hr > 90 || steps > 100;
  }, [healthData]);

  useEffect(() => {
    if (!enabled) return;

    const send = () => {
      if (sendingRef.current) return; // 防堆积
      sendingRef.current = true;

      try {
        const vector = extractVector({
          health: healthData,
          restingHRBaseline,
          sceneLabel,
          environmentType,
          screenActiveRatio,
          calendarEvents,
          deepSleepRatio,
        });

        if (!validateVector(vector)) {
          errorCountRef.current++;
          console.warn('[PerceptionVector] 异常数据，丢弃', { vector, count: errorCountRef.current });
          if (errorCountRef.current >= 3) {
            console.error('[PerceptionVector] 连续3次异常，暂停发送');
            if (intervalRef.current) clearInterval(intervalRef.current);
          }
          sendingRef.current = false;
          return;
        }

        errorCountRef.current = 0; // 重置错误计数

        const ws = (window as any).__peppaWS;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'perception:update',
            payload: { vector, timestamp: new Date().toISOString() },
          }));
        }

        // 同时走 Socket.IO 通道
        if (socket?.connected) {
          socket.emit('perception:update', {
            vector,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn('[PerceptionVector] 发送失败:', err);
      }

      sendingRef.current = false;
    };

    // 首次立即发送
    send();

    // 自适应频率
    const tick = () => {
      const interval = isActive() ? ACTIVE_INTERVAL : IDLE_INTERVAL;
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(send, interval);
    };

    tick();
    // 每30秒重新评估活跃度
    const assessTimer = setInterval(tick, 30000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearInterval(assessTimer);
    };
  }, [enabled, healthData, restingHRBaseline, sceneLabel, environmentType, screenActiveRatio, calendarEvents, deepSleepRatio, isActive]);

  return { isActive: isActive(), errorCount: errorCountRef.current };
}
