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
import { hasClientActionOnlyIntent, isDiagnosticOrRepairRequest, shouldAllowToolUseForTurn, shouldExposeAgentWork } from "../cognition/tool_intent";
import { resolveWorkSurfaceRoute } from "../cognition/work_surface";
import { formatToolRouteForPrompt, mergeToolPolicyWithRoute, routeToolsForTurn } from "../cognition/tool_router";
import { formatClientSelfPrompt } from "../client/self_model";
import { queryMemories, queryMemoriesVector, addMemory, addReminder, extractMemories, retrieveRelevantMemories, getTimeline, getMemories, storeMemory, extractKeyFacts, extractKnowledge, storeKnowledge, getKnowledge, formatKnowledgeForContext } from "../memory";
import { loadEmotionalState, saveEmotionalState, updateEmotionalState, updateEmotionalStateWithHIM, loadHIMState, saveHIMState, generateContextualGreeting, vectorMemoryBias } from "../personality/state";
import { buildModeOverlay } from "../personality/engine";
import { personalityRegistry } from "../personality";
import { lightweightEvolve } from "../personality/evolution";
import { getOrCreateActiveConversation, addMessage, getMessages, getMessagesByTokenBudget, checkAutoSummary, setConversationSummary, getConversationSummary, setConversationMode, getUnclosedConversation, extractTopics, trackTopic, getTopicContext } from "../conversation/manager";
import { ensureBranch } from "../memory/tree";
import { detectAndSwitchTopic } from "../memory/focusStack";
import { getPrefetchedContext, clearPrefetchedContext, touchActivity } from "../memory/prefetch";
import { getLifeSystem, getDirectionState } from "../life/index.js";
import { getVitality } from "../life/vitality.js";
import { getEmotionEngine } from "../life/emotions.js";
import { getPersonalityEngine } from "../life/personality.js";
import { getRelationshipEngine } from "../life/relationship.js";
import { onInteractionComplete } from "../life/relationshipAwareness.js";
import { routeMessage, isInstinctQuery, isIdentityQuery } from "../cognition/router.js";
import { getSelfState, synthesizeResponse } from "../cognition/deepReasoning.js";
import { generateIdentityResponse, generateHowAreYouResponse } from "../life/narrative.js";
import { updateComprehension, shouldClarify, generateClarification, getComprehensionState } from '../life/comprehension.js';
import { touchUserActivity } from "../life/userState.js";
// 【新增数字生命体模块】T80 心智 + MCP 拦截器
import { buildMindContext, classifyToolIntent, MindContext, SEVEN_STEP_MIND } from '../hooks/chat.js';
import { mcpInterceptor, buildToolBlockMessage } from '../tools/interceptor.js';
import { getUnrespondedObservations, markObservationResponded } from "../db/lifeDb.js";
import { retrieveChunks } from "../agents/rag";
import { getSensory } from "./shared";
import { processInput, handleLLMFailure, extractSentiment, CognitiveContext } from "../cognition";
import { matchQuickCommand } from "../cognition/quick_commands";
import { checkLLMAccess, recordUsage, estimateTokens } from "../subscription/proxy";
import { recordTokenUsage } from "../llm/token_tracker";
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
import { runNLChainer, shouldChainTask } from "../agents/nl_chainer";
import { autoInstallForTask } from "../agents/auto_installer";
import { adjustMusicPlayback, getMusicFailureMessage, isMusicAdjustmentRequest, isMusicPlaybackRequest, searchAndPlay } from "../music/search_play";
import { searchKnowledgeBase } from "../org/kb";
import { getMember } from "../org/db";
import { getWorkflow, recordWorkflowRun, listWorkflows } from "../agents/workflows";
import { buildProfessionOverlay } from "../autonomy/professions";
import { analyzeLikedMusicProfile, formatMusicProfileReport, isMusicProfileAnalysisRequest } from "../music/library_profile";
import { buildResponseLanguageInstruction } from "../utils/language";
import { guardCompletionClaims, needsCompletionEvidence } from "../work_product/completion_guard";
import { buildModelSelfAwareness, buildVisionRoutingOverlay, hasVisionIntent } from "../cognition/vision_routing";
import { DEFAULT_MODELS, getScopedPreferredLLM } from "../llm/user_preferences";
import { generateTemporalContext } from '../time/temporal_context.js';

const JWT_SECRET = process.env.JWT_SECRET || 'peppaOS_default_jwt_secret_2026_local';

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
    const llmTimeout = setTimeout(() => { abortController.abort(); logger.warn('[ChatHandler] LLM 超时 30s，强制中止'); }, 30000);

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
      const prefetchedContext = getPrefetchedContext(uid);
      if (prefetchedContext) {
        effectiveSystemPrompt += '\n\n' + prefetchedContext.summary;
        logger.info('[ChatHandler] prefetched context injected:', prefetchedContext.source);
        clearPrefetchedContext(uid);
      }
      if (conversationId) {
        const summaryContext = getConversationSummary(conversationId);
        if (summaryContext) {
          effectiveSystemPrompt += `\n\n## Conversation Context\n${summaryContext}`;
        }
      }
      // Cross-session: inject previous conversation context when starting fresh
      if (previousSessionContext) {
        effectiveSystemPrompt += `\n\n${previousSessionContext}`;
      }

      // ── M4: 跨会话记忆注入 ──
      try {
        const crossMemories = await getMemories(uid);
        if (crossMemories.length > 0) {
          const crossMemoryText = '## 跨会话记忆（关于用户的重要信息）\n以下是你从之前的对话中记住的关于用户的事实：\n'
            + crossMemories.map(m =>
                `- ${formatFactLabel(m.key)}: ${m.value}`
              ).join('\n')
            + '\n请在对话中自然地运用这些信息，让用户感受到你记得关于他们的事情。';
          effectiveSystemPrompt += '\n\n' + crossMemoryText;
          logger.info('[ChatHandler] 跨会话记忆:', crossMemories.length, '条');
        }
      } catch (e: any) {
        logger.warn('[ChatHandler] 跨会话记忆加载异常:', e.message);
      }

      // ── M5: 知识库注入 ──
      try {
        const knowledgeEntries = await getKnowledge(uid, { limit: 15, minConfidence: 0.3 });
        if (knowledgeEntries.length > 0) {
          const knowledgeContext = formatKnowledgeForContext(knowledgeEntries);
          effectiveSystemPrompt += '\n\n' + knowledgeContext;
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

      const interactionId = crypto.randomUUID();

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

      // Inject operation mode prompt overlay
      const opModeConfig = getOperationModeConfig(operationMode);
      const allowToolUseForTurn = shouldAllowToolUseForTurn(text, source, operationMode);
      const selfRepairTurn = isDiagnosticOrRepairRequest(text);
      const clientActionOnlyTurn = !selfRepairTurn && hasClientActionOnlyIntent(text) && (operationMode === 'chat' || operationMode === 'meeting');
      const workSurfaceRoute = resolveWorkSurfaceRoute(text);
      const visionIntent = hasVisionIntent(text);
      const clientActionToolPolicy = clientActionOnlyTurn
        ? { allowedTools: ['client_get_state', 'client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 }
        : null;
      const selfRepairToolPolicy = selfRepairTurn
        ? {
            allowedTools: ['*'],
            requireConfirmation: [
              'desktop_run_command',
              'run_command',
              'write_file',
              'file_delete',
              'delete_file',
              'rm',
              'unlink',
              'format',
              'rmdir',
              'uninstall',
              'computer_use',
            ],
            forbiddenTools: [],
            maxIterations: 8,
          }
        : null;
      const baseRoutedToolPolicy = isSanctuary
        ? { allowedTools: [], requireConfirmation: [], forbiddenTools: ['*'], maxIterations: 0 }
        : selfRepairToolPolicy
          ? selfRepairToolPolicy
          : clientActionToolPolicy
            ? clientActionToolPolicy
            : (workSurfaceRoute.toolPolicy || opModeConfig?.toolPolicy);
      const toolRoute = allowToolUseForTurn && !clientActionOnlyTurn && !selfRepairTurn && !isSanctuary
        ? routeToolsForTurn(text, toolRegistry.getToolDeclarations())
        : null;
      const routedToolPolicy = toolRoute && baseRoutedToolPolicy
        ? mergeToolPolicyWithRoute(baseRoutedToolPolicy, toolRoute)
        : baseRoutedToolPolicy;
      const exposeAgentWork = shouldExposeAgentWork(text);
      effectiveSystemPrompt += '\n\n' + formatClientSelfPrompt(uid);
      logger.info('[ChatHandler] tool gate:', allowToolUseForTurn ? 'enabled' : 'chat-only', 'operationMode:', operationMode, 'clientActionOnly:', clientActionOnlyTurn, 'selfRepair:', selfRepairTurn, 'route:', toolRoute ? `${toolRoute.toolNames.length}/${toolRoute.totalAvailable} ${toolRoute.categories.join(',') || 'fallback'}` : 'none');
      if (toolRoute) {
        socket.emit('agent:tool_route', {
          categories: toolRoute.categories,
          reasons: toolRoute.reasons,
          toolNames: toolRoute.toolNames,
          totalAvailable: toolRoute.totalAvailable,
          truncated: toolRoute.truncated,
        });
      }
      if (clientActionOnlyTurn) {
        effectiveSystemPrompt += '\n\n## Client Mode Control\nThe user is asking Peppa to change a client mode or open a client-native surface. You may only use client_get_state and client_action. Do not use file, terminal, desktop mouse/keyboard, web, team, or external-app tools. Music is a playback/atmosphere capability, not a top-level work mode: open the music center or mood layer without switching client mode. For meeting/autonomous mode, use the client action confirmation flow when required.';
      } else if (selfRepairTurn) {
        effectiveSystemPrompt += '\n\n## Client Self-Repair Turn\nThe user is reporting that Peppa or one of its client workflows is failing. Do not only apologize or repeat the raw error. Use client_get_state first when tools are available, inspect relevant status/log/config surfaces, apply one safe recovery or retry when the cause is clear, verify the result, and then give a concise report. Reads and status checks are allowed; writes, desktop control, external app automation, and system changes still require confirmation.';
      } else if (opModeConfig && (allowToolUseForTurn || operationMode === 'meeting')) {
        effectiveSystemPrompt += '\n\n' + opModeConfig.promptOverlay;
      } else {
        effectiveSystemPrompt += '\n\n## Interaction Mode\nThis turn is chat-only. Do not call tools, operate the desktop, or claim that you are taking actions. Answer naturally unless the user gives an explicit command.';
      }
      if (workSurfaceRoute.promptOverlay) {
        effectiveSystemPrompt += '\n\n' + workSurfaceRoute.promptOverlay;
      }
      if (toolRoute) {
        effectiveSystemPrompt += '\n\n' + formatToolRouteForPrompt(toolRoute);
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
        emitAgent("agent:response", { text: workflowQuickResult, agentName: personality.name });
        emitAgent("agent:status", { status: "idle" });
        return;
      }

      // ── Quick Command Fast-Path: deterministic commands skip LLM entirely ──
      try {
        const quickResult = await matchQuickCommand(text, uid);
        if (quickResult?.matched) {
          logger.info('[ChatHandler] Quick command:', text.slice(0, 60));
          if (quickResult.toolCall) {
            const toolCid = `qc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const shouldEmitQuickTool = !isDirectDesktopTool(quickResult.toolCall.name);
            if (shouldEmitQuickTool) {
              emitToolLifecycle({
                correlationId: toolCid,
                name: quickResult.toolCall.name,
                arguments: quickResult.toolCall.arguments,
              });
            }
            try {
              const tcResult = await toolRegistry.execute(quickResult.toolCall.name, quickResult.toolCall.arguments, { userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, desktopRelay, llmGetters });
              if (shouldEmitQuickTool) {
                emitToolLifecycle({
                  correlationId: toolCid,
                  name: quickResult.toolCall.name,
                  arguments: quickResult.toolCall.arguments,
                  result: formatToolResultForUi(tcResult),
                });
              }
            } catch (toolErr: any) {
              if (shouldEmitQuickTool) {
                emitToolLifecycle({
                  correlationId: toolCid,
                  name: quickResult.toolCall.name,
                  arguments: quickResult.toolCall.arguments,
                  error: toolErr.message,
                });
              }
            }
          }
          emitAgent("agent:response", { text: quickResult.responseText, agentName: personality.name });
          if (conversationId) {
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            if (quickResult.toolCall) {
              addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'tool', content: `[Tool: ${quickResult.toolCall.name}] Called`, domain: resolvedDomain, orgId: resolvedOrgId });
            }
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: quickResult.responseText, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
          }
          emitAgent("agent:status", { status: "idle" });
          // Track topics for quick commands too
          if (conversationId) {
            try {
              const topics = extractTopics(text);
              for (const topic of topics) trackTopic(conversationId, topic);
            } catch {}
          }
          chatSessionMap.delete(sessionKey);
          return;
        }
      } catch (qcErr: any) {
        logger.warn('[ChatHandler] Quick command check failed, falling through:', qcErr.message);
      }

      if (isMusicProfileAnalysisRequest(text)) {
        emitAgent("agent:status", { status: "thinking", agentName: personality.name, detail: "Analyzing music profile" });
        let profileResponse = '';
        try {
          const profile = await analyzeLikedMusicProfile(uid, { maxSongs: 3000 });
          profileResponse = formatMusicProfileReport(profile);
        } catch (profileErr: any) {
          profileResponse = `我现在还没能完成网易云喜欢歌单分析。\n\n${profileErr?.message || '请确认网易云已经登录，再试一次。'}`;
          socket.emit('music:error', { message: profileResponse });
        }

        emitAgent("agent:response", { text: profileResponse, agentName: personality.name });
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: profileResponse, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
        }
        emitAgent("agent:status", { status: "idle" });
        chatSessionMap.delete(sessionKey);
        return;
      }

      // ── 统一路由：本能层 → 工具层 → 认知层 → Orchestrator ──
      const route = await routeMessage(text, operationMode);
      logger.info(`[ChatHandler] route: ${route.layer} (${route.reason}) trace: ${route.trace.join(' → ')}`);
      // 注入路由信息到响应，供前端调试
      const routeContext = { layer: route.layer, reason: route.reason, trace: route.trace };

      // ── 本能层：关于系统自身状态的消息，直接回复不经过认知/工具层 ──
      // 模式定义统一在 router.ts 中管理（INSTINCT_PATTERNS + IDENTITY_PATTERNS）
      if (isInstinctQuery(text)) {
        const isIdentity = isIdentityQuery(text);
        const vt = getVitality();
        const em = getEmotionEngine();
        const rel = getRelationshipEngine();
        const reply = isIdentity
          ? await generateIdentityResponse()
          : vt.generateSelfAwareResponse(em.summarize(), rel.getRelationshipState().stage);

        // 存入数据库
        if (conversationId) {
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: reply, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
        }
        try { const db = readDB(); db.interactions.push({ id: `instinct_${Date.now()}`, userId: uid, agentId: agentId || '', conversationId: conversationId || '', content: storedUserContent, response: reply, role: 'user', personality: personality.id, timestamp: new Date().toISOString(), cognitiveIntent: 'conversation', llmWasCalled: false, domain: resolvedDomain, orgId: resolvedOrgId }); writeDB(db); } catch {}

        console.log("[本能层] 准备发送回复:", reply);
        socket.emit('agent:response', { text: reply, agentName: personality.name, source: 'instinct', requestId: requestId || undefined });
        logger.info('[ChatHandler] 本能层拦截:', text.slice(0, 30));
        chatSessionMap.delete(sessionKey);
        return;
      }

      // ── 深度推理层：优先使用自身状态生成回复 ──
      if (route.layer === 'deep_reasoning') {
        logger.info('[ChatHandler] 深度推理层触发（自身状态模式）:', text.slice(0, 40));
        let nluIntent: { intent: string; entities: Record<string, any>; confidence: number; source: string } | null = null;
        try {
          const { parseIntent } = await import('../cognition/nlu/index.js');
          nluIntent = await parseIntent(text);
          logger.info(`[ChatHandler] NLU: ${nluIntent.intent} (${nluIntent.confidence.toFixed(2)})`);
        } catch (e) {
          logger.warn('[ChatHandler] NLU failed:', e);
        }

        // ── 状态驱动回应（新逻辑） ──
        const comprehensionState = updateComprehension(text, {
          conversationHistory: [],
        });
        logger.info(`[ChatHandler] 当前理解状态: overall=${comprehensionState.overall.toFixed(2)}, missing=${comprehensionState.missingAspects.join(',')}`);
        console.log(`[DEBUG] overall=${comprehensionState.overall}, missing=${comprehensionState.missingAspects}`);

        if (comprehensionState.overall < 0.5) {
          const followUp = generateClarification(comprehensionState);
          if (followUp) {
            logger.info(`[ChatHandler] 追问: ${followUp.slice(0, 40)}...`);
            socket.emit('agent:response', {
              text: followUp,
              agentName: personality.name,
              source: 'clarification'
            });
            if (conversationId) {
              addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
              addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: followUp, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            }
            socket.emit('agent:status', { status: "idle" });
            chatSessionMap.delete(sessionKey);
            return;
          }
        }

        // ── 【新增数字生命体模块】7步心智 + 情绪注入 + 场景判定（仅深度推理分支） ──
        const toolIntent = classifyToolIntent(text);
        const shouldDisableTools = toolIntent === 'nostalgic';

        // 构建心智上下文
        const em = getEmotionEngine();
        const pe = getPersonalityEngine();
        const dirState = getDirectionState();
        const compState = getComprehensionState();
        const mindCtx: MindContext = {
          ...buildMindContext(
            em.getEmotions(),
            pe.getPersonality(),
            dirState.getInclination(),
            dirState.getIntensity(),
            compState.overall,
          ),
          toolIntent,
          shouldDisableTools,
        };

        if (shouldDisableTools) {
          logger.info(`[ChatHandler] 【新增数字生命体模块】场景判定: ${toolIntent} → MCP工具已屏蔽`);
          // 额外兜底：直接消耗本轮 MCP 配额，确保即使后续误判也不会调用
          mcpInterceptor.recordCall(sessionKey, 'blocked_nostalgic');
          // 在 System Prompt 中明确告知模型本轮不可使用工具
          effectiveSystemPrompt += '\n\n【重要】本轮对话属于情感陪伴场景，请勿调用任何工具。用纯共情的方式回应。';
        }

        // 将7步心智 + 情绪状态注入有效 System Prompt（深度推理专用）
        effectiveSystemPrompt = mindCtx.mindSystemPrompt + '\n\n' + mindCtx.emotionStatePrompt + '\n\n' + effectiveSystemPrompt;
        logger.info(`[ChatHandler] 【新增数字生命体模块】心智注入: toolIntent=${toolIntent} disableTools=${shouldDisableTools}`);

        let reply = '';
        try {
          const selfState = await getSelfState();
          logger.info('[Debug] selfState 内容:', JSON.stringify(selfState));

          // ── 实体提取：从用户消息中提取人物、事件、动作 ──
          const peopleKeywords = ['同事', '老板', '朋友', '家人', '领导', '同学', '伴侣', '师傅', '邻居', '客户', '合伙人'];
          const eventKeywords = [
            // 职业类
            '换工作', '跳槽', '转行', '裸辞', '辞职', '找工作', '面试', '升职', '加薪',
            // 生活类
            '换城市', '搬家', '买房', '租房', '买车', '结婚', '离婚', '分手', '复合',
            // 情感类
            '道歉', '表白', '求婚', '感谢', '和好',
            // 创业/投资类
            '创业', '投资', '理财', '炒股',
            // 决策类
            '决定', '选择', '放弃', '坚持'
          ];
          const actionKeywords = [
            '说', '做', '去', '找', '问', '要', '给', '聊', '谈', '讲', '写', '发',
            '告诉', '分享', '通知', '转告', '告知', '透露', '交代', '表示', '表达',
            '聊', '谈', '讨论', '商议', '商量', '协商'
          ];
          const extractedEntities = {
            people: peopleKeywords.filter(k => text.includes(k)),
            events: eventKeywords.filter(k => text.includes(k)),
            actions: actionKeywords.filter(k => text.includes(k)),
          };
          console.log('[实体提取] 人物:', extractedEntities.people, '事件:', extractedEntities.events, '动作:', extractedEntities.actions);

          const directionState = getDirectionState();
          await directionState.load();
          const direction = await directionState.updateFromState(
            selfState.emotion,
            selfState.personality,
            extractedEntities
          );
          const selfEmotion = selfState?.emotion;
          const selfPersonality = selfState?.personality;
          // 【修复】解析情绪状态（兼容 vector_json / emotion_type 两种格式）
          let selfEmotionText = '平静';
          if (selfEmotion) {
            if (selfEmotion.vector_json) {
              try {
                const vec = JSON.parse(selfEmotion.vector_json);
                const labels = ['喜悦','平静','期待','担忧','孤独','满足','好奇','依赖'];
                let maxI = 0; for (let i=1;i<8;i++) if (vec[i]>vec[maxI]) maxI=i;
                selfEmotionText = labels[maxI]||'平静';
              } catch { selfEmotionText = '平静'; }
            } else if (selfEmotion.emotion_type) {
              selfEmotionText = selfEmotion.emotion_type;
            }
          }
          let selfPersonalityText = '温和中立';
          if (selfPersonality?.vector_json) {
            try {
              const vec = JSON.parse(selfPersonality.vector_json);
              selfPersonalityText = (vec[2]||0.5) > 0.6 ? '偏主动' : '偏谨慎';
            } catch { selfPersonalityText = '温和中立'; }
          }
          const deduction: any = {
            domain: '人际沟通',
            steps: ['基于当前情绪、人格状态和表达倾向生成判断'],
            pro_position: selfEmotion && selfPersonality
              ? `基于我的状态（情绪：${selfEmotionText}，人格倾向：${selfPersonalityText}，表达倾向：${direction.inclination}），我倾向于...`
              : '我倾向于...',
            con_position: selfEmotion
              ? `我现在的状态是${selfEmotionText}，表达倾向${direction.inclination}，所以...`
              : '我不会盲目鼓励你做任何事。',
            intermediate_conclusion: selfEmotion && selfPersonality
              ? `我的状态决定了我的判断：${selfEmotionText}让我更谨慎，${selfPersonalityText}让我倾向于主动处理。表达倾向${direction.inclination}影响我的立场。`
              : '我建议你想清楚，但不强求。',
            direction: {
              inclination: direction.inclination,
              intensity: direction.intensity,
              reason: direction.reason,
            },
          };
          // 将 context 融入 deduction，让回复内容更具针对性
          if (extractedEntities && (extractedEntities.events.length > 0 || extractedEntities.people.length > 0)) {
            const contextInfo = [];
            if (extractedEntities.events.length > 0) {
              contextInfo.push(`你提到了 ${extractedEntities.events.join('、')}`);
            }
            if (extractedEntities.people.length > 0) {
              contextInfo.push(`涉及 ${extractedEntities.people.join('、')}`);
            }
            if (contextInfo.length > 0) {
              deduction.context_note = contextInfo.join('，');
              // 将 context 信息融入 intermediate_conclusion
              deduction.intermediate_conclusion += ` 基于你提到的内容，我给出以下判断。`;
            }
          }

          // ── 【新增数字生命体模块】传入情绪+心智参数，动态生成非生硬短句 ──
          const emotionSummaryForDeep = mindCtx?.emotionStatePrompt || '';
          reply = synthesizeResponse(text, deduction, null, { score: 70, dataCompleteness: 50, ruleSoundness: 70, verifiability: 50, uncertaintyFactors: [] }, { sources: [], summary: '', dataGaps: [] }, false, nluIntent, emotionSummaryForDeep);
          logger.info('[Debug] reply 内容:', reply);

          // 存入数据库
          if (conversationId) {
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'user', content: storedUserContent, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
            addMessage({ userId: uid, agentId: conversationAgentId, conversationId, role: 'assistant', content: reply, personality: personality.id, domain: resolvedDomain, orgId: resolvedOrgId });
          }
          try {
            const db = readDB();
            db.interactions.push({
              id: `deep_${Date.now()}`,
              userId: uid,
              agentId: agentId || '',
              conversationId: conversationId || '',
              content: storedUserContent,
              response: reply,
              role: 'user',
              personality: personality.id,
              timestamp: new Date().toISOString(),
              cognitiveIntent: 'deep_reasoning',
              llmWasCalled: false,
              domain: resolvedDomain,
              orgId: resolvedOrgId,
            });
            writeDB(db);
          } catch {}

          logger.info('[Debug] 准备发送 agent:response，reply 长度:', reply?.length);
          logger.info('[Debug] socket.connected:', socket.connected);

          socket.emit('agent:response', {
            text: reply,
            agentName: personality.name,
            source: 'deep_reasoning',
            requestId: requestId || undefined,
            metadata: {
              confidence: 70,
              llmCalls: 0,
              degraded: false,
              domain: 'self_state',
              framework: '自身状态判断',
            },
          });
          logger.info('[ChatHandler] 自身状态回复完成');
        } catch (e: any) {
          logger.error('[ChatHandler] 深度推理失败:', e.message);
          socket.emit('agent:response', {
            text: '这个问题有点复杂，我需要想想… 要不换个角度再问一次？',
            agentName: personality.name,
            source: 'deep_reasoning_degraded',
            requestId: requestId || undefined,
          });
        }
        // ── 【新增数字生命体模块】对话后置异步复盘（deep_reasoning 路径） ──
        if (reply) {
          import('../hooks/review.js').then(({ performPostChatReview }) => {
            performPostChatReview({
              uid, text, response: reply, sessionKey,
              conversationId, domain: resolvedDomain, orgId: resolvedOrgId,
              personality: { name: personality?.name || 'Peppa', vector: [] },
              emotion: { emotions: [], dominant: '' },
              source: 'deep_reasoning',
            }).catch(e => logger.warn('[ChatHandler] 异步复盘异常:', e?.message || e));
          }).catch(() => {});
        }
        chatSessionMap.delete(sessionKey);
        return;
      }

      // ── Peppa Cognitive Engine: classify intent BEFORE calling any LLM ──
      // 路由已判定为 instinct/tool → 跳过认知引擎（节省 Token）
      const skipCognition = route.layer === 'instinct' || route.layer === 'tool';
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
          { provider: activeProvider, model: activeProvider === 'deepseek' ? 'deepseek-v4-flash' : activeModel, userId: uid, maxTokens: 60, domain: resolvedDomain, orgId: resolvedOrgId },
          llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
          llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
        );
        return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
      };

      const cognition = skipCognition
        ? { intent: { category: route.layer === 'tool' ? 'command' : 'conversation', confidence: 1, entities: {}, needsLLM: true, subIntent: '', directToolCall: undefined }, directToolExecuted: false, responseText: '' } as any
        : await processInput(text, cognitiveCtx, llmClassifier);
      logger.info('[ChatHandler] cognition result:', cognition.intent.category, 'directToolExecuted:', cognition.directToolExecuted, 'responseText:', (cognition.responseText || '').slice(0, 100));

      // ── Sentiment analysis: detect emotional charge in user input ──
      const sentiment = extractSentiment(text);
      if (sentiment.valence !== 0 || sentiment.urgency > 0 || sentiment.frustration > 0) {
        logger.info('[ChatHandler] sentiment:', sentiment);
      }

      // ── Focus Stack: 话题切换检测 ──
      const focusResult = await detectAndSwitchTopic(text, {
        getDeepSeek: llmGetters.getDeepSeek,
        getGemini: llmGetters.getGemini,
      });
      if (focusResult.switched) {
        logger.info('[ChatHandler] focusStack switch:', focusResult.previousTopic, '→', focusResult.currentTopic);
      }

      // Auto-select model: flash for simple chat, pro for complex tasks
      const complexCategories = ['command', 'code', 'question', 'analysis'];
      const isComplex = complexCategories.includes(cognition.intent.category);
      if (activeProvider === 'deepseek') {
        activeModel = isComplex ? 'deepseek-v4-pro' : (activeModel === 'deepseek-chat' ? 'deepseek-v4-flash' : activeModel);
      } else if (activeProvider === 'qwen') {
        activeModel = isComplex ? 'qwen-max' : 'qwen-plus';
      } else if (activeProvider === 'gemini') {
        activeModel = isComplex ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
      } else if (activeProvider === 'openai') {
        activeModel = isComplex ? 'gpt-4o' : 'gpt-4o-mini';
      }
      logger.info('[ChatHandler] Model auto-selected:', activeProvider, '/', activeModel, 'for category:', cognition.intent.category);

      let responseText = '';
      let llmWasCalled = false;
      const allToolRecords: ToolExecutionRecord[] = [];
      const deferCompletionStream = needsCompletionEvidence(text);
      const prefersSequentialWorkflow =
        shouldChainTask(text) &&
        workSurfaceRoute.artifactFirst &&
        !workSurfaceRoute.directDesktop;
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

      if (cognition.directToolExecuted && cognition.responseText) {
        // Path A: Peppa handled this directly — no LLM needed
        responseText = cognition.responseText;
        logger.info(`[Cognition] Direct tool '${cognition.intent.directToolCall?.name}' handled without LLM`);
      }

      // Path A2: music intent. Handle before the generic tool loop so Peppa
      // does not wander into unrelated tools or report raw provider errors.
      const isMusicAdjustment = isMusicAdjustmentRequest(text);
      if (!responseText && (isMusicPlaybackRequest(text) || isMusicAdjustment)) {
        try {
          const result = isMusicAdjustment
            ? await adjustMusicPlayback(uid, socket, text)
            : await searchAndPlay(uid, socket, text);
          if (result.success && result.text) {
            responseText = result.text;
            llmWasCalled = true;
          } else {
            responseText = getMusicFailureMessage(result.reason);
            socket.emit('music:error', { message: responseText });
          }
        } catch (musicErr: any) {
          logger.warn('[Music Intent] Failed:', musicErr.message);
          responseText = getMusicFailureMessage(musicErr?.message);
          socket.emit('music:error', { message: responseText });
        }
      }

      if (!responseText) {
        const delegationDecision = shouldDelegateWorkInBackground({
          text,
          source: eventSource,
          category: cognition.intent.category,
          complexity: backgroundComplexity,
          allowToolUse: allowToolUseForTurn,
          clientActionOnly: clientActionOnlyTurn,
          selfRepair: selfRepairTurn,
          sanctuary: isSanctuary,
          directDesktop: workSurfaceRoute.directDesktop,
          prefersSequentialWorkflow,
          availableAgentCount: availableWorkerAgents.length,
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
                const db = readDB();
                db.interactions.push({
                  id: `bg-${interactionId}`,
                  userId: uid,
                  agentId: agentId || '',
                  conversationId: conversationId || '',
                  content: `Background delegated task: ${storedUserContent}`,
                  response: content,
                  role: 'agent',
                  personality: personality.id,
                  timestamp: new Date().toISOString(),
                  mode: 'background_delegation',
                  cognitiveIntent: cognition.intent.category,
                  llmWasCalled: true,
                  domain: resolvedDomain,
                  orgId: resolvedOrgId,
                } as any);
                writeDB(db);
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

      if (!responseText && !prefersSequentialWorkflow && allowToolUseForTurn && !clientActionOnlyTurn && !selfRepairTurn && !isSanctuary && (cognition.intent.category === 'command' || cognition.intent.category === 'code' || cognition.intent.category === 'question')) {
        // Path B: Orchestrator — decompose tasks into sub-tasks for worker agents
        // (Skipped for sanctuary agents — they stay in their territory)
        try {
          emitAgent("agent:status", { status: "thinking", agentName: exposeAgentWork ? "Peppa Orchestrator" : personality.name, phase: exposeAgentWork ? 'orchestrator' : 'background' });
          const orchResult = await runOrchestratedTask(
            text,
            { userId: uid, personalityId, domain: resolvedDomain, orgId: resolvedOrgId, desktopRelay },
            { provider: activeProvider, model: activeModel },
            llmGetters,
            exposeAgentWork ? (msg) => emitAgent("agent:chunk", { text: msg, agentName: "Peppa" }) : undefined,
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
          }
        } catch (orchErr: any) {
          logger.error('[Orchestrator] Workflow failed, falling back to normal chat:', orchErr.message);
        }
      }

      // Path B2: NL Task Chainer — for office workflows that chain tools (search→read→create etc.)
      if (!responseText && allowToolUseForTurn && !clientActionOnlyTurn && !selfRepairTurn && shouldChainTask(text)) {
        // Pre-flight: auto-install any matching uninstalled/outdated skills
        await autoInstallForTask(text, { emit: (event, data) => socket.emit(event, data) });

        try {
          emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'background' });
          const chainerResult = await runNLChainer(
            text,
            {
              userId: uid,
              provider: activeProvider,
              model: activeModel,
              desktopRelay,
              context: { isCancelled: () => abortController.signal.aborted, toolPolicy: routedToolPolicy || personality.toolPolicy },
              onTool: (record) => {
                allToolRecords.push(record);
                const payload: Record<string, any> = {
                  correlationId: record.id,
                  toolCallId: record.id,
                  name: record.name,
                  arguments: record.arguments,
                  args: record.arguments,
                };
                if (record.result !== '') payload.result = formatToolResultForUi(record.result);
                if (record.error !== undefined) payload.error = record.error;
                emitAgent("agent:tool_call", payload);
                emitAgent("agent:tool", payload);
              },
            },
            llmGetters,
            (step, total, desc) => {
              emitAgent("agent:status", { status: "thinking", agentName: personality.name, phase: 'background', detail: `Step ${step}/${total}: ${desc}` });
            },
          );
          if (chainerResult.finalResponse) {
            responseText = chainerResult.finalResponse;
            llmWasCalled = true;
            logger.info('[NLChainer] Completed with', chainerResult.stepResults.length, 'steps. Goal:', chainerResult.plan.goal);
          }
        } catch (chainErr: any) {
          logger.error('[NLChainer] Failed, falling back to normal chat:', chainErr.message);
        }
      }

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

        // ── 【新增数字生命体模块】cognitive LLM 主链路：7步心智 + 情绪人格 + 场景判定 ──
        let cognitiveToolDisabled = false;
        try {
          const em = getEmotionEngine();
          const pe = getPersonalityEngine();
          const dirState = getDirectionState();
          const compState = getComprehensionState();
          const cogToolIntent = classifyToolIntent(text);
          cognitiveToolDisabled = cogToolIntent === 'nostalgic';

          const cogMind = buildMindContext(
            em.getEmotions(),
            pe.getPersonality(),
            dirState.getInclination(),
            dirState.getIntensity(),
            compState.overall,
          );
          cogMind.toolIntent = cogToolIntent;
          cogMind.shouldDisableTools = cognitiveToolDisabled;

          // 注入7步心智 + 情绪状态到 System Prompt
          const cognitiveOverlay = cogMind.mindSystemPrompt + '\n\n' + cogMind.emotionStatePrompt;
          effectiveSystemPrompt = cognitiveOverlay + '\n\n' + effectiveSystemPrompt;

          if (cognitiveToolDisabled) {
            effectiveSystemPrompt += '\n\n【重要】本轮对话属于情感陪伴场景，请勿调用任何工具。用纯共情的方式温柔回应。';
            mcpInterceptor.recordCall(sessionKey, 'blocked_nostalgic_cognitive');
          }

          logger.info(`【新增数字生命体-LLM认知链路】toolIntent=${cogToolIntent} disableTools=${cognitiveToolDisabled} emotion=${em.summarize()}`);
        } catch (e) {
          logger.warn('【新增数字生命体-LLM认知链路】心智注入异常:', e);
        }

        const messages: NormalizedMessage[] = [
          { role: 'system', content: effectiveSystemPrompt + selfAwareness },
          ...conversationHistory,
          { role: 'user', content: text },
        ];

        try {
          const toolNamesForLLM = toolRegistry.getToolDeclarations().map((d: any) => d.function?.name || d.name || '').filter(Boolean);
          logger.info('[ChatHandler] Calling Path C with provider:', activeProvider, 'model:', activeModel, 'tools:', allowToolUseForTurn && !isSanctuary ? 'enabled' : 'off', 'available:', toolNamesForLLM.length, 'sample:', toolNamesForLLM.slice(0, 8).join(','));
          const streamChunks: string[] = [];
          const onChunk: StreamCallback = (chunk) => {
            streamChunks.push(chunk);
            if (!deferCompletionStream) {
              emitAgent("agent:chunk", { text: chunk, agentName: personality.name });
            }
          };

          // Sanctuary agents get zero tool access — they can only talk
          if (!allowToolUseForTurn || isSanctuary) {
            const response = await makeLLMCallStreaming(
              messages,
              [],
              { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal },
              onChunk,
              llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
              llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
            );

            responseText = response.text || streamChunks.join('') || '';
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
          } else {
            // ── T80: MCP 拦截器检查 ──
            const toolAllowed = mcpInterceptor.canCallTool(sessionKey);
            if (!toolAllowed) {
              logger.info(`[ChatHandler] T80 MCP阻断: 本轮已达上限 (${mcpInterceptor.getCallCount(sessionKey)}/${1})`);
            }

            const maxIterations = routedToolPolicy?.maxIterations || personality.toolPolicy.maxIterations || 25;

          // Collect tool calls for persistence

          let result: any;
          try {
          result = await runWithTools(
            messages,
            toolRegistry,
            { provider: activeProvider, model: activeModel, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId },
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
              ...(operationMode === 'assistant' || operationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? {
                requestConfirmation: async (toolName: string, args: Record<string, any>): Promise<boolean> => {
                  return new Promise((resolve) => {
                    const cid = crypto.randomUUID();
                    const timeout = setTimeout(() => resolve(false), 30000);
                    socket.once(`tool:confirm_result:${cid}`, (data: { allowed: boolean }) => {
                      clearTimeout(timeout);
                      resolve(data.allowed === true);
                    });
                    socket.emit('agent:confirm_tool', { correlationId: cid, name: toolName, arguments: args });
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
          } catch (toolErr: any) {
            logger.error('[ChatHandler] Tool execution failed:', toolErr.message);
            socket.emit('agent:error', {
              message: toolErr.message || '工具执行失败',
              requestId: requestId || '',
            });
            return;
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
                  messages,
                  [],
                  { provider: 'gemini', model: DEFAULT_MODELS.gemini, userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, signal: abortController.signal },
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
                messages, toolRegistry,
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
                    if (isDirectDesktopTool(call.name)) return;
                    emitToolLifecycle({
                      correlationId: call.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      name: call.name,
                      arguments: call.arguments,
                    });
                  },
                  ...(routedToolPolicy ? { toolPolicy: routedToolPolicy } : {}),
                  ...(operationMode === 'assistant' || operationMode === 'autonomous' || clientActionOnlyTurn || selfRepairTurn ? {
                    requestConfirmation: async (toolName: string, args: Record<string, any>): Promise<boolean> => {
                      return new Promise((resolve) => {
                        const cid = crypto.randomUUID();
                        const timeout = setTimeout(() => resolve(false), 30000);
                        socket.once(`tool:confirm_result:${cid}`, (data: { allowed: boolean }) => {
                          clearTimeout(timeout);
                          resolve(data.allowed === true);
                        });
                        socket.emit('agent:confirm_tool', { correlationId: cid, name: toolName, arguments: args });
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
              for (const u of fallback.usageRecords) {
                recordTokenUsage(uid, u.provider, u.model, { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens }, interactionId);
              }
              }
            } catch (fallbackErr: any) {
              // Both primary and fallback LLMs failed — use cognitive fallback
              const cf = handleLLMFailure(cognition.intent, fallbackErr);
              responseText = cf.responseText;
            }
          } else {
            // LLM failed for other reasons — use cognitive fallback
            const cf = handleLLMFailure(cognition.intent, llmErr);
            responseText = cf.responseText;
          }
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

      // Log interaction
      const db = readDB();
      db.interactions.push({
        id: interactionId, userId: uid, agentId: agentId || '',
        conversationId: conversationId || '', content: storedUserContent, response: responseText,
        role: "user", personality: personality.id, timestamp: new Date().toISOString(),
        cognitiveIntent: cognition.intent.category,
        llmWasCalled,
        domain: resolvedDomain,
        orgId: resolvedOrgId,
      });
      writeDB(db);

      // Emit response BEFORE conversation_updated so the client finalizes streaming first
      emitAgent("agent:progress", { stage: 'finalizing', message: '正在整理结果…' });
      emitAgent("agent:response", { text: responseText, agentName: personality.name });
      // Re-emit conversation_updated AFTER response so the client syncs from API with complete data
      if (conversationId) {
        socket.emit('chat:conversation_updated', { conversationId, agentId: conversationAgentId, source: 'chat' });
      }
      emitAgent("agent:status", { status: "idle" });

      // ── 注入交互事件到数字生命体 ──
      try {
        // 主入口：LifeSystem.receiveInteraction('user_initiated') 处理信任/人格/情绪/活力/欲望
        await getLifeSystem().receiveInteraction('user_initiated', 'accepted');
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

      // ── 【新增数字生命体模块】对话后置异步复盘（主路径，fire-and-forget） ──
      if (responseText) {
        // 捕获复盘时的实时情绪/人格快照
        const reviewEmotion = (() => { try { return getEmotionEngine().getEmotions(); } catch { return [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]; } })();
        const reviewPersonality = (() => { try { return getPersonalityEngine().getPersonality(); } catch { return [0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]; } })();
        const reviewDominant = (() => {
          const labels = ['喜悦','平静','期待','担忧','孤独','满足','好奇','依赖'];
          let maxI = 0; for (let i=1;i<8;i++) if (reviewEmotion[i]>reviewEmotion[maxI]) maxI=i;
          return labels[maxI]||'平静';
        })();
        import('../hooks/review.js').then(({ performPostChatReview }) => {
          performPostChatReview({
            uid, text, response: responseText, sessionKey,
            conversationId, domain: resolvedDomain, orgId: resolvedOrgId,
            personality: { name: personality?.name || 'Peppa', vector: reviewPersonality },
            emotion: { emotions: reviewEmotion, dominant: reviewDominant },
            source: 'chat',
          }).catch(e => logger.warn('[ChatHandler] 异步复盘异常:', e?.message || e));
        }).catch(() => {});
      }

      // Clean up abort session
      chatSessionMap.delete(sessionKey);

      // Auto-learn from corrections: when user corrects Peppa, extract high-confidence memories
      const correctionPatterns = [/不是/, /不对/, /错了/, /wrong/i, /incorrect/i, /actually/i, /no,?\s/i, /你弄错了/, /不是这样的/];
      const isCorrection = correctionPatterns.some(p => p.test(text));
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
              { provider: 'deepseek', model: 'deepseek-v4-flash', userId: uid, domain: resolvedDomain, orgId: resolvedOrgId, maxTokens: 300 },
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
          addMemory({
            userId: uid, type: mem.type, content: mem.content,
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

      // Update emotional state — reconnect if user was away for a while
      const hoursSinceLast = emotionalState.lastInteractionAt
        ? (Date.now() - new Date(emotionalState.lastInteractionAt).getTime()) / (1000 * 60 * 60)
        : 24;
      const isReconnect = hoursSinceLast > 1;
      let updatedState = updateEmotionalState(emotionalState, { type: 'interaction', userId: uid, timestamp: new Date().toISOString() });
      // Apply sentiment analysis results to emotional state
      if (sentiment.valence !== 0 || sentiment.frustration > 0 || sentiment.urgency > 0) {
        updatedState = updateEmotionalState(updatedState, { type: 'sentiment_analysis', sentiment, userId: uid, timestamp: new Date().toISOString() });
      }
      if (isReconnect) {
        updatedState = updateEmotionalState(updatedState, { type: 'reconnect', intensity: Math.min(1, hoursSinceLast / 72), userId: uid, timestamp: new Date().toISOString() });
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
      if (!isSanctuary && isReconnect && updatedState.intimacy > 0.2) {
        const greeting = generateContextualGreeting(updatedState, uid);
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
      logger.error("[Socket Agent Error]:", error);
      emitAgent("agent:error", { message: error.message });
      emitAgent("agent:status", { status: "error" });
    } finally {
      clearTimeout(llmTimeout);
      getLifeSystem().resume();
      chatSessionMap.delete(sessionKey);
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
      { provider: provider as any, model, maxTokens: 300, userId, domain, orgId },
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



