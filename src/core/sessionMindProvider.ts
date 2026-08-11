// src/core/sessionMindProvider.ts
// Phase3：会话心智上下文注入层 — 会话维度的 InnerTick 灰度接入
//
// 职责：根据 session_id 判断是否处于灰度白名单，统一收口输出「会话运行时心智」内存对象。
//   A模式（默认，旧模式）：会话不在白名单 / 总开关关闭 → 返回旧 life 引擎读取的持久状态（原有逻辑）。
//   B模式（灰度新模式）：白名单内且总开关开启 → 读取本会话最新一条 inner_tick_snapshot 快照，
//      把 InnerTickOutput 作为本会话运行时心智源；仅本会话内存生效。
//
// ⚠️ Phase3 硬性边界（只读层）：
//   - 本模块只输出运行时内存对象，禁止写回任何旧 life 数据表（emotions/desires/personality 等），
//     也绝不修改 inner_tick_snapshot 之外的任何持久层；InnerTick 输出仅内存会话级生效。
//   - 若未来在本文件内新增任何写库调用，必须先调用 guardSessionMindPersist(目标表名) 过范式守卫；
//     向旧 life 状态表写入 InnerTick 输出将触发 [ParadigmGuard] guardSessionMindPersist 告警。
//   - 兜底保护：快照缺失 / 快照JSON损坏 / 读取异常 → 自动降级回退旧 life 心智，绝不抛异常、绝不中断对话。

import { logger } from '../../server/lib/logger';
import { MIND_SWITCH } from '../config/mindSwitch';
import { getLatestInnerTickSnapshot } from '../../server/db/lifeDb';
import { guardSessionMindPersist } from '../utils/paradigmGuard';
import type { InnerTickMood, InnerTickOutput } from '../types/innerTickSchema';

const TAG = '[Phase3-MindProvider]';

/** 会话心智模式：old_life（旧life）| inner_tick_fallback（快照异常降级旧life）| inner_tick_active（InnerTick 心智源） */
export type SessionMindMode = 'old_life' | 'inner_tick_fallback' | 'inner_tick_active';

/** 会话运行时心智对象（仅内存，不落库） */
export interface SessionMindSnapshot {
  mode: SessionMindMode;
  sessionId: string;
  /** inner_tick_snapshot 表 id；仅 inner_tick_active 模式非空，其余为 null */
  snapshotId: number | null;
  /** 情绪向量（8维）；B模式由 InnerTick mood 映射，A模式为旧life引擎向量 */
  emotionVector: number[];
  /** 人格向量（8维）；B模式沿用旧life人格（InnerTick输出无人格字段，只读回退） */
  personalityVector: number[];
  /** InnerTick 完整结构化输出；仅 inner_tick_active 模式非空，其余为 null */
  innerOutput: InnerTickOutput | null;
  /** B模式：InnerTick 输出渲染的会话心智 prompt 文本（注入对话 System Prompt）；其余模式为空串 */
  innerMindPromptText: string;
}

const DEFAULT_VECTOR = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

// 与 server/hooks/chat.ts EMOTION_LABELS 保持一致的 8 维情绪标签（mood → 情绪向量映射）
const EMOTION_LABELS = ['喜悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '依赖'];

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** InnerTick mood → 8 维情绪向量：目标情绪维度 = 强度，其余维度低基线（仅供 buildMindContext 向量接口使用） */
function emotionVectorFromMood(mood: InnerTickMood): number[] {
  const v = new Array(8).fill(0.35);
  const idx = EMOTION_LABELS.indexOf(mood.name);
  const target = idx >= 0 ? idx : 1; // 未识别情绪名 → 归为「平静」
  v[target] = clamp01(mood.intensity);
  return v;
}

/** 快照 JSON 结构完整性校验：mood 字段缺失/类型错误视为快照失效 */
function isInnerOutputShapeValid(raw: any): boolean {
  return !!raw
    && typeof raw === 'object'
    && !!raw.mood
    && typeof raw.mood.name === 'string'
    && typeof raw.mood.intensity === 'number';
}

/** B模式：InnerTick 输出渲染为会话心智 prompt 文本（情绪/欲望/目标/自我反思） */
function renderInnerMindPromptText(output: InnerTickOutput): string {
  const desires = output.desires?.length
    ? output.desires.map((d) => `${d.content}（强度${d.intensity.toFixed(2)}）`).join('；')
    : '（暂无）';
  const goals = output.goals?.length
    ? output.goals.map((g) => `${g.content}（${g.status}）`).join('；')
    : '（暂无）';
  const focus = output.focus?.length ? output.focus.map((f) => f.content).join('；') : '（暂无）';
  const hints = output.memoryHints?.length ? output.memoryHints.join('；') : '（暂无）';
  return `## 当前内心状态（InnerTick 原生心智源）
主导情绪: ${output.mood.name}（强度 ${output.mood.intensity.toFixed(2)}）
内心独白: ${output.thought || '（无）'}
活跃欲望: ${desires}
当前目标: ${goals}
注意力焦点: ${focus}
记忆线索: ${hints}`;
}

/**
 * 读取旧 life 持久状态（A模式/降级兜底的心智来源，原有逻辑）。
 * 只读引擎/库；引擎初始化异常时回退默认向量，绝不抛异常。
 */
async function loadOldLifeMind(): Promise<{ emotionVector: number[]; personalityVector: number[] }> {
  let emotionVector: number[] = DEFAULT_VECTOR.slice();
  let personalityVector: number[] = DEFAULT_VECTOR.slice();
  try {
    const { getEmotionEngine } = await import('../../server/life/emotions');
    emotionVector = getEmotionEngine().getEmotions();
  } catch (e: any) {
    logger.warn(`${TAG} 旧life情绪引擎读取失败（回退默认向量）: ${e.message}`);
  }
  try {
    const { getPersonalityEngine } = await import('../../server/life/personality');
    personalityVector = getPersonalityEngine().getPersonality();
  } catch (e: any) {
    logger.warn(`${TAG} 旧life人格引擎读取失败（回退默认向量）: ${e.message}`);
  }
  return { emotionVector, personalityVector };
}

/** 会话是否命中灰度白名单（MIND_SWITCH.overrideSessionWhitelist + 环境变量扩展，供运维灰度不停机调整） */
function isSessionWhitelisted(sessionId: string): boolean {
  if (!sessionId) return false;
  if (MIND_SWITCH.overrideSessionWhitelist.includes(sessionId)) return true;
  const envList = (process.env.PHASE3_INNER_TICK_SESSION_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return envList.includes(sessionId);
}

/**
 * 组装旧life心智快照（A模式 / 降级兜底）：只读，不写任何库。
 * mode 参数：默认 old_life（非白名单/总闸关闭）；白名单会话快照异常降级时传 inner_tick_fallback，
 * 使消费方（chat 等）能观测到「会话本应在B模式但已降级」的状态。
 */
async function buildOldLifeSnapshot(sessionId: string, mode: SessionMindMode = 'old_life'): Promise<SessionMindSnapshot> {
  const base = await loadOldLifeMind();
  return {
    mode,
    sessionId,
    snapshotId: null,
    emotionVector: base.emotionVector,
    personalityVector: base.personalityVector,
    innerOutput: null,
    innerMindPromptText: '',
  };
}

/**
 * 解析会话运行时心智（灰度入口）。
 * 返回的 SessionMindSnapshot 仅内存对象：A模式读旧life引擎；B模式读本会话最新 inner_tick_snapshot。
 * 任何异常（总闸关闭/白名单外/快照缺失/JSON损坏/DB异常）都不会抛错 —— 一律降级旧life，绝不中断对话。
 * 本函数只读，无任何写库调用。
 */
export async function resolveSessionMind(sessionId: string): Promise<SessionMindSnapshot> {
  // 总闸关闭 → 全部会话强制走旧life（A模式）
  if (!MIND_SWITCH.sessionInnerTickOverride) {
    logger.info(`${TAG} session=${sessionId} mode=old_life snapshotId=null`);
    return buildOldLifeSnapshot(sessionId);
  }

  // 不在白名单 → 走旧life（A模式）
  if (!isSessionWhitelisted(sessionId)) {
    logger.info(`${TAG} session=${sessionId} mode=old_life snapshotId=null`);
    return buildOldLifeSnapshot(sessionId);
  }

  // 白名单内且总闸开启 → 读取本会话最新一条 inner_tick_snapshot（B模式）
  try {
    const row = await getLatestInnerTickSnapshot(sessionId);

    // 兜底1：快照缺失 → 降级回退旧life，打出明确告警日志
    if (!row) {
      logger.warn(`${TAG} session=${sessionId} mode=inner_tick_fallback snapshotId=null 告警：白名单会话无InnerTick快照，自动降级回旧life心智`);
      return buildOldLifeSnapshot(sessionId, 'inner_tick_fallback');
    }

    let output: InnerTickOutput;
    try {
      output = JSON.parse(row.inner_output);
    } catch (e: any) {
      // 兜底2：快照 JSON 损坏 → 降级回退旧life，打出明确告警日志
      logger.warn(`${TAG} session=${sessionId} mode=inner_tick_fallback snapshotId=${row.id} 告警：快照JSON解析失败（${e.message}），自动降级回旧life心智`);
      return buildOldLifeSnapshot(sessionId, 'inner_tick_fallback');
    }

    if (!isInnerOutputShapeValid(output)) {
      // 兜底3：快照结构校验失败（mood 缺失等）→ 降级回退旧life，打出明确告警日志
      logger.warn(`${TAG} session=${sessionId} mode=inner_tick_fallback snapshotId=${row.id} 告警：快照结构不完整（mood 缺失），自动降级回旧life心智`);
      return buildOldLifeSnapshot(sessionId, 'inner_tick_fallback');
    }

    // B模式生效：InnerTick 输出作为本会话运行时心智源（仅内存，不写任何库）
    const base = await loadOldLifeMind();
    logger.info(`${TAG} session=${sessionId} mode=inner_tick_active snapshotId=${row.id} ` +
      `mood=${output.mood.name}(${output.mood.intensity.toFixed(2)}) desires=${output.desires?.length ?? 0} goals=${output.goals?.length ?? 0}`);
    return {
      mode: 'inner_tick_active',
      sessionId,
      snapshotId: row.id,
      emotionVector: emotionVectorFromMood(output.mood),
      personalityVector: base.personalityVector, // InnerTick 输出无人格字段，人格沿用旧life（只读）
      innerOutput: output,
      innerMindPromptText: renderInnerMindPromptText(output),
    };
  } catch (e: any) {
    // 兜底4：读取异常（DB故障等）→ 降级回退旧life，打出明确告警日志，绝不抛异常
    logger.warn(`${TAG} session=${sessionId} mode=inner_tick_fallback snapshotId=null 告警：快照读取异常（${e?.message || e}），自动降级回旧life心智`);
    return buildOldLifeSnapshot(sessionId, 'inner_tick_fallback');
  }
}

// 只读契约声明：本模块唯一允许接触的持久层数据为「读取」旧life引擎状态 与「读取」inner_tick_snapshot 观测表。
// 若未来在 resolveSessionMind / buildOldLifeSnapshot / 任何本文件函数内新增写库调用，
// 必须在其前调用 guardSessionMindPersist(目标表名, 调用点描述)；写入旧life状态表将触发范式告警。
// 此处主动挂一次守卫探针（目标表为白名单 inner_tick_snapshot，静默通过），作为契约自检入口：
guardSessionMindPersist('inner_tick_snapshot', 'sessionMindProvider 只读契约探针（无写入）');
