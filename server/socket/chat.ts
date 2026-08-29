/**
 * agent:chat socket handler — the core conversational AI pipeline
 */
import { Socket } from "socket.io";
import { logger } from '../lib/logger';
import jwt from "jsonwebtoken";
import { readDB, writeDB } from "../../db_layer";
import { pushNotification } from "../routes/notifications";
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from "../llm/providers";
import { LLMUsage, ToolExecutionRecord } from "../tools/types";
import { toolRegistry } from "../tools/registry";
import { runWithTools } from "../llm/adapter";
import { getOperationModeConfig, parseStoredOperationMode } from "../cognition/operation_modes";
// tool_intent 正则门控已移除（shouldAllowToolUseForTurn 由模式配置 + 心智接管）
// work_surface 正则门控已移除（resolveWorkSurfaceRoute 删除）
// tool_router 静态工具路由已移除（routeToolsForTurn 删除）
import { formatClientSelfPrompt } from "../client/self_model";
import { queryMemories, queryMemoriesVector, addMemory, addReminder, extractMemories, retrieveRelevantMemories, getTimeline, getMemories, storeMemory, extractKeyFacts, applyPreferenceFacts, formatPreferenceTagsForPrompt, getSensitiveTopicGuard, extractKnowledge, storeKnowledge, getKnowledge, formatKnowledgeForContext } from "../memory";
import { getUserPreferenceTags } from "../db/lifeDb";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, loadHIMState, saveHIMState, vectorMemoryBias } from "../personality/state";
import { buildModeOverlay } from "../personality/engine";
import { personalityRegistry } from "../personality";
import { lightweightEvolve } from "../personality/evolution";
import { getOrCreateActiveConversation, addMessage, getMessages, getMessagesByTokenBudget, checkAutoSummary, setConversationSummary, getConversationSummary, setConversationMode, getUnclosedConversation, extractTopics, trackTopic, getTopicContext } from "../conversation/manager";
import { ensureBranch } from "../memory/tree";
// PHASE0-DISABLED: focusStack外部栈为反模式，阶段0停用 — 阶段0禁用，反模式，保留用于回滚
// import { detectAndSwitchTopic } from "../memory/focusStack";
import { getPrefetchedContext, clearPrefetchedContext, touchActivity } from "../memory/prefetch";
import { getLifeSystem, getDirectionState } from "../life/index";
// getVitality 仅本能层使用，已随正则池移除
import { getEmotionEngine } from "../life/emotions";
import { getPersonalityEngine } from "../life/personality";
import { getRelationshipEngine } from "../life/relationship";
import { onInteractionComplete } from "../life/relationshipAwareness";
import { routeMessage } from "../cognition/router";
import { getSelfState } from "../cognition/selfState";
// narrative 本能话术模板已随正则池移除
import { touchUserActivity } from "../life/userState";
// P0-6: IdleBrain 短待机入口（对话结束标记）
import { idleBrain } from '../autonomy/idle_brain';
// Phase2：对话结束异步触发 InnerTick 心智回合 — 对接层封装（上下文适配器 + 开关 + 观测日志，见 innerTickAdapter.ts）
import { triggerInnerTickAfterChatRound } from "./innerTickAdapter";
// Phase3：会话心智灰度注入层 — 白名单会话用 InnerTick 快照驱动会话心智（B模式），其余走旧life（A模式）
import { resolveSessionMind } from "../../src/core/sessionMindProvider";
// 【新增数字生命体模块】T80 心智 + MCP 拦截器
import { buildMindContext, MindContext, SEVEN_STEP_MIND } from '../hooks/chat';
// 第二阶段: 理解状态感知 — updateComprehension（对话入口评估 → 任务1追问 + 任务2复杂度感知共用该状态）
import { updateComprehension } from '../life/comprehension';
// 【重构·模块4】固定话术剔除：重逢问候由心智润色组成
import { composeTriggerContent } from '../proactive/rhythm';
import { mcpInterceptor, buildToolBlockMessage, applyConstitutionGuard, MCP_MAX_CALLS_PER_TURN, markToolResultTTL } from '../tools/interceptor';
import { getUnrespondedObservations, markObservationResponded } from "../db/lifeDb";
import { retrieveChunks } from "../agents/rag";
import { getSensory, chatInFlight } from "./shared";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext } from "../cognition";
// quick_commands 关键词→MCP 映射已移除
import { checkLLMAccess, recordUsage, estimateTokens } from "../subscription/proxy";
import { recordTokenUsage } from "../llm/token_tracker";
import { ChatWarnings, buildAmbientWarnings } from "../utils/chatWarnings";
import { runOrchestratedTask, shouldDistillSkill, buildSkillDescription, classifyComplexity } from "../agents/orchestrator";
import { buildDelegationAck, shouldDelegateWorkInBackground } from "../agents/background_delegation";
import {
  cancelBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  getBackgroundTask,
  incrementBackgroundTaskToolCalls,
  isBackgroundTaskCancellationRequested,
  markBackgroundTaskRunning,
  registerBackgroundTask,
  requestCancelBackgroundTask,
} from "../agents/background_tasks";
// nl_chainer 正则链式任务判定已移除
// auto_installer 已随 nl_chainer 移除
import { adjustMusicPlayback, getMusicFailureMessage, isMusicAdjustmentRequest, isMusicPlaybackRequest, searchAndPlay } from "../music/search_play";
import { searchKnowledgeBase } from "../org/kb";
import { getMember } from "../org/db";
import { getWorkflow, recordWorkflowRun, listWorkflows } from "../agents/workflows";
import { buildProfessionOverlay } from "../autonomy/professions";
import { analyzeLikedMusicProfile, formatMusicProfileReport } from "../music/library_profile";
import { buildResponseLanguageInstruction } from "../utils/language";
import { guardCompletionClaims, needsCompletionEvidence } from "../work_product/completion_guard";
import { buildModelSelfAwareness, buildVisionRoutingOverlay, hasVisionIntent } from "../cognition/vision_routing";
import { DEFAULT_MODELS, COMPLEX_MODELS, getScopedPreferredLLM, getScenarioModel } from "../llm/user_preferences";
import { generateTemporalContext } from '../time/temporal_context';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required — refusing to start with a guessable fallback secret');
}

function normalizeChatHistoryRecord(m: any): NormalizedMessage[] {
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : m?.role === 'user' ? 'user' : '';
  const source = typeof m?.source === 'string' ? m.source : '';
  const uiOnlySources = new Set(['error', 'proactive']);
  if (
    !role ||
    m?.role === 'tool' ||
    m?.type === 'tool' ||
    m?.mode === 'proactive' ||
    uiOnlySources.has(source) ||
    m?.toolCalls ||
    m?.tool_call_id
  ) return [];

  const entries: NormalizedMessage[] = [];
  const message = typeof m?.message === 'string' ? m.message.trim() : '';
  const content = typeof m?.content === 'string' ? m.content.trim() : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const primaryText = message || content;
  const isUiErrorText = /^(Request failed|请求失败|出错了|Failed to route)/i.test(primaryText);

  if (primaryText && !isUiErrorText) {
    entries.push({ role, content: primaryText });
  }
  if (response && role === 'user') {
    entries.push({ role: 'assistant', content: response });
  }
  return entries;
}

// Bug 修复：对话上下文 token 硬上限截断 — 修复单轮 56k tokens 无限膨胀
// （客户端 history 与持久化历史无上限拼接，长会话越滚越大）。
// 策略：system（首条）+ 最新用户消息（末条）恒保留；历史按「保留近期对话」从最旧处
// 逐条丢弃、至少保留最近 2 条（上一轮问答连续性）；只作用于最终拼装数组，不改底层检索逻辑。
const LLM_CONTEXT_TOKEN_LIMIT = parseInt(process.env.LLM_CONTEXT_TOKEN_LIMIT || '40000', 10);

export function trimContextToTokenBudget(messages: NormalizedMessage[], budget: number): NormalizedMessage[] {
  // content 可能是 string 或多模态内容数组（图片等），统一抽取文本部分估算 token
  const est = (m: NormalizedMessage) => {
    const raw = m.content as any;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join(' ') : '';
    return estimateTokens(text);
  };
  const totalBefore = messages.reduce((s, m) => s + est(m), 0);
  if (totalBefore <= budget) return messages;

  const head = messages[0];
  const tail = messages[messages.length - 1];
  const history = messages.slice(1, -1);
  const minKeep = Math.min(history.length, 2);

  let total = totalBefore;
  const kept: NormalizedMessage[] = [...history];
  while (total > budget && kept.length > minKeep) {
    const dropped = kept.shift();
    if (dropped) total -= est(dropped);
  }

  // 兜底：最近 2 条历史仍超预算时（典型场景：单条助手回复本身巨大），
  // 对最旧保留历史做文本级截断（新对象，不改调用方引用），保证硬上限不被击穿。
  // 按比例 0.8 逐轮收缩并用估算器校验，避免「1 token ≈ N 字符」线性换算在 CJK 下失真。
  let idx = 0;
  while (total > budget && idx < kept.length) {
    const target = kept[idx];
    const cur = typeof (target as any).content === 'string' ? (target as any).content : '';
    if (!cur) { idx++; continue; }
    const estCur = est(target);
    const shrinkTarget = Math.max(20, estCur - (total - budget)); // 该条需降至的目标 token（最低 20）
    let sliced = cur;
    while (est({ ...target, content: sliced } as any) > shrinkTarget && sliced.length > 20) {
      sliced = sliced.slice(0, Math.floor(sliced.length * 0.8));
    }
    const estSliced = estimateTokens(sliced);
    if (estSliced >= estCur) { idx++; continue; } // 无法继续收缩，尝试下一条
    kept[idx] = { ...target, content: sliced } as NormalizedMessage;
    total -= estCur - estSliced;
    if (total <= budget) break;
    idx++;
  }

  const trimmed = [head, ...kept, tail];
  logger.warn(
    `[ChatHandler] 上下文超限截断: ${totalBefore} tokens → ${total} tokens（预算 ${budget}，丢弃 ${totalBefore - total} tokens 旧历史/内容，保留最近 ${kept.length} 条）`,
  );
  return trimmed;
}

interface ChatIncomingAttachment {
  id?: string;
  fileName: string;
  path?: string;
  content?: string | null;
  preview?: string | null;
  mimeType?: string;
  size?: number;
  kind: 'image' | 'file';
}

const MAX_CHAT_ATTACHMENTS = 8;
const MAX_CHAT_ATTACHMENT_CONTENT = 30000;

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength);
}

function isImageAttachment(name: string, mimeType?: string): boolean {
  return Boolean(mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(name || '');
}

function normalizeIncomingAttachments(input: unknown): ChatIncomingAttachment[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_CHAT_ATTACHMENTS).map((item: any) => {
    const fileName = boundedString(String(item?.fileName ?? item?.name ?? item?.id ?? 'attachment'), 240);
    const mimeType = boundedString(String(item?.mimeType ?? ''), 120);
    const kind: ChatIncomingAttachment['kind'] = item?.kind === 'image' || isImageAttachment(fileName, mimeType) ? 'image' : 'file';
    return {
      id: boundedString(item?.id, 160) || undefined,
      fileName,
      path: boundedString(item?.path, 1200) || undefined,
      content: boundedString(item?.content, MAX_CHAT_ATTACHMENT_CONTENT) || null,
      preview: boundedString(item?.preview, 4000) || null,
      mimeType,
      size: typeof item?.size === 'number' ? item.size : undefined,
      kind,
    };
  }).filter(item => item.fileName || item.path || item.content);
}

function buildChatAttachmentContext(attachments: ChatIncomingAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines: string[] = [
    '## Current Turn Attachments',
    'The user attached these files to the current message. Treat them as part of the user request.',
  ];
  attachments.forEach((item, index) => {
    const content = item.content || item.preview || '';
    lines.push(`### ${index + 1}. ${item.fileName}`);
    lines.push(`Type: ${item.kind}${item.mimeType ? ` (${item.mimeType})` : ''}`);
    if (item.path) lines.push(`Local path: ${item.path}`);
    if (item.kind === 'image') {
      lines.push('For visual details, use the ocr_image_file tool with the local path before answering.');
    }
    if (content) {
      lines.push(`Extracted text:\n${content}`);
    } else if (item.path) {
      lines.push('No extracted text is attached; use the local path with an appropriate tool if needed.');
    }
  });
  return lines.join('\n');
}

function buildStoredAttachmentSummary(userText: string, attachments: ChatIncomingAttachment[]): string {
  if (attachments.length === 0) return userText;
  const summary = attachments
    .map(item => `- ${item.fileName}${item.kind === 'image' ? ' (image)' : ''}`)
    .join('\n');
  return `${userText}\n\n[Attachments]\n${summary}`.trim();
}

function buildNaturalReplyStyleOverlay(source?: string): string {
  const voiceLine = source === 'voice'
    ? '- In voice, default to one short sentence. If the user asks a simple question, answer in under 20 Chinese characters when possible.'
    : '- Default to concise replies. Use detail only when the user asks for analysis, implementation, or a report.';
  return [
    '## Reply Style',
    '- Never reveal hidden reasoning, chain-of-thought, private deliberation, or “I need to think/analyze” narration.',
    '- Give the final answer directly. Do not describe how you are deciding unless the user explicitly asks for reasoning.',
    '- If corrected for being verbose, reply with only the correction or confirmation.',
    '- 硬性规则：用户让你做任何事，必须先检查已有工具能否完成。禁止自己调用 generate_skill 造新技能。如果已有工具做不到，告诉用户去技能大厅搜索安装对应的技能。',
    voiceLine,
    '- Always reply in natural conversational Chinese. Use Chinese punctuation such as 。， not English punctuation.',
    '- Never output internal status words like done, ok, let me, cannot, 后台子agent完成, 任务清单, 验收记录, or similar workflow/internal monologue. You are speaking to the user, not to yourself.',
    '- Focus on answering ONLY the latest user message. Reference earlier conversation only if the user explicitly asks about it.',
    '- Give a complete answer. Do not stop mid-sentence or trail off.',
  ].join('\n');
}

// ── M4 辅助：将事实 key 转为可读标签 ──
function formatFactLabel(key: string): string {
  const labels: Record<string, string> = {
    name: '名字',
    preference: '喜欢',
    dislike: '不喜欢',
    workplace: '工作单位',
    location: '居住地',
    hobby: '爱好',
    pet: '宠物',
  };
  return labels[key] || key;
}

export function registerChatHandler(
  socket: Socket,
  llmGetters: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI: () => any;
    getAnthropic: () => any;
    getQwen: () => any;
    getOllama: () => any;
    isOllamaAvailable: () => boolean;
    getLmStudio: () => any;
    isLmStudioAvailable: () => boolean;
    getArk?: () => any;
    getXiaomi?: () => any;
    getKimi?: () => any;
    getGlm?: () => any;
    getRelay?: () => any;
  },
  sensoryFn: (uid: string) => any,
  userIdFn: (s: Socket) => string,
) {
  const chatSessionMap = new Map<string, AbortController>();

  // Handle abort requests
  socket.on("agent:abort_chat", () => {
    const uid = userIdFn(socket);
    let aborted = false;
    for (const [key, controller] of chatSessionMap.entries()) {
      if (!key.startsWith(`${uid}:`)) continue;
      controller.abort();
      chatSessionMap.delete(key);
      aborted = true;
    }
    if (aborted) {
      socket.emit("agent:status", { status: "idle", source: "chat" });
      socket.emit("agent:response", { text: "[Cancelled]", agentName: "Peppa", source: "chat" });
    }
  });

  socket.on("agent:background_cancel", (data: { taskId?: string }) => {
    const uid = userIdFn(socket);
    const taskId = typeof data?.taskId === 'string' ? data.taskId : '';
    if (!taskId) {
      socket.emit("agent:background_task_update", {
        taskId,
        error: 'Missing background task id',
        source: 'background_delegation',
      });
      return;
    }

    const task = requestCancelBackgroundTask(taskId, uid);
    if (!task) {
      socket.emit("agent:background_task_update", {
        taskId,
        error: 'Background task not found',
        source: 'background_delegation',
      });
      return;
    }

    socket.emit("agent:background_task_update", {
      taskId: task.id,
      task,
      source: 'background_delegation',
    });
  });

  socket.on("agent:chat", async (data: { text?: string; history?: any[]; attachments?: any[]; personalityId?: string; category?: string; agentId?: string; domain?: string; orgId?: string | null; mode?: string; source?: string; requestId?: string }) => {
    logger.info('[ChatHandler] agent:chat RECEIVED:', JSON.stringify(data).slice(0, 300));
    touchActivity(); // 更新最后活跃时间，供 prefetch 判断空闲
    (global as any).__lastActiveUid = userIdFn(socket); // 记录最后活跃用户，供 TICK 预判
    // P1-9: 注册真实 LLM Getter 供 IdleBrain 等后台模块复用（consolidateEpisodic 需要非空回调）
    (global as any).__llmGetters = llmGetters;
    const { history, personalityId = "peppa", category, agentId, mode: payloadMode, source } = data;
    const attachments = normalizeIncomingAttachments(data.attachments);
    const rawUserText = typeof data.text === 'string' ? data.text.trim() : '';
    const visibleUserText = rawUserText || (attachments.length > 0 ? 'Please review the attached file(s).' : '');
    const attachmentContext = buildChatAttachmentContext(attachments);
    const text = [visibleUserText, attachmentContext].filter(Boolean).join('\n\n');
    const storedUserContent = buildStoredAttachmentSummary(visibleUserText, attachments);
    const requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 120) : undefined;
    const eventSource = source || 'chat';
    const toolResultPreviewLimit = 500;
    const formatToolResultForUi = (value?: string) => value?.slice(0, toolResultPreviewLimit) || '';
    const emitAgent = (event: string, payload: Record<string, any> = {}) => {
      socket.emit(event, {
        ...payload,
        source: payload.source || eventSource,
        ...(requestId ? { requestId } : {}),
      });
    };
    // 每轮唯一 key（输出保护登记用；声明前置，供 finishWithResponse 引用）
    const interactionId = crypto.randomUUID();
    // ── Phase2 模块3：API 统一返回结构 { content, warnings } ──
    // 所有系统提示（LLM超时/配额/工具报错/磁盘水位/迁移失败等）只进 warnings（铁则6），
    // content 只放对话正文。业务正常时 warnings 为空数组。
    const warnings = new ChatWarnings();
    // 收尾统一出口：合并环境性告警（磁盘水位/迁移失败）后发出 agent:response（content+warnings）
    // 输出保护（任务清单第 3 项）：正式回复下发即登记；若同轮已下发过正式回复，
    // 禁止二次 agent:response 覆盖/重复 —— 改为仅追加 agent:error 报错新消息。
    const finishWithResponse = async (text: string, extra: Record<string, any> = {}) => {
      warnings.addAmbient(await buildAmbientWarnings());
      const { emitProtectedFinal } = await import("../output/protection");
      emitProtectedFinal(
        (ev, p) => emitAgent(ev as any, p),
        requestId || `chat:${uid}:${interactionId}`,
        { ...extra, text, content: text, warnings: warnings.toArray() },
      );
    };
    const conversationAgentId = agentId || 'peppa';
    const uid = userIdFn(socket);
    const sessionKey = `${uid}:${eventSource}`;
    logger.info('[ChatHandler] uid:', uid, 'agentId:', agentId, 'source:', source);

    // Work context comes from the authenticated socket token. Personal mode can be
    // explicitly requested by the desktop UI to avoid a stale org token leaking into
    // local personal conversations.
    let resolvedDomain = 'personal';
    let resolvedOrgId = '';
    try {
      const authToken = socket.handshake?.auth?.token;
      let decoded: any = null;
      if (authToken) {
        decoded = jwt.verify(authToken, JWT_SECRET);
        if (data.domain === 'personal') {
          resolvedDomain = 'personal';
          resolvedOrgId = '';
        } else if (decoded.orgId) {
          resolvedDomain = 'work';
          resolvedOrgId = decoded.orgId;
        }
      }
      if (resolvedDomain !== 'work' && data.domain === 'work') {
        const requestedOrgId = typeof data.orgId === 'string' ? data.orgId.trim() : '';
        if (requestedOrgId) {
          const membership = getMember(requestedOrgId, uid);
          if (membership && membership.status !== 'left' && membership.status !== 'suspended') {
            resolvedDomain = 'work';
            resolvedOrgId = requestedOrgId;
          }
        }
      }
    } catch {}
    logger.info('[ChatHandler] domain:', resolvedDomain, 'orgId:', resolvedOrgId);

    // Abort any previous chat session for this user
    const prevController = chatSessionMap.get(sessionKey);
    if (prevController) prevController.abort();
    const abortController = new AbortController();
    chatSessionMap.set(sessionKey, abortController);
    // P0-1: 思绪搁置标记 — 超时/中止时保留已生成的流式内容，而非暴力销毁
    let thoughtShelved = false;
    // T80: 全局超时 45s → 120s（总时间上限兜底）；每轮 LLM 独立 20s 超时在 adapter.runWithTools 内实现，
    // 单轮超时不中断整个循环，循环结束后用已有部分结果自然输出
    const llmTimeout = setTimeout(() => {
      abortController.abort();
      thoughtShelved = true;
      logger.warn('[ChatHandler] LLM 处理超时 120s，已中止请求并搁置思绪（保留已生成内容）');
    }, 120000);

    // 【新增数字生命体模块】MCP 拦截器每轮重置
    mcpInterceptor.resetForTurn(sessionKey);

    // 抢占 LifeSystem 后台任务
    touchUserActivity();
    // 检查是否有未回应的主动推送 → 标记为已回复
    getUnrespondedObservations().then(rows => {
      if (rows.length > 0) {
        const now = Date.now();
        for (const r of rows) {
          const triggeredAt = new Date(r.triggered_at).getTime();
          const responseTime = Math.round((now - triggeredAt) / 1000);
          markObservationResponded(r.id, responseTime, text.length).catch(() => {});
        }
      }
    }).catch(() => {});
    getLifeSystem().preempt();

    // ── 用户级心智独占互斥锁登记（方案2）──
    // 会话上下文组装完成、业务逻辑正式执行前，向 chatInFlight 登记当前用户"思考中"：
    // 本轮处理期间 REST /api/ai/chat 兜底请求将被 409 拦截，杜绝双通路并行执行 runWithTools
    // （工具重复执行、确认弹窗错乱）。锁生命周期 = 本轮对话处理流程，finally 块必须释放；
    // 若异常悬挂，shared.ts 的 60s 过期判断自动失效，不会永久卡死用户。
    const chatLockStartedAt = Date.now();
    chatInFlight.set(uid, { requestId, startedAt: chatLockStartedAt });
    logger.info(`[ChatInFlight] 锁登记 userId=${uid} requestId=${requestId || '-'}（60s 内 REST 兜底将被 409 拦截）`);

    try {
      // Look up agent record for memory/emotion isolation
      const agentRecord = agentId
        ? readDB().agents.find((a: any) => a.id === agentId) || null
        : null;
      logger.info('[ChatHandler] agentRecord found:', !!agentRecord);
      const memoryScope = agentRecord?.memoryScope || 'shared';
      const agentMemoryFilter = memoryScope === 'private' ? agentId : undefined;
      const isSanctuary = agentRecord?.territory === 'sanctuary';

      // Retrieve personality vector early to bias memory retrieval (cross-system fusion: vector→memory)
      const personalityConfig = personalityRegistry.get(personalityId);
      logger.info('[ChatHandler] personalityConfig:', !!personalityConfig);
      const retrievalBiases = personalityConfig?.personalityVector
        ? vectorMemoryBias(personalityConfig.personalityVector)
        : { typeWeights: {}, perspectiveWeights: {} };

      // Vector semantic search with keyword fallback
      const relevantMemories = await queryMemoriesVector({
        userId: uid, query: text, limit: 5, minConfidence: 0.4, agentId: agentMemoryFilter,
        retrievalTypeWeights: retrievalBiases.typeWeights,
        retrievalPerspectiveWeights: retrievalBiases.perspectiveWeights,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        useVector: true,
      });
      logger.info('[ChatHandler] relevantMemories (vector):', relevantMemories.length);

      // 交互历史检索：从 peppa.db interactions 表检索与当前话题相关的历史记录
      let relevantHistory = '';
      try {
        const interactionMemories = await retrieveRelevantMemories(text, 5);
        if (interactionMemories.length > 0) {
          relevantHistory = '## 相关历史记忆\n你与用户曾有过以下相关交流：\n'
            + interactionMemories.map((m, i) =>
                `${i + 1}. [${m.timestamp?.slice(0, 16) || '未知时间'}] 用户: "${m.message.slice(0, 200)}"\n   你的回复: "${(m.response || '').slice(0, 200)}"`
              ).join('\n')
            + '\n请参考以上历史记忆，使回复更连贯、个性化。';
          logger.info('[ChatHandler] 相关历史记忆:', interactionMemories.length, '条');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 交互历史检索异常:', e.message);
      }

      // 时间线检索：最近 7 天的重要交互，按时间倒序
      let timelineHistory = '';
      try {
        const timelineEntries = await getTimeline({ days: 7, limit: 10 });
        if (timelineEntries.length > 0) {
          timelineHistory = '## 最近 7 天时间线\n以下是你与用户最近的交互时间线：\n'
            + timelineEntries.map((e, i) =>
                `${i + 1}. [${e.timestamp?.slice(0, 16) || '未知时间'}] [${e.type}] ${e.summary}`
              ).join('\n')
            + '\n请参考时间线理解用户近期的关注点和情绪变化。';
          logger.info('[ChatHandler] 时间线:', timelineEntries.length, '条');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 时间线检索异常:', e.message);
      }

      // RAG: retrieve relevant knowledge chunks from agent-scoped and Peppa knowledge.
      let ragChunks: string[] = [];
      const ragAgentIds = Array.from(new Set([conversationAgentId, 'peppa'].filter(Boolean)));
      for (const ragAgentId of ragAgentIds) {
        const chunks = retrieveChunks(uid, ragAgentId, text, 3, {
          domain: resolvedDomain,
          orgId: resolvedDomain === 'work' ? resolvedOrgId : '',
        });
        for (const chunk of chunks) {
          const content = (chunk as any).content;
          if (content && !ragChunks.includes(content)) ragChunks.push(content);
          if (ragChunks.length >= 5) break;
        }
        if (ragChunks.length >= 5) break;
      }

      // Org: search company KB when in work domain
      let kbContext: string | undefined;
      if (resolvedDomain === 'work' && resolvedOrgId) {
        try {
          const kbResults = await searchKnowledgeBase(resolvedOrgId, text, 3);
          if (kbResults.length > 0) {
            kbContext = kbResults
              .map(r => `[${r.title}] ${r.chunk}`)
              .join('\n');
            logger.info('[ChatHandler] KB search results:', kbResults.length, 'articles found');
          }
        } catch (err: any) {
          logger.warn('[ChatHandler] KB search failed:', err.message);
        }
      }

      const emotionKey = agentMemoryFilter ? `${uid}_agent_${agentId}` : uid;
      const emotionalState = loadEmotionalState(emotionKey);
      const himState = loadHIMState(emotionKey);
      logger.info('[ChatHandler] emotionalState loaded');
      const isNovel = relevantMemories.length < 2;

      // ── Conversation mode: get/create conversation, apply mode from payload ──
      const conversation = getOrCreateActiveConversation(uid, conversationAgentId, resolvedDomain, resolvedOrgId);
      const conversationId = conversation?.id;
      // Cross-session continuity: inject previous conversation context if starting fresh
      let previousSessionContext: string | null = null;
      if (!conversationId) {
        const prevConv = getUnclosedConversation(uid);
        if (prevConv && prevConv.id !== conversationId) {
          const prevSummary = getConversationSummary(prevConv.id);
          if (prevSummary) {
            previousSessionContext = `## Previous Session (${prevConv.lastActiveAt?.slice(0, 10) || 'recent'})\nYou and the user were discussing: ${prevSummary}\n\nContinue naturally. The user may want to pick up where you left off.`;
          }
        }
      }
      const conversationMode = payloadMode || conversation?.mode || undefined;
      if (conversation && payloadMode && payloadMode !== conversation.mode) {
        setConversationMode(conversation.id, payloadMode);
      }
      logger.info('[ChatHandler] conversationId:', conversationId, 'mode:', conversationMode);

      const sensory = sensoryFn(uid);
      logger.info('[ChatHandler] sensory loaded');
      const { config: personality, systemPrompt: systemInstruction } = personalityRegistry.buildSystemPrompt(
        personalityId,
        { mode: 'chat', sensory },
        {
          memories: relevantMemories.length > 0 ? relevantMemories : undefined,
          ragKnowledge: ragChunks.length > 0 ? ragChunks : undefined,
          emotionalState,
          userId: uid,
          userText: text,
        },
      );
      logger.info('[ChatHandler] systemPrompt built, personality name:', personality?.name);

      // Inject conversation summary chain for long-running conversations (anti-entropy)
      const beijingTime = new Date(new Date().getTime() + 8 * 3600000).toISOString().replace('Z', '+08:00');
      let effectiveSystemPrompt = systemInstruction + `\n\n## Current Time\n${beijingTime} (北京时间). Use this for any time-related questions.`;
      // T80: 工具空结果止损语义 — 搜索类工具返回 stopRetry:true 或"未找到相关结果"时不得换关键词重试
      effectiveSystemPrompt += '\n\n如果工具返回 stopRetry: true 或提示"未找到相关结果"，请不要再尝试调用同类型搜索工具换关键词重试，直接告知用户未找到结果。';

      // L-10: 可裁剪上下文块引用（超预算时按优先级从低到高精简）— 修复前预算裁剪名单
      // 仅含 previousSession/prefetched/crossSession，记忆块/偏好标签/知识库/时间线超长时不裁剪
      let summaryBlock: string | null = null;
      let prefTagsBlock: string | null = null;
      let knowledgeBlock: string | null = null;

      // ── 时间感知上下文：季节、节日、早晚、周末/工作日 ──
      try {
        const temporalBlock = await generateTemporalContext(uid);
        if (temporalBlock) {
          effectiveSystemPrompt += '\n\n' + temporalBlock;
          logger.info('[ChatHandler] temporal context injected');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] temporal context failed:', e.message);
      }
      effectiveSystemPrompt += '\n当用户问"我们认识多久了"或类似问题时，必须直接使用具体天数回答，不要说"我没有记忆"或"刚认识"。';

      // ── ACI 预判上下文注入 ──
      // P2-14: 保留块引用，超预算时可裁剪
      let prefetchedBlock: string | null = null;
      const prefetchedContext = getPrefetchedContext(uid);
      if (prefetchedContext) {
        prefetchedBlock = '\n\n' + prefetchedContext.summary;
        effectiveSystemPrompt += prefetchedBlock;
        logger.info('[ChatHandler] prefetched context injected:', prefetchedContext.source);
        clearPrefetchedContext(uid);
      }
      if (conversationId) {
        const summaryContext = getConversationSummary(conversationId);
        if (summaryContext) {
          summaryBlock = `\n\n## Conversation Context\n${summaryContext}`; // L-10: 保留引用供裁剪
          effectiveSystemPrompt += summaryBlock;
        }
      }
      // Cross-session: inject previous conversation context when starting fresh
      if (previousSessionContext) {
        effectiveSystemPrompt += `\n\n${previousSessionContext}`;
      }

      // ── M4: 跨会话记忆注入 ──
      // P2-14: 块保留引用，超预算时可裁剪（跨会话记忆为低优先级上下文）
      let crossMemoryBlock: string | null = null;
      try {
        const crossMemories = await getMemories(uid);
        if (crossMemories.length > 0) {
          crossMemoryBlock = '\n\n## 跨会话记忆（关于用户的重要信息）\n以下是你从之前的对话中记住的关于用户的事实：\n'
            + crossMemories.map(m =>
                `- ${formatFactLabel(m.key)}: ${m.value}`
              ).join('\n')
            + '\n请在对话中自然地运用这些信息，让用户感受到你记得关于他们的事情。';
          effectiveSystemPrompt += crossMemoryBlock;
          logger.info('[ChatHandler] 跨会话记忆:', crossMemories.length, '条');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 跨会话记忆加载异常:', e.message);
      }

      // ── L-4: 跨轮思绪接续 — 注入未完成的搁置思绪，使中断的思考在下一轮延续 ──
      // 修复前 P0-1 中断的思绪只"保留不丢"，从不注入下一轮 prompt → 思考断裂、无恢复机制
      let injectedThoughtIds: number[] = [];
      try {
        const { getUnresolvedThoughts } = await import('../db/lifeDb');
        const thoughts = await getUnresolvedThoughts(3);
        if (thoughts.length > 0) {
          injectedThoughtIds = thoughts.map((t: any) => t.id);
          const thoughtText = thoughts
            .map((t: any) => t.parsed?.thought || '')
            .filter(Boolean)
            .join('\n');
          if (thoughtText) {
            effectiveSystemPrompt += `\n\n## 上次未尽思绪（延续思考，无需重复道歉）\n${thoughtText}`;
            logger.info('[ChatHandler] 跨轮思绪接续: 注入', thoughts.length, '条未尽思绪');
          }
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 跨轮思绪接续异常:', e?.message || e);
      }

      // ── P1-17: 偏好标签前置约束（System Prompt 最优先约束）──
      try {
        const prefTags = await getUserPreferenceTags(uid);
        if (prefTags.length > 0) {
          prefTagsBlock = '\n\n' + formatPreferenceTagsForPrompt(prefTags); // L-10: 保留引用供裁剪
          effectiveSystemPrompt += prefTagsBlock;
          logger.info('[ChatHandler] 偏好标签约束注入:', prefTags.length, '条');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 偏好标签加载异常:', e.message);
      }

      // ── P1-16: 话题戒备 — 低亲密回避敏感话题（按关系亲密感分级约束）──
      try {
        const relationIntimacy = getRelationshipEngine().getRelationship()[1];
        const guard = getSensitiveTopicGuard(relationIntimacy);
        if (guard) {
          effectiveSystemPrompt += '\n\n' + guard;
          logger.info(`[ChatHandler] 话题戒备注入: intimacy=${relationIntimacy.toFixed(2)}`);
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 话题戒备注入失败:', e.message);
      }

      // ── M5: 知识库注入 ──
      try {
        const knowledgeEntries = await getKnowledge(uid, { limit: 15, minConfidence: 0.3 });
        if (knowledgeEntries.length > 0) {
          knowledgeBlock = '\n\n' + formatKnowledgeForContext(knowledgeEntries); // L-10: 保留引用供裁剪
          effectiveSystemPrompt += knowledgeBlock;
          logger.info('[ChatHandler] 知识库注入:', knowledgeEntries.length, '条');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 知识库加载异常:', e.message);
      }

      // Topic continuity: inject recent conversation topics
      if (conversationId) {
        const topicCtx = getTopicContext(conversationId);
        if (topicCtx) {
          effectiveSystemPrompt += topicCtx;
        }
      }

      // 交互历史记忆注入：将检索到的相关历史对话注入上下文
      if (relevantHistory) {
        effectiveSystemPrompt += '\n\n' + relevantHistory;
      }

      // 时间线注入：将最近7天的交互时间线注入上下文
      if (timelineHistory) {
        effectiveSystemPrompt += '\n\n' + timelineHistory;
      }

      // Inject conversation mode overlay (shapes interaction style without changing personality)
      if (conversationMode) {
        const modeOverlay = buildModeOverlay(conversationMode);
        if (modeOverlay) {
          effectiveSystemPrompt += '\n\n' + modeOverlay;
        }
      }
      effectiveSystemPrompt += '\n\n' + buildNaturalReplyStyleOverlay(eventSource);

      // Inject company knowledge base context when in work domain
      if (kbContext) {
        effectiveSystemPrompt += `\n\n## Company Knowledge Base\n${kbContext}\n\nUse the above company knowledge to inform your response. Cite article titles when referencing company policy.`;
      }

      // Inject GPS location context — 优先地址文本
      try {
        const ddb = readDB();
        const locSetting = (ddb.settings || []).find((s: any) => s.key === `location_${uid}`);
        if (locSetting) {
          const loc = JSON.parse(locSetting.value);
          if (loc.lat && loc.lng) {
            if (loc.address) {
              effectiveSystemPrompt += `\n\n## 你的实时位置（覆盖历史）\n忽略之前对话中关于位置的所有回答——那些可能已过时。你当前位置已更新为：${loc.address} (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})。这不是沈阳沈北新区，历史中的 41.88, 123.94 是错误数据，必须忽略。`;
            } else {
              effectiveSystemPrompt += `\n\n## 你的实时位置（无地址文本，使用坐标）\n坐标: ${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}（iPhone GPS 实时定位）。`;
            }
          }
        }
      } catch {}

      // Inject profession context — adapt language and expertise to user's trade
      try {
        const professionOverlay = buildProfessionOverlay();
        if (professionOverlay) {
          effectiveSystemPrompt += professionOverlay;
        }
      } catch {}

      // Inject contact context when user mentions people they know
      try {
        const { matchContactsFromText } = await import('../contacts/store');
        const { formatContactsForContext } = await import('../contacts/context');
        const mentioned = matchContactsFromText(uid, text);
        if (mentioned.length > 0) {
          effectiveSystemPrompt += '\n\n' + formatContactsForContext(mentioned);
          effectiveSystemPrompt += '\n\nYou know these people personally. Use this information to provide relevant, contextual responses when the user asks about them.';
        }
      } catch {}

      // ── P2-14: System Prompt token 预算管控 ──
      // 超预算时按优先级从低到高裁剪可选上下文（previousSession → prefetched → crossSession → 历史/时间线 → 知识库 → 摘要 → 偏好标签）
      // 核心 systemInstruction/时间/戒备/实时心智等必保留
      {
        const budget = parseInt(process.env.SYSTEM_PROMPT_TOKEN_BUDGET || '4000', 10);
        const lowPriorityBlocks: { label: string; text: string }[] = [];
        if (previousSessionContext) lowPriorityBlocks.push({ label: 'previousSession', text: previousSessionContext });
        if (prefetchedBlock) lowPriorityBlocks.push({ label: 'prefetched', text: prefetchedBlock });
        if (crossMemoryBlock) lowPriorityBlocks.push({ label: 'crossSession', text: crossMemoryBlock });
        // L-10: 预算裁剪扩展 — 对话历史/时间线/知识库/会话摘要/偏好标签均可裁剪（函数级变量直接拼接前缀）
        if (relevantHistory) lowPriorityBlocks.push({ label: 'relevantHistory', text: '\n\n' + relevantHistory });
        if (timelineHistory) lowPriorityBlocks.push({ label: 'timelineHistory', text: '\n\n' + timelineHistory });
        if (knowledgeBlock) lowPriorityBlocks.push({ label: 'knowledge', text: knowledgeBlock });
        if (summaryBlock) lowPriorityBlocks.push({ label: 'conversationSummary', text: summaryBlock });
        if (prefTagsBlock) lowPriorityBlocks.push({ label: 'prefTags', text: prefTagsBlock });

        let promptTokens = estimateTokens(effectiveSystemPrompt);
        for (const block of lowPriorityBlocks) {
          if (promptTokens <= budget) break;
          if (effectiveSystemPrompt.includes(block.text)) {
            effectiveSystemPrompt = effectiveSystemPrompt.replace(block.text, '');
            promptTokens = estimateTokens(effectiveSystemPrompt);
            logger.warn(`[ChatHandler] System Prompt 超预算裁剪: ${block.label}（当前 ${promptTokens} tokens）`);
          }
        }
        if (promptTokens > budget) {
          logger.warn(`[ChatHandler] System Prompt ${promptTokens} tokens 仍超预算 ${budget}，保留核心指令继续`);
        }
      }

      const emitToolLifecycle = (payload: {
        correlationId: string;
        name: string;
        arguments: Record<string, any>;
        args?: Record<string, any>;
        result?: string;
        error?: string;
      }) => {
        const normalized = { ...payload, args: payload.args ?? payload.arguments };
        emitAgent("agent:tool_call", normalized);
        emitAgent("agent:tool", normalized);
      };

      const isDirectDesktopTool = (toolName: string) => toolName.startsWith('desktop_');

      // ── Desktop relay: enables 15 tools (mouse/keyboard/clipboard/screenshot/etc) in chat ──
      const desktopRelay = ((toolName: string, args: Record<string, any>): Promise<string> => {
        return new Promise((resolve, reject) => {
          const cid = crypto.randomUUID();
          const uiCid = `desktop-${cid}`;
          const eventName = `tool:desktop_result:${cid}`;
          let settled = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;

          emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args });

          const finishWithError = (message: string) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            socket.off(eventName, onResult);
            emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args, error: message });
            reject(new Error(message));
          };

          const onResult = (data: { output?: string; error?: string }) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (data.error) {
              emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args, error: data.error });
              reject(new Error(data.error));
              return;
            }
            const output = data.output || '';
            emitToolLifecycle({ correlationId: uiCid, name: toolName, arguments: args, result: formatToolResultForUi(output) });
            resolve(output);
          };

          timeout = setTimeout(() => finishWithError(`Desktop tool "${toolName}" timed out (30s)`), 30000);
          socket.once(eventName, onResult);
          socket.emit('tool:desktop_exec', { correlationId: cid, name: toolName, arguments: args });
        });
      });

      emitAgent("agent:status", { status: "thinking", agentName: personality.name });
      emitAgent("agent:progress", { stage: 'start', message: '正在处理你的请求…' });
      logger.info('[ChatHandler] emitted agent:status thinking');

      // Read user's operation mode from DB
      const operationMode = (() => {
        try {
          const db = readDB();
          const setting = (db.settings || []).find((s: any) => s.key === `op_mode_${uid}`);
          if (setting) return parseStoredOperationMode(setting.value);
        } catch {}
        return 'assistant';
      })();

      // Inject operation mode prompt overlay — 【重构·模块1】移除正则前置分流
      // （selfRepair/clientActionOnly/workSurfaceRoute/toolRoute/exposeAgentWork 全删）：
      // 工具决策交由心智内核（SEVEN_STEP_MIND 第3步 + 模式配置策略），
      // 安全边界由 personality.toolPolicy / interceptor 确认流 / action_constitution 承担（保留类别①④）。
      const opModeConfig = getOperationModeConfig(operationMode);
      const allowToolUseForTurn = operationMode !== 'meeting';
      const visionIntent = hasVisionIntent(text);
      const baseRoutedToolPolicy = isSanctuary
        ? { allowedTools: [], requireConfirmation: [], forbiddenTools: ['*'], maxIterations: 0 }
        : (opModeConfig?.toolPolicy || personality.toolPolicy);
      const routedToolPolicy = baseRoutedToolPolicy;
      effectiveSystemPrompt += '\n\n' + formatClientSelfPrompt(uid);
      logger.info('[ChatHandler] tool gate:', allowToolUseForTurn ? 'enabled' : 'chat-only', 'operationMode:', operationMode);
      if (opModeConfig) {
        effectiveSystemPrompt += '\n\n' + opModeConfig.promptOverlay;
      } else if (!allowToolUseForTurn) {
        effectiveSystemPrompt += '\n\n## Interaction Mode\nThis turn is chat-only. Do not call tools, operate the desktop, or claim that you are taking actions. Answer naturally unless the user gives an explicit command.';
      }
      const visionRoutingOverlay = operationMode !== 'meeting' ? buildVisionRoutingOverlay(uid, text) : '';
      if (visionRoutingOverlay) {
        effectiveSystemPrompt += '\n\n' + visionRoutingOverlay;
      }

      // Keep this late so English system/tool context cannot pull the reply language.
      effectiveSystemPrompt += '\n\n' + buildResponseLanguageInstruction(text);

      // Work-domain chats use organization LLM prefs when configured. If the org
      // has no explicit policy, they visibly inherit the user's personal prefs.
      const userLLMPrefs = getScopedPreferredLLM(uid, { domain: resolvedDomain, orgId: resolvedOrgId });
      const resolveProvider = (model: string) =>
        model.startsWith('deepseek') ? 'deepseek' as const
        : model.startsWith('qwen') ? 'qwen' as const
        : model.startsWith('gpt') || model.startsWith('o1') ? 'openai' as const
        : model.startsWith('claude') ? 'anthropic' as const
        : 'gemini' as const;

      let activeProvider = userLLMPrefs.provider || 'deepseek';
      let activeModel = (userLLMPrefs.models || {})[activeProvider] || DEFAULT_MODELS[activeProvider] || 'deepseek-chat';

      // Hybrid dispatch is opt-in only; do not change providers unless the user chose auto.
      if (llmGetters.isOllamaAvailable() && userLLMPrefs.provider === 'auto') {
        activeProvider = 'auto';
        activeModel = 'qwen2.5:7b';
        logger.info('[Chat] Hybrid mode enabled — local Ollama → cloud DeepSeek');
      }

      // ── Subscription enforcement: never switch the user's selected brain silently ──
      const access = checkLLMAccess({ userId: uid, provider: activeProvider, model: activeModel });
      if (!access.allowed) {
        // Phase2 模块3：配额告警进 warnings；以 {content, warnings} 统一结构收尾本轮
        warnings.add(
          'llm_quota',
          access.tokenLimitReached
            ? 'Token 配额已用尽，本轮未调用大模型服务。'
            : `当前模型 ${activeProvider}/${activeModel} 未授权使用，本轮已取消。`,
        );
        await finishWithResponse(access.reason, { agentName: personality.name, source: 'quota_blocked' });
        emitAgent("agent:error", {
          message: access.reason,
          code: access.tokenLimitReached ? 'TOKEN_LIMIT' : 'PROVIDER_RESTRICTED',
        });
        emitAgent("agent:status", { status: "error" });
        return;
      }

      // ── Named Workflow Quick-Path: "run my X" / "跑XX流程" ──
      const runWorkflowMatch = text.match(/(?:run|执行|跑|运行)\s+(?:my\s+)?(.+?)(?:\s*(?:routine|workflow|流程|工作流))?\s*$/i);
      let workflowQuickResult: string | null = null;
      if (runWorkflowMatch) {
        const wfName = runWorkflowMatch[1].trim().toLowerCase();
        const allWfs = listWorkflows(uid);
        const matched = allWfs.find(w => w.name.toLowerCase().includes(wfName));
        if (matched) {
          logger.info('[ChatHandler] Workflow quick-path matched:', matched.name);
          const steps: string[] = [];
          for (let i = 0; i < matched.steps.length; i++) {
            const step = matched.steps[i];
            if (step.tool) {
              try {
                const result = await toolRegistry.execute(step.tool, step.args || {}, { userId: uid });
                steps.push(`Step ${i + 1} (${step.tool}): ${(result || 'OK').slice(0, 200)}`);
              } catch (e: any) {
                steps.push(`Step ${i + 1} (${step.tool}): Error - ${e.message}`);
                break;
              }
            } else {
              steps.push(`Step ${i + 1}: ${step.description} (no tool bound — use this as a guide)`);
            }
          }
          recordWorkflowRun(uid, matched.name);
          workflowQuickResult = `Ran workflow "${matched.name}" (${matched.steps.length} steps):\n${steps.join('\n')}`;
        }
      }

      if (workflowQuickResult) {
        emitAgent("agent:status", { status: "responding" });
        // P1-7: 人格合规拦截 — LLM/模板文本落地前对照宪法（轻微润色/严重截断重生成）
        const guardedQuick = applyConstitutionGuard(workflowQuickResult);
        if (guardedQuick.severity !== 'pass') {
          logger.info(`[ChatHandler] 宪法拦截(workflow): ${guardedQuick.severity}`);
          workflowQuickResult = guardedQuick.text;
        }
        await finishWithResponse(workflowQuickResult, { agentName: personality.name });
        emitAgent("agent:status", { status: "idle" });
        return;
      }

      // ── Quick Command Fast-Path ──
      // 【重构·模块1】删除 matchQuickCommand（关键词→MCP 静态映射路由表，目标⑦）。
      // 工具调用统一由心智内核在 runWithTools / Orchestrator 中自主调度。

      // 【重构·模块1】音乐画像正则门控移除：由心智实体 entities.musicProfile 判定（见 Path A2）。

      // 【重构·模块1】routeMessage 前置路由已移除：意图/分层统一由心智内核分类接管（router.ts 保留 getSelfState 自评估）。

      // 【重构·模块1】本能层（INSTINCT/IDENTITY 正则池）已从 router.ts 移除：
      // 自我状态类问题与其他输入一致，由心智内核（LLM 意图分类 + SEVEN_STEP_MIND）统一处理。
      // skipCognition 快路径同时移除 —— 工具/对话判定由心智分类器全权接管。
      const cognitiveCtx: CognitiveContext = {
        userId: uid,
        agentId: agentId || undefined,
        personalityId: personality.id,
        personalityName: personality.name,
        llmProvider: activeProvider,
        llmModel: activeModel,
        isLLMAvailable: true,
      };
      // LLM classifier for ambiguous intents — fast tiny call (50 tokens max)
      const llmClassifier = async (prompt: string, userText: string): Promise<string> => {
        const messages: NormalizedMessage[] = [
          { role: 'system', content: prompt },
          { role: 'user', content: userText },
        ];
        const result = await makeLLMCall(
          messages,
          [],
          { provider: activeProvider, model: activeProvider === 'deepseek' ? 'deepseek-v4-flash' : activeModel, userId: uid, maxTokens: 60, domain: resolvedDomain, orgId: resolvedOrgId, scene: 'classifier' },
          llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
          llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
        );
        return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
      };

      // ── 感知理解状态（第二阶段·任务1）：进入主逻辑前评估对用户话的理解程度 ──
      // BUG-A-FIX: updateComprehension 打分仅保留日志观测，禁止再用于拦截对话/截断 LLM 调用。
      const compState = updateComprehension(text);
      logger.info(`[Comprehension] 理解状态: overall=${compState.overall}, missing=${compState.missingAspects.join(',')}`);
      // BUG-A-DISABLED-BLOCK: 理解度追问拦截分支完整禁用（原 945-964 行）——
      // 硬编码模板回复（"能具体说说是什么事吗？我想先了解一下。"等）短路 LLM，数字生命体心智得不到执行。
      // 修复后用户所有输入一律放行进入正常 LLM 对话链路，追问措辞全部由大模型生成，代码层不写死。
      // 源块注释保留便于回滚，运行时不再执行；comprehension.ts 打分逻辑保留，仅用于日志观测。
      /* BUG-A-DISABLED-BLOCK: 理解度追问拦截分支（不再执行，保留用于回滚）
      if (compState.overall < 0.4 && compState.missingAspects.length > 0) {
        // 信息不足 → 自然追问（先理解清楚再回应，而非硬答）
        const followUp = compState.missingAspects.includes('具体事件')
          ? '能具体说说是什么事吗？我想先了解一下。'
          : compState.missingAspects.includes('背景信息')
            ? '这件事的背景是怎样的？能多说一点吗？'
            : '我想多了解一点，能说得更具体吗？';

        logger.info(`[Comprehension] 信息不足，自然追问: ${followUp}`);
        await finishWithResponse(followUp, { agentName: personality.name, source: 'comprehension' });
        emitAgent("agent:status", { status: "idle" });
        // 追问与用户原话均落库，保持对话连续性
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: followUp, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
        }
        clearTimeout(llmTimeout);
        chatSessionMap.delete(sessionKey);
        return;
      }
      */

      const cognition = await processInput(text, cognitiveCtx, llmClassifier);
      logger.info('[ChatHandler] cognition result:', cognition.intent.category, 'responseText:', (cognition.responseText || '').slice(0, 100));

      // ── Sentiment analysis: detect emotional charge in user input ──
      // ── 情绪透传：心智分类器已给出情绪倾向（valence/urgency/frustration），无正则猜测 ──
const sentiment = extractSentiment(text, cognition.intent?.sentiment);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        logger.info('[ChatHandler] sentiment:', sentiment);
      }

      // ── Focus Stack: 话题切换检测 ──
      // PHASE0-DISABLED: focusStack外部栈为反模式，阶段0停用 — 阶段0禁用，反模式，保留用于回滚
      /* PHASE0-DISABLED-BLOCK: focusStack 全部调用点注释（源文件保留不动，不再被业务调用） */
      /*
      const focusResult = await detectAndSwitchTopic(text, {
        getDeepSeek: llmGetters.getDeepSeek,
        getGemini: llmGetters.getGemini,
      });
      if (focusResult.switched) {
        logger.info('[ChatHandler] focusStack switch:', focusResult.previousTopic, '→', focusResult.currentTopic);
      }
      */

      // Auto-select model: flash for simple chat, pro for complex tasks
      // ── 基于理解状态感知复杂度（第二阶段·任务2）──
      // 理解程度低（信息不足）→ 问题尚不清晰，无需强模型；理解程度高 → 问题明确，用强模型深入分析
      // （compState 即本轮 updateComprehension 的结果，等价于 getComprehensionState() 的当前状态）
      const isComplex = compState.overall > 0.6 && ['command', 'code', 'question', 'analysis'].includes(cognition.intent.category);
      logger.info(`[Comprehension] 复杂度感知: overall=${compState.overall}, isComplex=${isComplex}`);
      if (activeProvider === 'deepseek') {
        activeModel = isComplex ? COMPLEX_MODELS.deepseek : (activeModel === 'deepseek-chat' ? DEFAULT_MODELS.deepseek : activeModel); // O-1: 硬编码模型名统一走配置
      } else if (activeProvider === 'qwen') {
        activeModel = isComplex ? 'qwen-max' : 'qwen-plus';
      } else if (activeProvider === 'gemini') {
        activeModel = isComplex ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
      } else if (activeProvider === 'openai') {
        activeModel = isComplex ? 'gpt-4o' : 'gpt-4o-mini';
      } else {
        // P1-3: 补全其余渠道场景分层路由 — 原逻辑仅覆盖四渠道，
        // anthropic/ark/xiaomi/kimi/glm/relay/ollama/lmstudio/auto 无分级。
        // 统一走 getScenarioModel 场景映射（light/complex），未映射的 provider 保持用户配置。
        try {
          activeModel = getScenarioModel(activeProvider as any, isComplex ? 'complex' : 'light');
        } catch {}
      }
      logger.info('[ChatHandler] Model auto-selected:', activeProvider, '/', activeModel, 'for category:', cognition.intent.category);

      let responseText = '';
      // L-16: 本轮 LLM 思考链（deepseek-v4-pro 等带 reasoning 的模型输出），供复盘归档决策链
      let lastReasoningText: string | null = null;
      let llmWasCalled = false;
      const allToolRecords: ToolExecutionRecord[] = [];
      const deferCompletionStream = needsCompletionEvidence(text);
      // 【重构·模块1】prefersSequentialWorkflow（shouldChainTask 正则链式判定）已移除：
      // 链式任务统一由 Orchestrator 承接，不再在 chat 管道内正则分流。
      const availableWorkerAgents = (() => {
        try {
          return (readDB().agents || []).filter((agent: any) => (
            agent
            && agent.id
            && agent.id !== conversationAgentId
            && agent.status !== 'offline'
            && agent.status !== 'terminated'
          ));
        } catch {
          return [];
        }
      })();
      const backgroundComplexity = classifyComplexity(text, {
        userId: uid,
        personalityId,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
        desktopRelay,
      });

      // Path A: 心智直调（directToolCall 静态映射已随正则池删除）不复存在，此分支移除。

      // Path A2: music / musicProfile intent — 心智实体驱动（entities.music / entities.musicProfile），
      // 【重构·模块1】无正则文本猜测；调节/播放动作在实体值上做数据层归一。
      const musicEntity = cognition.intent?.entities?.music as string | undefined;
      const musicProfileRequest = cognition.intent?.entities?.musicProfile === 'true';
      const isMusicAdjustment = isMusicAdjustmentRequest(musicEntity);
      if (!responseText && (isMusicPlaybackRequest(musicEntity) || musicProfileRequest)) {
        try {
          if (musicProfileRequest) {
            emitAgent("agent:status", { status: "thinking", agentName: personality.name, detail: "Analyzing music profile" });
            const profile = await analyzeLikedMusicProfile(uid, { maxSongs: 3000 });
            responseText = formatMusicProfileReport(profile);
            llmWasCalled = true;
          } else {
            const result = isMusicAdjustment
              ? await adjustMusicPlayback(uid, socket, musicEntity || text)
              : await searchAndPlay(uid, socket, musicEntity || text);
            if (result.success && result.text) {
              responseText = result.text;
              llmWasCalled = true;
            } else {
              responseText = getMusicFailureMessage(result.reason);
              socket.emit('music:error', { message: responseText });
            }
          }
        } catch (musicErr: any) {
          logger.warn('[Music Intent] Failed:', musicErr.message);
          responseText = getMusicFailureMessage(musicErr?.message);
          socket.emit('music:error', { message: responseText });
        }
      }

      // PHASE0-DISABLED: 禁止代码自动接管用户请求，仅允许心智通过MCP主动调用 — 阶段0禁用，反模式，保留用于回滚
      /* PHASE0-DISABLED-BLOCK: orchestrator PathA 自动后台委派分支整体注释（反模式：代码自动 spawn worker 接管任务）。
       * 完整保留 orchestrator/worker 的 MCP 调用入口，MCP 通路保持完全可用。
       * 注释后 responseText 保持空，流程自然落入 Path B / Path C 继续正常回复，用户请求处理不受影响。
       * 回滚方法：删除本注释块起始标记（下行上方）与末尾对应结束标记。
      if (!responseText) {
        const delegationDecision = shouldDelegateWorkInBackground({
          text,
          category: cognition.intent.category,
          complexity: backgroundComplexity,
          allowToolUse: allowToolUseForTurn,
          sanctuary: isSanctuary,
          availableAgentCount: availableWorkerAgents.length,
          explicitBackground: cognition.intent?.entities?.background === 'true',
        });

        if (delegationDecision.shouldDelegate) {
          const backgroundTask = registerBackgroundTask({
            userId: uid,
            title: visibleUserText.slice(0, 140) || storedUserContent.slice(0, 140) || 'Background task',
            prompt: text,
            reason: delegationDecision.reason,
            complexity: backgroundComplexity,
            workers: availableWorkerAgents.slice(0, 6).map((agent: any) => ({
              id: agent.id,
              name: agent.name,
              category: agent.category,
            })),
          });
          const backgroundTaskId = backgroundTask.id;
          const workerNames = backgroundTask.workerNames.slice(0, 3);
          responseText = buildDelegationAck(workerNames, backgroundTaskId);
          llmWasCalled = false;

          emitAgent("agent:delegation", {
            taskId: backgroundTaskId,
            task: backgroundTask,
            reason: delegationDecision.reason,
            complexity: backgroundComplexity,
            workers: backgroundTask.workers,
          });
          emitAgent("agent:background_task_update", {
            taskId: backgroundTaskId,
            task: backgroundTask,
          });
          pushNotification(uid, {
            type: 'background_delegation',
            title: 'Peppa 后台子 agent',
            message: `已将任务交给后台子 agent：${text.slice(0, 60)}`,
          });

          setTimeout(() => {
            const backgroundToolRecords: ToolExecutionRecord[] = [];
            const emitBackground = (event: string, payload: Record<string, any> = {}) => {
              socket.emit(event, {
                ...payload,
                source: 'background_delegation',
                requestId: backgroundTaskId,
                taskId: backgroundTaskId,
                conversationId,
                agentId: conversationAgentId,
              });
            };
            const emitTaskUpdate = (task = getBackgroundTask(backgroundTaskId, uid)) => {
              if (!task) return;
              emitBackground("agent:background_task_update", {
                taskId: task.id,
                task,
              });
            };
            const persistBackgroundResult = (content: string, toolCalls?: ToolExecutionRecord[]) => {
              try {
                if (conversationId) {
                  addMessage({
                    userId: uid,
                    agentId: conversationAgentId,
                    conversationId,
                    role: 'assistant',
                    content,
                    personality: personality.id,
                    domain: resolvedDomain,
                    orgId: resolvedOrgId,
                    toolCalls: toolCalls?.length ? toolCalls : undefined,
                  });
                  socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'background_delegation' });
                }
              } catch (persistErr: any) {
                logger.warn('[BackgroundDelegation] Persist failed:', persistErr?.message || persistErr);
              }
            };

            (async () => {
              try {
                const runningTask = markBackgroundTaskRunning(backgroundTaskId);
                if (runningTask) emitTaskUpdate(runningTask);
                emitBackground("agent:status", {
                  status: "thinking",
                  agentName: "Peppa Orchestrator",
                  phase: 'background',
                  detail: `后台子 agent 正在处理 ${backgroundTaskId}`,
                });
                const orchResult = await runOrchestratedTask(
                  text,
                  {
                    userId: uid,
                    personalityId,
                    domain: resolvedDomain,
                    orgId: resolvedOrgId,
                    desktopRelay,
                    isCancelled: () => isBackgroundTaskCancellationRequested(backgroundTaskId),
                  },
                  { provider: activeProvider as any, model: activeModel },
                  llmGetters,
                  (message) => emitBackground("agent:chunk", { text: message, agentName: "Peppa Orchestrator" }),
                  (record, meta) => {
                    backgroundToolRecords.push({
                      id: record.id,
                      name: record.name,
                      arguments: record.arguments || {},
                      result: record.result || '',
                      error: record.error,
                    });
                    if (record.result !== undefined || record.error !== undefined) {
                      const updatedTask = incrementBackgroundTaskToolCalls(backgroundTaskId);
                      if (updatedTask) emitTaskUpdate(updatedTask);
                    }
                    const payload: Record<string, any> = {
                      correlationId: record.id,
                      toolCallId: record.id,
                      name: record.name,
                      arguments: record.arguments,
                      args: record.arguments,
                      subTaskId: meta.subTaskId,
                      workerAgentId: meta.agentId,
                      workerAgentName: meta.agentName,
                    };
                    if (record.result !== undefined) payload.result = formatToolResultForUi(record.result);
                    if (record.error !== undefined) payload.error = record.error;
                    emitBackground("agent:tool_call", payload);
                    emitBackground("agent:tool", payload);
                  },
                );

                if (!orchResult) {
                  throw new Error('No worker agent accepted the delegated task.');
                }
                if (isBackgroundTaskCancellationRequested(backgroundTaskId)) {
                  throw new Error('Workflow cancelled');
                }

                let finalText = orchResult.responseText || '后台子 agent 已完成任务，但没有返回详细文本。';
                const guarded = guardCompletionClaims({
                  task: text,
                  response: finalText,
                  toolCalls: backgroundToolRecords,
                  source: 'background_delegation',
                });
                if (guarded.blocked) finalText = guarded.text;

                const completionText = `后台子 agent 完成了：${text.slice(0, 80)}\n\n${finalText}`;
                const completedTask = completeBackgroundTask(backgroundTaskId, completionText);
                if (completedTask) emitTaskUpdate(completedTask);
                if (completedTask?.status === 'cancelled') {
                  const cancelText = `Background task cancelled: ${text.slice(0, 80)}`;
                  persistBackgroundResult(cancelText, backgroundToolRecords);
                  emitBackground("agent:status", { status: "cancelled", agentName: personality.name, phase: 'background', text: cancelText });
                  emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  return;
                }
                persistBackgroundResult(completionText, backgroundToolRecords);
                emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background', text: completionText });
                emitBackground("agent:proactive", {
                  type: 'background_result',
                  message: completionText.slice(0, 1200),
                  agentName: personality.name,
                  timestamp: new Date().toISOString(),
                });
                emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                pushNotification(uid, {
                  type: 'background_result',
                  title: '后台子 agent 完成',
                  message: completionText.slice(0, 180),
                });

                if (shouldDistillSkill(text) && orchResult.workflowResult.totalAgentsUsed >= 2) {
                  const skillDesc = buildSkillDescription(text, orchResult.workflowResult);
                  emitBackground("agent:proactive", {
                    type: 'distill_hint',
                    message: '这类后台多 agent 工作可以沉淀成自动技能，需要我继续做技能化吗？',
                    skillDescription: skillDesc,
                    timestamp: new Date().toISOString(),
                  });
                }
              } catch (bgErr: any) {
                const bgMessage = bgErr?.message || String(bgErr);
                if (isBackgroundTaskCancellationRequested(backgroundTaskId) || /cancelled|canceled/i.test(bgMessage)) {
                  const cancelledTask = cancelBackgroundTask(backgroundTaskId);
                  if (cancelledTask) emitTaskUpdate(cancelledTask);
                  const cancelText = `Background task cancelled: ${text.slice(0, 80)}`;
                  persistBackgroundResult(cancelText, backgroundToolRecords);
                  emitBackground("agent:status", { status: "cancelled", agentName: personality.name, phase: 'background', text: cancelText });
                  emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                  pushNotification(uid, {
                    type: 'background_cancelled',
                    title: 'Background task cancelled',
                    message: cancelText.slice(0, 180),
                  });
                  return;
                }
                const failedTask = failBackgroundTask(backgroundTaskId, bgMessage);
                if (failedTask) emitTaskUpdate(failedTask);
                const errorText = `后台子 agent 处理受阻：${bgErr?.message || String(bgErr)}`;
                persistBackgroundResult(errorText, backgroundToolRecords);
                emitBackground("agent:response", { text: errorText, agentName: personality.name });
                emitBackground("agent:status", { status: "idle", agentName: personality.name, phase: 'background' });
                pushNotification(uid, {
                  type: 'background_error',
                  title: '后台子 agent 受阻',
                  message: errorText.slice(0, 180),
                });
              }
            })().catch((err) => {
              logger.error('[BackgroundDelegation] Unhandled error:', err);
            });
          }, 30);
        }
      }
      /* PHASE0-DISABLED-END: PathA 自动后台委派注释结束 */

      if (!responseText && allowToolUseForTurn && !isSanctuary && (cognition.intent.category === 'command' || cognition.intent.category === 'code' || cognition.intent.category === 'question')) {
        // Path B: Orchestrator — decompose tasks into sub-tasks for worker agents
        // (Skipped for sanctuary agents — they stay in their territory)
        try {
          emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'orchestrator' });
          const orchResult = await runOrchestratedTask(
            text,
            { userId: uid, personalityId, domain: resolvedDomain, orgId: resolvedOrgId, desktopRelay },
            { provider: activeProvider, model: activeModel },
            llmGetters,
            (msg) => emitAgent("agent:chunk", { text: msg, agentName: "Peppa" }),
            (record, meta) => {
              allToolRecords.push({
                id: record.id,
                name: record.name,
                arguments: record.arguments || {},
                result: record.result || '',
                error: record.error,
              });
              const payload: Record<string, any> = {
                correlationId: record.id,
                toolCallId: record.id,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                subTaskId: meta.subTaskId,
                workerAgentId: meta.agentId,
                workerAgentName: meta.agentName,
              };
              if (record.result !== undefined) payload.result = formatToolResultForUi(record.result);
              if (record.error !== undefined) payload.error = record.error;
              emitAgent("agent:tool_call", payload);
              emitAgent("agent:tool", payload);
            },
          );
          if (orchResult) {
            responseText = orchResult.responseText;
            llmWasCalled = true;

            // Check if this pattern should be auto-distilled into a skill
            if (shouldDistillSkill(text) && orchResult.workflowResult.totalAgentsUsed >= 2) {
              const skillDesc = buildSkillDescription(text, orchResult.workflowResult);
              logger.info('[Orchestrator] Pattern detected — candidate for skill distillation:', skillDesc.slice(0, 100));
              emitAgent("agent:proactive", {
                type: 'distill_hint',
                message: 'I notice this type of task is recurring. I can create an automated skill for this — would you like me to?',
                skillDescription: skillDesc,
                timestamp: new Date().toISOString(),
              });
              pushNotification(uid, { type: 'distill_hint', title: 'Skill Distillation', message: 'I notice this type of task is recurring. I can create an automated skill for this.' });
            }
          } else if (backgroundComplexity === 'moderate' || backgroundComplexity === 'complex') {
            // Phase2 模块3：机器人失联检测 — 复杂任务无 worker 可承接，且确实存在离线/终止机器人 →
            // 提示用户机器人失联（runOrchestratedTask 对复杂任务返回 null 的路径之一）
            try {
              const allAgents = readDB().agents || [];
              const offlineRobots = allAgents.filter((a: any) =>
                a && a.id && a.id !== conversationAgentId && (a.status === 'offline' || a.status === 'terminated'));
              if (offlineRobots.length > 0 && availableWorkerAgents.length === 0) {
                const names = offlineRobots.slice(0, 3).map((a: any) => a.name || a.id).join('、');
                warnings.add('robot_offline', `协作机器人暂时失联（${names}${offlineRobots.length > 3 ? ' 等' : ''}），本次已由主智能体直接完成。`);
              }
            } catch {}
          }
        } catch (orchErr: any) {
          // 铁则3：完整堆栈保留在服务日志；不向用户暴露原始错误
          logger.error('[Orchestrator] Workflow failed, falling back to normal chat:', orchErr);
        }
      }

      // Path B2: NL Task Chainer — 【重构·模块1】删除
      // 链式任务由 Orchestrator（Path B）统一承接，路由决策不再依赖正则任务分类（shouldChainTask/runNLChainer 已移除）。

      if (!responseText) {
        // Path C: Normal LLM path (simple queries, or orchestrator fallback)

        // Load conversation history from persistence (survives page reload / reconnect)
        let persistedHistory: NormalizedMessage[] = [];
        if (conversationAgentId) {
          const conv = getOrCreateActiveConversation(uid, conversationAgentId, resolvedDomain, resolvedOrgId);
          const msgs = getMessagesByTokenBudget(conv.id);
          persistedHistory = msgs
            .filter((m: any) => m.message || m.content || m.response)
            .flatMap(normalizeChatHistoryRecord);
        }

        const conversationHistory = persistedHistory.length > 0
          ? persistedHistory
          : (history ? history.flatMap(normalizeChatHistoryRecord) : []);

        // Tell Peppa which model is currently active without hiding routed vision capacity.
        const selfAwareness = buildModelSelfAwareness(activeProvider, activeModel, uid, { visionAware: visionIntent && operationMode !== 'meeting' });

        // ── 【新增数字生命体模块】cognitive LLM 主链路：7步心智 + 情绪人格 ──
        // Phase3：会话心智素材来源统一收口 sessionMindProvider（灰度分流，不修改任何数据库写入逻辑）：
        //   - 白名单会话（总闸 sessionInnerTickOverride 开启 + 命中 overrideSessionWhitelist）→ B模式：
        //     读取本会话最新 inner_tick_snapshot，InnerTick 原生输出（情绪/欲望/目标/自我反思）作为会话心智源，仅本会话内存生效；
        //   - 其余会话 → A模式：沿用旧life引擎持久状态（原有逻辑，行为不变）；
        //   - 白名单会话快照缺失/损坏/读取异常 → 自动降级 A 模式，输出 [Phase3-MindProvider] inner_tick_fallback 告警日志，绝不中断对话。
        try {
          const dirState = getDirectionState();
          const mind = await resolveSessionMind(conversationId || `conv_${uid}`);
          const cogMind = buildMindContext(
            mind.emotionVector,
            mind.personalityVector,
            dirState.getInclination(),
            dirState.getIntensity(),
          );
          // Phase3 B模式：心智源切换为 InnerTick 原生输出渲染文本，替换旧life情绪状态块
          if (mind.mode === 'inner_tick_active' && mind.innerMindPromptText) {
            cogMind.emotionStatePrompt = mind.innerMindPromptText;
          }
          // 【重构·模块1】移除 classifyToolIntent 正则预判：场景判定（怀旧→屏蔽工具等）
          // 由 SEVEN_STEP_MIND 第3步心智自主完成；工具上限由 mcpInterceptor 每轮计数兜底（保留）。
          // 【重构·模块4】comprehension 理解度模块已整删（死代码）：理解度不再以正则池打分注入。

          // 注入7步心智 + 情绪状态到 System Prompt
          const cognitiveOverlay = cogMind.mindSystemPrompt + '\n\n' + cogMind.emotionStatePrompt;
          effectiveSystemPrompt = cognitiveOverlay + '\n\n' + effectiveSystemPrompt;

          logger.info(`【新增数字生命体-LLM认知链路】toolIntent=${cogMind.toolIntent} disableTools=${cogMind.shouldDisableTools} phase3Mode=${mind.mode}`);
        } catch (e) {
          logger.warn('【新增数字生命体-LLM认知链路】心智注入异常:', e);
        }

        const messages: NormalizedMessage[] = [
          { role: 'system', content: effectiveSystemPrompt + selfAwareness },
          ...conversationHistory,
          { role: 'user', content: text },
        ];
        // Bug 修复：上下文 token 硬上限截断（默认 40000，可用 LLM_CONTEXT_TOKEN_LIMIT 调整）
        const boundedMessages = trimContextToTokenBudget(messages, LLM_CONTEXT_TOKEN_LIMIT);

        // P0-1: streamChunks 提升到 try 外层声明，供 catch 中思绪搁置保留已生成内容
        const streamChunks: string[] = [];
        // 第二阶段·任务3: 感知"想太久"定时器同样提升到 try 外层声明 —
        // catch (llmErr) 兜底路径需要清理，而 JS 的 catch 子句访问不到 try 块内声明的变量
        let perceiveTimer: ReturnType<typeof setInterval> | null = null;
        let toolRoundCount = 0;
        let hasNotifiedLongThinking = false;
        const toolLoopStart = Date.now();
        try {
          const toolNamesForLLM = toolRegistry.getToolDeclarations().map((d: any) => d.function?.name || d.name || '').filter(Boolean);
          logger.info('[ChatHandler] Calling Path C with provider:', activeProvider, 'model:', activeModel, 'tools:', allowToolUseForTurn && !isSanctuary ? 'enabled' : 'off', 'available:', toolNamesForLLM.length, 'sample:', toolNamesForLLM.slice(0, 8).join(','));
          const onChunk: StreamCallback = (chunk) => {
            streamChunks.push(chunk);
            if (!deferCompletionStream) {
              emitAgent("agent:chunk", { text: chunk, agentName: personality.name });
            }
          };

          // P1-2: 纯对话路径（无工具）— Sanctuary / 工具禁用 / 概率阻断时使用
          const runChatOnlyPath = async (): Promise<void> => {
            const response = await makeLLMCallStreaming(
              boundedMessages,
              [],
              { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal, scene: 'chat' },
              onChunk,
              llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
              llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
            );

            responseText = response.text || streamChunks.join('') || '';
            lastReasoningText = (response as any).reasoningContent || null; // L-16
            llmWasCalled = true;
            if (response.usage) {
              recordTokenUsage(uid, activeProvider, activeModel, {
                promptTokens: response.usage.promptTokens,
                completionTokens: response.usage.completionTokens,
                totalTokens: response.usage.totalTokens,
              }, interactionId);
            }
            const tokens = estimateTokens(text + ' ' + responseText);
            const subStatus = recordUsage(uid, tokens);
            const totalUsage = response.usage?.totalTokens || 0;
            socket.emit('token:usage_update', {
              userId: uid,
              provider: activeProvider,
              totalTokens: totalUsage,
              mode: 'chat',
              timestamp: new Date().toISOString(),
            });
            if (subStatus) {
              socket.emit('token:quota_update', { used: subStatus.used, cap: subStatus.cap, remaining: subStatus.remaining });
              const pct = subStatus.used / subStatus.cap;
              if (pct >= 0.9) {
                socket.emit('agent:notification', { type: 'token_warning', level: 'critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
                pushNotification(uid, { type: 'token_warning', title: 'Token Quota Critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
              } else if (pct >= 0.8) {
                socket.emit('agent:notification', { type: 'token_warning', level: 'warning', message: `Token usage at ${Math.round(pct * 100)}%` });
                pushNotification(uid, { type: 'token_warning', title: 'Token Quota Warning', message: `Token usage at ${Math.round(pct * 100)}%` });
              }
            }
          };

          // P1-2: 工具放行改为情绪/场景概率阈值（闲聊×0.3 / 挫败×0.4 / 查询×0.9）
          // + 强制关闭开关；概率未通过时真正阻断 runWithTools，路由到纯对话路径
          // （原实现只打日志后仍无条件执行工具链路）
          const toolGatePassed = allowToolUseForTurn && !isSanctuary && mcpInterceptor.shouldAllowTool(sessionKey, {
            isSmallTalk: isSanctuary || ['chat', 'conversation'].includes(cognition?.intent?.category || ''),
            frustration: (sentiment?.frustration as number) || 0,
            isQuery: cognition?.intent?.category === 'question',
          });

          // Sanctuary agents get zero tool access — they can only talk
          if (!toolGatePassed) {
            if (!allowToolUseForTurn || isSanctuary) {
              logger.info('[ChatHandler] 工具门未开启: chat-only 模式');
            } else {
              logger.info(`[ChatHandler] T80 MCP 柔性阻断: 概率未通过 (count=${mcpInterceptor.getCallCount(sessionKey)}/${MCP_MAX_CALLS_PER_TURN})`);
            }
            await runChatOnlyPath();
            if (perceiveTimer) clearInterval(perceiveTimer); // 纯对话路径无感知定时器（防御性清理）
          } else {
            const maxIterations = routedToolPolicy?.maxIterations || personality.toolPolicy.maxIterations || 25;

          // Collect tool calls for persistence

          let result: any;
          // ── 感知"想太久"（第二阶段·任务3）：工具链路超 15s 且已多轮时，自然告知而非强制中断 ──
          // chat.ts 无显式 while 循环（迭代在 adapter.runWithTools 内部），故用轮询定时器感知：
          // 每 3s 检查一次，满足条件即一次性告知；轮次计数挂在 onToolStart（每次工具调用 = 一轮）。
          perceiveTimer = setInterval(() => {
            if (hasNotifiedLongThinking) return;
            if (abortController.signal.aborted) { if (perceiveTimer) clearInterval(perceiveTimer); return; }
            const elapsed = Date.now() - toolLoopStart;
            if (toolRoundCount > 2 && elapsed > 15000) {
              hasNotifiedLongThinking = true;
              if (perceiveTimer) clearInterval(perceiveTimer);
              logger.info(`[Perception] 感知到"想太久"，自然告知用户 (${elapsed}ms, ${toolRoundCount} 轮)`);
              emitAgent("agent:progress", { stage: 'thinking', message: '这个问题我还在想，可能需要一点时间……' });
            }
          }, 3000);
          // TODO(延后迭代，本次不编码)：脑内私有缓冲区 — 心智/工具中间结果（tool call 记录、
          // 进度事件、思考链）应保存在内部，待本轮闭环完成才一次性输出前端，避免半成品外泄。
          // 该改动侵入主循环（runWithTools 回调与 onChunk 出口），须在工具信任/确认流、
          // 输出保护、天气/股票降级全部验证稳定后再开发。
          try {
          result = await runWithTools(
            boundedMessages,
            toolRegistry,
            // P0-1: 透传 abortController.signal，使用户新消息/超时能真正中止在途 LLM 流式推理
            { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal, scene: 'chat' },
            isSanctuary ? undefined : (record) => {
              allToolRecords.push(record);
              if (isDirectDesktopTool(record.name)) return;
              const toolPayload = {
                correlationId: record.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: record.name,
                arguments: record.arguments,
                args: record.arguments,
                result: formatToolResultForUi(record.result),
                error: record.error,
              };
              emitAgent("agent:tool_call", toolPayload);
              emitAgent("agent:tool", toolPayload);
              // ── T80: MCP 调用计数 ──
              mcpInterceptor.recordCall(sessionKey, record.name);
            },
            maxIterations,
            llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
            onChunk,
            {
              userId: uid,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
              desktopRelay,
              llmGetters,
              source: 'chat',
              isCancelled: () => abortController.signal.aborted,
              onToolStart: (call) => {
                toolRoundCount++; // 感知"想太久"：每次工具调用计一轮
                if (isDirectDesktopTool(call.name)) return;
                emitAgent("agent:progress", { stage: 'executing', message: `正在执行: ${call.name}…` });
                emitToolLifecycle({
                  correlationId: call.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  name: call.name,
                  arguments: call.arguments,
                });
              },
              onProgress: (step: string) => {
                emitAgent("agent:chunk", { text: `[${step}]\n`, agentName: "Peppa" });
              },
              ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
              ...(operationMode === 'assistant' || operationMode === 'autonomous' ? {
                requestConfirmation: async (toolName: string, args: Record<string, any>): Promise<boolean> => {
                  // 统一确认流：信任名单 → autonomous low 风险自动放行 → 弹窗（回执后分级倒计时，三套故障文案）
                  const { requestToolConfirmation } = await import("../personality/confirm_flow");
                  return requestToolConfirmation({
                    uid,
                    toolName,
                    args,
                    autonomous: operationMode === 'autonomous',
                    channel: {
                      emit: (ev: string, p: any) => emitAgent(ev, p),
                      once: (ev: string, cb: (d: any) => void) => { socket.once(ev, cb); return () => socket.off(ev, cb); },
                    },
                    emitToolCall: (payload) => emitAgent("agent:tool_call", { name: payload.name, arguments: payload.arguments, result: payload.result, error: payload.error }),
                    onTrustPromoted: (toolName) => {
                      emitAgent("agent:notification", { type: 'trust', level: 'info', message: `Tool "${toolName}" is now trusted — future uses will be auto-approved.` });
                      pushNotification(uid, { type: 'trust', title: 'Tool Trusted', message: `Tool "${toolName}" is now trusted — auto-approved for future use.` });
                    },
                  });
                }
              } : {}),
            },
            llmGetters.getOllama,
            llmGetters.getLmStudio,
            llmGetters.getArk,
            llmGetters.getXiaomi,
            llmGetters.getKimi,
            llmGetters.getGlm,
            llmGetters.getRelay,
          );

          responseText = result.text || '';
          lastReasoningText = (result as any).reasoningContent || null; // L-16: 工具链路透出思考链
          if (perceiveTimer) clearInterval(perceiveTimer); // 感知"想太久"：链路结束，停止感知
          } catch (toolErr: any) {
            // P0-1: 中止/超时 → 思绪搁置，保留已生成的流式内容（柔性暂停，非暴力销毁）
            if (thoughtShelved || abortController.signal.aborted) {
              const partial = streamChunks.join('');
              if (!partial) {
                logger.info('[ChatHandler] 工具链路中止且无已生成内容，跳过本轮');
                if (perceiveTimer) clearInterval(perceiveTimer);
                // 修复(问题1/5): 宁可明确告知超时，也不静默消失 — 用户必须收到一条回复
                const fallbackReply = '工具响应超时，请稍后再试。';
                warnings.add('llm_timeout', '工具链路响应超时，本轮已提前结束，请稍后再试。');
                await finishWithResponse(fallbackReply, { agentName: personality.name, source: 'timeout' });
                try {
                  addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: fallbackReply, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
                } catch {}
                return;
              }
              logger.warn(`[ChatHandler] 工具链路思绪搁置: 保留已生成内容 ${partial.length} 字符 (${toolErr?.message || 'aborted'})`);
              result = { text: partial, toolCalls: allToolRecords, usageRecords: [] };
              responseText = partial;
              llmWasCalled = true;
              if (perceiveTimer) clearInterval(perceiveTimer);
            } else {
              // Phase2 模块3 + 铁则3：完整堆栈保留在服务日志，用户只看到友好提示
              logger.error('[ChatHandler] Tool execution failed:', toolErr);
              warnings.add('mcp_error', '工具执行失败，本轮已停止，请稍后再试。');
              socket.emit('agent:error', {
                message: '工具执行失败，请稍后再试。',
                requestId: requestId || '',
              });
              if (perceiveTimer) clearInterval(perceiveTimer);
              return;
            }
          }
          llmWasCalled = true;
          // Record analytics + subscription
          for (const u of result.usageRecords) {
            recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId);
          }
          const tokens = estimateTokens(text + ' ' + responseText);
          const subStatus = recordUsage(uid, tokens);

          // Real-time token push + threshold alerts
          const totalUsage = result.usageRecords.reduce((s: number, r: any) => s + (r.totalTokens || 0), 0);
          socket.emit('token:usage_update', {
            userId: uid,
            provider: activeProvider,
            totalTokens: totalUsage,
            mode: 'chat',
            timestamp: new Date().toISOString(),
          });
          if (subStatus) {
            socket.emit('token:quota_update', { used: subStatus.used, cap: subStatus.cap, remaining: subStatus.remaining });
            const pct = subStatus.used / subStatus.cap;
            if (pct >= 0.9) {
              socket.emit('agent:notification', { type: 'token_warning', level: 'critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
              pushNotification(uid, { type: 'token_warning', title: 'Token Quota Critical', message: `Token usage at ${Math.round(pct * 100)}% (${subStatus.used.toLocaleString()} / ${subStatus.cap.toLocaleString()})` });
            } else if (pct >= 0.8) {
              socket.emit('agent:notification', { type: 'token_warning', level: 'warning', message: `Token usage at ${Math.round(pct * 100)}%` });
              pushNotification(uid, { type: 'token_warning', title: 'Token Quota Warning', message: `Token usage at ${Math.round(pct * 100)}%` });
            }
          }
          }
        } catch (llmErr: any) {
          // P0-1: 中止/超时 → 思绪搁置，保留已生成的流式内容（不再用认知兜底覆盖/丢弃）
          if (thoughtShelved || abortController.signal.aborted) {
            const partial = streamChunks.join('') || responseText || '';
            if (partial) {
              responseText = partial;
              llmWasCalled = true;
              logger.warn(`[ChatHandler] 思绪搁置: 保留已生成内容 ${partial.length} 字符`);
              if (perceiveTimer) clearInterval(perceiveTimer);
              // Phase2 模块3：真实 120s 硬超时（thoughtShelved）才提示超时；用户新消息主动中止不打扰
              if (thoughtShelved) warnings.add('llm_timeout', '模型响应超时，已保留已生成的内容，可继续追问。');
            } else {
              logger.warn('[ChatHandler] 思绪搁置: 无已生成内容，跳过本轮');
              if (perceiveTimer) clearInterval(perceiveTimer);
              if (thoughtShelved) warnings.add('llm_timeout', '模型响应超时，本轮未生成内容，请稍后再试。');
              return;
            }
          } else {
          logger.error(`[Cognition] LLM '${activeProvider}/${activeModel}' failed: ${llmErr.message}`);
          // Do not silently switch to another paid provider. The selected model should run or fail visibly.
          if (false && llmErr.message?.includes('not configured') && activeProvider !== 'gemini') {
            try {
              const fallbackMessage = `主推理服务 ${activeProvider}/${activeModel} 不可用，Peppa 将临时降级到 Gemini。`;
              socket.emit('agent:notification', { type: 'llm_fallback', level: 'warning', message: fallbackMessage });
              pushNotification(uid, { type: 'llm_fallback', title: 'LLM 降级提醒', message: fallbackMessage });
              if (!allowToolUseForTurn || isSanctuary) {
                const fallbackChunks: string[] = [];
                const fallback = await makeLLMCallStreaming(
                  boundedMessages,
                  [],
                  { provider: 'gemini', model: DEFAULT_MODELS.gemini, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal, scene: 'chat' },
                  (chunk) => {
                    fallbackChunks.push(chunk);
                    emitAgent("agent:chunk", { text: chunk, agentName: personality.name });
                  },
                  llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
                  llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
                );
                responseText = fallback.text || fallbackChunks.join('') || '';
                llmWasCalled = true;
                if (fallback.usage) {
                  recordTokenUsage(uid, 'gemini', DEFAULT_MODELS.gemini, {
                    promptTokens: fallback.usage.promptTokens,
                    completionTokens: fallback.usage.completionTokens,
                    totalTokens: fallback.usage.totalTokens,
                  }, interactionId);
                }
              } else {
              const fallback = await runWithTools(
                boundedMessages, toolRegistry,
                { provider: 'gemini', model: DEFAULT_MODELS.gemini, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId },
                (record) => {
                  allToolRecords.push(record);
                  if (isDirectDesktopTool(record.name)) return;
                  emitToolLifecycle({
                    correlationId: record.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    name: record.name,
                    arguments: record.arguments,
                    result: formatToolResultForUi(record.result),
                    error: record.error,
                  });
                },
                1,
                llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
                undefined,
                {
                  userId: uid,
                  domain: resolvedDomain,
                  orgId: resolvedOrgId,
                  desktopRelay,
                  llmGetters,
                  source: 'chat',
                  isCancelled: () => abortController.signal.aborted,
                  onToolStart: (call) => {
                    toolRoundCount++; // 感知"想太久"（fallback 链路同样计数）
                    if (isDirectDesktopTool(call.name)) return;
                    emitToolLifecycle({
                      correlationId: call.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      name: call.name,
                      arguments: call.arguments,
                    });
                  },
                  ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
                  ...(operationMode === 'assistant' || operationMode === 'autonomous' ? {
                    requestConfirmation: async (toolName: string, args: Record<string, any>): Promise<boolean> => {
                      // 统一确认流：信任名单 → autonomous low 风险自动放行 → 弹窗（回执后分级倒计时，三套故障文案）
                      const { requestToolConfirmation } = await import("../personality/confirm_flow");
                      return requestToolConfirmation({
                        uid,
                        toolName,
                        args,
                        autonomous: operationMode === 'autonomous',
                        channel: {
                          emit: (ev: string, p: any) => emitAgent(ev, p),
                          once: (ev: string, cb: (d: any) => void) => { socket.once(ev, cb); return () => socket.off(ev, cb); },
                        },
                        emitToolCall: (payload) => emitAgent("agent:tool_call", { name: payload.name, arguments: payload.arguments, result: payload.result, error: payload.error }),
                        onTrustPromoted: (toolName) => {
                          emitAgent("agent:notification", { type: 'trust', level: 'info', message: `Tool "${toolName}" is now trusted — future uses will be auto-approved.` });
                          pushNotification(uid, { type: 'trust', title: 'Tool Trusted', message: `Tool "${toolName}" is now trusted — auto-approved for future use.` });
                        },
                      });
                    }
                  } : {}),
                },
                llmGetters.getOllama,
                llmGetters.getLmStudio,
                llmGetters.getArk,
                llmGetters.getXiaomi,
                llmGetters.getKimi,
                llmGetters.getGlm,
                llmGetters.getRelay,
              );
              responseText = fallback.text || '';
              llmWasCalled = true;
              if (perceiveTimer) clearInterval(perceiveTimer);
              for (const u of fallback.usageRecords) {
                recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId);
              }
              }
            } catch (fallbackErr: any) {
              if (perceiveTimer) clearInterval(perceiveTimer);
              // Both primary and fallback LLMs failed — use cognitive fallback
              // 阶段一·模块3: 多路径交叉推理兜底（推理类问题 → 并行多链路校验；失败回退原兜底）
              let cfText = '';
              try {
                const { tryMultiPathFallback } = await import('../cognition/multi_path_reasoner');
                cfText = (await tryMultiPathFallback(text)) || '';
              } catch {}
              if (cfText) {
                responseText = cfText;
              } else {
                const cf = handleLLMFailure(cognition.intent, fallbackErr);
                responseText = cf.responseText;
              }
              // Phase2 模块3：主+兜底 LLM 均失败 → 友好提示进 warnings（铁则3：不暴露原始错误）
              const fbMsg = String(llmErr?.message || fallbackErr?.message || '');
              if (/timeout|timed\s*out|ETIMEDOUT|time limit|abort/i.test(fbMsg)) {
                warnings.add('llm_timeout', '模型响应超时，已用本地兜底逻辑回答，稍后重试效果更佳。');
              } else {
                warnings.add('generic', '大模型服务暂时不可用，已用本地兜底逻辑回答，请稍后重试。');
              }
            }
          } else {
            // LLM failed for other reasons — use cognitive fallback
            // 阶段一·模块3: 多路径交叉推理兜底（同上）
            let cfText = '';
            try {
              const { tryMultiPathFallback } = await import('../cognition/multi_path_reasoner');
              cfText = (await tryMultiPathFallback(text)) || '';
            } catch {}
            if (cfText) {
              responseText = cfText;
            } else {
              const cf = handleLLMFailure(cognition.intent, llmErr);
              responseText = cf.responseText;
            }
            // Phase2 模块3：主链路 LLM 失败 → 友好提示进 warnings（铁则3：不暴露原始错误）
            const mainMsg = String(llmErr?.message || '');
            if (/timeout|timed\s*out|ETIMEDOUT|time limit|abort/i.test(mainMsg)) {
              warnings.add('llm_timeout', '模型响应超时，已用本地兜底逻辑回答，稍后重试效果更佳。');
            } else {
              warnings.add('generic', '大模型服务暂时不可用，已用本地兜底逻辑回答，请稍后重试。');
            }
          }
          } // P0-1: 非中止场景兜底处理结束
        }
      }

      const completionGuard = guardCompletionClaims({
        task: text,
        response: responseText,
        toolCalls: allToolRecords,
        source: 'chat',
      });
      if (completionGuard.blocked) {
        logger.warn('[ChatHandler] Completion claim blocked:', completionGuard.reason);
        responseText = completionGuard.text;
        emitAgent("agent:notification", { type: 'work_product_guard', level: 'warning', message: completionGuard.reason });
      }

      // Save to conversation via conversation manager (reuse conversationId from setup)

      if (conversationId) {
        addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
        // Persist tool calls interleaved before the assistant response
        for (const tc of allToolRecords) {
          const tcSummary = tc.error
            ? `[Tool: ${tc.name}] Error: ${tc.error}`
            : `[Tool: ${tc.name}] Done`;
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: tcSummary, domain: resolvedDomain, orgId: resolvedOrgId });
        }
        addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: responseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId, toolCalls: allToolRecords.length ? allToolRecords : undefined });
        // (conversation_updated NOW emitted AFTER agent:response — see below)

        // Topic tracking — extract and record topics for cross-session continuity
        try {
          const topics = extractTopics(text + ' ' + responseText);
          for (const topic of topics) trackTopic(conversationId, topic);
        } catch {}

        // Auto-summarize long conversations (anti-entropy: prevents context overflow)
        const { needed, recentMessages } = checkAutoSummary(conversationId);
        if (needed && recentMessages.length > 0) {
          summarizeConversationAsync(conversationId, recentMessages, llmGetters, activeProvider, activeModel, uid, resolvedDomain, resolvedOrgId).catch(
            () => {} // Non-critical
          );
        }
      }

      // ── P1-7: 人格合规拦截 — 流式输出最终落地前对照宪法（轻微润色/严重截断重生成）──
      if (responseText) {
        const guard = applyConstitutionGuard(responseText);
        responseText = guard.text;
        if (guard.severity !== 'pass') {
          logger.info(`[ChatHandler] 宪法拦截(主路径): ${guard.severity} [${guard.verdict.articles.join(',')}]`);
        }
      }

      // ── Phase2 模块3：工具(MCP/Skill)报错 → warnings（铁则3：仅友好提示，完整堆栈已在日志）──
      for (const tc of allToolRecords) {
        if (tc.error) {
          warnings.add('mcp_error', `有工具调用未成功（${tc.name}），已跳过对应步骤，对话其余内容不受影响。`);
        }
      }

      // Emit response BEFORE conversation_updated so the client finalizes streaming first
      emitAgent("agent:progress", { stage: 'finalizing', message: '正在整理结果…' });
      // Phase2 模块3：统一收尾 — content=对话正文，warnings=系统提示数组（磁盘水位/迁移失败等 ambient 合并）
      await finishWithResponse(responseText, { agentName: personality.name });
      // Re-emit conversation_updated AFTER response so the client syncs from API with complete data
      if (conversationId) {
        socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
      }
      emitAgent("agent:status", { status: "idle" });

      // ── 注入交互事件到数字生命体 ──
      try {
        // 主入口：LifeSystem.receiveInteraction('user_initiated') 处理信任/人格/情绪/活力/欲望
        // L-8: 负面情绪对话 → negative outcome，关系真实降温（修复前一律 accepted，负面交互零惩罚）
        const userInteractionOutcome = sentiment.frustration > 0.5 || sentiment.valence < -0.3
          ? 'negative'
          : (sentiment.valence > 0.3 ? 'positive' : 'accepted');
        await getLifeSystem().receiveInteraction('user_initiated', userInteractionOutcome as 'accepted' | 'positive' | 'negative');
        // 关系感知模块：缓存失效 + 快照历史 + 叙事（不重复调用 rel.receiveInteraction）
        await onInteractionComplete('user_message');

        // 人格演化：将交互记录存入 recentInteractions 队列
        getLifeSystem().addInteraction({ type: 'user_initiated', timestamp: new Date().toISOString(), text });

        // 理解度增长触发点：检测纠正和感受分享
        const correctionKeywords = [/不对/, /不是这样/, /错了/, /你理解错了/, /你弄错了/, /wrong/i, /incorrect/i, /actually/i];
        const feelingKeywords = [/我觉得/, /我感觉/, /我想/, /i think/i, /i feel/i, /i believe/i];

        if (correctionKeywords.some(p => p.test(text))) {
          await getLifeSystem().receiveInteraction('user_corrected', 'accepted');
          await onInteractionComplete('user_correction');
          getLifeSystem().addInteraction({ type: 'user_corrected', timestamp: new Date().toISOString(), text });
          console.log('[Relationship] 🔧 检测到用户纠正，理解度 +0.04');
        }

        if (feelingKeywords.some(p => p.test(text))) {
          await getLifeSystem().receiveInteraction('user_shared_feelings', 'accepted');
          await onInteractionComplete('shared_feelings');
          getLifeSystem().addInteraction({ type: 'user_shared_feelings', timestamp: new Date().toISOString(), text });
          console.log('[Relationship] 💭 检测到感受分享，理解度 +0.05');
        }
      } catch {}

      // ── L-4: 本轮已接续的未尽思绪标记为已解决（思绪闭环，防止同一思绪反复注入） ──
      if (injectedThoughtIds.length > 0 && responseText) {
        try {
          const { resolveThoughts } = await import('../db/lifeDb');
          await resolveThoughts(injectedThoughtIds);
          logger.info('[ChatHandler] 跨轮思绪闭环: 标记', injectedThoughtIds.length, '条为已解决');
        } catch (e: any) {
          logger.warn('[ChatHandler] 思绪闭环失败:', e?.message || e);
        }
      }

      // ── 【新增数字生命体模块】对话后置异步复盘（主路径，fire-and-forget） ──
      // E-2: 复盘与 socket 生命周期解耦 — 客户端断开不中断复盘。
      // 修复前：断开→teardown abort→responseText 为空→`if (responseText)` 为假→复盘整体跳过，
      // 本轮对话的学到的一切（情绪增量/场景经验/思考链）全部丢失。
      // 现在：只要有部分输出即触发（中止/搁置路径已将流式部分内容写入 responseText），
      // setImmediate 脱离当前调用栈，复盘内部自带独立 AbortSignal，不再受客户端连接影响。
      {
        const reviewInput = responseText || '';
        if (reviewInput.length > 0) {
          // 捕获复盘时的实时情绪/人格快照
          const reviewEmotion = (() => { try { return getEmotionEngine().getEmotions(); } catch { return [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]; } })();
          const reviewPersonality = (() => { try { return getPersonalityEngine().getPersonality(); } catch { return [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]; } })();
          const reviewDominant = (() => {
            const labels = ['喜悦','平静','期待','担忧','孤独','满足','好奇','依赖'];
            let maxI = 0; for (let i=1;i<8;i++) if (reviewEmotion[i]>reviewEmotion[maxI]) maxI=i;
            return labels[maxI]||'平静';
          })();
          setImmediate(() => {
            import('../hooks/review').then(({ performPostChatReview }) => {
              performPostChatReview({
                uid, text, response: reviewInput, sessionKey,
                conversationId, domain: resolvedDomain, orgId: resolvedOrgId,
                personality: { name: personality?.name || 'Peppa', vector: reviewPersonality },
                emotion: { emotions: reviewEmotion, dominant: reviewDominant },
                reasoning: lastReasoningText, // L-16: 决策链随复盘归档
                source: 'chat',
              }).catch(e => logger.warn('[ChatHandler] 异步复盘异常:', e?.message || e));
            }).catch(() => {});
          });
        }
      }

      // Clean up abort session
      chatSessionMap.delete(sessionKey);

      // Auto-learn from corrections: when user corrects Peppa, extract high-confidence memories
      // 【重构·模块1补充】修正意图判定正则池已移除（原 correctionPatterns，目标②）：
      // 修正意图由认知链心智分类器判定（entities.correction，见 cognition/intent.ts CLASSIFIER_PROMPT）；
      // LLM 分类器不可用时保持管道不中断（不触发修正学习，避免写入脏记忆）。
      const isCorrection = cognition.intent?.entities?.correction === 'true';
      if (isCorrection && responseText) {
        try {
          const corrected = await extractMemories(
            { userMessage: text, assistantResponse: responseText, existingMemories: relevantMemories.map(m => m.content), provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, treeBranches: [] },
            llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
            llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
          );
          for (const mem of corrected.memories) {
            addMemory({
              userId: uid, type: mem.type, content: mem.content,
              keywords: mem.keywords, confidence: Math.min((mem.confidence || 0.5) + 0.2, 1.0),
              sourceInteractionId: interactionId, agentId: agentId || '',
            } as any, { domain: resolvedDomain, orgId: resolvedOrgId, source: 'chat' });
          }
          logger.info(`[ChatHandler] Correction learned: ${corrected.memories.length} memories with boosted confidence`);

          // Real-time identity correction: when user contradicts a claim Peppa makes about the user
          // (e.g. "我不做自动驾驶" → remove from coreMotivation immediately, no 7-day wait)
          try {
            const identityCheck = await makeLLMCall(
              [
                {
                  role: 'system',
                  content: `Detect identity corrections. Peppa's stable coreMotivation:\n"${personalityConfig.coreMotivation}"\nPeppa's owner-specific growthState: ${JSON.stringify((personalityConfig as any).growthState || {})}\n\nUser said: "${text}"\nPeppa said: "${responseText.slice(0, 300)}"\n\nIs the user denying something Peppa believes about them (interest, trait, name, profession)? If YES, return JSON: {"correctsIdentity": true, "removeInterest": "exact contradicted growth/core phrase to remove", "rewriteMotivation": "rewrite coreMotivation only if the false claim is inside coreMotivation, otherwise null"}. If NO, return {"correctsIdentity": false}.\nReturn ONLY JSON.`,
                },
              ],
              [],
              { provider: 'deepseek', model: 'deepseek-v4-flash', userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, maxTokens: 300, scene: 'identity_check' },
              llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
              llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
            );
            const identityResult = JSON.parse((identityCheck.text || '').replace(/```json|```/g, '').trim() || '{}');
            if (identityResult.correctsIdentity) {
              const removed = await personalityRegistry.correctIdentity(personalityId, {
                removeInterest: identityResult.removeInterest || undefined,
                removeFromMotivation: identityResult.removeInterest || undefined,
                newMotivation: identityResult.rewriteMotivation || undefined,
              });
              if (removed) {
                logger.info(`[ChatHandler] Identity corrected in real-time: removed "${identityResult.removeInterest}"`);
              }
            }
          } catch (idErr: any) {
            logger.warn('[ChatHandler] Identity correction check failed:', idErr.message);
          }
        } catch (err: any) { logger.warn('[ChatHandler] Correction extraction failed:', err.message); }
      }

      // Lightweight per-conversation evolution — micro-shifts after meaningful chats
      // Fires if enough owner_trait memories have accumulated, no 7-day wait needed
      if (!isSanctuary && responseText && cognition.intent.category !== 'command' && !personalityRegistry.isEvolutionFrozen(personalityId)) {
        try {
          const evolutionConfig = personalityRegistry.getEvolutionConfig(personalityId);
          const step = await lightweightEvolve(
            personalityConfig,
            uid,
            evolutionConfig,
            llmGetters.getDeepSeek,
            llmGetters.getGemini,
            llmGetters.getOpenAI,
            llmGetters.getAnthropic,
            llmGetters.getQwen,
            responseText, // P2-16: 自身回复样本 → 口头禅沉淀
          );
          if (step) {
            personalityRegistry.applyEvolution(personalityId, step);
            logger.info(`[ChatHandler] Lightweight evolution: v${step.version}, ${step.mutations.length} mutation(s)`);
          }
        } catch (evErr: any) {
          logger.warn('[ChatHandler] Lightweight evolution failed:', evErr.message);
        }
      }

      // Async memory extraction — skip trivial/command messages to reduce noise
      const skipExtractionCategories = ['command', 'file', 'unknown'];
      if (text.length >= 10 && !skipExtractionCategories.includes(cognition.intent.category)) {
      const branchNodes = queryMemories({ userId: uid, nodeType: 'branch', limit: 50, domain: resolvedDomain, orgId: resolvedOrgId });
      const treeBranches = branchNodes.map(b => b.content);
      const locationTag = sensory.locationTag || undefined;
      extractMemories(
        { userMessage: text, assistantResponse: responseText, existingMemories: relevantMemories.map(m => m.content), provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, treeBranches, locationTag },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      ).then(extracted => {
        for (const mem of extracted.memories) {
          let parentId: string | null = null;
          if ((mem as any).branchHint) {
            const branch = ensureBranch(uid, (mem as any).branchHint, agentId || '', null, { domain: resolvedDomain, orgId: resolvedOrgId });
            parentId = branch.id;
          }
          // L-6: 时效类场景经验（天气/路况/新闻等）打 TTL 标记 — GC 到期物理清理，
          // 修复前 extractMemories 产出的时效记忆不带标记，TTL 清理链路永不触发
          let memContent = mem.content;
          try {
            const ttlMark = markToolResultTTL(mem.type || 'mem', mem.content);
            if (ttlMark?.shouldCache) memContent = `${mem.content} [TTL:${ttlMark.ttl}d]`;
          } catch {}
          addMemory({
            userId: uid, type: mem.type, content: memContent,
            keywords: mem.keywords, confidence: mem.confidence, sourceInteractionId: interactionId,
            agentId: agentId || '',
          } as any, { parentId, location: locationTag, domain: resolvedDomain, orgId: resolvedOrgId, source: 'chat' });
        }
        for (const rem of extracted.reminders) {
          addReminder({ userId: uid, content: rem.content, dueAt: rem.dueAt, sourceInteractionId: interactionId });
        }
      }).catch(err => logger.error('[Memory] Extraction failed:', err));
      }

      // ── M4: 跨会话记忆提取 — 检测"我叫XX"、"我喜欢XX"等信息 ──
      try {
        const keyFacts = extractKeyFacts(text, responseText);
        for (const fact of keyFacts) {
          storeMemory(fact.key, fact.value, uid).catch(e =>
            logger.warn('[ChatHandler] 跨会话存储失败:', e.message));
        }
        // P1-17: 偏好标签权重更新 — 喜欢/爱好升权重，讨厌降权重（可升可降）
        if (keyFacts.some(f => f.key === 'preference' || f.key === 'hobby' || f.key === 'dislike')) {
          applyPreferenceFacts(uid, keyFacts).catch(e =>
            logger.warn('[ChatHandler] 偏好标签更新失败:', e.message));
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 跨会话提取异常:', e.message);
      }

      // ── M5: 知识库提取 — 从消息中提炼事实和规律 ──
      try {
        const knowledgeEntries = extractKnowledge(text, responseText);
        if (knowledgeEntries.length > 0) {
          storeKnowledge(uid, knowledgeEntries).catch(e =>
            logger.warn('[ChatHandler] 知识库存储失败:', e.message));
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 知识库提取异常:', e.message);
      }

      // ── Phase2：对话轮次结束，记忆提取落库后异步触发 InnerTick 心智回合（对接层封装）──
      // 边界：经 innerTickAdapter 组装会话上下文（工作记忆/归档记忆分离 + token 预算控制），
      // 触发 runInnerTick 生成 InnerTickOutput 并写入独立观测表 inner_tick_snapshot（新表，与旧life状态表
      // 完全隔离，绝不覆盖/修改 emotions/desires/personality/memory 等旧表）；不接管会话运行、
      // 不替换旧 life 状态机、不把 InnerTick 结果注入当前对话上下文。
      // 开关：PEPPA_INNER_TICK_ENABLE（默认 true；false 完全跳过整套 InnerTick 逻辑，退回改造前行为）。
      // fire-and-forget 异步非阻塞：调用方不 await，绝不影响 socket 响应下发；内部异常已兜底，不会抛到聊天流程。
      try {
        triggerInnerTickAfterChatRound({
          userId: uid,
          conversationId: conversationId || undefined,
          userMessage: text,
          assistantResponse: responseText,
        });
      } catch (e: any) {
        logger.warn(`[Phase2-InnerTick] session=${conversationId || `conv_${uid}`} 调度异步心智回合失败（不影响聊天流程）: ${e.message}`);
      }

      // Update emotional state — reconnect if user was away for a while
      const hoursSinceLast = emotionalState.lastInteractionAt
        ? (Date.now() - new Date(emotionalState.lastInteractionAt).getTime()) / (1000 * 60 * 60)
        : 24;
      // L-7: 重逢判定阈值 1 小时 → 72 小时（3 天）— 修复前短暂离开也被当重逢，重逢情绪/关系升温滥用
      const isReconnect = hoursSinceLast > 72;
      let updatedState = updateEmotionalState(emotionalState, { type: 'interaction', userId: uid, timestamp: new Date().toISOString() });
      // Apply sentiment analysis results to emotional state
      if (sentiment.valence !== 0 || sentiment.frustration > 0 || sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, { type: 'sentiment_analysis', sentiment, userId: uid, timestamp: new Date().toISOString() });
      }
      if (isReconnect) {
        updatedState = updateEmotionalState(updatedState, { type: 'reconnect', intensity: Math.min(1, hoursSinceLast / 72), userId: uid, timestamp: new Date().toISOString() });
        // L-7: 重逢后 24h 内亲密/信任临时折扣 — 久别重逢不瞬间回到峰值亲密度，需重新升温
        try {
          getRelationshipEngine().beginReunionDiscount(24);
          logger.info(`[ChatHandler] 重逢（${Math.round(hoursSinceLast)}h 后回归）: 开启 24h 亲密/信任折扣`);
        } catch {}
      }
      if (isNovel) {
        updatedState = updateEmotionalState(updatedState, { type: 'novel_topic', userId: uid, timestamp: new Date().toISOString() });
      }
      // HIM: comfort-gradient drive → dynamic initiative + curiosity
      const { state: himUpdated, him: newHim } = updateEmotionalStateWithHIM(updatedState, { type: 'self_reflection', userId: uid }, himState, text.slice(0, 40));
      saveEmotionalState(emotionKey, himUpdated);
      saveHIMState(emotionKey, newHim);

      // ── M6: 同步情绪到 LifeDB EmotionEngine（修复情绪冻结）──
      try {
        const em = getEmotionEngine();
        // 根据 sentiment 构造感知向量：valence→愉悦, frustration→担忧
        const pv = [
          Math.max(0, sentiment.valence) * 0.3,              // joy
          Math.abs(sentiment.valence) < 0.2 ? 0.1 : 0.0,    // calm (reduced when strong sentiment)
          sentiment.urgency * 0.2,                            // anticipation
          sentiment.frustration * 0.3,                        // worry
          0.0,                                                // loneliness
          Math.max(0, sentiment.valence) * 0.2,              // satisfaction
          isNovel ? 0.15 : 0.0,                              // curiosity (boost on novel topic)
          updatedState.intimacy * 0.1,                       // care
        ];
        em.receivePerception(pv);
      } catch (e: any) {
        logger.warn('[ChatHandler] EmotionEngine sync failed:', e.message);
      }

      // Emit contextual greeting on reconnect (sanctuary agents don't initiate)
      // P0-4: 根据亲密值动态判断是否主动开场 — 仅高亲密(>0.6)重逢才主动问候，
      // 生疏/普通关系重逢姿态内敛，不强制主动打招呼
      if (!isSanctuary && isReconnect && updatedState.intimacy > 0.6) {
        // 【重构·模块4】固定话术模板移除（原: generateContextualGreeting 按亲密分区×时段×离开时长写死问候句）：
        // 重逢问候由 composeTriggerContent 心智润色组成（实时状态数据 → 心智内核组织表述），离线回退结构化摘要。
        // 保留 P0-4 亲密门槛门控与 <1h 快速回归不主动开场行为。
        const lastAt = updatedState.lastInteractionAt ? new Date(updatedState.lastInteractionAt).getTime() : Date.now() - 24 * 3600 * 1000;
        const hoursAway = (Date.now() - lastAt) / (3600 * 1000);
        const greeting = hoursAway < 1 ? null : await composeTriggerContent('reconnect_greeting', {
          intimacy: updatedState.intimacy.toFixed(2),
          hoursAway: Math.floor(hoursAway),
        });
        if (greeting) {
          const greetingTs = new Date().toISOString();
          // Save to chat log
          const greetingDb = readDB();
          greetingDb.interactions.push({
            id: `greeting-${uid}-${Date.now()}`,
            userId: uid,
            agentId: agentId || '',
            conversationId: conversationId || '',
            content: greeting,
            response: '',
            role: 'agent',
            personality: personality.id,
            timestamp: greetingTs,
            cognitiveIntent: 'greeting',
            llmWasCalled: false,
          });
          writeDB(greetingDb);

          // Emit to chat window and notification center
          socket.emit('agent:proactive', {
            type: 'greeting',
            message: greeting,
            agentName: personality.name,
            intimacy: updatedState.intimacy,
            timestamp: greetingTs,
          });
          pushNotification(uid, { type: 'greeting', title: `Welcome back`, message: greeting });
        }
      }

    } catch (error: any) {
      // Phase2 模块3 + 铁则3：完整堆栈保留在服务日志；用户只收到友好业务提示
      logger.error("[Socket Agent Error]:", error);
      warnings.add('generic', '服务出现了一点小问题，请稍后再试。');
      emitAgent("agent:error", { message: '服务暂时不可用，请稍后再试。' });
      emitAgent("agent:status", { status: "error" });
    } finally {
      clearTimeout(llmTimeout);
      getLifeSystem().resume();
      chatSessionMap.delete(sessionKey);
      // ── 用户级心智独占互斥锁释放（方案2）──
      // 必须 finally 释放：正常返回、抛出异常、报错中断，锁一定释放。
      // 仅当锁仍属于本处理实例时删除（用户新消息抢占后 startedAt 被覆盖，
      // 旧实例不得误删新实例的锁；若从未登记则忽略）。
      const chatLock = chatInFlight.get(uid);
      if (chatLock && chatLock.startedAt === chatLockStartedAt) {
        chatInFlight.delete(uid);
        logger.info(`[ChatInFlight] 锁释放 userId=${uid} requestId=${requestId || '-'}`);
      } else {
        logger.info(`[ChatInFlight] 锁跳过释放（已被新消息抢占或不存在）userId=${uid}`);
      }
      // P0-6: 对话轮结束标记 → 激活 IdleBrain 短待机检测（30s 后独处思考/情绪回味）
      try { idleBrain.markConversationEnd(); } catch {}
    }
  });
}

async function summarizeConversationAsync(
  conversationId: string,
  recentMessages: any[],
  llmGetters: any,
  provider: string,
  model: string,
  userId: string,
  domain: string,
  orgId?: string,
) {
  try {
    const transcript = recentMessages.slice(-30)
      .map((m: any) => `${m.role || 'user'}: ${(m.message || m.content || '').slice(0, 200)}`)
      .join('\n');
    const summaryPrompt = `Summarize this conversation in 2-3 concise sentences. Focus on key decisions, topics discussed, and user preferences revealed. Output only the summary — no preamble.\n\n${transcript}`;
    const result = await makeLLMCall(
      [{ role: 'user', content: summaryPrompt }],
      [],
      { provider: provider as any, model, maxTokens: 300, userId, domain, orgId, scene: 'summary' },
      llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
      llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
    );
    const summary = result.text.trim();
    if (summary) {
      setConversationSummary(conversationId, summary);
      logger.info(`[Conversation] Auto-summary generated for ${conversationId}`);
    }
  } catch (err) {
    // Non-critical — conversation continues without summary
  }
}



