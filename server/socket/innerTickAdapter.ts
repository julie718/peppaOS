// server/socket/innerTickAdapter.ts
// Phase2 心智回合对接层（聊天链路侧）— 会话上下文提取适配器 + 聊天链路触发封装
//
// 职责：
//  1. 会话上下文提取适配器：读取当前会话记忆（工作记忆）+ 长程摘要/用户画像（归档记忆），
//     采用工作记忆/归档记忆分离逻辑组装 runInnerTick 需要的 conversationSummary 输入结构体，
//     按 token 预算过滤超长内容，控制注入 LLM 推演的 token 规模；
//  2. 聊天链路触发封装：环境变量开关（PEPPA_INNER_TICK_ENABLE，默认 true）+ 执行耗时/token 观测
//     + 结构化日志埋点（成功/失败标记、InnerTickOutput 完整摘要）；异常捕获打印完整堆栈，不崩溃主聊天流程；
//     PEPPA_INNER_TICK_ENABLE 仅控制 chat_turn 对话回合触发源；scheduler/dream/narrative 等其他
//     runInnerTick 调用点不受该开关管控（详见偏差签署 PHASE2_DEVIATION.md）；
//  3. 存储隔离：InnerTick 输出由 src/core/innerTick.ts 内部统一写入独立观测表 inner_tick_snapshot
//     （写入前经 guardInnerTickLifeOverwrite 范式守卫校验白名单），本层绝不接触/覆盖任何旧 life 状态表
//     （emotions/desires/personality/self_reflections/interaction_memories/relationship_* 等）。
//
// 硬性边界（Phase2）：
//  - 不修改 innerTickSchema.ts 内部定义、不改动 Phase1 产出的 src/core/innerTick.ts 核心逻辑；
//  - 触发为异步 fire-and-forget（调用方不 await），绝不影响聊天响应返回；
//  - 本层只做链路对接、状态读取、日志埋点；InnerTick 输出不参与生成给用户看的回答。
//  - 旧 life TICK 状态机（server/life）完全不受本层影响，两套心智数据物理隔离，供后期对照评估。

import { getMessages, getConversationSummary } from '../conversation/manager';
import { getUserPreferenceTags } from '../db/lifeDb';
import { estimateTokenCount } from '../llm/providers';
import { runInnerTick } from '../../src/core/innerTick';
import type { InnerTickOutput } from '../../src/types/innerTickSchema';
import { logger } from '../lib/logger';

const TAG = '[Phase2-InnerTick]';

// ─────────────────────────────────────────────
// 1. 环境变量开关：PEPPA_INNER_TICK_ENABLE（默认 true）
//    仅控制 chat_turn 对话回合触发源；scheduler/dream/narrative 等其他 runInnerTick 调用点不受该开关管控；
//    读取发生在每次触发时（非进程启动缓存），运行中修改 .env 并重启服务即生效。
// ─────────────────────────────────────────────

export const PEPPA_INNER_TICK_ENV = 'PEPPA_INNER_TICK_ENABLE';

/** 开关判定：缺省 / true / 1 / yes / on → 开启；false / 0 / no / off → 关闭 */
export function isInnerTickEnabled(): boolean {
  const raw = (process.env[PEPPA_INNER_TICK_ENV] || 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no' && raw !== 'off';
}

// ─────────────────────────────────────────────
// 2. 会话上下文提取适配器
//    工作记忆（working memory）：最近 N 条会话 user/assistant 对（即时上下文，本轮推演的直接素材）；
//    归档记忆（archival memory）：会话长程摘要 + 用户偏好标签（长期画像，低优先级素材）；
//    两段分离后按独立 token 预算截断，合计受总预算约束，控制注入规模。
// ─────────────────────────────────────────────

/** 注入 LLM 推演的对话上下文总 token 预算（估算值，基于 estimateTokenCount） */
export const CTX_TOTAL_BUDGET_TOKENS = 2200;
/** 归档记忆段预算：长程摘要 + 用户偏好标签 */
export const CTX_ARCHIVAL_BUDGET_TOKENS = 700;
/** 工作记忆段预算：最近会话对 */
export const CTX_WORKING_BUDGET_TOKENS = 1000;
/** 本轮对话段预算：本轮用户消息 + 助手回复 */
export const CTX_CURRENT_BUDGET_TOKENS = 500;
/** 工作记忆最近会话对数量上限（超出部分按时间最久截断） */
export const CTX_WORKING_MESSAGE_LIMIT = 6;
/** 归档记忆偏好标签条数上限（按权重降序取） */
export const CTX_PREFERENCE_TAG_LIMIT = 12;

export interface InnerTickChatContextInput {
  userId: string;               // 记忆/偏好归属用户（chat 的 uid）
  conversationId?: string;      // 会话ID（chat 的 conversationId；缺省回退 conv_<userId>）
  userMessage: string;          // 本轮用户消息原文
  assistantResponse: string;    // 本轮助手回复原文
}

export interface InnerTickChatContextStats {
  approxInputTokens: number;    // 组装上下文估算 token 总数（estimateTokenCount 求和）
  workingMemoryPairs: number;   // 工作记忆实际装载的会话对数
  archivalChunks: number;       // 归档记忆实际装载的素材块数（摘要/偏好各计1）
  truncated: boolean;           // 是否有任何段被预算截断
  buildMs: number;              // 上下文组装耗时（毫秒）
}

export interface InnerTickChatContext {
  summaryText: string;          // 组装后的对话上下文摘要文本（注入 runInnerTick.conversationSummary）
  stats: InnerTickChatContextStats;
}

/** 按 token 预算截断文本：估算超出预算 → 按保守字符比例粗切并重新估算；不超出则原样返回 */
function fitToTokenBudget(text: string, budgetTokens: number): { text: string; tokens: number; truncated: boolean } {
  if (!text) return { text: '', tokens: 0, truncated: false };
  const tokens = estimateTokenCount(text);
  if (tokens <= budgetTokens) return { text, tokens, truncated: false };
  // 中英混排保守按 2 字符/token 粗切（中文约 1.5 字/token、英文约 4 字/token，取中间偏保守值）
  const targetChars = Math.floor(budgetTokens * 2);
  const cut = text.slice(0, targetChars);
  return { text: cut, tokens: estimateTokenCount(cut), truncated: true };
}

/** 读取工作记忆：最近会话 user/assistant 对（过滤 tool 记录/主动消息/UI 错误等非对话内容） */
function loadWorkingMemory(conversationId: string | undefined, limit: number): { role: 'user' | 'assistant'; content: string }[] {
  if (!conversationId) return [];
  try {
    const uiOnlySources = new Set(['error', 'proactive']);
    const msgs = getMessages(conversationId, limit);
    const pairs: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of msgs) {
      const record: any = m;
      if (record.role === 'agent') continue;                                  // 主动消息（greeting/proactive）
      if (record.mode === 'proactive' || uiOnlySources.has(record.source)) continue; // UI 层消息
      if (record.toolCalls || record.type === 'tool' || record.tool_call_id) continue; // 工具记录
      const userPart = String(record.message || record.content || '').trim();
      const respPart = String(record.response || '').trim();
      if (userPart) pairs.push({ role: 'user', content: userPart });
      if (respPart) pairs.push({ role: 'assistant', content: respPart });
    }
    return pairs;
  } catch (e: any) {
    logger.warn(`${TAG} 读取工作记忆（会话历史）失败（不影响本轮推演）: ${e.message}`);
    return [];
  }
}

/** 读取归档记忆：会话长程摘要 + 用户偏好标签（权重降序前 N 条） */
async function loadArchivalMemory(input: InnerTickChatContextInput): Promise<string[]> {
  const chunks: string[] = [];

  try {
    const summary = input.conversationId ? getConversationSummary(input.conversationId) : null;
    if (summary) chunks.push(`对话长程摘要: ${String(summary).trim()}`);
  } catch (e: any) {
    logger.warn(`${TAG} 读取归档记忆（会话长程摘要）失败（不影响本轮推演）: ${e.message}`);
  }

  try {
    const tags = await getUserPreferenceTags(input.userId, 0.15);
    const top = (tags || []).slice(0, CTX_PREFERENCE_TAG_LIMIT);
    if (top.length) {
      chunks.push(`用户偏好标签: ${top.map((t) => `${t.tag}(${t.weight.toFixed(2)})`).join(', ')}`);
    }
  } catch (e: any) {
    logger.warn(`${TAG} 读取归档记忆（用户偏好标签）失败（不影响本轮推演）: ${e.message}`);
  }

  return chunks;
}

/**
 * 组装 InnerTick 对话上下文输入结构体。
 * 结构：本轮对话段（最新素材）→ 工作记忆段（最近会话，即时上下文）→ 归档记忆段（长程摘要+用户画像）。
 * 各段按独立预算截断（filter超长内容），合计不超过总预算，控制注入 LLM 的 token 规模。
 * 纯读取 + 文本组装，不产生任何写入；失败段降级为空，不影响主流程。
 */
export async function buildInnerTickChatContext(input: InnerTickChatContextInput): Promise<InnerTickChatContext> {
  const startedAt = Date.now();
  const truncatedFlags: boolean[] = [];

  // 本轮对话段（预算 CTX_CURRENT_BUDGET_TOKENS）
  const currentLines = [
    input.userMessage.trim() ? `用户消息: ${input.userMessage.trim()}` : '',
    input.assistantResponse.trim() ? `助手回复: ${input.assistantResponse.trim()}` : '',
  ].filter(Boolean).join('\n');
  const current = fitToTokenBudget(currentLines, CTX_CURRENT_BUDGET_TOKENS);
  truncatedFlags.push(current.truncated);

  // 工作记忆段（预算 CTX_WORKING_BUDGET_TOKENS；最近 CTX_WORKING_MESSAGE_LIMIT 条 user/assistant 对）
  const workingPairs = loadWorkingMemory(input.conversationId, CTX_WORKING_MESSAGE_LIMIT);
  const workingLines = workingPairs.map((p) => `${p.role === 'user' ? '用户' : '助手'}: ${p.content}`).join('\n');
  const working = fitToTokenBudget(workingLines, CTX_WORKING_BUDGET_TOKENS);
  truncatedFlags.push(working.truncated);

  // 归档记忆段（预算 CTX_ARCHIVAL_BUDGET_TOKENS；长程摘要 + 用户偏好标签）
  const archivalChunks = await loadArchivalMemory(input);
  const archivalLines = archivalChunks.join('\n');
  const archival = fitToTokenBudget(archivalLines, CTX_ARCHIVAL_BUDGET_TOKENS);
  truncatedFlags.push(archival.truncated);

  const sections: string[] = [];
  if (current.text) sections.push(`【本轮对话】\n${current.text}`);
  if (working.text) sections.push(`【工作记忆·最近会话】\n${working.text}`);
  if (archival.text) sections.push(`【归档记忆·长程上下文】\n${archival.text}`);

  const summaryText = sections.join('\n\n') || '(无摘要)';
  const approxInputTokens = current.tokens + working.tokens + archival.tokens;

  return {
    summaryText,
    stats: {
      approxInputTokens,
      workingMemoryPairs: workingPairs.length,
      archivalChunks: archivalChunks.length,
      truncated: truncatedFlags.some(Boolean),
      buildMs: Date.now() - startedAt,
    },
  };
}

// ─────────────────────────────────────────────
// 3. InnerTickOutput 观测摘要 + 失败兜底识别
// ─────────────────────────────────────────────

/** 将 InnerTickOutput 压缩为单行结构化观测摘要（thought/mood/desires/goals/focus/archive + P2 演化字段） */
export function summarizeInnerTickOutput(o: InnerTickOutput): string {
  const mood = o.mood ? `${o.mood.name}(${o.mood.intensity.toFixed(2)})` : '-';
  const emotionDrift = o.emotionDrift
    ? `${o.emotionDrift.name}(${o.emotionDrift.intensity.toFixed(2)},Δ${o.emotionDrift.change >= 0 ? '+' : ''}${o.emotionDrift.change.toFixed(2)})`
    : '-';
  const personalityDrift = o.personalityDrift
    ? `delta=[${o.personalityDrift.delta.map((v) => v.toFixed(3)).join(',')}]`
    : '-';
  const relationshipAdjustment = o.relationshipAdjustment
    ? `vector=[${o.relationshipAdjustment.vector.map((v) => v.toFixed(2)).join(',')}]`
    : '-';
  return (
    `output={ thought="${(o.thought || '').slice(0, 60)}" ` +
    `isPublic=${o.isPublic === true} mood=${mood} desires=${o.desires.length} goals=${o.goals.length} focus=${o.focus.length} ` +
    `archive=${o.archiveItems.length} memoryHints=${o.memoryHints.length} triggerInnerTick=${o.triggerInnerTick} ` +
    `emotionDrift=${emotionDrift} desireEvolve=${o.desireEvolve?.length ?? 0} ` +
    `personalityDrift=${personalityDrift} relationshipAdjustment=${relationshipAdjustment} }`
  );
}

/**
 * 识别 runInnerTick 内部 LLM 推演失败的兜底输出（超时/解析失败等场景返回 buildFallbackInnerTickOutput，
 * 特征：triggerInnerTick=false + 无欲望/目标/焦点 + 固定失败占位 thought）。
 * 用于观测日志区分「LLM 推演失败回退（本轮零写库）」与「正常推演」。
 */
export function detectFallbackInnerTickOutput(o: InnerTickOutput): boolean {
  return (
    o.triggerInnerTick === false &&
    o.desires.length === 0 &&
    o.goals.length === 0 &&
    o.focus.length === 0 &&
    /未能完成|模型输出异常/.test(o.thought || '')
  );
}

// ─────────────────────────────────────────────
// 4. 聊天链路触发封装（异步 fire-and-forget，供 chat.ts 对话轮次结束后调用）
// ─────────────────────────────────────────────

export interface InnerTickTriggerResult {
  ok: boolean;                  // 链路级成功（包含 LLM 推演失败但已兜底返回的场景）
  skipped: boolean;             // 开关关闭被跳过
  sessionId: string;
  durationMs: number;           // 触发→完成耗时（含上下文组装 + LLM 推演 + 快照落库）
  approxInputTokens: number;    // 注入 LLM 推演的对话上下文估算 token（适配器组装段）
  inference: 'llm' | 'fallback';// llm=正常推演；fallback=LLM 推演失败回退（本轮心智业务表零写入）
  output?: InnerTickOutput;
  error?: string;
}

/**
 * 对话轮次结束后触发一轮 InnerTick 心智推演。
 * 边界承诺：
 *  - 受 PEPPA_INNER_TICK_ENABLE 开关控制（默认 true；false 仅跳过本 chat_turn 触发源，
 *    scheduler/dream/narrative 等其他 runInnerTick 调用点不受该开关管控）；
 *  - 全程异步执行，本函数返回的 Promise 由调用方 fire-and-forget，绝不阻塞聊天响应；
 *  - 内部所有读取/推演/落库失败均被捕获（完整堆栈日志），绝不抛出到聊天主流程；
 *  - InnerTick 输出只写 inner_tick_snapshot 独立观测表（runInnerTick 内部经守卫校验），
 *    不覆盖/修改任何旧 life 状态表，不参与生成给用户看的回答。
 */
export async function triggerInnerTickAfterChatRound(input: InnerTickChatContextInput): Promise<InnerTickTriggerResult> {
  const sessionId = input.conversationId || `conv_${input.userId}`;

  // 开关检查：关闭 → 仅跳过 chat_turn 触发源（scheduler/dream/narrative 等其他 runInnerTick 调用点不受管控）
  if (!isInnerTickEnabled()) {
    logger.info(`${TAG} trigger=chat_turn session=${sessionId} DISABLED skip（${PEPPA_INNER_TICK_ENV}=false → 仅关闭 chat_turn 触发源，其他调用点不受影响）`);
    return { ok: false, skipped: true, sessionId, durationMs: 0, approxInputTokens: 0, inference: 'fallback' };
  }

  const startedAt = Date.now();
  try {
    // 1) 会话上下文提取（工作记忆/归档记忆分离 + token 预算控制）
    const ctx = await buildInnerTickChatContext(input);

    // 2) 后台触发 InnerTick 心智推演（runInnerTick 内部处理归档 addMemory / life.db 快照备份 /
    //    inner_tick_snapshot 观测表 / P2 迁移落库，均含容错，不抛出）
    const output = await runInnerTick({
      userId: input.userId,
      sessionId,
      conversationSummary: ctx.summaryText,
      triggerSource: 'chat_turn',
    });

    const durationMs = Date.now() - startedAt;
    const inference = detectFallbackInnerTickOutput(output) ? 'fallback' : 'llm';

    // 3) 结构化观测日志：耗时 / token / 上下文统计 / InnerTickOutput 完整摘要 / 成功标记
    logger.info(
      `${TAG} trigger=chat_turn session=${sessionId} ok durationMs=${durationMs} ` +
      `approxInputTokens=${ctx.stats.approxInputTokens} ctx={workingMem=${ctx.stats.workingMemoryPairs} ` +
      `archival=${ctx.stats.archivalChunks} truncated=${ctx.stats.truncated} buildMs=${ctx.stats.buildMs}} ` +
      `inference=${inference} ${summarizeInnerTickOutput(output)}`,
    );

    return { ok: true, skipped: false, sessionId, durationMs, approxInputTokens: ctx.stats.approxInputTokens, inference, output };
  } catch (e: any) {
    // 最终防线：任何未预期异常（上下文组装/调度/快照写入等）均在此兜底，绝不向上抛出影响聊天流程
    const durationMs = Date.now() - startedAt;
    logger.error(
      `${TAG} trigger=chat_turn session=${sessionId} fail durationMs=${durationMs} ` +
      `error=${e?.message || String(e)} kind=${e?.name || 'unknown'}`,
    );
    console.error(`${TAG} chat轮次触发InnerTick异常（不影响聊天流程），完整堆栈:`, e);
    return { ok: false, skipped: false, sessionId, durationMs, approxInputTokens: 0, inference: 'fallback', error: String(e?.message || e) };
  }
}
