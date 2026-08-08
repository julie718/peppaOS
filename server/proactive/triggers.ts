// server/proactive/triggers.ts
// 【重构·模块2】触发器动态推演 — 阈值/作息/话术全部来自 rhythm.ts 统计学习底座
// 原实现：写死 23-7 静默 / 6-10 晨间窗口 / 6h·12h·48h 沉默阈值 / 24h·18h·8h·3d 冷却 /
//         0.75 记忆重要度下限 / 3 天跟进窗口 / 固定安慰问候句子（目标④⑧⑥）。
// 重构后：静默窗口与晨间窗口由交互活跃直方图学习（deriveQuietWindow/deriveMorningWindow），
//         各沉默阈值/冷却/情绪临界/记忆跟进/行程窗口 由 deriveThresholds() 按交互间隔、关系亲近度、
//         行程提前量、记忆重要度分布派生（无数据时回落统计先验锚点 — 底层数学模型常量，保留类别⑥）；
//         推送内容经 composeTriggerContent() 由实时触发数据动态组成（心智 LLM 润色，离线回退结构化摘要）。
// 本文件不含任何固定阈值与固定话术。

import { logger } from '../lib/logger';
import { ProactiveTrigger, TriggerResult } from './index';
import { getLastUserMessageAt } from '../life/userState';
import { getEmotionEngine } from '../life/emotions';
import { getRelationshipEngine } from '../life/relationship';
import { queryMemories } from '../memory/store';
import type { Memory } from '../memory/types';
// 行程临近批量拉取推送（travel-cal-mcp，窗口由派生阈值给出）
import { pushUpcomingTravelInfo } from '../tools/mcp_servers/travel_cal';
// 统计学习底座：作息学习 / 阈值派生 / 话术数据化
import { deriveRhythmProfile, deriveThresholds, deriveMorningWindow, isQuietNow, composeTriggerContent } from './rhythm';

const HOUR = 60 * 60 * 1000;

// 当前小时（优先测试注入的强制小时，E2E 与运行时刻/时区解耦）
function currentHour(): number {
  const forced = (global as any).__forcedHour;
  return typeof forced === 'number' ? forced : new Date().getHours();
}

/** 静默窗口内是否处于给定小时（窗口本身由交互作息学习，无数据回落先验 23-7） */
function inQuietWindow(profile: ReturnType<typeof deriveRhythmProfile>, hour: number = currentHour()): boolean {
  return isQuietNow(profile, hour);
}

// ── P1-13: 通用工具 ──
const lastFiredAt: Record<string, number> = {};

/** 冷却检查 — 通过则记录本次触发时间（保证至多每 ms 一次；ms 由派生阈值给出，无全局写死冷却） */
function cooldownOk(name: string, ms: number): boolean {
  const now = Date.now();
  if (now - (lastFiredAt[name] || 0) < ms) return false;
  lastFiredAt[name] = now;
  return true;
}

/** 当前活跃业务用户（与 TICK 预判一致），无活跃用户时回退 anonymous */
function getActiveUserId(): string {
  return ((global as any).__lastActiveUid as string) || 'anonymous';
}

/** P1-13: 关系门槛 — 陌生人(刚认识/零交互)不主动推送；熟人及以上才允许主动打扰（关系状态为实时数据，非静态分支） */
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
    // 晨间窗口由交互作息学习（先验 6-10），静默窗口内一律不打扰
    const profile = deriveRhythmProfile();
    const hour = currentHour();
    if (inQuietWindow(profile, hour)) return { triggered: false };

    const w = deriveMorningWindow(profile);
    const inWindow = w.startHour <= w.endHour
      ? hour >= w.startHour && hour < w.endHour
      : hour >= w.startHour || hour < w.endHour; // 跨午夜窗口
    if (!inWindow) return { triggered: false };

    // P1-13: 亲密门槛 — 陌生人不主动推送晨间问候（刚认识即被打扰很冒犯）
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    const t = deriveThresholds(profile);
    // 冷却：派生晨间冷却（先验 18h）保证每个自然日窗口至多一次
    if (!cooldownOk('morning_greeting', t.morningCooldownMs)) return { triggered: false };

    return {
      triggered: true,
      scene: 'morning_greeting',
      reason: `清晨 ${hour} 点问候`,
      content: await composeTriggerContent('morning_greeting', { hour, stage: profile.relationshipStage, intimacy: profile.intimacy }),
    };
  }
};

// ========== 触发器2：长静默关怀 ==========
export const longSilenceTrigger: ProactiveTrigger = {
  name: 'long_silence',
  check: async (): Promise<TriggerResult> => {
    const profile = deriveRhythmProfile();
    if (inQuietWindow(profile)) return { triggered: false };

    // P1-13: 陌生人不过度关怀（需已建立熟人关系）
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    // P1-8: 读取持久化的最后用户消息时间（重启后连续可用）
    const lastMessageAt = getLastUserMessageAt();
    if (!lastMessageAt) return { triggered: false };
    const silenceMs = Date.now() - lastMessageAt;

    const t = deriveThresholds(profile);
    // 情绪感知 — 自身孤独(4)/牵挂(7) 高于派生牵挂临界时阈值放宽（×0.5 更早关怀），否则派生基础阈值
    let thresholdMs = t.longSilenceMs;
    try {
      const emotions = getEmotionEngine().getEmotions();
      if (emotions[4] > t.emotionLonelyCeil || emotions[7] > t.emotionLonelyCeil) thresholdMs = t.longSilenceMs * 0.5;
    } catch {}

    if (silenceMs < thresholdMs) return { triggered: false };

    // 派生通用冷却：避免每 10 分钟 TICK 重复关怀
    if (!cooldownOk('long_silence', t.cooldownMs)) return { triggered: false };

    return {
      triggered: true,
      scene: 'long_silence',
      reason: `已 ${Math.floor(silenceMs / HOUR)} 小时没有你的消息`,
      content: await composeTriggerContent('long_silence', { silenceHours: Math.floor(silenceMs / HOUR), stage: profile.relationshipStage }),
    };
  }
};

// ========== 触发器3：记忆触发 ==========
export const memoryTrigger: ProactiveTrigger = {
  name: 'memory_trigger',
  check: async (): Promise<TriggerResult> => {
    const profile = deriveRhythmProfile();
    if (inQuietWindow(profile)) return { triggered: false };

    const t = deriveThresholds(profile);
    // 高重要性记忆跟进 — 重要度下限（重要度分布 70 分位）与跟进窗口（派生，先验 0.75 / 3 天）均由数据派生
    let memory: Memory | null = null;
    try {
      const candidates = queryMemories({
        userId: getActiveUserId(),
        minImportance: t.memoryImportanceFloor,
        limit: 5,
        noTouch: true, // P0-5: 只读查询，不刷新检索时间戳（触发器不扰动记忆热度）
      });
      memory = candidates.find(m =>
        !m.lastRetrievedAt || Date.now() - new Date(m.lastRetrievedAt).getTime() > t.memoryFollowupMs
      ) || null;
    } catch {}

    if (!memory) return { triggered: false };

    // 派生冷却
    if (!cooldownOk('memory_trigger', t.cooldownMs)) return { triggered: false };

    // 用关键词或内容摘要生成跟进话题（≤16 字）
    const topic = (memory.keywords && memory.keywords[0]) || memory.content.slice(0, 16);
    return {
      triggered: true,
      scene: 'memory_trigger',
      reason: `高重要性记忆跟进: importance=${(memory.importance || 0).toFixed(2)}`,
      content: await composeTriggerContent('memory_trigger', { topic, importance: (memory.importance || 0).toFixed(2) }),
    };
  }
};

// ========== 触发器4：情绪状态分享 ==========
export const emotionShareTrigger: ProactiveTrigger = {
  name: 'emotion_share',
  check: async (): Promise<TriggerResult> => {
    const profile = deriveRhythmProfile();
    if (inQuietWindow(profile)) return { triggered: false };

    // P1-13: 内心分享 — 陌生人(零交互)不表达内心情绪
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    // 内心分享 — 担忧(3)/孤独(4) 高于派生牵挂临界时主动表达并问候用户
    const t = deriveThresholds(profile);
    let concerns: string[] = [];
    try {
      const emotions = getEmotionEngine().getEmotions();
      if (emotions[3] > t.emotionWorryCeil) concerns.push('担忧');
      if (emotions[4] > t.emotionLonelyCeil) concerns.push('孤独');
    } catch {}

    if (concerns.length === 0) return { triggered: false };

    // 派生冷却
    if (!cooldownOk('emotion_share', t.cooldownMs)) return { triggered: false };

    return {
      triggered: true,
      scene: 'emotion_share',
      reason: `负面情绪偏高: ${concerns.join('/')}`,
      content: await composeTriggerContent('emotion_share', { concerns: concerns.join('/'), intimacy: profile.intimacy }),
    };
  }
};

// ========== 触发器5：低情绪主动安慰（L-11） ==========
// 用户长时间沉默期间 Peppa 自身情绪低落（喜悦低于派生下限 / 孤独担忧高于派生临界）→ 主动安慰。
// 区别于 emotion_share（无沉默要求，仅情绪触发）与 long_silence（无情绪要求）：
// 本触发要求「长时间沉默 × 情绪低落」双条件，是深度牵挂场景的专门推送。
export const lowMoodComfortTrigger: ProactiveTrigger = {
  name: 'low_mood_comfort',
  check: async (): Promise<TriggerResult> => {
    const profile = deriveRhythmProfile();
    if (inQuietWindow(profile)) return { triggered: false };
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    // 双条件：沉默 ≥ 派生安慰阈值（先验 12h）且情绪低落
    const lastMessageAt = getLastUserMessageAt();
    if (!lastMessageAt) return { triggered: false };
    const silenceMs = Date.now() - lastMessageAt;

    const t = deriveThresholds(profile);
    if (silenceMs < t.comfortAfterMs) return { triggered: false };

    let lowMood = false;
    let concerns: string[] = [];
    try {
      const emotions = getEmotionEngine().getEmotions();
      if (emotions[0] < t.emotionJoyFloor) { lowMood = true; concerns.push('低落'); }
      if (emotions[4] > t.emotionLonelyCeil) { lowMood = true; concerns.push('孤独'); }
      if (emotions[3] > t.emotionWorryCeil) { lowMood = true; concerns.push('担忧'); }
    } catch {}
    if (!lowMood) return { triggered: false };

    // 派生冷却
    if (!cooldownOk('low_mood_comfort', t.cooldownMs)) return { triggered: false };

    return {
      triggered: true,
      scene: 'low_mood_comfort',
      reason: `沉默 ${Math.floor(silenceMs / HOUR)}h 且情绪${concerns.join('/')}`,
      content: await composeTriggerContent('low_mood_comfort', { silenceHours: Math.floor(silenceMs / HOUR), concerns: concerns.join('/'), intimacy: profile.intimacy }),
    };
  }
};

// ========== 触发器6：低活跃度问候（L-11） ==========
// 用户沉默 ≥ 派生问候阈值（先验 48h）→ 温和唤醒问候（熟人及以上、非静默窗口），派生冷却（先验 3 天）。
// 修复前缺失此类触发：长时间无消息时只有 long_silence 的 6h 关怀，48h+ 无专属问候路径。
export const lowActivityGreetingTrigger: ProactiveTrigger = {
  name: 'low_activity_greeting',
  check: async (): Promise<TriggerResult> => {
    const profile = deriveRhythmProfile();
    if (inQuietWindow(profile)) return { triggered: false };
    if (!isAcquaintanceOrAbove()) return { triggered: false };

    const lastMessageAt = getLastUserMessageAt();
    if (!lastMessageAt) return { triggered: false };
    const silenceMs = Date.now() - lastMessageAt;

    const t = deriveThresholds(profile);
    if (silenceMs < t.greetingAfterMs) return { triggered: false };

    // 低活跃问候冷却（派生，先验 3 天 — 低活跃场景无需每日打扰）
    if (!cooldownOk('low_activity_greeting', t.lowActivityCooldownMs)) return { triggered: false };

    return {
      triggered: true,
      scene: 'low_activity_greeting',
      reason: `已 ${Math.floor(silenceMs / (24 * HOUR))} 天没有你的消息`,
      content: await composeTriggerContent('low_activity_greeting', { silenceDays: Math.floor(silenceMs / (24 * HOUR)), stage: profile.relationshipStage }),
    };
  }
};

// ========== 触发器7：行程临近批量拉取推送（阶段一·模块2） ==========
// 派生窗口（先验 72h）内出发的行程 → 批量拉取行程+目的地天气信息推送；派生冷却（先验 8h）防重复。
// 无活跃业务用户时跳过（与 TICK 预判一致）。
export const travelUpcomingTrigger: ProactiveTrigger = {
  name: 'travel_upcoming',
  check: async (): Promise<TriggerResult> => {
    const userId = getActiveUserId();
    if (!userId || userId === 'anonymous') return { triggered: false };

    const profile = deriveRhythmProfile();
    if (inQuietWindow(profile)) return { triggered: false };

    const t = deriveThresholds(profile);
    if (!cooldownOk('travel_upcoming', t.travelCooldownMs)) return { triggered: false };

    let pushed = 0;
    try {
      pushed = await pushUpcomingTravelInfo(userId, t.travelWindowHours);
    } catch (e: any) {
      logger.warn(`[Proactive] 行程临近检查失败: ${e?.message}`);
      return { triggered: false };
    }
    if (pushed <= 0) return { triggered: false };

    return {
      triggered: true,
      scene: 'travel_upcoming',
      reason: `${pushed} 个行程 ${Math.round(t.travelWindowHours)}h 内临近`,
      content: await composeTriggerContent('travel_upcoming', { pushed, windowHours: Math.round(t.travelWindowHours) }),
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
  travelUpcomingTrigger,      // 阶段一·模块2: 行程临近批量推送
];
