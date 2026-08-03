import { logger } from '../lib/logger';
import { ProactiveTrigger, TriggerResult, ProactiveScene } from './index';

// 获取当前时间
function getHour(): number {
  return new Date().getHours();
}

// 检查是否在深夜（23-7点）
function isLateNight(): boolean {
  const hour = getHour();
  return hour >= 23 || hour < 7;
}

// 检查是否在清晨（6-10点）
function isMorning(): boolean {
  const hour = getHour();
  return hour >= 6 && hour <= 10;
}

// ========== 触发器1：晨间问候 ==========
export const morningGreetingTrigger: ProactiveTrigger = {
  name: 'morning_greeting',
  check: async (): Promise<TriggerResult> => {
    const hour = new Date().getHours();

    // 时间检查：6:00-10:00
    if (hour < 6 || hour > 10) {
      return { triggered: false };
    }

    // 触发成功
    return {
      triggered: true,
      scene: 'morning_greeting',
      reason: `清晨 ${hour} 点问候`,
      content: '早上好！今天有什么计划吗？'
    };
  }
};

// ========== 触发器2：长静默关怀 ==========
export const longSilenceTrigger: ProactiveTrigger = {
  name: 'long_silence',
  check: async (): Promise<TriggerResult> => {
    // TODO: 检查上次用户消息时间
    // TODO: 检查是否超过6小时
    return { triggered: false };
  }
};

// ========== 触发器3：记忆触发 ==========
export const memoryTrigger: ProactiveTrigger = {
  name: 'memory_trigger',
  check: async (): Promise<TriggerResult> => {
    // TODO: 检查是否有高重要性记忆需要跟进
    return { triggered: false };
  }
};

// ========== 触发器4：情绪状态分享 ==========
export const emotionShareTrigger: ProactiveTrigger = {
  name: 'emotion_share',
  check: async (): Promise<TriggerResult> => {
    // TODO: 检查情绪状态变化
    return { triggered: false };
  }
};

// 所有触发器列表
export const allTriggers: ProactiveTrigger[] = [
  morningGreetingTrigger,
  longSilenceTrigger,
  memoryTrigger,
  emotionShareTrigger,
];
