// src/core/innerTick.ts
// 阶段1：InnerTick 独立心智回合模块 — 完全由 LLM 驱动的心理推演
//
// ⚠️ 本阶段硬性边界（Phase1）：
//   - 仅作为独立库组件，不接管系统主控、不替换旧 life TICK（server/life/index.ts 状态机继续完整运行）。
//   - InnerTick：数字生命体原生心智回合底座；可在chat结束、空闲时机触发；只输出结构化心智快照，落库life.db与向量记忆，不直接修改运行时状态，不接管对话输出。
//   - runInnerTick() 执行完成不修改任何全局运行状态，仅返回结构化对象 + 写入 life.db 快照备份。
//   - life.db 历史快照只作为 prompt 素材渲染为文本，严禁直接拿快照对象赋值给运行状态。
//
// ⚠️ Phase2 边界（对话链路触发）：
//   - chat 每轮对话结束后由 socket/chat.ts 异步非阻塞触发 runInnerTick（传入 sessionId / 对话上下文摘要 / triggerSource='chat_turn'）。
//   - 完整输出另写独立观测表 inner_tick_snapshot（session_id/user_uid/turn_index/inner_output/trigger_source），
//     只做观测对比；严禁 InnerTick 输出覆盖/修改旧 life 状态表（emotions/desires/personality/memory 等）——写入前经 guardInnerTickLifeOverwrite 守卫校验。
//
// 心智回合内容（欲望生成/衰减、情绪变化、目标归档）全部由 LLM 推理生成。

import { makeLLMCall, NormalizedMessage } from '../../server/llm/providers';
import type { NormalizedLLMResponse } from '../../server/tools/types';
import { createLLMRuntime } from '../../server/runtime/llm';
import type { LLMClients } from '../../server/runtime/llm';
import { getUserPreferredLLMConfig } from '../../server/llm/user_preferences';
// Phase-2 综合修复：休眠模式 prompt 瘦身（inner_tick 非活跃模式减少召回记忆条数）
import { getRhythmMode } from '../../server/runtime/rhythm';
import { MIND_SWITCH } from '../config/mindSwitch';
import { addMemory } from '../../server/memory/store';
import {
  guardIllegalAddMemory,
  guardInnerTickLifeOverwrite,
  guardP2MentalStateWrite,
  isP2MigrateEnabled,
} from '../utils/paradigmGuard';
import {
  getPersonality,
  getRecentEmotions,
  getActiveDesires,
  getTopDesire,
  getRecentReflections,
  getSignificantMemories,
  getLatestRelationship,
  getRecentEvents,
  getUnresolvedThoughts,
  logSystemEvent,
  insertInnerTickSnapshot,
  countInnerTickSnapshots,
  addEmotion,
  addDesire,
  updateDesirePriority,
  updateDesireStatus,
  updatePersonality,
  recordPersonalityEvolution,
  saveRelationshipVector,
  loadRelationshipState,
} from '../../server/db/lifeDb';
import { logger } from '../../server/lib/logger';
import type {
  InnerTickOutput,
  InnerTickMood,
  InnerTickDesire,
  InnerTickGoal,
  InnerTickFocus,
  InnerTickArchiveItem,
  MentalEventItem,
  InnerTickEmotionDrift,
  InnerTickDesireEvolve,
  InnerTickPersonalityDrift,
  InnerTickRelationshipAdjustment,
} from '../types/innerTickSchema';

const TAG = '[InnerTick]';
const TAG_RETRY = '[InnerTick-RETRY]';
const TAG_WARN = '[InnerTick-WARN]';
const TAG_ERROR = '[InnerTick-ERROR]';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * InnerTick LLM 推演失败分类（超时/格式/空content 的明确区分，供分级日志与兜底决策使用）：
 *  - llm_timeout     ：LLM 调用超过 mindSwitch.innerTickLLMTimeoutMs 阈值被 AbortController 中止；
 *  - reasoning_only  ：模型只输出 reasoning、content 为空（审计观测到的 deepseek-v4-flash 已知异常）；
 *  - empty_content   ：模型返回纯空 content（无 reasoning 也无文本）；
 *  - parse_error     ：模型返回文本无法解析为 schema JSON；
 *  - unknown         ：其他未归类失败。
 */
type InnerTickLLMFailureKind = 'llm_timeout' | 'reasoning_only' | 'empty_content' | 'parse_error' | 'unknown';

class InnerTickLLMError extends Error {
  readonly kind: InnerTickLLMFailureKind;
  /** 附加失败上下文（如 reasoning_only 时携带模型思考链原文，供降级抽取心智信息） */
  readonly details?: { reasoningContent?: string };
  constructor(kind: InnerTickLLMFailureKind, message: string, details?: { reasoningContent?: string }) {
    super(message);
    this.name = 'InnerTickLLMError';
    this.kind = kind;
    this.details = details;
  }
}

/** 快照事件类型：完整 InnerTickOutput 序列化后写入 life.db system_events 表，作为快照备份 */
export const INNER_TICK_SNAPSHOT_EVENT = 'inner_tick_snapshot';

export interface InnerTickOptions {
  userId?: string;      // 记忆/偏好归属用户；默认 'default'（与既有 skills adapter 一致）
  maxTokens?: number;   // 覆盖 LLM 输出上限
  scene?: string;       // LLM 场景标记，默认 'inner_tick'
  derivedMentalEvents?: MentalEventItem[]; // 旧模块（scheduler/idle_brain/dream/consolidator等）收集的派生心智事件，注入本轮 LLM 推演上下文
  // ── Phase2：对话链路触发上下文 ──
  sessionId?: string;              // 会话ID（chat 的 conversationId）；非对话触发缺省 → 快照 session_id 记 ''
  conversationSummary?: string;    // 本轮对话上下文摘要（对话轮次结束后由 chat 链路组装传入，注入 LLM 推演上下文）
  triggerSource?: 'chat_turn' | 'manual'; // 快照触发来源；默认 'manual'
  turnIndex?: number;              // 会话内轮次序号；不传时按该会话快照条数自增推断
  // ── Phase-2 修复：推演深度分级（浅层/深层）──
  // shallow：后台 session=- 浅层推演 — 只注入结构化心智快照，禁止灌入原始对话碎片
  //          （conversationSummary 被拦截丢弃）；人格微漂移（personalityDrift）不落库（仅深层允许执行）。
  // deep：6h narrative_consolidation 深层推演入口 — 允许携带记忆碎片（derivedMentalEvents），
  //       执行人格微漂移与叙事合并沉淀。
  // 不传（如 chat_turn 对话触发）：保留原对话上下文注入行为，但同样不执行人格微漂移（仅深层可执行）。
  depth?: 'shallow' | 'deep';
  // ── 测试注入（生产调用不传）：覆盖 LLM provider getters，供自测脚本模拟超时/空content 等异常响应 ──
  llmGetters?: Partial<LLMClients>;
  // ── Phase-2：休眠模式 prompt 瘦身（显式覆盖用；不传时按节律模式自动判定）──
  slim?: boolean;
}

// ─────────────────────────────────────────────
// 1. life.db 历史快照读取 → 仅渲染为 prompt 文本素材
// ─────────────────────────────────────────────

/**
 * 读取 life.db 历史快照（人格/情绪/欲望/反思/关系/事件/搁置思绪 + 上一轮 InnerTick 快照），
 * 渲染为文本供 LLM 参考。快照对象绝不赋值给任何运行状态。
 *
 * Phase-2 综合修复：slim=true（半休眠/深度休眠）时减少召回条数做 prompt 瘦身，
 * 活跃模式（slim=false）保持原有召回逻辑完全不变。
 */
async function loadLifeSnapshotAsText(slim: boolean = false): Promise<string> {
  const lines: string[] = [];

  try {
    const personality = await getPersonality();
    if (personality?.vector_json) {
      lines.push(`人格向量: ${personality.vector_json}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取人格快照失败: ${e.message}`);
  }

  try {
    const emotions = await getRecentEmotions(slim ? 4 : 10);
    if (emotions.length) {
      lines.push(`最近情绪: ${emotions.map((x: any) => `${x.emotion_type}(${(+x.intensity).toFixed(2)})`).join(', ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取情绪快照失败: ${e.message}`);
  }

  try {
    const allDesires = await getActiveDesires();
    const desires = slim ? allDesires.slice(0, 3) : allDesires;
    if (desires.length) {
      lines.push(`活跃欲望: ${desires.map((x: any) => `${x.desire_text}(${(+x.priority).toFixed(2)})`).join('; ')}`);
    }
    const top = await getTopDesire();
    if (top) {
      lines.push(`主导欲望: ${top.desire_text}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取欲望快照失败: ${e.message}`);
  }

  try {
    const reflections = await getRecentReflections(slim ? 2 : 5);
    if (reflections.length) {
      lines.push(`最近反思: ${reflections.map((x: any) => x.reflection_text).join('; ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取反思快照失败: ${e.message}`);
  }

  try {
    const memories = await getSignificantMemories(0.6, slim ? 4 : 10);
    if (memories.length) {
      lines.push(`重要交互记忆: ${memories.map((x: any) => x.event_type || JSON.stringify(x.context_json || {}).slice(0, 80)).join('; ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取交互记忆快照失败: ${e.message}`);
  }

  try {
    const relationship = await getLatestRelationship();
    if (relationship?.vector_json) {
      lines.push(`关系状态: ${relationship.vector_json}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取关系快照失败: ${e.message}`);
  }

  try {
    const thoughts = await getUnresolvedThoughts(slim ? 1 : 3);
    if (thoughts.length) {
      lines.push(`搁置思绪: ${thoughts.map((x: any) => x.event_type || x.context_json).join('; ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取搁置思绪失败: ${e.message}`);
  }

  // 上一轮 InnerTick 快照（从 system_events 读回，保证跨回合连续性，仍仅作 prompt 素材）
  try {
    const events = await getRecentEvents(slim ? 15 : 50);
    const prev = events.find((x: any) => x.event_type === INNER_TICK_SNAPSHOT_EVENT);
    if (prev?.data_json) {
      try {
        const prevOut = JSON.parse(prev.data_json);
        lines.push(`上一轮InnerTick推演: ${prevOut?.innerTickOutput?.thought || '(无思考内容)'}`);
      } catch { /* 旧快照解析失败不影响本轮 */ }
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取上一轮快照失败: ${e.message}`);
  }

  return lines.join('\n') || '(暂无历史快照)';
}

// ─────────────────────────────────────────────
// 2. InnerTick 专用 System Prompt
// ─────────────────────────────────────────────

const SCHEMA_SPEC = `输出 JSON 结构（严格符合，禁止输出多余解释文本）:
{
  "thought": "本轮内心独白/思考文本",
  "isPublic": true,
  "mood": { "name": "情绪名", "intensity": 0.0-1.0 },
  "desires": [ { "id": "uuid-v4", "content": "欲望内容", "intensity": 0.0-1.0, "status": "active|archived" } ],
  "goals": [ { "id": "uuid-v4", "content": "目标内容", "status": "active|suspended|finished|archived" } ],
  "focus": [ { "id": "uuid-v4", "content": "当前注意力焦点" } ],
  "archiveItems": [ { "type": "desire|goal", "id": "对应列表中要归档的 id", "reason": "归档原因" } ],
  "triggerInnerTick": true,
  "memoryHints": ["可写入长期记忆的提示/线索，可为空数组"],
  "emotionDrift": { "name": "情绪名", "intensity": 0.0-1.0, "change": -1.0-1.0 },
  "desireEvolve": [ { "id": "已有欲望id(新增时省略)", "content": "欲望内容", "intensity": 0.0-1.0, "status": "active|archived|abandoned|completed", "priorityDelta": -1.0-1.0 } ],
  "personalityDrift": { "delta": [8维增量，每维-0.02~0.02，禁止剧烈突变] },
  "relationshipAdjustment": { "vector": [4维目标向量：信任/亲密/理解/依赖，0.0-1.0] }
}`;

function buildInnerTickSystemPrompt(
  snapshotText: string,
  derivedEvents?: MentalEventItem[],
  conversationSummary?: string,
): string {
  // Phase4: 旧模块沉淀的派生心智事件（scheduler/idle_brain/dream/consolidator 等）注入推演上下文。
  // 只作为输入素材参与本轮推演，不要求 LLM 逐条复述或直接落库（落库统一收敛在 InnerTick 内部）。
  const eventsText = derivedEvents && derivedEvents.length > 0
    ? derivedEvents
        .map((e, i) => `${i + 1}. [${e.source}/${e.eventType}] ${e.brief}${
          e.payload && Object.keys(e.payload).length ? ` — ${JSON.stringify(e.payload).slice(0, 300)}` : ''
        }`)
        .join('\n')
    : '';

  // Phase2: 本轮对话上下文摘要（chat 对话轮次结束后由 chat 链路组装传入）注入推演上下文。
  // 只作为推演输入素材，绝不据此改写任何旧 life 状态表。
  const chatContextText = conversationSummary
    ? `\n\n本轮对话上下文摘要（最新一轮用户-助手完整对话，作为本轮推演的直接输入素材）:
${conversationSummary}`
    : '';

  return `你是数字生命体的内部心智。所有情绪、欲望生成、欲望衰减、情绪演变全部由你推理生成。
欲望可以随经历减弱、消退、被满足后消失，也可以生成全新欲望；人格允许缓慢演化，禁止剧烈突变。
参考传入的历史快照信息，但不要直接照搬快照，做独立推演。
通过archiveItems标记不再活跃的目标、欲望用于归档。
[Phase2-铁则] isPublic 必填布尔字段：true=本轮思考可对外公开呈现（可让用户看到的心智内容）；
false=纯内部推演（内心独白、隐私相关、未定稿想法），对外代码强制拦截、仅落库与日志，绝不泄露给用户。
拿不准时保守填 false。禁止将 isPublic=false 的内容改写为 true 输出。
[P2-MIGRATE] emotionDrift / desireEvolve / personalityDrift / relationshipAdjustment 为可选字段，仅在发生演化时输出（字段结构见下方 SCHEMA_SPEC）。
严格输出符合schema的JSON，禁止输出多余解释文本。

${SCHEMA_SPEC}
${chatContextText}
${eventsText ? `本轮外部模块沉淀的心智事件（作为推演输入素材，不必逐条复述；若与快照冲突以事件为准）:
${eventsText}

` : ''}历史快照信息（仅作参考素材，独立推演）:
${snapshotText}`;
}

// ─────────────────────────────────────────────
// 3. LLM 调用 + 强制 JSON 输出 + 解析容错
// ─────────────────────────────────────────────

/** 解析 LLM 返回文本为 JSON：剥离代码围栏、截取首个 {...} 块、容忍尾逗号；失败记录错误日志 */
function parseInnerTickJson(text: string): any {
  const raw = (text || '').trim();
  let candidate = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  // 若 LLM 夹杂了额外文本，截取首个 { ... 到最后一个 } 的完整块
  const braceMatch = candidate.match(/\{[\s\S]*\}/);
  if (braceMatch) candidate = braceMatch[0].trim();

  const attempts: Array<() => any> = [
    () => JSON.parse(candidate),
    // 容错：去除 JSON 内尾逗号（数组/对象最后一个元素后的逗号）
    () => JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')),
  ];
  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (e) {
      lastErr = e;
    }
  }
  logger.error(`${TAG} JSON解析失败: ${(lastErr as Error)?.message || lastErr}; 原文片段: ${candidate.slice(0, 300)}`);
  throw new Error(`InnerTick JSON 解析失败: ${(lastErr as Error)?.message || String(lastErr)}`);
}

// ─────────────────────────────────────────────
// 4. 输出规范化：uuid v4、intensity 0-1 限定、字段兜底
// ─────────────────────────────────────────────

function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** P2迁移：-1 ~ 1 区间限定（情绪变化量 / 欲望优先级增量） */
function clamp11(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(-1, n));
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function validUuidOrNew(v: unknown): string {
  const s = toStr(v);
  return UUID_V4_RE.test(s) ? s : crypto.randomUUID();
}

function normalizeOutput(raw: any): InnerTickOutput {
  const moodRaw = raw?.mood && typeof raw.mood === 'object' ? raw.mood : {};
  const mood: InnerTickMood = { name: toStr(moodRaw.name).slice(0, 50) || '平静', intensity: clamp01(moodRaw.intensity) };

  // LLM 原始 id → 规范化 uuid 映射：保证 archiveItems 引用能解析到列表中实际的条目
  const idMap = new Map<string, string>();

  const desires: InnerTickDesire[] = Array.isArray(raw?.desires)
    ? raw.desires.map((d: any) => {
        const normalizedId = validUuidOrNew(d?.id);
        if (d?.id) idMap.set(toStr(d.id), normalizedId);
        return {
          id: normalizedId,
          content: toStr(d?.content).slice(0, 500),
          intensity: clamp01(d?.intensity),
          status: d?.status === 'archived' ? 'archived' as const : 'active' as const,
        };
      }).filter((d: InnerTickDesire) => d.content)
    : [];

  const goals: InnerTickGoal[] = Array.isArray(raw?.goals)
    ? raw.goals.map((g: any) => {
        const normalizedId = validUuidOrNew(g?.id);
        if (g?.id) idMap.set(toStr(g.id), normalizedId);
        return {
          id: normalizedId,
          content: toStr(g?.content).slice(0, 500),
          status: ['active', 'suspended', 'finished', 'archived'].includes(g?.status)
            ? g.status as InnerTickGoal['status']
            : 'active' as const,
        };
      }).filter((g: InnerTickGoal) => g.content)
    : [];

  const focus: InnerTickFocus[] = Array.isArray(raw?.focus)
    ? raw.focus.map((f: any) => ({ id: validUuidOrNew(f?.id), content: toStr(f?.content).slice(0, 200) }))
        .filter((f: InnerTickFocus) => f.content)
    : [];

  const archiveItems: InnerTickArchiveItem[] = Array.isArray(raw?.archiveItems)
    ? raw.archiveItems
        .filter((a: any) => a && (a.type === 'desire' || a.type === 'goal') && toStr(a.id) && toStr(a.reason))
        .map((a: any) => {
          const rawId = toStr(a.id);
          // 优先映射到规范化 id；映射不到但本身是合法 uuid v4 的原样保留，否则无法解析的丢弃
          const resolvedId = idMap.get(rawId) ?? (UUID_V4_RE.test(rawId) ? rawId : '');
          return { type: a.type as 'desire' | 'goal', id: resolvedId, reason: toStr(a.reason).slice(0, 300) };
        })
        .filter((a: InnerTickArchiveItem) => a.id)
    : [];

  // ── P2迁移：心智演化事件规范化（可选字段；非法/缺失 → undefined，不触发落库）──
  const emotionDrift: InnerTickEmotionDrift | undefined = (() => {
    const e = raw?.emotionDrift;
    if (!e || typeof e !== 'object') return undefined;
    const name = toStr(e.name).slice(0, 50);
    if (!name) return undefined;
    return { name, intensity: clamp01(e.intensity), change: clamp11(e.change) };
  })();

  const desireEvolve: InnerTickDesireEvolve[] | undefined = Array.isArray(raw?.desireEvolve)
    ? raw.desireEvolve
        .map((d: any) => ({
          id: d?.id ? toStr(d.id).slice(0, 100) : undefined,
          content: toStr(d?.content).slice(0, 500),
          intensity: clamp01(d?.intensity),
          status: (['active', 'archived', 'abandoned', 'completed'].includes(d?.status) ? d.status : 'active') as InnerTickDesireEvolve['status'],
          priorityDelta: d?.priorityDelta !== undefined ? clamp11(d.priorityDelta) : undefined,
        }))
        .filter((d: InnerTickDesireEvolve) => d.content)
    : undefined;

  const personalityDrift: InnerTickPersonalityDrift | undefined = (() => {
    const p = raw?.personalityDrift;
    if (!p || !Array.isArray(p?.delta) || p.delta.length !== 8) return undefined;
    return { delta: p.delta.map((v: unknown) => clamp11(v)) };
  })();

  const relationshipAdjustment: InnerTickRelationshipAdjustment | undefined = (() => {
    const r = raw?.relationshipAdjustment;
    if (!r || !Array.isArray(r?.vector) || r.vector.length !== 4) return undefined;
    return { vector: r.vector.map((v: unknown) => clamp01(v)) };
  })();

  return {
    thought: toStr(raw?.thought).slice(0, 2000),
    // Phase2 铁则：isPublic 默认 false（LLM 未输出/非法 → 按内部推演保守拦截，禁止外泄）
    isPublic: raw?.isPublic === true,
    mood,
    desires,
    goals,
    focus,
    archiveItems,
    triggerInnerTick: raw?.triggerInnerTick === true,
    memoryHints: Array.isArray(raw?.memoryHints) ? raw.memoryHints.map((h: any) => toStr(h)).filter(Boolean).slice(0, 10) : [],
    emotionDrift,
    desireEvolve,
    personalityDrift,
    relationshipAdjustment,
  };
}

// ─────────────────────────────────────────────
// 5. archiveItems 处理：addMemory 写入向量记忆（必经 paradigmGuard 守卫）+ 从 active 列表移除
// ─────────────────────────────────────────────

/**
 * 处理归档条目：
 *  - 每条归档经 guardIllegalAddMemory 守卫后调用 addMemory 写入向量记忆；
 *  - 归档完成后从本次输出的 active desires/goals 列表移除归档项；
 *  - 返回被移除的 id 集合（供日志/测试断言）。
 */
async function processArchives(output: InnerTickOutput, userId: string): Promise<Set<string>> {
  const archivedIds = new Set<string>();
  // Phase-2 修复：单轮归档任务计数上限（默认 10 条）— LLM 输出超量时本轮只执行前 N 条，
  // 超限部分留待下一轮（对应条目仍在 active 列表，下轮 LLM 推演可继续归档）；
  // 快照观测表 inner_tick_snapshot 仍保留完整输出，仅业务侧 addMemory 执行数被截断。
  const capItems = output.archiveItems.slice(0, INNER_TICK_MAX_ARCHIVES_PER_ROUND);
  if (output.archiveItems.length > capItems.length) {
    logger.warn(`${TAG} 单轮归档任务计数上限（${INNER_TICK_MAX_ARCHIVES_PER_ROUND}）: 本轮 ${output.archiveItems.length} 条 → 执行前 ${capItems.length} 条，超限 ${output.archiveItems.length - capItems.length} 条留待下一轮`);
  }
  for (const item of capItems) {
    // 1) 守卫校验：InnerTick 白名单调用点（paradigmGuard 内部亦做堆栈白名单检测）
    guardIllegalAddMemory(`InnerTick 归档条目 ${item.type}:${item.id}`);

    const source =
      item.type === 'desire'
        ? output.desires.find((d) => d.id === item.id)
        : output.goals.find((g) => g.id === item.id);
    const content = source?.content || '';

    // 2) 写入向量记忆（firewall 拦截等异常不阻断本轮，记录日志继续）
    try {
      addMemory({
        userId,
        content: `[InnerTick归档] ${item.type === 'desire' ? '欲望' : '目标'}「${content || item.id}」已归档，原因：${item.reason}`,
        type: 'fact',
        keywords: ['InnerTick', '归档', item.type, ...(content ? [content.slice(0, 12)] : [])],
        confidence: 0.7,
        sourceInteractionId: '',
      }, {
        tier: 'episodic',
        importance: 0.3,
        source: 'system',
      });
      logger.info(`${TAG} 归档动作: type=${item.type} id=${item.id} reason=${item.reason}`);
    } catch (e: any) {
      logger.error(`${TAG} 归档 addMemory 失败 type=${item.type} id=${item.id}: ${e.message}`);
    }

    // 3) 归档完成后从本次输出的 active 列表移除
    archivedIds.add(item.id);
  }

  if (archivedIds.size) {
    output.desires = output.desires.filter((d) => !archivedIds.has(d.id));
    output.goals = output.goals.filter((g) => !archivedIds.has(g.id));
  }
  return archivedIds;
}

// ─────────────────────────────────────────────
// 6. 完整 InnerTickOutput 序列化写入 life.db 快照备份
// ─────────────────────────────────────────────

async function persistSnapshot(output: InnerTickOutput): Promise<number> {
  try {
    const eventId = await logSystemEvent(INNER_TICK_SNAPSHOT_EVENT, {
      innerTickOutput: output,
      snapshotAt: new Date().toISOString(),
    });
    logger.info(`${TAG} 快照备份已写入 life.db（system_events#${eventId}）`);
    return eventId;
  } catch (e: any) {
    logger.error(`${TAG} 快照备份写入失败: ${e.message}`);
    return -1;
  }
}

// ─────────────────────────────────────────────
// 6.5 Phase2: 快照写入独立观测表 inner_tick_snapshot
// 边界：只写新表，绝不覆盖/修改旧 life 状态表（emotions/desires/personality/memory 等）。
// 写前经 guardInnerTickLifeOverwrite 范式守卫校验目标表名（白名单 inner_tick_snapshot）。
// ─────────────────────────────────────────────

const TAG_P2 = '[Phase2-InnerTick]';
const PHASE2_SNAPSHOT_TABLE = 'inner_tick_snapshot';

/**
 * 写入 inner_tick_snapshot 独立观测表（含会话归属、轮次序号、触发来源），
 * 并输出 [Phase2-InnerTick] session=xxx turn=xxx ok/fail 日志埋点 + 简要快照摘要。
 * 失败不抛出（返回 -1），绝不阻断调用方（chat 返回、scheduler 任务）。
 */
async function persistInnerTickSnapshot(params: {
  output: InnerTickOutput;
  userId: string;
  sessionId?: string;
  turnIndex?: number;
  triggerSource: 'chat_turn' | 'manual';
}): Promise<number> {
  const sessionId = params.sessionId || '-';

  // Phase2 范式防护：目标表白名单校验（白名单静默通过；旧life状态表名 → paradigmGuard 告警）
  guardInnerTickLifeOverwrite(PHASE2_SNAPSHOT_TABLE, 'persistInnerTickSnapshot');

  // 会话内轮次序号：优先显式传入；缺省按该会话已有快照条数 +1 推断
  let turnIndex = params.turnIndex ?? 0;
  if (turnIndex <= 0) {
    try {
      turnIndex = params.sessionId ? (await countInnerTickSnapshots(params.sessionId)) + 1 : 1;
    } catch {
      turnIndex = 1;
    }
  }

  try {
    const snapshotId = await insertInnerTickSnapshot({
      sessionId: params.sessionId || '',
      userUid: params.userId,
      turnIndex,
      innerOutput: params.output,
      triggerSource: params.triggerSource,
    });
    // 日志埋点：ok + 简要快照摘要（thought/mood/desires/goals）
    logger.info(
      `${TAG_P2} session=${sessionId} turn=${turnIndex} ok snapshot=#${snapshotId} ` +
      `mood=${params.output.mood.name}(${params.output.mood.intensity.toFixed(2)}) ` +
      `desires=${params.output.desires.length} goals=${params.output.goals.length} ` +
      `trigger=${params.output.triggerInnerTick} thought="${(params.output.thought || '').slice(0, 60)}"`,
    );
    return snapshotId;
  } catch (e: any) {
    logger.error(`${TAG_P2} session=${sessionId} turn=${turnIndex} fail ${e.message}`);
    return -1;
  }
}

// ─────────────────────────────────────────────
// 6.75 P2迁移：LLM 心智演化事件 → MentalEventItem → 守卫校验 → 统一落库业务状态表
// 边界（与 Phase2「InnerTick 严禁覆盖旧life状态表」的差异）：
//   Phase2 阶段 InnerTick 输出只写 inner_tick_snapshot 观测表；P2 迁移阶段由 p2MigrateEnable
//   总闸控制——开启后，LLM 推演的 emotionDrift/desireEvolve/personalityDrift/relationshipAdjustment
//   经 guardP2MentalStateWrite 守卫校验（本文件调用栈在白名单内）统一写入业务状态表；
//   总闸关闭时本模块不执行任何写库，上述字段仅作为快照观测内容（维持既有行为）。
// ─────────────────────────────────────────────

const TAG_P2M = '[P2-MIGRATE]';
const PERSONALITY_DIM = 8;
const RELATIONSHIP_DIM = 4;
const PERSONALITY_BASELINE: number[] = [0.55, 0.55, 0.45, 0.55, 0.50, 0.45, 0.60, 0.50];

/** 将 LLM 推演的 4 类心智演化事件封装为 MentalEventItem（守卫校验 + 落库日志的统一载体） */
function buildDriftEvents(output: InnerTickOutput): MentalEventItem[] {
  const events: MentalEventItem[] = [];
  if (output.emotionDrift) {
    events.push({
      source: 'inner_tick',
      eventType: 'emotion_drift',
      brief: `情绪漂移: ${output.emotionDrift.name} ${output.emotionDrift.intensity.toFixed(2)} (Δ${output.emotionDrift.change >= 0 ? '+' : ''}${output.emotionDrift.change.toFixed(2)})`,
      payload: { ...output.emotionDrift },
    });
  }
  for (const d of output.desireEvolve || []) {
    events.push({
      source: 'inner_tick',
      eventType: 'desire_evolve',
      brief: `欲望演化[${d.status}]: ${d.content} (${d.intensity.toFixed(2)}${d.priorityDelta !== undefined ? ` Δ${d.priorityDelta >= 0 ? '+' : ''}${d.priorityDelta.toFixed(2)}` : ''})`,
      payload: { ...d },
    });
  }
  if (output.personalityDrift) {
    events.push({
      source: 'inner_tick',
      eventType: 'personality_drift',
      brief: `人格漂移: delta=[${output.personalityDrift.delta.map(v => v.toFixed(3)).join(',')}]`,
      payload: { delta: output.personalityDrift.delta },
    });
  }
  if (output.relationshipAdjustment) {
    events.push({
      source: 'inner_tick',
      eventType: 'relationship_adjustment',
      brief: `关系调整: vector=[${output.relationshipAdjustment.vector.map(v => v.toFixed(2)).join(',')}]`,
      payload: { vector: output.relationshipAdjustment.vector },
    });
  }
  return events;
}

/** 欲望演化落库：active=生成/优先级调整，其余=状态变更（表约束不含 archived → 映射为 abandoned） */
async function applyDesireEvolve(d: InnerTickDesireEvolve): Promise<void> {
  // 定位既有欲望：id 为纯数字 → 直接作为 desires 表整数 id；否则按内容精确匹配 active 欲望
  let targetId: number | null = null;
  if (d.id && /^\d+$/.test(d.id)) {
    targetId = Number(d.id);
  } else if (d.id || d.status !== 'active') {
    try {
      const active = await getActiveDesires();
      const match = active.find((x: any) => x.desire_text === d.content);
      if (match) targetId = Number(match.id);
    } catch { targetId = null; }
  }

  if (d.status === 'active') {
    if (targetId) {
      if (d.priorityDelta !== undefined) {
        await updateDesirePriority(targetId, d.priorityDelta);
        logger.info(`${TAG_P2M} desire_evolve 优先级调整 desires#${targetId}: Δ${d.priorityDelta >= 0 ? '+' : ''}${d.priorityDelta.toFixed(2)}`);
      }
    } else {
      const id = await addDesire(d.content, d.intensity, 'inner_tick');
      logger.info(`${TAG_P2M} desire_evolve 新增欲望 desires#${id}: ${d.content}(${d.intensity.toFixed(2)})`);
    }
    return;
  }
  // 衰减/归档：仅对已存在欲望生效（无法定位的跳过并告警）
  if (targetId) {
    const status = d.status === 'archived' ? 'abandoned' : d.status; // 表约束不含 archived
    await updateDesireStatus(targetId, status);
    logger.info(`${TAG_P2M} desire_evolve 状态变更 desires#${targetId} → ${status}`);
  } else {
    logger.warn(`${TAG_P2M} desire_evolve 无法定位既有欲望，跳过状态变更: ${d.content}（status=${d.status}）`);
  }
}

/** 人格漂移落库：delta 截断 ±0.02 后叠加库内当前向量（禁止剧烈突变），记录演化审计 */
async function applyPersonalityDrift(delta: number[]): Promise<void> {
  if (!Array.isArray(delta) || delta.length !== PERSONALITY_DIM) return;
  const clamped = delta.map(v => Math.min(0.02, Math.max(-0.02, v)));

  let before: number[] = PERSONALITY_BASELINE;
  try {
    const row = await getPersonality();
    if (row?.vector_json) {
      const parsed = JSON.parse(row.vector_json);
      if (Array.isArray(parsed) && parsed.length === PERSONALITY_DIM) before = parsed.map(Number);
    }
  } catch { /* 读取失败则按基线叠加 */ }

  const after = before.map((v, i) => Math.min(1, Math.max(0, v + (clamped[i] || 0))));
  const id = await updatePersonality(after);
  await recordPersonalityEvolution(before, after, clamped, 'inner_tick');
  logger.info(`${TAG_P2M} personality_drift 落库 personality#${id}: delta=[${clamped.map(v => v.toFixed(3)).join(',')}]`);
}

/** 关系调整落库：替换 4 维目标向量，保留既有时间元数据（lastInteractionAt/lastDecayAt/totalInteractions） */
async function applyRelationshipAdjustment(vector: number[]): Promise<void> {
  if (!Array.isArray(vector) || vector.length !== RELATIONSHIP_DIM) return;
  const clamped = vector.map(v => Math.min(1, Math.max(0, v)));
  let meta: { lastInteractionAt?: number | null; lastDecayAt?: number | null; totalInteractions?: number | null } = {};
  try { meta = await loadRelationshipState(); } catch { /* 保留默认空元数据 */ }
  await saveRelationshipVector(clamped, {
    lastInteractionAt: meta.lastInteractionAt ?? null,
    lastDecayAt: meta.lastDecayAt ?? null,
    totalInteractions: meta.totalInteractions ?? 0,
  });
  logger.info(`${TAG_P2M} relationship_adjustment 落库 relationship_state: [${clamped.map(v => v.toFixed(2)).join(',')}]`);
}

/**
 * P2 统一落库入口：将 LLM 推演输出中的心智演化事件（emotionDrift/desireEvolve/personalityDrift/
 * relationshipAdjustment）封装为 MentalEventItem，经 guardP2MentalStateWrite 守卫校验后
 * 统一写入业务状态表。仅由 runInnerTick 在 p2MigrateEnable=true 时调用；导出供自测脚本
 * 以真实 innerTick 调用栈验证守卫放行路径（调用方栈含 innerTick.ts → 守卫放行）。
 * 单条失败不阻断其余事件（逐条 try/catch + 日志）。
 */
export async function applyMentalDriftToBusinessState(
  output: InnerTickOutput,
  userId: string,
  opts?: { allowPersonalityDrift?: boolean },
): Promise<void> {
  let events = buildDriftEvents(output);
  // Phase-2 修复：人格微漂移只允许深层推演执行（浅层/chat_turn 路径在此剔除，不落库；
  // 快照观测表 inner_tick_snapshot 仍保留 personalityDrift 字段供对照，仅业务状态表不写入）
  if (opts?.allowPersonalityDrift === false) {
    events = events.filter((ev) => ev.eventType !== 'personality_drift');
  }
  if (events.length === 0) return;

  // 1) 守卫校验：本文件（src/core/innerTick.ts）为 P2 唯一合法写者 → 白名单放行；
  //    若未来外部代码误走本入口（栈不含 innerTick），guardP2MentalStateWrite 触发范式告警。
  for (const ev of events) {
    const table = ev.eventType === 'emotion_drift' ? 'emotions'
      : ev.eventType === 'desire_evolve' ? 'desires'
      : ev.eventType === 'personality_drift' ? 'personality'
      : 'relationship_state';
    guardP2MentalStateWrite(table, `applyMentalDriftToBusinessState ${ev.eventType} (source=${ev.source})`);
  }

  // 2) 统一落库业务状态表（逐条独立失败隔离，输出 [P2-MIGRATE] 埋点）
  // Phase-2 修复：单轮欲望演化任务计数上限（默认 8 条）— LLM 输出超量时本轮只执行前 N 条，
  // 超限部分留待下一轮推演（快照观测表 inner_tick_snapshot 仍保留完整输出供对照）。
  let appliedDesireEvolves = 0;
  for (const ev of events) {
    if (ev.eventType === 'desire_evolve') {
      if (appliedDesireEvolves >= INNER_TICK_MAX_DESIRE_EVOLVES_PER_ROUND) {
        logger.warn(`${TAG_P2M} desire_evolve 单轮任务计数上限（${INNER_TICK_MAX_DESIRE_EVOLVES_PER_ROUND}）: 跳过超限事件（${ev.brief}），留待下一轮推演`);
        continue;
      }
      appliedDesireEvolves++;
    }
    try {
      switch (ev.eventType) {
        case 'emotion_drift': {
          const e = ev.payload as InnerTickEmotionDrift;
          const id = await addEmotion(e.name, e.intensity, `p2-innerTick emotionDrift Δ${e.change >= 0 ? '+' : ''}${e.change.toFixed(3)}`);
          logger.info(`${TAG_P2M} emotion_drift 落库 emotions#${id}: ${e.name}(${e.intensity.toFixed(2)})`);
          break;
        }
        case 'desire_evolve':
          await applyDesireEvolve(ev.payload as InnerTickDesireEvolve);
          break;
        case 'personality_drift':
          await applyPersonalityDrift((ev.payload as InnerTickPersonalityDrift).delta);
          break;
        case 'relationship_adjustment':
          await applyRelationshipAdjustment((ev.payload as InnerTickRelationshipAdjustment).vector);
          break;
      }
    } catch (e: any) {
      logger.error(`${TAG_P2M} ${ev.eventType} 落库失败（不阻断本轮其余事件）: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────
// 7. 对外入口：runInnerTick()
// ─────────────────────────────────────────────

/** 重试仍失败时的兜底输出：保持对外返回类型不变，不抛异常、不打断主业务流程 */
function buildFallbackInnerTickOutput(): InnerTickOutput {
  return {
    thought: '本轮内部推演未能完成（模型输出异常），维持既有心智状态。',
    isPublic: false, // 兜底输出一律按内部内容处理（保守拦截，禁止外泄）
    mood: { name: '平静', intensity: 0.5 },
    desires: [],
    goals: [],
    focus: [],
    archiveItems: [],
    triggerInnerTick: false,
    memoryHints: [],
  };
}

/**
 * Bug 修复：reasoning-only 降级 —— 从模型思考链原文尽力抽取有效心智信息生成快照。
 * 优先尝试把 reasoning 整体按 schema 解析（推理模型可能在思考链里草拟了完整 JSON）；
 * 失败则正则抽取「欲望/渴望/想…」「情绪/心情…」条目 + 思考文本作为 thought。
 * 抽取不到任何信息时返回 null（由调用方继续降级）。isPublic 一律 false（内部推演保守拦截）。
 */
function buildSnapshotFromReasoning(reasoningText: string): InnerTickOutput | null {
  const text = String(reasoningText || '').trim();
  if (!text) return null;

  // 1) reasoning 内可能已有完整 schema JSON 草稿 → 直接走既有解析+规范化链路
  try {
    const parsed = parseInnerTickJson(text);
    if (parsed && typeof parsed === 'object') {
      const output = normalizeOutput(parsed);
      if (output.thought || output.desires.length > 0 || output.goals.length > 0) {
        (output as InnerTickOutput & { degraded?: string }).degraded = 'reasoning_only';
        return output;
      }
    }
  } catch { /* 非 JSON 推理文本 → 走正则抽取 */ }

  // 2) 正则抽取欲望条目（如「欲望：xxx」「渴望：xxx」「想探索xxx」）
  const desires: InnerTickDesire[] = [];
  const desireRe = /(?:欲望|渴望|想(?:要|做|去)?)[：:]\s*([^\n。；;，,]{2,80})/g;
  let dm: RegExpExecArray | null;
  while ((dm = desireRe.exec(text)) && desires.length < 5) {
    const content = dm[1].trim();
    if (content && !desires.some(d => d.content === content)) {
      desires.push({ id: crypto.randomUUID(), content, intensity: 0.6, status: 'active' });
    }
  }

  // 3) 情绪条目
  const moodMatch = text.match(/(?:情绪|心情)[：:]\s*([^\n。；;，,]{2,20})/);
  const mood: InnerTickMood = {
    name: toStr(moodMatch?.[1] || '平静').slice(0, 50),
    intensity: 0.5,
  };

  const thought = text.replace(/\s+/g, ' ').slice(0, 800);
  if (desires.length === 0 && !moodMatch && !thought) return null;

  const output: InnerTickOutput = {
    thought: thought || '（模型仅输出思考链，已从推理过程抽取心智信息）',
    isPublic: false,
    mood,
    desires,
    goals: [],
    focus: [],
    archiveItems: [],
    triggerInnerTick: false,
    memoryHints: [],
  };
  (output as InnerTickOutput & { degraded?: string }).degraded = 'reasoning_only';
  return output;
}

/**
 * Bug 修复：超时/无素材降级 —— 从当前 life.db 既有状态（活跃欲望 + 最近情绪）生成部分快照，
 * 拒绝整轮零写入。仅写观测快照表（system_events / inner_tick_snapshot），不写业务状态表。
 */
async function buildDegradedSnapshot(reasonKind: string, reasonText: string): Promise<InnerTickOutput> {
  const emotions = await getRecentEmotions(1).catch(() => [] as any[]);
  const activeDesires = await getActiveDesires().catch(() => [] as any[]);

  const mood: InnerTickMood = emotions[0]
    ? { name: toStr(emotions[0]?.emotion_type || '平静').slice(0, 50), intensity: clamp01(emotions[0]?.intensity) }
    : { name: '平静', intensity: 0.5 };

  const output: InnerTickOutput = {
    thought: `本轮内部推演${reasonText}（${reasonKind}），未获得模型输出，快照由既有心智状态降级生成。`,
    isPublic: false,
    mood,
    desires: (activeDesires as any[]).slice(0, 5).map((d: any) => ({
      id: validUuidOrNew(''),
      content: toStr(d?.desire_text).slice(0, 500),
      intensity: clamp01(d?.priority),
      status: 'active' as const,
    })).filter((d: InnerTickDesire) => d.content),
    goals: [],
    focus: [],
    archiveItems: [],
    triggerInnerTick: false,
    memoryHints: [],
  };
  (output as InnerTickOutput & { degraded?: string }).degraded = reasonKind;
  return output;
}

// ─────────────────────────────────────────────
// 7.5 Phase2 铁则：最小触发间隔硬锁 + 对外输出拦截器
// ─────────────────────────────────────────────

/**
 * Phase2 铁则2：InnerTick 心智循环最小触发间隔 3 分钟 —— 代码硬锁。
 * ⚠️ 硬编码常量，不受任何环境变量控制；按用户维度独立计时（多用户互不饿死）。
 * 触发过早（距上次 <180s）→ 本轮直接跳过，不调用 LLM、不写库，返回 skipped 标记输出。
 */
export const INNER_TICK_MIN_INTERVAL_MS = 3 * 60 * 1000; // 3 分钟，硬锁不可配置

const lastRunAtByUser = new Map<string, number>();

/** 检查用户是否处于冷却期（true=冷却中应跳过） */
export function isInnerTickInCooldown(userId: string): boolean {
  const last = lastRunAtByUser.get(userId) ?? 0;
  if (last <= 0) return false;
  return Date.now() - last < INNER_TICK_MIN_INTERVAL_MS;
}

/** 冷却剩余毫秒（调试/观测用；非冷却返回 0） */
export function innerTickCooldownRemainingMs(userId: string): number {
  const last = lastRunAtByUser.get(userId) ?? 0;
  if (last <= 0) return 0;
  const remain = INNER_TICK_MIN_INTERVAL_MS - (Date.now() - last);
  return remain > 0 ? remain : 0;
}

// ─────────────────────────────────────────────
// 7.6 Phase-2 修复：后台 session=- 推演管控（2h 硬冷却 + 独立每日熔断 + LLM 健康环）
// ─────────────────────────────────────────────

/**
 * 后台 session=- 浅层推演最小间隔 2 小时 —— 代码硬锁（替换原 idle_brain 的 1 小时可配置闸门）。
 * 仅作用于「无派生事件、非 chat_turn」的后台裸推演（当前唯一入口：idle_brain 后台触发）；
 * 带 derivedMentalEvents 的重要状态变更推演不受此锁约束（保持 Phase4 事件派发语义）。
 */
export const INNER_TICK_BG_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000;

const lastBgRunAtByUser = new Map<string, number>();

/** 判断是否为后台裸推演（无会话、无派生事件、非 chat_turn）——受 2h 硬冷却与每日熔断约束的推演类别 */
export function isBackgroundBareInference(
  options: Pick<InnerTickOptions, 'triggerSource' | 'derivedMentalEvents'>,
): boolean {
  return options.triggerSource !== 'chat_turn' && !(options.derivedMentalEvents && options.derivedMentalEvents.length > 0);
}

/** 后台推演 2h 冷却检查（true=冷却中应跳过） */
export function isBackgroundInnerTickInCooldown(userId: string): boolean {
  const last = lastBgRunAtByUser.get(userId) ?? 0;
  if (last <= 0) return false;
  return Date.now() - last < INNER_TICK_BG_MIN_INTERVAL_MS;
}

// ── 后台推演独立每日调用熔断（chat_turn 对话触发不计入本统计）──
// 与预算熔断（budgetGate/backgroundGate）相互独立；进程内存计数（重启清零，2h 硬锁兜底防重启连打）。
const BACKGROUND_DAILY_MAX = (() => {
  const n = Number(process.env.PEPPA_INNER_TICK_BG_DAILY_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 12;
})();

let bgBreakerDate = '';
let bgBreakerCount = 0;

/** 后台推演每日熔断：true=今日后台推演额度已耗尽，本轮后台推演应跳过 */
export function isBackgroundInnerTickBreakerOpen(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (bgBreakerDate !== today) {
    bgBreakerDate = today;
    bgBreakerCount = 0;
  }
  return bgBreakerCount >= BACKGROUND_DAILY_MAX;
}

/** 记录一次后台推演调用（chat_turn 对话触发不经过本函数，天然不计入后台熔断统计） */
export function recordBackgroundInnerTick(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (bgBreakerDate !== today) {
    bgBreakerDate = today;
    bgBreakerCount = 0;
  }
  bgBreakerCount++;
}

// ── LLM 健康环（降级保护数据源：连续超时/失败 → 后台推演直接跳过）──
const LLM_HEALTH_RING_SIZE = 6;
const llmHealthRing: Array<'ok' | 'timeout' | 'fail'> = [];

function recordInnerTickLLMOutcome(outcome: 'ok' | 'timeout' | 'fail'): void {
  llmHealthRing.push(outcome);
  if (llmHealthRing.length > LLM_HEALTH_RING_SIZE) llmHealthRing.shift();
}

/**
 * 最近 window 次 LLM 推演中失败（超时/重试耗尽）是否 ≥ threshold 次。
 * 供后台推演降级保护判定（LLM 连续超时 → 跳过后台 session=- 推演）。
 */
export function hasInnerTickLLMFailures(window: number, threshold: number): boolean {
  const recent = llmHealthRing.slice(-window);
  if (recent.length < 2) return false;
  return recent.filter((o) => o === 'timeout' || o === 'fail').length >= threshold;
}

// ─────────────────────────────────────────────
// 7.7 Phase-2 修复：duration 限流（慢推演冷却放大）+ 单轮任务计数上限
// ─────────────────────────────────────────────

// ── duration 限流：上一轮 LLM 推演实际耗时超过 SLOW 阈值 → 本轮最小间隔按 耗时×系数 放大（上限 1h）──
// 仅作用于非 chat_turn 推演（chat_turn 对话触发恒豁免，保持纯 3 分钟硬锁，用户对话体验不受影响）；
// LLM 响应正常（耗时 ≤ SLOW 阈值）时有效间隔 = 原 3 分钟硬锁，运行行为不变。
const INNER_TICK_DURATION_SLOW_MS = (() => {
  const n = Number(process.env.PEPPA_INNER_TICK_DURATION_SLOW_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 20000; // 默认 20s
})();
const INNER_TICK_DURATION_BACKOFF_FACTOR = (() => {
  const n = Number(process.env.PEPPA_INNER_TICK_DURATION_BACKOFF_FACTOR);
  return Number.isFinite(n) && n >= 1 ? n : 5; // 默认 ×5
})();
const INNER_TICK_DURATION_BACKOFF_MAX_MS = (() => {
  const n = Number(process.env.PEPPA_INNER_TICK_DURATION_BACKOFF_MAX_MS);
  return Number.isFinite(n) && n >= 60000 ? Math.floor(n) : 60 * 60 * 1000; // 默认 1h
})();

/** 各用户上一轮 LLM 推演实际耗时（ms）；仅记录确实执行过 LLM 调用轮的耗时（跳过/冷却轮不记录） */
const lastRoundDurationMsByUser = new Map<string, number>();

/** 记录一轮 LLM 推演实际耗时（runInnerTick 内部调用；导出供观测/自测） */
export function recordInnerTickRoundDuration(userId: string, durationMs: number): void {
  if (Number.isFinite(durationMs) && durationMs >= 0) lastRoundDurationMsByUser.set(userId, durationMs);
}

/** duration 限流生效间隔：上一轮耗时慢 → 冷却放大（上限 1h）；否则原 3 分钟硬锁 */
export function innerTickEffectiveIntervalMs(userId: string): number {
  const last = lastRoundDurationMsByUser.get(userId) ?? 0;
  if (last <= INNER_TICK_DURATION_SLOW_MS) return INNER_TICK_MIN_INTERVAL_MS;
  return Math.min(
    Math.max(last * INNER_TICK_DURATION_BACKOFF_FACTOR, INNER_TICK_MIN_INTERVAL_MS),
    INNER_TICK_DURATION_BACKOFF_MAX_MS,
  );
}

/**
 * duration 限流剩余冷却（>0 = 本轮应跳过）。
 * chat_turn 对话触发恒返回 0（不参与 duration 限流，保持纯 3 分钟硬锁）；
 * 锚点与 3 分钟硬锁一致（上一轮开始时刻），慢推演将其后推演间隔整体放大。
 */
export function innerTickDurationBackoffRemainingMs(
  userId: string,
  triggerSource?: InnerTickOptions['triggerSource'],
): number {
  if (triggerSource === 'chat_turn') return 0;
  const lastRun = lastRunAtByUser.get(userId) ?? 0;
  if (lastRun <= 0) return 0;
  const last = lastRoundDurationMsByUser.get(userId) ?? 0;
  if (last <= INNER_TICK_DURATION_SLOW_MS) return 0;
  return Math.max(0, innerTickEffectiveIntervalMs(userId) - (Date.now() - lastRun));
}

// ── 单轮任务计数上限：LLM 输出条目数保护（一轮内实际执行任务数封顶，超限部分留待下一轮）──
// 快照观测表 inner_tick_snapshot 仍保留 LLM 完整输出（观测不受影响），仅业务侧执行/写入被截断。
const INNER_TICK_MAX_ARCHIVES_PER_ROUND = (() => {
  const n = Number(process.env.PEPPA_INNER_TICK_MAX_ARCHIVES_PER_ROUND);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10; // 默认单轮归档 ≤ 10 条
})();
const INNER_TICK_MAX_DESIRE_EVOLVES_PER_ROUND = (() => {
  const n = Number(process.env.PEPPA_INNER_TICK_MAX_DESIRE_EVOLVES_PER_ROUND);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8; // 默认单轮欲望演化 ≤ 8 条
})();

/**
 * Phase-2 综合修复：休眠模式 prompt 瘦身总开关。
 * PEPPA_INNER_TICK_SLIM=true（默认）时，半休眠/深度休眠模式下的 inner_tick 快照召回条数减量，
 * 活跃模式（active）恒不瘦身（用户交互后的完整推演不受影响）。
 */
export function isInnerTickSlimEnabled(): boolean {
  const v = process.env.PEPPA_INNER_TICK_SLIM;
  if (v === undefined || v === '') return true; // 默认开启
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Phase2 铁则2：心智内容对外输出代码级拦截器。
 * isPublic=false 的内部推演内容：强制拦截，禁止输出到普通聊天返回（仅落库与日志）。
 * 返回 true 表示允许对外使用；false 表示内容被拦截，调用方必须丢弃/降级，不得透出。
 */
export function isInnerTickOutputPublic(output: InnerTickOutput | null | undefined): boolean {
  if (!output) return false;
  if (output.isPublic !== true) {
    logger.warn(`${TAG} 对外输出拦截: isPublic=false 的心智记录禁止输出到普通聊天返回（仅落库与日志），thought="${(output.thought || '').slice(0, 40)}"`);
    return false;
  }
  return true;
}

/**
 * Phase2 铁则2：取可对外公开的内心独白文本。
 * isPublic=true → 返回 thought；isPublic=false → 返回 null（调用方禁止透出）。
 */
export function getPublicInnerTickThought(output: InnerTickOutput | null | undefined): string | null {
  if (!isInnerTickOutputPublic(output)) return null;
  return output!.thought || null;
}

/**
 * 执行一轮 InnerTick 心智回合。
 * 边界承诺：不修改任何全局运行状态，仅返回 InnerTickOutput + 写入 life.db 快照备份。
 */
export async function runInnerTick(options: InnerTickOptions = {}): Promise<InnerTickOutput> {
  // P2-3 心智通道：独立落盘 logs/mind.log（同时镜像主控制台）
  // Phase-2 修复：记录推演深度分级，便于后台浅层/深层路径观测
  const depth = options.depth ?? 'shallow';
  logger.mind(`${TAG} 心智回合开始 depth=${depth} trigger=${options.triggerSource || 'manual'}`);
  const userId = options.userId || 'default';

  // ── Phase2 铁则2：InnerTick 最小触发间隔 3 分钟硬锁（代码硬锁，不可配置）──
  // 触发过早 → 本轮直接跳过：不调用 LLM、不写库、不产 logSystemEvent/快照，返回 skipped 标记输出。
  if (isInnerTickInCooldown(userId)) {
    const remainSec = Math.round(innerTickCooldownRemainingMs(userId) / 1000);
    logger.mind(`${TAG} 冷却硬锁 user=${userId} 距上次心智回合不足 3 分钟（剩余 ${remainSec}s），本轮跳过（最小触发间隔 3 分钟，代码硬锁）`);
    const skipped = buildFallbackInnerTickOutput();
    (skipped as InnerTickOutput & { skipped: boolean }).skipped = true;
    return skipped;
  }

  // ── Phase-2 修复：duration 限流（慢推演冷却放大）──
  // chat_turn 对话触发恒返回 0（不受限流，保持纯 3 分钟硬锁，用户对话体验不受影响）；
  // 上一轮 LLM 推演耗时超过 SLOW 阈值 → 本轮最小间隔按 耗时×系数 放大（上限 1h），慢推演自动降温。
  const durBackoffMs = innerTickDurationBackoffRemainingMs(userId, options.triggerSource);
  if (durBackoffMs > 0) {
    logger.mind(`${TAG} duration 限流 user=${userId} 上一轮 LLM 推演耗时过长，冷却放大至 ${Math.round(innerTickEffectiveIntervalMs(userId) / 1000)}s（剩余 ${Math.round(durBackoffMs / 1000)}s），本轮跳过（chat_turn 对话触发不受此限流约束）`);
    const skipped = buildFallbackInnerTickOutput();
    (skipped as InnerTickOutput & { skipped: boolean }).skipped = true;
    return skipped;
  }
  lastRunAtByUser.set(userId, Date.now());

  // ── Phase-2 修复：后台 session=- 裸推演 2h 硬冷却 + 独立每日熔断（chat_turn 不计入）──
  // 仅作用于无派生事件、非 chat_turn 的后台裸推演（idle_brain 后台触发入口）；
  // 带 derivedMentalEvents 的重要状态变更推演不受约束（保持 Phase4 事件派发语义）。
  if (isBackgroundBareInference(options)) {
    if (isBackgroundInnerTickInCooldown(userId)) {
      logger.mind(`${TAG} 后台推演 2h 硬冷却 user=${userId} 距上次后台推演不足 2 小时，本轮跳过（后台 session=- 推演最小间隔 2 小时，代码硬锁，替换原 idle_brain 1 小时闸门）`);
      const skipped = buildFallbackInnerTickOutput();
      (skipped as InnerTickOutput & { skipped: boolean }).skipped = true;
      return skipped;
    }
    if (isBackgroundInnerTickBreakerOpen()) {
      logger.warn(`${TAG} 后台推演每日熔断 user=${userId} 今日后台推演次数已达上限（${BACKGROUND_DAILY_MAX} 次），本轮跳过（chat_turn 对话触发不计入此统计）`);
      const skipped = buildFallbackInnerTickOutput();
      (skipped as InnerTickOutput & { skipped: boolean }).skipped = true;
      return skipped;
    }
    lastBgRunAtByUser.set(userId, Date.now());
  }

  // ── Phase-2 修复：浅层/深层推演路径区分 ──
  // 浅层（depth='shallow'，后台 session=-）：只传结构化心智快照，原始对话碎片（conversationSummary）一律拦截丢弃；
  // 深层（depth='deep'，6h narrative_consolidation）：允许携带记忆碎片（derivedMentalEvents）并执行人格微漂移。
  const isExplicitShallow = options.depth === 'shallow';
  if (isExplicitShallow && options.conversationSummary) {
    logger.warn(`${TAG} 浅层推演拦截原始对话碎片: depth=shallow 仅允许结构化心智快照，conversationSummary 已丢弃（user=${userId}）`);
  }
  const summaryForPrompt = isExplicitShallow ? undefined : options.conversationSummary;

  // 读取 life.db 历史快照 → 仅渲染为 prompt 文本（不参与运行状态）
  // Phase-2 综合修复：半休眠/深度休眠模式（非 active）自动瘦身快照召回条数；
  // 聊天触发时用户刚交互 → 模式为 active → 保持原有完整召回，行为不变。
  const slim = options.slim ?? (isInnerTickSlimEnabled() && getRhythmMode() !== 'active');
  if (slim) {
    logger.mind(`${TAG} 休眠模式 prompt 瘦身生效（mode=${getRhythmMode()}），快照召回条数减量`);
  }
  const snapshotText = await loadLifeSnapshotAsText(slim);
  // Phase4: 旧模块派生心智事件（derivedMentalEvents）一并注入 LLM 推演上下文
  // Phase2: 本轮对话上下文摘要（conversationSummary）一并注入，作为对话触发的推演输入素材
  const systemPrompt = buildInnerTickSystemPrompt(snapshotText, options.derivedMentalEvents, summaryForPrompt);

  // LLM 配置：沿用用户偏好 provider/model，独立场景标记 inner_tick
  const llm = createLLMRuntime();
  const pref = getUserPreferredLLMConfig(userId, { maxTokens: options.maxTokens || 1024, scenario: 'standard' });

  const messages: NormalizedMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请基于当前心智状态进行一轮内部推演，输出完整 JSON。' },
  ];

  // ── 超时控制：本轮 LLM 推演调用（含单次重试）共享同一个超时窗口 ──
  // 阈值来自 mindSwitch.innerTickLLMTimeoutMs（可配置调参，<= 0 表示不启用超时、保持旧行为）；
  // 超时后 AbortController 通过 signal 中止 makeLLMCall 在途请求（providers 各 provider 分支均已透传 signal）。
  const timeoutMs = MIND_SWITCH.innerTickLLMTimeoutMs;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const abortTimer = controller
    ? setTimeout(() => {
        controller.abort();
        logger.warn(`${TAG_WARN} LLM调用超时（阈值 ${timeoutMs}ms）已中止在途请求`);
      }, timeoutMs)
    : null;

  // 单次 LLM 调用 + 结构化输出解析。失败统一分类为 InnerTickLLMError（llm_timeout / reasoning_only /
  // empty_content / parse_error / unknown），由下方「超时直接终止」或「单层重试兜底」处理。
  const getters: LLMClients = { ...llm, ...(options.llmGetters || {}) };
  const attemptInnerTickCall = async (): Promise<InnerTickOutput> => {
    let response: NormalizedLLMResponse;
    try {
      response = await makeLLMCall(
        messages,
        [],
        // ⚠️ 强制 maxTokens=8000：deepseek 系推理模型（v4-flash 等）的 max_tokens 为「思考链+输出」总配额，
        // providers 侧自动扩容仅到 4000，思考链耗光配额会导致 JSON 截断（Unexpected end of JSON input）。
        // 显式传入 8000 覆盖自动扩容逻辑；该值仅作用于 InnerTick 自身调用，其他模块不受影响。
        // signal：超时控制 signal 透传底层 provider 请求，超时即中止在途调用。
        { provider: pref.provider, model: pref.model, maxTokens: 8000, userId, scene: options.scene || 'inner_tick', signal: controller?.signal },
        getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen,
        getters.getOllama, getters.getLmStudio, getters.getArk, getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay,
      );
    } catch (e: any) {
      // 超时判定：以本轮控制器状态为准（底层错误经 withRetry 包装后可能丢失 AbortError 名称）
      if (controller?.signal.aborted || e?.name === 'AbortError' || /abort|cancel/i.test(String(e?.message || ''))) {
        throw new InnerTickLLMError('llm_timeout', `LLM调用超时（阈值 ${timeoutMs}ms）: ${e?.message || e}`);
      }
      throw new InnerTickLLMError('unknown', `LLM调用失败: ${e?.message || e}`);
    }
    if (!response?.text || !response.text.trim()) {
      // 审计观测到的 deepseek-v4-flash 已知异常：只输出 reasoning、content 为空
      if (response?.reasoningContent) {
        // Bug 修复：reasoning 原文随错误携带，供降级层抽取欲望/洞察生成快照（避免整轮作废）
        throw new InnerTickLLMError(
          'reasoning_only',
          '模型仅输出 reasoning 无有效 content（deepseek-v4-flash 已知异常），content 为空',
          { reasoningContent: response.reasoningContent },
        );
      }
      throw new InnerTickLLMError('empty_content', '模型返回 content 为空');
    }
    let parsed: any;
    try {
      parsed = parseInnerTickJson(response.text);
    } catch (e: any) {
      throw new InnerTickLLMError('parse_error', `模型返回格式解析失败: ${e?.message || e}`);
    }
    return normalizeOutput(parsed);
  };

  // 推演结果：成功走下方正常链路；失败（超时 / 重试耗尽）输出分级日志后进入降级链路。
  // 超时不重试（重试会再次阻塞整个超时阈值时长，违背超时兜底目的）；格式类失败沿用原单次重试。
  // Phase-2 修复：duration 限流数据源 — 记录本轮 LLM 调用段实际耗时（含单次重试；跳过/冷却轮不经过此处）
  const llmRoundT0 = Date.now();
  let output: InnerTickOutput | null = null;
  let failedKind: InnerTickLLMFailureKind | null = null;
  // 最近一次失败携带的模型思考链原文（reasoning-only 降级用）
  let lastReasoningContent: string | null = null;
  try {
    output = await attemptInnerTickCall();
    logger.mind(`${TAG} 心智推演完成（首次调用成功）`);
  } catch (firstErr: any) {
    const firstKind = firstErr instanceof InnerTickLLMError ? firstErr.kind : 'unknown';
    if (firstKind === 'llm_timeout') {
      failedKind = firstKind;
      // 日志区分：超时错误（独立文案，与格式异常明确区分）
      logger.error(`${TAG_ERROR} LLM调用超时（kind=llm_timeout，阈值 ${timeoutMs}ms）: ${firstErr?.message || String(firstErr)}；进入超时降级：尝试从既有心智状态生成部分快照，拒绝整轮空落库`);
    } else {
      logger.warn(`${TAG_WARN} 首次心智推演失败（kind=${firstKind}）: ${firstErr?.message || String(firstErr)}；自动重试（最多1次）`);
      try {
        output = await attemptInnerTickCall();
        logger.info(`${TAG_RETRY} 重试成功，心智推演完成`);
      } catch (retryErr: any) {
        failedKind = retryErr instanceof InnerTickLLMError ? retryErr.kind : 'unknown';
        if (retryErr instanceof InnerTickLLMError) {
          lastReasoningContent = retryErr.details?.reasoningContent || null;
        }
        logger.error(`${TAG_ERROR} 重试仍失败（kind=${failedKind}）: ${retryErr?.message || String(retryErr)}；进入降级链路，尽力产出部分快照`);
      }
    }
  } finally {
    // 释放超时计时器（成功/失败路径均需清理，避免悬挂 timer）
    if (abortTimer) clearTimeout(abortTimer);
  }
  // Phase-2 修复：本轮 LLM 推演实际耗时入账（duration 限流数据源；超时/失败轮同样记录 — 慢轮越久，后续冷却越久）
  recordInnerTickRoundDuration(userId, Date.now() - llmRoundT0);

  // ⚠️ 异常降级边界（Bug 修复）：不再整轮作废零写入 —— 从已有素材尽力产出可用快照：
  //   1. reasoning_only（deepseek-v4-flash 只出思考链、content 为空）→ 从思考链提取欲望/洞察生成快照；
  //   2. llm_timeout → 从当前 life 状态（活跃欲望+最近情绪）生成部分快照；
  //   3. 无任何可恢复素材（empty_content / parse_error / unknown）→ 维持纯 fallback 兜底。
  // 降级快照仅写观测表（system_events + inner_tick_snapshot），不执行归档 addMemory / P2 业务状态写入。
  // Phase-2 修复：本轮 LLM 健康度入环（降级保护数据源 — LLM 连续超时/失败 → 后台推演直接跳过）
  if (failedKind) {
    recordInnerTickLLMOutcome(failedKind === 'llm_timeout' ? 'timeout' : 'fail');
  } else {
    recordInnerTickLLMOutcome('ok');
  }

  if (failedKind) {
    let degradedKind: string = failedKind;
    if (failedKind === 'reasoning_only' && lastReasoningContent) {
      const extracted = buildSnapshotFromReasoning(lastReasoningContent);
      if (extracted) {
        output = extracted;
        degradedKind = 'reasoning_only';
        logger.info(`${TAG} reasoning-only 降级生效：已从模型思考链抽取心智信息生成快照（desires=${extracted.desires.length} mood=${extracted.mood.name}）`);
      } else {
        degradedKind = 'reasoning_only_no_content';
        logger.warn(`${TAG} reasoning-only 降级：思考链中无可提取的心智信息，继续按超时路径生成状态快照`);
      }
    }
    if (!output && (failedKind === 'llm_timeout' || degradedKind !== failedKind)) {
      // 超时 / reasoning 提取失败：用既有心智状态生成部分快照（真实数据，非纯占位）
      output = await buildDegradedSnapshot(
        failedKind,
        failedKind === 'llm_timeout' ? '超时' : '模型输出异常',
      );
      logger.info(`${TAG} 超时/无素材降级：已从既有心智状态生成部分快照（desires=${output.desires.length} mood=${output.mood.name}）`);
    }
    if (!output) {
      return buildFallbackInnerTickOutput();
    }
    // 降级快照统一落观测表（仅观测，不写业务状态；与正常路径同表、同结构，便于对照）
    await persistSnapshot(output);
    await persistInnerTickSnapshot({
      output,
      userId,
      sessionId: options.sessionId,
      turnIndex: options.turnIndex,
      triggerSource: options.triggerSource || 'manual',
    });
    logger.warn(`${TAG} 降级快照已落库（degraded=${degradedKind}），本轮为部分心智产出，下一轮对话仍可正常触发`);
    return output;
  }
  output = output as InnerTickOutput;

  // 处理归档：addMemory（经守卫）+ 从 active 列表移除
  const archivedIds = await processArchives(output, userId);

  // 完整输出序列化写入 life.db 快照备份（Phase1 既有行为，保留：scheduler 等派生事件链路依赖其跨轮连续性）
  await persistSnapshot(output);

  // Phase2: 完整输出写入独立观测表 inner_tick_snapshot（新表，仅观测对比；旧life状态表数据不受影响）
  // 输出 [Phase2-InnerTick] session=xxx turn=xxx ok/fail 日志埋点；失败仅记日志，不影响本流程
  await persistInnerTickSnapshot({
    output,
    userId,
    sessionId: options.sessionId,
    turnIndex: options.turnIndex,
    triggerSource: options.triggerSource || 'manual',
  });

  // ── P2迁移：LLM 推演心智演化事件统一落库（受 p2MigrateEnable 总闸控制）──
  // 总闸关闭（默认）：不执行任何业务状态写入，emotionDrift/desireEvolve/personalityDrift/
  // relationshipAdjustment 仅作为快照观测内容（维持既有行为）；总闸开启：经
  // MentalEventItem → guardP2MentalStateWrite 守卫校验后写入 emotions/desires/personality/relationship_state。
  // Phase-2 修复：人格微漂移只允许深层推演执行（depth='deep'），浅层/chat_turn 的 personalityDrift 不落业务状态表。
  if (isP2MigrateEnabled()) {
    await applyMentalDriftToBusinessState(output, userId, { allowPersonalityDrift: depth === 'deep' });
  }

  logger.info(`${TAG} 心智回合结束 (desires=${output.desires.length} goals=${output.goals.length} archived=${archivedIds.size} trigger=${output.triggerInnerTick})`);
  return output;
}
