// server/proactive/rhythm.ts
// 【重构·模块2】主动行为触发引擎 — 动态多维推演底座
// 原实现：写死固定阈值（23-7 静默 / 48h 问候 / 13h 关怀 / 72h 行程窗口 / 情绪临界 / 24h 冷却）。
// 重构后：所有阈值由用户交互数据统计派生（作息活跃度直方图、交互间隔中位数、关系阶段、行程提前量）。
//
// 先验锚点说明：统计学习在数据不足（样本 < 3）时必须具备初始锚点才能启动，
// 以下 PRIOR_* 常量属于「底层数学模型常量」（保留类别⑥，同情绪收敛系数/人格冷却周期），
// 并非行为逻辑中的固化阈值 —— 有足够交互数据后全部由数据估计主导。
// 本文件是全域阈值唯一出处，行为判断一律经 deriveThresholds() 取派生值。

import { logger } from '../lib/logger';
import { getRelationshipEngine } from '../life/relationship';
import { getLastUserMessageAt } from '../life/userState';
import { queryMemories } from '../memory/store';
import { getEmotionEngine } from '../life/emotions';
// 【重构·校验修复】require → 静态 import：providers/user_preferences 无 proactive 依赖环（已核实），
// 原 require('../llm/adapter') 解构的 makeLLMCall 实际未从 adapter 导出（恒 undefined），
// 且 ESM 环境（tsx）下 require 未定义 → 润色分支从未生效，仅离线摘要可用。现修复为正确来源。
import { makeLLMCall } from '../llm/providers';
import { getScenarioModel } from '../llm/user_preferences';

// ── 统计先验锚点（底层数学模型常量，文档化，仅无数据时启用） ──
const PRIOR = {
  QUIET_START_HOUR: 23,        // 静默窗口起始（先验：23 点后不打扰）
  QUIET_END_HOUR: 7,           // 静默窗口结束（先验：7 点前不打扰）
  MORNING_START_HOUR: 6,       // 晨间窗口起始（先验）
  MORNING_END_HOUR: 10,        // 晨间窗口结束（先验）
  COMFORT_AFTER_HOURS: 12,     // 低情绪关怀沉默阈值（先验：12h）
  GREETING_AFTER_HOURS: 48,    // 低活跃问候沉默阈值（先验：48h）
  LONG_SILENCE_HOURS: 6,       // 长静默关怀基础阈值（先验：6h）
  TRAVEL_WINDOW_HOURS: 72,     // 行程临近推送窗口（先验：72h）
  COOLDOWN_HOURS: 24,          // 同类触发冷却（先验：24h）
  MORNING_COOLDOWN_HOURS: 18,  // 晨间问候冷却（先验：18h）
  TRAVEL_COOLDOWN_HOURS: 8,    // 行程推送冷却（先验：8h）
  LOW_ACTIVITY_COOLDOWN_DAYS: 3, // 低活跃问候冷却（先验：3 天）
  MEMORY_FOLLOWUP_DAYS: 3,     // 高重要性记忆跟进窗口（先验：3 天）
  MEMORY_IMPORTANCE_FLOOR: 0.75, // 记忆跟进重要度下限（先验）
  EMOTION_JOY_FLOOR: 0.2,      // 喜悦过低判低落（先验）
  EMOTION_WORRY_CEIL: 0.45,    // 担忧过高判牵挂（先验）
  EMOTION_LONELY_CEIL: 0.45,   // 孤独过高判牵挂（先验）
  EMOTION_SHARE_CEIL: 0.5,     // 情绪分享触发临界（先验）
  MIN_SAMPLES: 3,              // 数据驱动生效的最小样本量
} as const;

const HOUR = 60 * 60 * 1000;

export interface RhythmProfile {
  /** 交互间隔统计（小时） */
  medianGapHours: number | null;
  sampleCount: number;
  /** 活跃小时直方图（0-23 → 交互次数） */
  activeHourHistogram: number[];
  /** 关系阶段（'陌生人'|...） */
  relationshipStage: string;
  /** 情感亲近度 0-1（熟人以上才可能 >0.3） */
  intimacy: number;
  /** 当前静默时长（小时），无记录为 null */
  silenceHours: number | null;
  /** 情绪向量（8 维），取不到为 null */
  emotionVector: number[] | null;
  /** 行程提前量统计（出发-创建 小时），无行程为 null */
  travelLeadHours: number[] | null;
  /** 记忆重要度分布（已取重要度值列表） */
  memoryImportances: number[];
}

// ── 交互数据采集 ──
function readInteractionTimestamps(): number[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getSignificantMemories } = require('../db/lifeDb');
    // 异步接口无法在同步 TICK 中等待，退回同步 SQL 读取
    const { readDB } = require('../../db_layer');
    const db = readDB();
    const rows = (db.interaction_memories || []).map((m: any) => ({
      ts: new Date(m.created_at || m.createdAt || 0).getTime(),
      score: m.significance_score ?? m.significance ?? 0,
    }));
    return rows
      .filter(r => r.ts > 0 && r.score >= 0.1)
      .map(r => r.ts);
  } catch {
    return [];
  }
}

function readTravelItineraries(): number[] {
  try {
    const { readDB } = require('../../db_layer');
    const db = readDB();
    return (db.travel_itineraries || [])
      .filter((t: any) => t.depart_at && t.created_at)
      .map((t: any) => (new Date(t.depart_at).getTime() - new Date(t.created_at).getTime()) / HOUR)
      .filter((h: number) => h > 0);
  } catch {
    return [];
  }
}

/** 中位数（小时） */
function medianHours(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 生成活跃小时直方图（交互时间 → 小时桶） */
function buildHourHistogram(timestamps: number[]): number[] {
  const hist = new Array(24).fill(0) as number[];
  for (const ts of timestamps) {
    const h = new Date(ts).getHours();
    if (h >= 0 && h <= 23) hist[h]++;
  }
  return hist;
}

/** 采集并组装节奏画像（纯数据读取，无任何行为判断） */
export function deriveRhythmProfile(): RhythmProfile {
  const timestamps = readInteractionTimestamps();
  const hist = buildHourHistogram(timestamps);

  // 交互间隔：排序后相邻差
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = (sorted[i] - sorted[i - 1]) / HOUR;
    if (g > 0 && g < 24 * 30) gaps.push(g); // 剔除 >30 天的断层（长期离线不算作息）
  }

  let stage = '陌生人';
  let intimacy = 0;
  try {
    const rel = getRelationshipEngine().getRelationshipState();
    stage = rel.stage;
      // 亲密感维度（vector[1] 已在 0.05..1 数据层归一，见 relationship.ts DIM_LABELS）作为亲近度信号
      intimacy = (typeof rel.vector === 'object' && typeof rel.vector[1] === 'number') ? Math.min(1, Math.max(0, rel.vector[1])) : 0;
  } catch {}

  let emotionVector: number[] | null = null;
  try {
    const emo = getEmotionEngine().getEmotions();
    if (Array.isArray(emo) && emo.length >= 8) emotionVector = emo;
  } catch {}

  let memoryImportances: number[] = [];
  try {
    memoryImportances = queryMemories({ userId: ((global as any).__lastActiveUid as string) || 'anonymous', limit: 100, noTouch: true })
      .map(m => m.importance ?? 0)
      .filter(i => i > 0);
  } catch {}

  return {
    medianGapHours: medianHours(gaps),
    sampleCount: gaps.length,
    activeHourHistogram: hist,
    relationshipStage: stage,
    intimacy,
    silenceHours: (() => {
      const last = getLastUserMessageAt();
      return last ? (Date.now() - last) / HOUR : null;
    })(),
    emotionVector,
    travelLeadHours: (() => {
      const leads = readTravelItineraries();
      return leads.length > 0 ? leads : null;
    })(),
    memoryImportances,
  };
}

// ── 作息窗口学习 ──
export interface QuietWindow {
  startHour: number;
  endHour: number;
}

/**
 * 夜间静默窗口：学习用户活跃作息。
 * 直方图中"几乎无交互"的连续时段（≤ 峰值 10%）即为用户休息窗口；
 * 无数据时退回先验 23-7。
 */
export function deriveQuietWindow(profile: RhythmProfile): QuietWindow {
  const hist = profile.activeHourHistogram;
  const peak = Math.max(...hist);
  if (peak <= 0) return { startHour: PRIOR.QUIET_START_HOUR, endHour: PRIOR.QUIET_END_HOUR };

  const quiet = hist.map((v) => v <= peak * 0.1);
  // 找最长的静默连续段（环形，跨午夜视为同一段）
  let bestStart: number = PRIOR.QUIET_START_HOUR;
  let bestLen = 0;
  for (let s = 0; s < 24; s++) {
    if (!quiet[s]) continue;
    let len = 0;
    let h = s;
    while (quiet[h % 24]) { len++; h++; if (len > 24) break; }
    if (len > bestLen) { bestLen = len; bestStart = s; }
  }
  if (bestLen < 4) return { startHour: PRIOR.QUIET_START_HOUR, endHour: PRIOR.QUIET_END_HOUR };
  return { startHour: bestStart, endHour: (bestStart + bestLen) % 24 };
}

export function isQuietNow(profile: RhythmProfile, hour: number = new Date().getHours()): boolean {
  const w = deriveQuietWindow(profile);
  if (w.startHour <= w.endHour) return hour >= w.startHour && hour < w.endHour;
  return hour >= w.startHour || hour < w.endHour; // 跨午夜
}

/** 晨间窗口：学习得到的静默窗口结束后的活跃时段（先验 6-10） */
export function deriveMorningWindow(profile: RhythmProfile): QuietWindow {
  const quiet = deriveQuietWindow(profile);
  if (quiet.startHour === PRIOR.QUIET_START_HOUR && quiet.endHour === PRIOR.QUIET_END_HOUR) {
    return { startHour: PRIOR.MORNING_START_HOUR, endHour: PRIOR.MORNING_END_HOUR };
  }
  // 静默窗口结束后的前 4 小时即晨间
  const start = quiet.endHour;
  return { startHour: start, endHour: (start + 4) % 24 };
}

// ── 阈值派生（全部由画像数据计算，先验仅作锚点） ──
export interface DerivedThresholds {
  comfortAfterMs: number;      // 低情绪关怀沉默阈值
  longSilenceMs: number;       // 长静默关怀阈值
  greetingAfterMs: number;     // 低活跃问候阈值
  travelWindowHours: number;   // 行程临近窗口
  cooldownMs: number;          // 通用冷却
  morningCooldownMs: number;   // 晨间问候冷却
  travelCooldownMs: number;    // 行程推送冷却
  lowActivityCooldownMs: number; // 低活跃问候冷却
  memoryFollowupMs: number;    // 记忆跟进窗口
  memoryImportanceFloor: number; // 记忆跟进重要度下限
  emotionJoyFloor: number;     // 喜悦低落临界
  emotionWorryCeil: number;    // 担忧牵挂临界
  emotionLonelyCeil: number;   // 孤独牵挂临界
  emotionShareCeil: number;    // 情绪分享临界
}

/**
 * 全量阈值派生：
 * - 交互间隔中位数主导沉默阈值与冷却（用户回复越快，关怀阈值越紧凑）
 * - 关系亲近度放宽情绪牵挂临界（越亲近越容易牵挂）
 * - 行程提前量中位数主导行程窗口（用户习惯提前多久规划，就提前多久提醒）
 * - 记忆重要度 70 分位主导跟进下限
 */
export function deriveThresholds(profile: RhythmProfile): DerivedThresholds {
  const gap = profile.medianGapHours;

  // 沉默阈值：先验 × 间隔归一（24h 间隔 → 先验值；间隔越大阈值越长）
  const gapFactor = gap && gap > 0 ? Math.max(0.6, Math.min(2, gap / 24)) : 1;
  const comfortAfterMs = PRIOR.COMFORT_AFTER_HOURS * gapFactor * HOUR;
  const greetingAfterMs = PRIOR.GREETING_AFTER_HOURS * gapFactor * HOUR;
  const longSilenceMs = PRIOR.LONG_SILENCE_HOURS * gapFactor * HOUR;

  // 冷却：交互越频繁冷却越短（≤ 先验），越稀疏冷却越长
  const cooldownFactor = gap && gap > 0 ? Math.max(0.5, Math.min(2, 24 / gap)) : 1;
  const cooldownMs = PRIOR.COOLDOWN_HOURS * cooldownFactor * HOUR;
  const morningCooldownMs = PRIOR.MORNING_COOLDOWN_HOURS * cooldownFactor * HOUR;
  const travelCooldownMs = PRIOR.TRAVEL_COOLDOWN_HOURS * cooldownFactor * HOUR;
  const lowActivityCooldownMs = PRIOR.LOW_ACTIVITY_COOLDOWN_DAYS * 24 * cooldownFactor * HOUR;

  // 情绪临界：亲近度越高牵挂越敏锐（临界放宽 = 更易触发关怀；下限下调、上限下调）
  const careSensitivity = profile.intimacy > 0.5 ? 1.15 : profile.intimacy > 0.2 ? 1.08 : 1;
  const emotionJoyFloor = PRIOR.EMOTION_JOY_FLOOR / careSensitivity;
  const emotionWorryCeil = PRIOR.EMOTION_WORRY_CEIL / careSensitivity;
  const emotionLonelyCeil = PRIOR.EMOTION_LONELY_CEIL / careSensitivity;
  const emotionShareCeil = PRIOR.EMOTION_SHARE_CEIL / careSensitivity;

  // 行程窗口：提前量中位数 × 1.2（留出余量），无数据先验 72h
  const travelWindowHours = profile.travelLeadHours && profile.travelLeadHours.length >= PRIOR.MIN_SAMPLES
    ? Math.max(12, Math.min(168, (medianHours(profile.travelLeadHours) || PRIOR.TRAVEL_WINDOW_HOURS) * 1.2))
    : PRIOR.TRAVEL_WINDOW_HOURS;

  // 记忆跟进：重要度 70 分位；无数据先验
  let memoryImportanceFloor: number = PRIOR.MEMORY_IMPORTANCE_FLOOR;
  if (profile.memoryImportances.length >= PRIOR.MIN_SAMPLES) {
    const sorted = [...profile.memoryImportances].sort((a, b) => a - b);
    memoryImportanceFloor = Math.max(0.5, sorted[Math.floor(sorted.length * 0.7)]);
  }
  const memoryFollowupMs = PRIOR.MEMORY_FOLLOWUP_DAYS * gapFactor * 24 * HOUR;

  return {
    comfortAfterMs,
    longSilenceMs,
    greetingAfterMs,
    travelWindowHours,
    cooldownMs,
    morningCooldownMs,
    travelCooldownMs,
    lowActivityCooldownMs,
    memoryFollowupMs,
    memoryImportanceFloor,
    emotionJoyFloor,
    emotionWorryCeil,
    emotionLonelyCeil,
    emotionShareCeil,
  };
}

// ── 话术数据化（替代固定安慰/问候句子，随触发数据动态组成） ──

/**
 * 由触发数据动态组成推送内容（无固定句子，全部字段来自实时状态）。
 * 有 LLM Getter 时交给心智内核润色为个性化表达；离线时回退为结构化摘要（容灾）。
 */
export async function composeTriggerContent(
  scene: string,
  data: Record<string, string | number>,
): Promise<string> {
  const summary = Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');

  try {
    const g = ((global as any).__llmGetters || {}) as Record<string, (() => any) | undefined>;
    const getter = (name: string): (() => any) => g[name] || (() => null);
    if (g.getDeepSeek || g.getGemini) {
      // 模型走档位配置（light 场景轻量模型，见 user_preferences 场景分层路由），不写死模型名
      const prompt = `你是 Peppa，请基于以下触发数据，用一句温暖自然、不模板化的话主动联系用户（不超过 40 字，不要提到"触发""场景"等工程词，不要重复数据原文）：\n场景: ${scene}\n数据: ${summary}`;
      const result = await makeLLMCall(
        [{ role: 'system', content: prompt }, { role: 'user', content: '请输出那句话。' }],
        [],
        { provider: 'deepseek', model: getScenarioModel('deepseek', 'light'), userId: 'proactive', maxTokens: 60, scene: 'proactive' },
        getter('getDeepSeek'), getter('getGemini'), getter('getOpenAI'),
        getter('getAnthropic'), getter('getQwen'), getter('getOllama'),
        getter('getLmStudio'), getter('getArk'), getter('getXiaomi'),
        getter('getKimi'), getter('getGlm'), getter('getRelay'),
      );
      const text = (result.text || '').trim();
      if (text && text.length >= 4 && text.length <= 80) return text;
    }
  } catch (e: any) {
    logger.warn(`[Rhythm] 主动消息心智润色不可用，回退结构化摘要: ${e?.message || e}`);
  }
  return `[${scene}] ${summary}`;
}
