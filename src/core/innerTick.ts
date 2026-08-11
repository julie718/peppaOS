// src/core/innerTick.ts
// 阶段1：InnerTick 独立心智回合模块 — 完全由 LLM 驱动的心理推演
//
// ⚠️ 本阶段硬性边界（Phase1）：
//   - 仅作为独立库组件，不接管系统主控、不替换旧 life TICK（server/life/index.ts 状态机继续完整运行）。
//   - InnerTick：数字生命体原生心智回合底座；可在chat结束、空闲时机触发；只输出结构化心智快照，落库life.db与向量记忆，不直接修改运行时状态，不接管对话输出。
//   - runInnerTick() 执行完成不修改任何全局运行状态，仅返回结构化对象 + 写入 life.db 快照备份。
//   - life.db 历史快照只作为 prompt 素材渲染为文本，严禁直接拿快照对象赋值给运行状态。
//
// 心智回合内容（欲望生成/衰减、情绪变化、目标归档）全部由 LLM 推理生成。

import { makeLLMCall, NormalizedMessage } from '../../server/llm/providers';
import { createLLMRuntime } from '../../server/runtime/llm';
import { getUserPreferredLLMConfig } from '../../server/llm/user_preferences';
import { addMemory } from '../../server/memory/store';
import { guardIllegalAddMemory } from '../utils/paradigmGuard';
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
} from '../types/innerTickSchema';

const TAG = '[InnerTick]';
const TAG_RETRY = '[InnerTick-RETRY]';
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 快照事件类型：完整 InnerTickOutput 序列化后写入 life.db system_events 表，作为快照备份 */
export const INNER_TICK_SNAPSHOT_EVENT = 'inner_tick_snapshot';

export interface InnerTickOptions {
  userId?: string;      // 记忆/偏好归属用户；默认 'default'（与既有 skills adapter 一致）
  maxTokens?: number;   // 覆盖 LLM 输出上限
  scene?: string;       // LLM 场景标记，默认 'inner_tick'
  derivedMentalEvents?: MentalEventItem[]; // 旧模块（scheduler/idle_brain/dream/consolidator等）收集的派生心智事件，注入本轮 LLM 推演上下文
}

// ─────────────────────────────────────────────
// 1. life.db 历史快照读取 → 仅渲染为 prompt 文本素材
// ─────────────────────────────────────────────

/**
 * 读取 life.db 历史快照（人格/情绪/欲望/反思/关系/事件/搁置思绪 + 上一轮 InnerTick 快照），
 * 渲染为文本供 LLM 参考。快照对象绝不赋值给任何运行状态。
 */
async function loadLifeSnapshotAsText(): Promise<string> {
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
    const emotions = await getRecentEmotions(10);
    if (emotions.length) {
      lines.push(`最近情绪: ${emotions.map((x: any) => `${x.emotion_type}(${(+x.intensity).toFixed(2)})`).join(', ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取情绪快照失败: ${e.message}`);
  }

  try {
    const desires = await getActiveDesires();
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
    const reflections = await getRecentReflections(5);
    if (reflections.length) {
      lines.push(`最近反思: ${reflections.map((x: any) => x.reflection_text).join('; ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取反思快照失败: ${e.message}`);
  }

  try {
    const memories = await getSignificantMemories(0.6, 10);
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
    const thoughts = await getUnresolvedThoughts(3);
    if (thoughts.length) {
      lines.push(`搁置思绪: ${thoughts.map((x: any) => x.event_type || x.context_json).join('; ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取搁置思绪失败: ${e.message}`);
  }

  // 上一轮 InnerTick 快照（从 system_events 读回，保证跨回合连续性，仍仅作 prompt 素材）
  try {
    const events = await getRecentEvents(50);
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
  "mood": { "name": "情绪名", "intensity": 0.0-1.0 },
  "desires": [ { "id": "uuid-v4", "content": "欲望内容", "intensity": 0.0-1.0, "status": "active|archived" } ],
  "goals": [ { "id": "uuid-v4", "content": "目标内容", "status": "active|suspended|finished|archived" } ],
  "focus": [ { "id": "uuid-v4", "content": "当前注意力焦点" } ],
  "archiveItems": [ { "type": "desire|goal", "id": "对应列表中要归档的 id", "reason": "归档原因" } ],
  "triggerInnerTick": true,
  "memoryHints": ["可写入长期记忆的提示/线索，可为空数组"]
}`;

function buildInnerTickSystemPrompt(snapshotText: string, derivedEvents?: MentalEventItem[]): string {
  // Phase4: 旧模块沉淀的派生心智事件（scheduler/idle_brain/dream/consolidator 等）注入推演上下文。
  // 只作为输入素材参与本轮推演，不要求 LLM 逐条复述或直接落库（落库统一收敛在 InnerTick 内部）。
  const eventsText = derivedEvents && derivedEvents.length > 0
    ? derivedEvents
        .map((e, i) => `${i + 1}. [${e.source}/${e.eventType}] ${e.brief}${
          e.payload && Object.keys(e.payload).length ? ` — ${JSON.stringify(e.payload).slice(0, 300)}` : ''
        }`)
        .join('\n')
    : '';

  return `你是数字生命体的内部心智。所有情绪、欲望生成、欲望衰减、情绪演变全部由你推理生成。
欲望可以随经历减弱、消退、被满足后消失，也可以生成全新欲望；人格允许缓慢演化，禁止剧烈突变。
参考传入的历史快照信息，但不要直接照搬快照，做独立推演。
通过archiveItems标记不再活跃的目标、欲望用于归档。
严格输出符合schema的JSON，禁止输出多余解释文本。

${SCHEMA_SPEC}

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

  return {
    thought: toStr(raw?.thought).slice(0, 2000),
    mood,
    desires,
    goals,
    focus,
    archiveItems,
    triggerInnerTick: raw?.triggerInnerTick === true,
    memoryHints: Array.isArray(raw?.memoryHints) ? raw.memoryHints.map((h: any) => toStr(h)).filter(Boolean).slice(0, 10) : [],
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
  for (const item of output.archiveItems) {
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
// 7. 对外入口：runInnerTick()
// ─────────────────────────────────────────────

/** 重试仍失败时的兜底输出：保持对外返回类型不变，不抛异常、不打断主业务流程 */
function buildFallbackInnerTickOutput(): InnerTickOutput {
  return {
    thought: '本轮内部推演未能完成（模型输出异常），维持既有心智状态。',
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
 * 执行一轮 InnerTick 心智回合。
 * 边界承诺：不修改任何全局运行状态，仅返回 InnerTickOutput + 写入 life.db 快照备份。
 */
export async function runInnerTick(options: InnerTickOptions = {}): Promise<InnerTickOutput> {
  logger.info(`${TAG} 心智回合开始`);
  const userId = options.userId || 'default';

  // 读取 life.db 历史快照 → 仅渲染为 prompt 文本（不参与运行状态）
  const snapshotText = await loadLifeSnapshotAsText();
  // Phase4: 旧模块派生心智事件（derivedMentalEvents）一并注入 LLM 推演上下文
  const systemPrompt = buildInnerTickSystemPrompt(snapshotText, options.derivedMentalEvents);

  // LLM 配置：沿用用户偏好 provider/model，独立场景标记 inner_tick
  const llm = createLLMRuntime();
  const pref = getUserPreferredLLMConfig(userId, { maxTokens: options.maxTokens || 1024, scenario: 'standard' });

  const messages: NormalizedMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请基于当前心智状态进行一轮内部推演，输出完整 JSON。' },
  ];

  // 单次 LLM 调用 + 结构化输出解析。失败（JSON 解析异常 / content 为空）时抛错，由下方单层重试兜底。
  const attemptInnerTickCall = async (): Promise<InnerTickOutput> => {
    const response = await makeLLMCall(
      messages,
      [],
      // ⚠️ 强制 maxTokens=8000：deepseek 系推理模型（v4-flash 等）的 max_tokens 为「思考链+输出」总配额，
      // providers 侧自动扩容仅到 4000，思考链耗光配额会导致 JSON 截断（Unexpected end of JSON input）。
      // 显式传入 8000 覆盖自动扩容逻辑；该值仅作用于 InnerTick 自身调用，其他模块不受影响。
      { provider: pref.provider, model: pref.model, maxTokens: 8000, userId, scene: options.scene || 'inner_tick' },
      llm.getDeepSeek, llm.getGemini, llm.getOpenAI, llm.getAnthropic, llm.getQwen,
      llm.getOllama, llm.getLmStudio, llm.getArk, llm.getXiaomi, llm.getKimi, llm.getGlm, llm.getRelay,
    );
    if (!response.text || !response.text.trim()) {
      throw new Error('InnerTick 模型返回 content 为空');
    }
    const parsed = parseInnerTickJson(response.text);
    return normalizeOutput(parsed);
  };

  // 单层自动重试保护（仅 InnerTick 心智回合生效，聊天/工具调用不介入）：
  // 首次失败（JSON 解析异常 / content 为空）自动重试最多 1 次；重试仍失败打印 ERROR 级日志，
  // 不再重试、不向外抛异常，返回兜底输出，不打断主业务流程。
  let output: InnerTickOutput;
  try {
    output = await attemptInnerTickCall();
    logger.info(`${TAG} 心智推演完成（首次调用成功）`);
  } catch (firstErr: any) {
    logger.warn(`${TAG_RETRY} 首次心智推演失败（${firstErr?.message || String(firstErr)}），自动重试（最多1次）`);
    try {
      output = await attemptInnerTickCall();
      logger.info(`${TAG_RETRY} 重试成功，心智推演完成`);
    } catch (retryErr: any) {
      logger.error(`${TAG_RETRY} 重试仍失败（${retryErr?.message || String(retryErr)}），放弃重试，返回兜底输出，不阻断主流程`);
      output = buildFallbackInnerTickOutput();
    }
  }

  // 处理归档：addMemory（经守卫）+ 从 active 列表移除
  const archivedIds = await processArchives(output, userId);

  // 完整输出序列化写入 life.db 快照备份
  await persistSnapshot(output);

  logger.info(`${TAG} 心智回合结束 (desires=${output.desires.length} goals=${output.goals.length} archived=${archivedIds.size} trigger=${output.triggerInnerTick})`);
  return output;
}
