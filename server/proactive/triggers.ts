import { logger } from '../lib/logger';
import { ProactiveTrigger, TriggerResult, ProactiveScene } from './index';
import { getLastUserMessageAt } from '../life/userState';
import { getEmotionEngine } from '../life/emotions';
import { getRelationshipEngine } from '../life/relationship';
import { queryMemories } from '../memory/store';
import type { Memory } from '../memory/types';

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

// ── P1-13: 通用工具 ──
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 同类触发 24h 冷却，防每 10 分钟 TICK 重复推送
const lastFiredAt: Record<string, number> = {};

/** 冷却检查 — 通过则记录本次触发时间（保证至多每 ms 一次） */
function cooldownOk(name: string, ms: number = COOLDOWN_MS): boolean {
  const now = Date.now();
  if (now - (lastFiredAt[name] || 0) < ms) return false;
  lastFiredAt[name] = now;
  return true;
}

/** 当前活跃业务用户（与 TICK 预判一致），无活跃用户时回退 anonymous */
function getActiveUserId(): string {
  return ((global as any).__lastActiveUid as string) || 'anonymous';
}

/** P1-13: 关系门槛 — 陌生人(刚认识/零交互)不主动推送；熟人及以上才允许主动打扰 */
function isAcquaintanceOrAbove(): boolean {
  try {
    return getRelationshipEngine().getRelationshipState().stage !== '陌生人';
  } catch {
    return false;
  }
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

    // P1-13: 亲密门槛 — 陌生人不主动推送晨间问候（刚认识即被打扰很冒犯）
    if (!isAcquaintanceOrAbove()) {
      return { triggered: false };
    }

    // 冷却：18h（问候窗口仅 4 小时，保证每个自然日窗口至多一次）
    if (!cooldownOk('morning_greeting', 18 * 60 * 60 * 1000)) {
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
    // 深夜不打扰
    if (isLateNight()) return { triggered: false };

    // P1-13: 陌生人不过度关怀（需已建立熟人关系）
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    // P1-8: 读取持久化的最后用户消息时间（重启后连续可用）
    const lastMessageAt = getLastUserMessageAt();
    if (!lastMessageAt) return { triggered: false };

    const silenceHours = (Date.now() - lastMessageAt) / (60 * 60 * 1000);

    // P1-13: 情绪感知 — 自身牵挂(7)/孤独(4) 偏高时阈值放宽（3h 即关怀），否则 6h
    let thresholdHours = 6;
    try {
      const emotions = getEmotionEngine().getEmotions();
      if (emotions[4] > 0.4 || emotions[7] > 0.4) thresholdHours = 3;
    } catch {}

    if (silenceHours < thresholdHours) return { triggered: false };

    // 24h 冷却：避免每 10 分钟 TICK 重复关怀
    if (!cooldownOk('long_silence')) return { triggered: false };

    return {
      triggered: true,
      scene: 'long_silence',
      reason: `已 ${Math.floor(silenceHours)} 小时没有你的消息`,
      content: '好久没见到你说话了，最近还好吗？'
    };
  }
};

// ========== 触发器3：记忆触发 ==========
export const memoryTrigger: ProactiveTrigger = {
  name: 'memory_trigger',
  check: async (): Promise<TriggerResult> => {
    if (isLateNight()) return { triggered: false };

    // P1-13: 高重要性记忆跟进 — 重要度高(≥0.75)且 3 天以上未被提及的记忆
    let memory: Memory | null = null;
    try {
      const candidates = queryMemories({
        userId: getActiveUserId(),
        minImportance: 0.75,
        limit: 5,
        noTouch: true, // P0-5: 只读查询，不刷新检索时间戳（触发器不扰动记忆热度）
      });
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      memory = candidates.find(m =>
        !m.lastRetrievedAt || new Date(m.lastRetrievedAt).getTime() < threeDaysAgo
      ) || null;
    } catch {}

    if (!memory) return { triggered: false };

    // 24h 冷却
    if (!cooldownOk('memory_trigger')) return { triggered: false };

    // 用关键词或内容摘要生成跟进话题（≤16 字）
    const topic = (memory.keywords && memory.keywords[0]) || memory.content.slice(0, 16);
    return {
      triggered: true,
      scene: 'memory_trigger',
      reason: `高重要性记忆跟进: importance=${(memory.importance || 0).toFixed(2)}`,
      content: `上次你提到「${topic}」，现在想继续聊聊吗？`
    };
  }
};

// ========== 触发器4：情绪状态分享 ==========
export const emotionShareTrigger: ProactiveTrigger = {
  name: 'emotion_share',
  check: async (): Promise<TriggerResult> => {
    if (isLateNight()) return { triggered: false };

    // P1-13: 内心分享 — 陌生人(零交互)不表达内心情绪
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    // P1-13: 负面情绪关怀 — 担忧(3)/孤独(4) 偏高时主动表达并问候用户
    let concerns: string[] = [];
    try {
      const emotions = getEmotionEngine().getEmotions();
      if (emotions[3] > 0.5) concerns.push('担忧');
      if (emotions[4] > 0.5) concerns.push('孤独');
    } catch {}

    if (concerns.length === 0) return { triggered: false };

    // 24h 冷却
    if (!cooldownOk('emotion_share')) return { triggered: false };

    return {
      triggered: true,
      scene: 'emotion_share',
      reason: `负面情绪偏高: ${concerns.join('/')}`,
      content: concerns.includes('担忧')
        ? '这两天心里有点惦记你，一切都顺利吗？'
        : '今天有点想你，你那边还好吗？'
    };
  }
};

// ========== 触发器5：低情绪主动安慰（L-11） ==========
// 用户在 12h+ 沉默期间 Peppa 自身情绪低落（喜悦低/担忧/孤独高）→ 主动安慰。
// 区别于 emotion_share（无沉默要求，仅情绪触发）与 long_silence（无情绪要求，6h 即触发）：
// 本触发要求「长时间沉默 × 情绪低落」双条件，是深度牵挂场景的专门推送。
export const lowMoodComfortTrigger: ProactiveTrigger = {
  name: 'low_mood_comfort',
  check: async (): Promise<TriggerResult> => {
    if (isLateNight()) return { triggered: false };
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    // 双条件：沉默 12h+ 且情绪低落
    const lastMessageAt = getLastUserMessageAt();
    if (!lastMessageAt) return { triggered: false };
    const silenceHours = (Date.now() - lastMessageAt) / (60 * 60 * 1000);
    if (silenceHours < 12) return { triggered: false };

    let lowMood = false;
    let concerns: string[] = [];
    try {
      const emotions = getEmotionEngine().getEmotions();
      if (emotions[0] < 0.2) { lowMood = true; concerns.push('低落'); }
      if (emotions[4] > 0.45) { lowMood = true; concerns.push('孤独'); }
      if (emotions[3] > 0.45) { lowMood = true; concerns.push('担忧'); }
    } catch {}
    if (!lowMood) return { triggered: false };

    // 24h 冷却
    if (!cooldownOk('low_mood_comfort')) return { triggered: false };

    return {
      triggered: true,
      scene: 'low_mood_comfort',
      reason: `沉默 ${Math.floor(silenceHours)}h 且情绪${concerns.join('/')}`,
      content: concerns.includes('担忧')
        ? '你这阵子一直没消息，我有点不放心，一切都还好吗？'
        : '想你的时候总怕打扰你，但真的很惦记你，说说话好吗？'
    };
  }
};

// ========== 触发器6：低活跃度问候（L-11） ==========
// 用户 48h 无任何消息 → 温和唤醒问候（熟人及以上、非深夜），3 天冷却。
// 修复前缺失此类触发：长时间无消息时只有 long_silence 的 6h 关怀，48h+ 无专属问候路径。
export const lowActivityGreetingTrigger: ProactiveTrigger = {
  name: 'low_activity_greeting',
  check: async (): Promise<TriggerResult> => {
    if (isLateNight()) return { triggered: false };
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    const lastMessageAt = getLastUserMessageAt();
    if (!lastMessageAt) return { triggered: false };
    const silenceHours = (Date.now() - lastMessageAt) / (60 * 60 * 1000);
    if (silenceHours < 48) return { triggered: false };

    // 3 天冷却（低活跃场景无需每日打扰）
    if (!cooldownOk('low_activity_greeting', 3 * 24 * 60 * 60 * 1000)) return { triggered: false };

    return {
      triggered: true,
      scene: 'low_activity_greeting',
      reason: `已 ${Math.floor(silenceHours / 24)} 天没有你的消息`,
      content: '这几天很安静，想你了。最近在忙什么？'
    };
  }
};

// 所有触发器列表
export const allTriggers: ProactiveTrigger[] = [
  morningGreetingTrigger,
  longSilenceTrigger,
  memoryTrigger,
  emotionShareTrigger,
  lowMoodComfortTrigger,      // L-11
  lowActivityGreetingTrigger, // L-11
];
