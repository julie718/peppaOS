/**
 * Voice / Audio Pipeline — STT → LLM → TTS real-time handlers
 * v2.1 — Multi-turn tool iteration, hands/mouth separation, input queue
 */
import { Socket } from "socket.io";
import { logger } from '../lib/logger';
import { readDB, writeDB } from "../../db_layer";
import { NormalizedMessage, makeLLMCallStreaming, makeLLMCall } from "../llm/providers";
import { compactToolResultForModel } from "../llm/adapter";
import { toolRegistry } from "../tools/registry";
import { ToolExecutionRecord } from "../tools/types";
import { personalityRegistry } from "../personality";
import { loadEmotionalState, updateEmotionalState, saveEmotionalState, loadHIMState, saveHIMState } from "../personality/state";
import { himTick } from "../personality/him";
import { createStreamingSession, getActiveSTTProvider } from "../stt/adapter";
import { synthesizeSpeech, mapStateToVoiceParams, resolveEmotionVoice, resolveVoiceTtsProvider } from "../tts/adapter";
import { getDirectionState } from "../life/index";
import { getRelationshipEngine } from "../life/relationship";
import { recordLatency } from "../monitor/latency_store";
import { getOrCreateActiveConversation, addMessage, getMessagesByTokenBudget, extractTopics, trackTopic, getTopicContext, getConversationSummary } from "../conversation/manager";
import { processInput, CognitiveContext, extractSentiment } from "../cognition";
import { runOrchestratedTask, classifyComplexity, type LlmGetters } from "../agents/orchestrator";
import { queryMemories, addMemory } from "../memory/store";
import { recordTokenUsage } from "../llm/token_tracker";
import { DEFAULT_MODELS, COMPLEX_MODELS, getScopedPreferredLLM, getUserPreferredLLMConfig } from "../llm/user_preferences";
// 【重构·模块4】语音唤醒问候回退由心智润色组成
import { composeTriggerContent } from '../proactive/rhythm';
import { getOperationModeConfig, parseStoredOperationMode, OperationMode } from "../cognition/operation_modes";
import { updatePresence } from "../biometrics/presence";
import { getVoiceprints } from "../biometrics/store";
import { formatClientSelfPrompt } from "../client/self_model";
import { getIdleState } from "../context/activity_stream";
import { adjustMusicPlayback, getMusicFailureMessage, isMusicAdjustmentRequest, isMusicPlaybackRequest, searchAndPlay } from "../music/search_play";
import { analyzeLikedMusicProfile, formatMusicProfileReport } from "../music/library_profile";
import { guardCompletionClaims, needsCompletionEvidence } from "../work_product/completion_guard";
import { buildVisionRoutingOverlay, hasVisionIntent } from "../cognition/vision_routing";

interface AudioSession {
  sttSession: ReturnType<typeof createStreamingSession> | null;
  isActive: boolean;
  ttsAbortController: AbortController | null;
  currentVoiceId: string | null;
  currentVoiceProvider: string | null;
  personalityId: string;
  userId: string;
  agentId: string;
  domain: 'personal' | 'work';
  orgId: string;
  accumulatedText: string;
  /** TTS is actively playing audio — user can barge-in */
  isSpeaking: boolean;
  /** Tool iteration loop is running — new input is queued, not dropped */
  isProcessing: boolean;
  /** True during orchestrator multi-agent execution — status checks get quick ack */
  isOrchestrating: boolean;
  /** AbortController for the full LLM+tool pipeline — aborted on barge-in */
  pipelineAbortController: AbortController | null;
  /** Queue of pending utterances while isProcessing=true */
  inputQueue: string[];
  /** True when background agent is executing tools (barge-in requires wake word) */
  isBackgroundWork: boolean;
  /** Incremented on each new command — only latest generation gets TTS output */
  bgGeneration: number;
  /** Timestamp of last audio chunk for STT latency measurement */
  lastChunkTime: number;
  /** Timer to auto-close STT session after prolonged silence (5min) */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Tracked TTS decay timers — cleared on stop/disconnect to prevent post-session mutations */
  ttsDecayTimers: ReturnType<typeof setTimeout>[];
  /** Barge-in confirmation delay timer — cleared on stop/disconnect */
  bargeinTimer: ReturnType<typeof setTimeout> | null;
  /** Voiceprint verification: true when owner's voice is recognized */
  voiceprintMatched: boolean;
  voiceprintConfidence: number;
  voiceprintRequired: boolean;
  voiceprintLastAt: number;
  /** Meeting mode: STT only, no LLM/TTS/tool processing. */
  transcriptionOnly: boolean;
  /** 数字生命体·语音模块（阶段三）: 最近一次有效用户语音（非回声/非噪声）transcript 时间戳 */
  lastTranscriptAt: number;
}

// Module-level ambient noise tracking — used by both processVoiceInput and registerVoiceHandlers
let ambientRms = 0;
let ambientRmsLastUpdate = 0;

// ── 环境音分类与温馨提示（数字生命体·语音模块·阶段三）──
// 前端每 5s 心跳上报 rms/isSpeaking/callState；后端无法拿原始音频（前端本地处理），
// 用启发式分类：Peppa 发声 → speech；rms 持续高且期间无用户语音 → environment；其余 → quiet。
const AMBIENT_WINDOW_SIZE = 6; // 6 次心跳 × 5s ≈ 30s 持续噪音才算环境音
const AMBIENT_NOISE_THRESHOLD = 0.35; // rms 阈值
const AMBIENT_TIP_COOLDOWN_MS = 30 * 60 * 1000; // 温馨提示冷却：30 分钟最多 1 次
const ambientWindow = new Map<string, number[]>(); // socketId → 最近 rms 采样窗口
const ambientTipCooldown = new Map<string, number>(); // socketId → 上次提示时间戳

/** 环境音分类：speech（Peppa 发声/回声）/ environment（持续噪音）/ quiet（安静） */
function classifyAmbient(data: { rms: number; isSpeaking: boolean }): 'speech' | 'environment' | 'quiet' {
  if (data.isSpeaking) return 'speech';
  if (data.rms >= AMBIENT_NOISE_THRESHOLD) return 'environment';
  return 'quiet';
}

/** 持续环境噪音 → 有节制的温馨提示（感知但不打扰：仅环境音样本累计 + 夜间/忙时抑制 + 30min 冷却 + 用户说话时不提示） */
function maybeEnvironmentTip(socket: Socket, session: AudioSession, data: { rms: number; isSpeaking: boolean }): void {
  try {
    const sid = socket.id;
    // 只有"环境音"分类的样本进入滑动窗口 — speech（Peppa 发声）与 quiet 会清空窗口（噪音不连续 = 非环境音场景）
    if (classifyAmbient(data) !== 'environment') {
      ambientWindow.delete(sid);
      return;
    }
    const win = ambientWindow.get(sid) || [];
    win.push(data.rms);
    if (win.length > AMBIENT_WINDOW_SIZE) win.shift();
    ambientWindow.set(sid, win);
    if (win.length < AMBIENT_WINDOW_SIZE) return; // 持续噪音未满 ~30s，还不到提示时机

    // 冷却检查（30min）
    const lastTip = ambientTipCooldown.get(sid) || 0;
    if (Date.now() - lastTip < AMBIENT_TIP_COOLDOWN_MS) return;

    // 窗口期间有用户语音（STT transcript）→ 不是环境噪音场景，不提示
    if (session.lastTranscriptAt && Date.now() - session.lastTranscriptAt < 25000) return;

    // 夜间/凌晨不打扰
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 7) return;

    // 触发
    ambientTipCooldown.set(sid, Date.now());
    ambientWindow.delete(sid);
    logger.info(`[Voice] 环境音分类=environment 持续噪音≥30s rms=${data.rms.toFixed(2)} → 温馨提示`);
    socket.emit("agent:response", { text: '周围的声音有点杂，我帮你留意着。需要我做什么的话，随时说。', source: 'environment' });
  } catch {}
}

// TTS playback flag — shared with wake detector to suppress echo during speech
let ttsSpeakingCount = 0;
export function isTtsPlaying(): boolean { return ttsSpeakingCount > 0; }

// ── Module-level TTS echo tracker (shared with wake detector) ──

/** Simple character-overlap ratio for echo detection. > 0.5 = likely echo. */
function charOverlap(a: string, b: string): number {
  const an = a.replace(/\s/g, '').toLowerCase();
  const bn = b.replace(/\s/g, '').toLowerCase();
  if (!an || !bn) return 0;
  const setA = new Set(an);
  const setB = new Set(bn);
  let overlap = 0;
  for (const c of setA) { if (setB.has(c)) overlap++; }
  return overlap / Math.max(setA.size, setB.size);
}

const MAX_ECHO_ENTRIES = 50;
const recentTtsTexts: { text: string; until: number }[] = [];

/** Record a TTS sentence for echo cancellation (shared with wake detector). */
export function addEchoText(text: string): void {
  recentTtsTexts.push({ text, until: Date.now() + 10000 });
  if (recentTtsTexts.length > MAX_ECHO_ENTRIES) recentTtsTexts.shift();
}

/** Check if a transcript matches recent TTS output (speaker → mic echo). */
export function isEchoText(transcript: string): boolean {
  const now = Date.now();
  // Purge stale entries
  for (let i = recentTtsTexts.length - 1; i >= 0; i--) {
    if (recentTtsTexts[i].until <= now) recentTtsTexts.splice(i, 1);
  }
  if (recentTtsTexts.length === 0) return false;
  const tNorm = transcript.replace(/\s/g, '').toLowerCase();
  if (tNorm.length < 2) return true;
  for (const r of recentTtsTexts) {
    if (r.text.includes(transcript) || transcript.includes(r.text)) return true;
    if (charOverlap(transcript, r.text) > 0.5) return true;
  }
  return false;
}

function normalizeSpeechText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[。！？.!?，,、；;：:“”"'‘’（）()\[\]【】~～]/g, '')
    .toLowerCase();
}

function isExplicitInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  if (!normalized) return false;
  return /^(停|停下|停止|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|stop|wait|pause|interrupt|holdon|shutup)$/.test(normalized)
    || /^(停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样)$/.test(normalized)
    || /(停一下|先停|别说了|不要说了|打断一下|等我一下|暂停一下|不用说了|别讲了|stop|hold on|wait a second|pause)/i.test(text);
}

function isPureInterruptCommand(text: string): boolean {
  const normalized = normalizeSpeechText(text);
  return /^(停|停下|停止|打断|闭嘴|别说|不要说|先别说|别讲|不要讲|等下|等一下|暂停|好了|行了|够了|停一下|停一停|先停|先停一下|别说了|不要说了|先别说了|别讲了|不要讲了|打断一下|等我一下|暂停一下|可以了|不用说了|先这样|stop|wait|pause|interrupt|holdon|shutup)$/.test(normalized);
}

// 【重构·模块1】删除模式切换/工作升级的正则前置分流：
// - detectVoiceClientModeSwitch/isPureModeSwitchRequest（"切换到XX模式"正则池）→ 由心智内核调用
//   client_action 工具自主完成模式切换（工具自描述驱动，无静态绑定）
// - shouldAutoPromoteVoiceWork（chat→assistant 升级正则）→ 工具决策统一由心智 + 模式配置策略承担

function cancelActiveVoiceTurn(session: AudioSession): void {
  session.bgGeneration++;
  session.isSpeaking = false;
  session.isProcessing = false;
  session.isOrchestrating = false;
  session.inputQueue = [];
  session.accumulatedText = '';
  if (session.bargeinTimer) {
    clearTimeout(session.bargeinTimer);
    session.bargeinTimer = null;
  }
  if (session.ttsAbortController) {
    session.ttsAbortController.abort();
    session.ttsAbortController = null;
  }
  if (session.pipelineAbortController) {
    session.pipelineAbortController.abort();
    session.pipelineAbortController = null;
  }
  const pendingDecayCount = session.ttsDecayTimers.length;
  for (const t of session.ttsDecayTimers) clearTimeout(t);
  session.ttsDecayTimers = [];
  if (pendingDecayCount > 0) {
    ttsSpeakingCount = Math.max(0, ttsSpeakingCount - pendingDecayCount);
  }
}

function normalizeVoiceHistoryRecord(m: any): NormalizedMessage[] {
  if (m?.role === 'tool' || m?.mode === 'proactive') return [];
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : '';
  if (!role) return [];
  const message = typeof m?.message === 'string' ? m.message.trim() : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const entries: NormalizedMessage[] = [];
  if (message) entries.push({ role, content: message });
  if (response && role === 'user') entries.push({ role: 'assistant', content: response });
  return entries;
}

function buildVoiceReplyStyleOverlay(): string {
  return [
    '\n\n## Spoken Reply Style',
    '- Never speak hidden reasoning, chain-of-thought, private deliberation, or phrases like “我得想想 / 我需要分析 / 好的，毛先生这是在…”.',
    '- Say the final answer only.',
    '- Default to one short sentence. For simple confirmations, use 2-6 Chinese characters.',
    '- If the user interrupts or says you are verbose, stop immediately and do not explain.',
  ].join('\n');
}

function getAmbientNoise(): number | null {
  if (Date.now() - ambientRmsLastUpdate > 15000) return null; // stale
  return ambientRms;
}

function computeVolumeGain(): number {
  let gain = 1.0;
  const noise = getAmbientNoise();
  if (noise !== null) {
    if (noise > 0.15) gain = 1.2;
    else if (noise > 0.08) gain = 1.1;
    else if (noise < 0.02) gain = 0.85;
  }
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 7) gain = Math.min(gain, 0.8);
  else if (hour >= 7 && hour < 9) gain = Math.min(gain, 0.9);
  return Math.max(0.5, Math.min(1.3, gain));
}

function getAudioSession(socket: Socket): AudioSession {
  if (!socket.data.audioSession) {
    socket.data.audioSession = {
      sttSession: null,
      isActive: false,
      ttsAbortController: null,
      currentVoiceId: null,
      currentVoiceProvider: null,
      personalityId: 'peppa',
      accumulatedText: '',
      isSpeaking: false,
      isProcessing: false,
      isBackgroundWork: false,
      bgGeneration: 0,
      pipelineAbortController: null,
      inputQueue: [],
      lastChunkTime: 0,
      silenceTimer: null,
      ttsDecayTimers: [],
      bargeinTimer: null,
      userId: '',
      agentId: 'peppa',
      domain: 'personal',
      orgId: '',
      voiceprintMatched: true,  // default: allow (no voiceprints enrolled yet)
      voiceprintConfidence: 0,
      voiceprintRequired: false,
      voiceprintLastAt: 0,
      transcriptionOnly: false,
      lastTranscriptAt: 0,
    };
  }
  return socket.data.audioSession as AudioSession;
}

function isVoiceprintGateOpen(session: AudioSession): boolean {
  if (!session.voiceprintRequired) return true;
  const fresh = Date.now() - session.voiceprintLastAt < 3500;
  return fresh && session.voiceprintMatched && session.voiceprintConfidence >= 0.68;
}

function blockUnverifiedVoice(socket: Socket, session: AudioSession, reason: string): void {
  logger.info(`[Voiceprint] ${reason} (required=${session.voiceprintRequired}, matched=${session.voiceprintMatched}, conf=${session.voiceprintConfidence.toFixed(2)})`);
  session.isSpeaking = false;
  session.isProcessing = false;
  session.accumulatedText = '';
  socket.emit('audio:status', { status: 'listening' });
}

async function processVoiceInput(
  socket: Socket,
  session: AudioSession,
  userText: string,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
): Promise<void> {
  if (!isVoiceprintGateOpen(session)) {
    blockUnverifiedVoice(socket, session, 'Rejected voice command from unverified speaker');
    return;
  }

  // ── Voiceprint gate: ignore speech from unrecognized speakers ──
  // Only active when voiceprints are enrolled for this user AND at least one
  // recent voiceprint:result has been received with confidence data.
  if (session.voiceprintRequired && session.voiceprintMatched === false && session.voiceprintConfidence > 0) {
    logger.info(`[Voiceprint] Stranger voice detected (conf=${session.voiceprintConfidence.toFixed(2)}) — ignoring`);
    session.isSpeaking = false;
    session.isProcessing = false;
    session.accumulatedText = '';
    socket.emit('audio:status', { status: 'idle' });
    // Send a silent response so the UI doesn't hang in "thinking" state
    socket.emit('agent:response', { text: '' });
    return;
  }

  session.isSpeaking = false;
  session.isProcessing = true;
  session.pipelineAbortController = new AbortController();
  socket.emit("agent:status", { status: "thinking", agentName: "Peppa" });
  session.ttsAbortController = new AbortController();
  socket.emit("audio:status", { status: "thinking" });
  const voiceScope = { domain: session.domain, orgId: session.orgId };

  // Cross-session memory retrieval — voice now has access to what was discussed before
  let voiceMemories: any[] = [];
  try {
    voiceMemories = queryMemories({
      userId: session.userId,
      query: userText,
      limit: 5,
      minConfidence: 0.4,
      domain: voiceScope.domain,
      orgId: voiceScope.orgId,
    });
  } catch {}

  const sensoryAudio = sensoryFn(socket.id);
  const { config: personality, systemPrompt: fullPersonalityPrompt } = personalityRegistry.buildSystemPrompt(
    session.personalityId || 'peppa',
    { mode: 'task', sensory: sensoryAudio, uiContext: 'voice' },
    {
      userId: session.userId,
      memories: voiceMemories.length > 0 ? voiceMemories : undefined,
      userText,
    },
  );

  // ── Unified personality prompt + voice-specific overlay ──
  // Same core prompt as text chat — one Peppa, one framework.
  const toolVoiceOverlay = [
    '\n## Voice Mode',
    '- You are SPEAKING, not typing. Be conversational and natural, like talking to a friend.',
    '- Keep spoken responses concise — the user is listening, not reading.',
    '',
    '## Your Tools — Use Them, Don\'t Just Talk About Them',
    '- **web_search** — Search the internet for real-time information, facts, and data.',
    '- **url_fetch** — Read and extract content from any URL/webpage.',
    '- **desktop_open** — Open apps, files, folders, URLs on the user\'s computer.',
    '- **desktop_run_command** — Execute shell commands (cmd /C on Windows) for system operations.',
    '- **desktop_list_files** — Browse files and folders on the desktop.',
    '- **read_file / write_file** — Read existing files or create new ones.',
    '- **create_ppt** — Generate professional PowerPoint presentations. Provide images array for visuals.',
    '- **generate_image** — Create AI-generated images (provide local file paths as slide images).',
    '- **run_workflow** — Execute previously saved multi-step workflows.',
    '',
    '## CRITICAL: You MUST Call Tools to Do Real Work',
    '- When the user asks you to CREATE, SEARCH, OPEN, or DO anything: CALL THE TOOL.',
    '- Saying "好的" or "我帮你做" without calling the tool = the user gets NOTHING. This is a FAILURE.',
    '- **Narrate WHILE acting.** Say "正在搜索..." as you call web_search. Say "正在生成PPT..." as you call create_ppt.',
    '- Only when all tool actions are complete should you summarize the results.',
  ].join('\n');

  const baseVoiceOverlay = [
    '\n## Voice Mode',
    '- You are SPEAKING, not typing. Be conversational and natural, like talking to a friend.',
    '- Keep spoken responses concise; the user is listening, not reading.',
  ].join('\n');

  // Inject compact conversation continuity if available
  let topicContext = '';
  try {
    const convForTopic = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    const summary = getConversationSummary(convForTopic.id);
    if (summary) topicContext += `\n\n## Conversation Context\n${summary}`;
    const tc = getTopicContext(convForTopic.id);
    if (tc) topicContext += tc;
  } catch {}

  const operationMode = (() => {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === `op_mode_${session.userId}`);
      if (setting) return parseStoredOperationMode(setting.value);
    } catch {}
    return 'assistant';
  })();

  // 【重构·模块1】移除正则前置分流（selfRepair/clientActionOnly/workSurface/exposeAgentWork/toolRoute）。
  // 工具决策交由心智内核（SEVEN_STEP_MIND 第3步 + 模式配置策略），安全边界由
  // personality.toolPolicy / interceptor 确认流 / action_constitution 承担（保留类别①④）。
  const effectiveOperationMode: OperationMode = operationMode;
  const effectiveOpModeConfig = getOperationModeConfig(effectiveOperationMode);
  const allowToolUseForTurn = effectiveOperationMode !== 'meeting';
  const visionIntent = hasVisionIntent(userText);
  const routedToolPolicy = effectiveOpModeConfig?.toolPolicy;
  logger.info(`[Audio] tool gate: ${allowToolUseForTurn ? 'enabled' : 'chat-only'} mode=${operationMode} effective=${effectiveOperationMode}`);
  const opModeOverlay = effectiveOpModeConfig ? '\n\n' + effectiveOpModeConfig.promptOverlay : '';
  const visionRoutingOverlay = visionIntent && effectiveOperationMode !== 'meeting' ? '\n\n' + buildVisionRoutingOverlay(session.userId, userText) : '';
  const interactionOverlay = allowToolUseForTurn
    ? toolVoiceOverlay
    : baseVoiceOverlay;

  const clientSelfPrompt = '\n\n' + formatClientSelfPrompt(session.userId);
  const voiceSystemPrompt = fullPersonalityPrompt + interactionOverlay + opModeOverlay + visionRoutingOverlay + buildVoiceReplyStyleOverlay() + clientSelfPrompt + topicContext;

  const userLLMPrefs = getScopedPreferredLLM(session.userId, voiceScope);
  const provider = userLLMPrefs.provider || 'deepseek';
  const voiceModel = (userLLMPrefs.models || {})[provider]
    // O-1: 语音链路高档位模型统一走 COMPLEX_MODELS 配置（修复前直写 'deepseek-v4-pro'）
    || COMPLEX_MODELS[provider]
    || userLLMPrefs.model
    || 'deepseek-chat';

  const maxIterations = routedToolPolicy?.maxIterations || personality.toolPolicy.maxIterations || 5;

  const desktopRelay = async (toolName: string, args: Record<string, any>): Promise<string> => {
    return new Promise((resolve, reject) => {
      const cid = Math.random().toString(36).substring(2, 11);
      const timeout = setTimeout(() => {
        reject(new Error(`Desktop tool "${toolName}" timed out (30s)`));
      }, 30000);
      socket.once(`tool:desktop_result:${cid}`, (data: { output?: string; error?: string }) => {
        clearTimeout(timeout);
        if (data.error) reject(new Error(data.error));
        else resolve(data.output || '');
      });
      socket.emit('tool:desktop_exec', { correlationId: cid, name: toolName, arguments: args });
    });
  };

  const requestConfirmation = async (toolName: string, args: Record<string, any>): Promise<boolean> => {
    // Tool trust learning: auto-approve tools the user has trusted
    const { getTrustedTools, recordToolApprove, recordToolDeny } = await import("../personality/tool_trust");
    if (getTrustedTools(session.userId).includes(toolName)) {
      socket.emit("agent:tool_call", { name: toolName, arguments: args, result: 'Auto-approved (trusted)', error: undefined });
      return true;
    }
    return new Promise((resolve) => {
      const cid = Math.random().toString(36).substring(2, 11);
      const timeout = setTimeout(() => {
        socket.emit("agent:tool_call", { name: toolName, arguments: args, result: 'Auto-denied (30s timeout)', error: 'User did not respond' });
        resolve(false);
      }, 30000);
      socket.once(`tool:confirm_result:${cid}`, (data: { allowed: boolean }) => {
        clearTimeout(timeout);
        if (data.allowed) {
          const promoted = recordToolApprove(session.userId, toolName);
          if (promoted) {
            socket.emit("agent:notification", { type: 'trust', level: 'info', message: `Tool "${toolName}" is now trusted — future uses will be auto-approved.` });
          }
        } else {
          recordToolDeny(session.userId, toolName);
        }
        resolve(data.allowed === true);
      });
      socket.emit('agent:confirm_tool', { correlationId: cid, name: toolName, arguments: args });
    });
  };

  // ── Capture abort controller refs BEFORE anything that checks them ──
  // Must NOT look up session.pipelineAbortController / session.ttsAbortController
  // in the loop or flushSentence because a new processVoiceInput will overwrite them.
  const pipelineAbort = session.pipelineAbortController;
  const ttsAbort = session.ttsAbortController;

  const toolContext = {
    userId: session.userId,
    domain: voiceScope.domain,
    orgId: voiceScope.orgId,
    desktopRelay,
    llmGetters,
    source: 'voice',
    ...(effectiveOperationMode === 'assistant' || effectiveOperationMode === 'autonomous' ? { requestConfirmation } : {}),
    isCancelled: () => pipelineAbort?.signal.aborted ?? false,
    toolPolicy: routedToolPolicy,
  };
  const ttsProvider = resolveVoiceTtsProvider({ provider: session.currentVoiceProvider || undefined });
  // Emotion-adaptive voice: map mood to speech parameters, preserve user's chosen voiceId
  // 数字生命体·语音模块（阶段四）: 情绪 → 方向 → 关系 三重映射（emotion 心情 / direction 姿态 / relationship 温度）
  const emotionVoice = ((): { voiceId: string; speechRate?: number; pitch?: number; volume?: number } => {
    try {
      const es = loadEmotionalState(session.userId);
      const dirState = getDirectionState();
      const relState = getRelationshipEngine().getRelationshipState();
      return mapStateToVoiceParams(session.currentVoiceId || 'longxiaochun_v3', {
        emotion: es,
        direction: { inclination: dirState.getInclination(), intensity: dirState.getIntensity() },
        relationship: { stage: relState.stage },
      });
    } catch {}
    return { voiceId: session.currentVoiceId || 'longxiaochun_v3' };
  })();
  logger.info(`[Audio] 三重语音映射 emotion+方向+关系 → speechRate=${emotionVoice.speechRate ?? 1.0} pitch=${emotionVoice.pitch ?? 1.0} volume=${emotionVoice.volume ?? 1.0}`);
  logger.info(`[Audio] TTS provider=${ttsProvider} voiceId=${session.currentVoiceId}`);
  let responseText = '';
  let toolResults: ToolExecutionRecord[] = [];
  let sentenceBuffer = '';
  let sentenceIdx = 0;
  const ttsPromises: Promise<void>[] = [];
  let previousToolSig: string | null = null;
  const deferCompletionSpeech = needsCompletionEvidence(userText);

  // ── Generation gating: only latest command gets TTS output ──
  session.bgGeneration++;
  const myGeneration = session.bgGeneration;
  let ttsQueue: Promise<void> = Promise.resolve();

  const flushSentence = (sentence: string) => {
    const txt = sentence.trim();
    if (!txt || txt.length <= 1 || !ttsProvider || !session.currentVoiceId || !session.isActive) return;
    if (!/[a-zA-Z一-鿿㐀-䶿\d]/.test(txt)) return;
    if (ttsAbort?.signal.aborted) return;
    if (session.bgGeneration !== myGeneration) return;
    sentenceIdx++;
    // Serialize TTS to avoid 429 rate limits
    ttsQueue = ttsQueue.then(async () => {
      if (ttsAbort?.signal.aborted) return;
      if (session.bgGeneration !== myGeneration) return;
      session.isSpeaking = true;
      ttsSpeakingCount++;
      try {
        const ttsResult = await synthesizeSpeech(txt, {
          provider: ttsProvider,
          voiceId: emotionVoice.voiceId,
          speechRate: emotionVoice.speechRate,
          pitch: emotionVoice.pitch,
          volume: emotionVoice.volume,
          signal: ttsAbort?.signal,
        });
        logger.info(`[Audio TTS] "${txt.slice(0,30)}" → ${ttsResult.audioBuffer.length} bytes OK`);
        if (!ttsAbort?.signal.aborted && session.bgGeneration === myGeneration) {
          socket.emit("audio:status", { status: "speaking" });
          addEchoText(txt);
          const volumeGain = computeVolumeGain();
          socket.emit("audio:response", { buffer: ttsResult.audioBuffer, volumeGain });
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        logger.warn(`[Audio TTS] ${e.message?.slice(0, 80)}`);
      } finally {
        if (session.bgGeneration === myGeneration) session.isSpeaking = false;
        // Keep ttsSpeakingCount elevated for 3s after synthesis — client playback continues
        const decay = () => { ttsSpeakingCount = Math.max(0, ttsSpeakingCount - 1); };
        const t = setTimeout(decay, 3000);
        session.ttsDecayTimers.push(t);
      }
    });
    ttsPromises.push(ttsQueue);
  };

  // 【重构·模块1】删除模式切换 Fast-Path（directlyAppliedMode）与 Quick Command 静态映射
  // （matchQuickCommand 关键词→工具绑定）：模式切换由心智调用 client_action 工具完成，
  // 工具执行由心智在 runWithTools / Orchestrator 中自主调度。

  // 【重构·模块1】音乐/音乐画像意图在 cognition 心智分类后由 entities 实体统一门控（见后文 shortcut），此处不再做文本正则前置分流。

  try {
    // ── Peppa Cognitive Engine: classify intent BEFORE calling any LLM ──
    // Same cognitive layer as text chat — one Peppa, one framework.
    const cognitiveCtx: CognitiveContext = {
      userId: session.userId,
      agentId: session.agentId,
      personalityId: session.personalityId || 'peppa',
      personalityName: personality.name,
      llmProvider: provider,
      llmModel: voiceModel,
      isLLMAvailable: true,
    };
    const llmClassifier = async (prompt: string, userText: string): Promise<string> => {
      const classifierModel = provider === 'deepseek' ? 'deepseek-v4-flash' : voiceModel;
      const result = await makeLLMCall(
        [{ role: 'system', content: prompt }, { role: 'user', content: userText }],
        [],
        { provider, model: classifierModel, userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, maxTokens: 60 , scene: 'voice_classifier'},
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );
      recordTokenUsage(session.userId, provider, classifierModel, result.usage, `voice_cls_${Date.now()}`, 'voice');
      return result.text || '{"category":"unknown","confidence":0.5,"entities":{}}';
    };

    const cognition = await processInput(userText, cognitiveCtx, llmClassifier);

    if (cognition.directToolExecuted && cognition.responseText) {
      // Path A: Cognitive engine handled this directly — no LLM needed
      responseText = cognition.responseText;
      flushSentence(responseText);
      await Promise.allSettled(ttsPromises);
      // Persist
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
      session.isProcessing = false;
      session.isSpeaking = false;
      session.pipelineAbortController = null;
      socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
      return;
    }

    // Auto-select model based on cognitive intent
    const complexCategories = ['command', 'code', 'question', 'analysis'];
    const isComplex = complexCategories.includes(cognition.intent.category);
    let effectiveModel = voiceModel;
    if (provider === 'deepseek') {
      effectiveModel = isComplex ? COMPLEX_MODELS.deepseek : DEFAULT_MODELS.deepseek; // O-1
    }
    logger.info(`[Audio] Cognition: ${cognition.intent.category} (confidence: ${cognition.intent.confidence}), model: ${effectiveModel}`);

    // ── Music / MusicProfile intent shortcut — 心智实体驱动（entities.music / entities.musicProfile）──
    // 【重构·模块1】门控由 LLM 分类器实体判定，无正则文本猜测；调节/播放动作在实体值上做数据层归一。
    const musicEntity = cognition.intent?.entities?.music as string | undefined;
    const musicProfileRequest = cognition.intent?.entities?.musicProfile === 'true';
    const isMusicAdjustment = isMusicAdjustmentRequest(musicEntity);
    if (isMusicPlaybackRequest(musicEntity) || musicProfileRequest) {
      logger.info(`[Audio] Music intent matched (mind entity): ${musicProfileRequest ? 'musicProfile' : `"${musicEntity}"`}, attempting shortcut...`);
      try {
        if (musicProfileRequest) {
          const profile = await analyzeLikedMusicProfile(session.userId, { maxSongs: 3000 });
          responseText = formatMusicProfileReport(profile);
          flushSentence(profile.summaryCn || responseText);
        } else {
          const result = isMusicAdjustment
            ? await adjustMusicPlayback(session.userId, socket, musicEntity || userText)
            : await searchAndPlay(session.userId, socket, musicEntity || userText);
          responseText = result.success && result.text ? result.text : getMusicFailureMessage(result.reason);
          if (!result.success) socket.emit('music:error', { message: responseText });
          flushSentence(responseText);
        }
        await Promise.allSettled(ttsPromises);
        const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        session.isProcessing = false;
        session.isSpeaking = false;
        session.pipelineAbortController = null;
        socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
        socket.emit("audio:status", { status: "listening" });
        socket.emit("agent:status", { status: "idle" });
        return;
      } catch (musicErr: any) {
        logger.warn('[Audio] Music intent shortcut failed:', musicErr.message);
        responseText = getMusicFailureMessage(musicErr?.message);
        socket.emit('music:error', { message: responseText });
        flushSentence(responseText);
        await Promise.allSettled(ttsPromises);
        const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
        session.isProcessing = false;
        session.isSpeaking = false;
        session.pipelineAbortController = null;
        socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });
        socket.emit("audio:status", { status: "listening" });
        socket.emit("agent:status", { status: "idle" });
        return;
      }
    }

    // ── Orchestrator: complex/moderate tasks → multi-agent decomposition ──
    let usedOrchestrator = false;
    const complexity = classifyComplexity(userText, { userId: session.userId, personalityId: session.personalityId });
    if (allowToolUseForTurn && (complexity === 'complex' || complexity === 'moderate')) {
      try {
        socket.emit("agent:status", { status: "thinking", agentName: "Peppa", phase: 'orchestrator' });
        // \u8bed\u97f3\u7ba1\u9053\u5373\u65f6\u5e94\u7b54\uff08\u5de5\u7a0b\u4fdd\u7559\uff09\uff1aOrchestrator \u6267\u884c\u671f\u95f4\u907f\u514d TTS \u9759\u9ed8
        flushSentence("\u6536\u5230\uff0c\u6211\u6765\u5904\u7406\u3002");
        session.isOrchestrating = true;

        const orchResult = await runOrchestratedTask(
          userText,
          { userId: session.userId, personalityId: session.personalityId, domain: voiceScope.domain, orgId: voiceScope.orgId, desktopRelay },
          { provider, model: effectiveModel },
          llmGetters,
          (msg) => socket.emit("agent:chunk", { text: msg, agentName: "Peppa" }),
          (record, meta) => {
            toolResults.push({
              id: record.id,
              name: record.name,
              arguments: record.arguments || {},
              result: record.result || '',
              error: record.error,
            });
            socket.emit("agent:tool_call", {
              correlationId: record.id,
              toolCallId: record.id,
              name: record.name,
              arguments: record.arguments,
              args: record.arguments,
              subTaskId: meta.subTaskId,
              workerAgentId: meta.agentId,
              workerAgentName: meta.agentName,
              result: record.result?.slice(0, 500),
              error: record.error,
            });
          },
        );
        if (orchResult) {
          usedOrchestrator = true;
          responseText = orchResult.responseText;
          const rawSentences = responseText.split(/(?<=[。！？.!?\n])/).filter(s => s.trim());
          if (!deferCompletionSpeech) {
            // Flush orchestrator result to TTS sentence by sentence
            for (const s of rawSentences) {
              if (pipelineAbort?.signal.aborted) break;
              flushSentence(s);
            }
          }
          logger.info(`[Audio] Orchestrator response: "${responseText.slice(0, 80)}" (${rawSentences.length} sentences)`);
        }
        session.isOrchestrating = false;
      } catch (e) {
        session.isOrchestrating = false;
        logger.warn('[Audio] Orchestrator failed, falling back to LLM:', (e as Error).message);
      }
    }

    if (!usedOrchestrator) {
      // ── Single-phase: stream LLM → TTS with tool iteration, all inline ──
      // Load recent conversation history for context continuity
      // Include both user & assistant messages with correct roles
      const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
      const recentMsgs = getMessagesByTokenBudget(conv.id);
      const voiceHistory: NormalizedMessage[] = recentMsgs.flatMap(normalizeVoiceHistoryRecord);

      const messages: any[] = [
        { role: 'system', content: voiceSystemPrompt },
        ...voiceHistory,
        { role: 'user', content: userText },
      ];

      for (let iter = 0; iter < maxIterations; iter++) {
      if (pipelineAbort?.signal.aborted) break;

      logger.info(`[Audio] LLM iter ${iter + 1}/${maxIterations}: provider=${provider} model=${effectiveModel}`);
      const toolDeclarations = allowToolUseForTurn
        ? toolRegistry.getToolDeclarations().filter((declaration) => {
            const name = declaration.function.name;
            const forbidden = new Set(routedToolPolicy?.forbiddenTools || []);
            if (forbidden.has('*') || forbidden.has(name)) return false;
            const allowed = routedToolPolicy?.allowedTools || [];
            if (allowed.includes('*')) return true;
            return allowed.includes(name);
          })
        : [];

      const streamResult = await makeLLMCallStreaming(
        messages as NormalizedMessage[],
        toolDeclarations,
        { provider, model: effectiveModel, userId: session.userId, domain: voiceScope.domain, orgId: voiceScope.orgId, signal: pipelineAbort?.signal },
        (chunk: string) => {
          responseText += chunk;
          if (!deferCompletionSpeech) {
            sentenceBuffer += chunk;
            socket.emit("agent:chunk", { text: chunk, agentName: "Peppa" });
            const match = sentenceBuffer.match(/^([\s\S]*?[。！？.!?\n])/);
            if (match) {
              sentenceBuffer = sentenceBuffer.slice(match[1].length);
              flushSentence(match[1]);
            }
          }
        },
        llmGetters.getDeepSeek, llmGetters.getGemini, llmGetters.getOpenAI, llmGetters.getAnthropic, llmGetters.getQwen,
        llmGetters.getOllama, llmGetters.getLmStudio, llmGetters.getArk, llmGetters.getXiaomi, llmGetters.getKimi, llmGetters.getGlm, llmGetters.getRelay,
      );

      messages.push({
        role: 'assistant',
        content: streamResult.text || null,
        ...(streamResult.toolCalls?.length ? { toolCalls: streamResult.toolCalls } : {}),
        reasoningContent: streamResult.reasoningContent,
      });

      // Record token usage for this streaming call
      recordTokenUsage(session.userId, provider, effectiveModel, streamResult.usage, `voice_stream_${Date.now()}`, 'voice');

      if (!streamResult.toolCalls || streamResult.toolCalls.length === 0) break;

      const toolSig = JSON.stringify(streamResult.toolCalls.map(tc => ({ n: tc.name, a: tc.arguments })));
      if (toolSig === previousToolSig) { logger.info('[Audio] Duplicate tools, breaking'); break; }
      previousToolSig = toolSig;

      for (const tc of streamResult.toolCalls) {
        if (pipelineAbort?.signal.aborted) break;
        const cid = `${tc.name}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        socket.emit("agent:tool_call", { correlationId: cid, name: tc.name, arguments: tc.arguments });

        let execResult: string;
        let execError: string | undefined;
        try {
          execResult = await toolRegistry.execute(tc.name, tc.arguments, toolContext);
        } catch (execErr: any) {
          execResult = '';
          execError = execErr.message?.slice(0, 200) || 'Tool execution failed';
        }

        toolResults.push({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments || {},
          result: execResult,
          error: execError,
        });

        if (execError) {
          socket.emit("agent:tool_call", { correlationId: cid, name: tc.name, arguments: tc.arguments, error: execError });
        } else {
          const short = typeof execResult === 'string' ? execResult.slice(0, 500) : JSON.stringify(execResult).slice(0, 500);
          socket.emit("agent:tool_call", { correlationId: cid, name: tc.name, arguments: tc.arguments, result: short });
        }

        messages.push({
          role: 'tool',
          content: execError ? `Error: ${execError}` : compactToolResultForModel(tc.name, execResult),
          toolCallId: tc.id,
          name: tc.name,
        });
      }
    }
    } // end if (!usedOrchestrator)

    const completionGuard = guardCompletionClaims({
      task: userText,
      response: responseText,
      toolCalls: toolResults,
      source: 'voice',
    });
    if (completionGuard.blocked) {
      logger.warn(`[Audio] Completion claim blocked: ${completionGuard.reason}`);
      responseText = completionGuard.text;
      sentenceBuffer = '';
      socket.emit("agent:notification", { type: 'work_product_guard', level: 'warning', message: completionGuard.reason });
    }

    // Flush remaining text
    if (sentenceBuffer.trim() && !deferCompletionSpeech) flushSentence(sentenceBuffer);
    if (deferCompletionSpeech && responseText) {
      const finalSentences = responseText.split(/(?<=[。！？.!?\n])/).filter(s => s.trim());
      for (const s of finalSentences) {
        if (pipelineAbort?.signal.aborted) break;
        flushSentence(s);
      }
    }
    await Promise.allSettled(ttsPromises);

    if (responseText) {
      logger.info(`[Audio] Response: "${responseText.slice(0, 80)}" (${sentenceIdx} sentences, ${toolResults.length} tool calls)`);
      socket.emit("agent:response", { text: responseText, agentName: "Peppa", source: "voice" });
    }

    // Persist
    const conv = getOrCreateActiveConversation(session.userId, session.agentId, voiceScope.domain, voiceScope.orgId);
    if (!conv.title) {
      conv.title = userText.slice(0, 50);
      writeDB(readDB());
    }
    addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'user', content: userText, personality: session.personalityId, mode: 'voice', domain: voiceScope.domain, orgId: voiceScope.orgId });
    if (responseText) {
      addMessage({ userId: session.userId, agentId: session.agentId, conversationId: conv.id, role: 'assistant', content: responseText, personality: session.personalityId, mode: 'voice', toolCalls: toolResults.length ? toolResults : undefined, domain: voiceScope.domain, orgId: voiceScope.orgId });
    }
    // Topic tracking — extract and record topics for cross-session continuity
    try {
      const topics = extractTopics(userText + ' ' + responseText);
      for (const topic of topics) {
        trackTopic(conv.id, topic);
      }
    } catch {}
    // Text sentiment analysis on user input (matching chat.ts behavior)
    const textSentiment = extractSentiment(userText);
    if (textSentiment.valence !== 0 || textSentiment.urgency > 0 || textSentiment.frustration > 0) {
      try {
        const es = loadEmotionalState(session.userId);
        const updated = updateEmotionalState(es, {
          type: 'sentiment_analysis',
          timestamp: new Date().toISOString(),
          userId: session.userId,
          sentiment: {
            valence: textSentiment.valence,
            frustration: textSentiment.frustration,
            urgency: textSentiment.urgency,
          },
        });
        saveEmotionalState(session.userId, updated);
        try { const hm = loadHIMState(session.userId); const { him: nh } = himTick(updated, hm); saveHIMState(session.userId, nh); } catch {}
      } catch { /* best-effort */ }
    }
    socket.emit('chat:conversation_updated', { conversationId: conv.id, agentId: session.agentId, source: 'voice' });

  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.info('[Audio] Pipeline aborted (barge-in or stop)');
    } else {
      logger.error("[Audio Error]:", err);
      socket.emit("agent:error", { message: "Voice processing failed" });
    }
  } finally {
    session.isSpeaking = false;
    session.isProcessing = false;
    session.isBackgroundWork = false;
    session.ttsAbortController = null;
    session.pipelineAbortController = null;

    if (session.isActive) {
      resetSilenceTimer(session, socket);
      socket.emit("audio:status", { status: "listening" });
      socket.emit("agent:status", { status: "idle" });
    }
  }
}

function resetSilenceTimer(session: AudioSession, socket: Socket) {
  if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
  session.silenceTimer = setTimeout(() => {
    if (session.isActive && !session.isProcessing) {
      logger.info('[Audio] Silence timeout (5min) — closing STT session');
      if (session.sttSession) {
        session.sttSession.end();
        session.sttSession = null;
      }
      socket.emit("audio:status", { status: "idle" });
    }
  }, 5 * 60 * 1000);
}

export function registerVoiceHandlers(
  socket: Socket,
  llmGetters: LlmGetters,
  sensoryFn: (uid: string) => any,
  getUserId: (s: Socket) => string,
) {
  socket.on("audio:start", async (data: { voiceId?: string; voiceProvider?: string; personalityId?: string; agentId?: string; transcriptionOnly?: boolean; domain?: 'personal' | 'work'; orgId?: string }) => {
    logger.info(`[Audio] Voice call started by ${socket.id}`);
    const session = getAudioSession(socket);
    session.isActive = true;
    session.accumulatedText = '';
    session.isSpeaking = false;
    session.isProcessing = false;
    session.inputQueue = [];
    session.lastChunkTime = 0;
    session.userId = getUserId(socket);
    session.agentId = data.agentId || 'peppa';
    session.domain = data.domain === 'work' && data.orgId ? 'work' : 'personal';
    session.orgId = session.domain === 'work' ? String(data.orgId || '') : '';
    session.transcriptionOnly = data.transcriptionOnly === true;
    const enrolledVoiceprints = session.userId ? getVoiceprints(session.userId) : [];
    session.voiceprintRequired = enrolledVoiceprints.length > 0;
    session.voiceprintMatched = !session.voiceprintRequired;
    session.voiceprintConfidence = 0;
    session.voiceprintLastAt = 0;
    const personalityCfg = personalityRegistry.get(data.personalityId || 'peppa');
    // Use explicit voiceId, then personality's TTS voice, then null (TTS provider default)
    session.currentVoiceId = data.voiceId || personalityCfg?.ttsVoiceId || null;
    session.currentVoiceProvider = data.voiceProvider || null;
    session.personalityId = data.personalityId || 'peppa';

    // End previous STT session if re-starting without explicit stop
    if (session.sttSession) { try { session.sttSession.end(); } catch {} session.sttSession = null; }

    const sttProvider = getActiveSTTProvider();
    if (sttProvider) {
      try {
        const language = sttProvider === 'qwen' ? 'zh' : 'zh-CN';
        session.sttSession = createStreamingSession({ provider: sttProvider, language, interimResults: true });
        resetSilenceTimer(session, socket);

        session.sttSession.onResult(async (result) => {
          if (result.text && result.isFinal) {
            if (session.lastChunkTime > 0) {
              recordLatency('stt', Date.now() - session.lastChunkTime);
            }
            logger.info(`[Audio] Final transcript: "${result.text}"`);
            // Feed voice sentiment from Deepgram into emotional state
            if (result.sentiment && session.userId) {
              try {
                const es = loadEmotionalState(session.userId);
                const updated = updateEmotionalState(es, {
                  type: 'sentiment_analysis',
                  timestamp: new Date().toISOString(),
                  userId: session.userId,
                  sentiment: {
                    valence: result.sentiment.sentiment_score,
                    frustration: result.sentiment.sentiment === 'negative' ? 0.6 : 0,
                    urgency: 0,
                  },
                });
                saveEmotionalState(session.userId, updated);
                try { const hm2 = loadHIMState(session.userId); const { him: nh2 } = himTick(updated, hm2); saveHIMState(session.userId, nh2); } catch {}
              } catch { /* best-effort sentiment tracking */ }
            }
            session.accumulatedText += result.text;
            const text = session.accumulatedText.trim();
            session.accumulatedText = '';
            if (!text) return;

            // ── Filter filler words: single-char interjections ──
            const isFiller = /^[嗯啊哦呃哼唉呀哈呵嗨喂诶唔嘶啧哎哦哟嘿嘛哇啦嘞][。！？.!?，,～~]*$/.test(text);
            if (isFiller) {
              logger.info(`[Audio] Ignored filler: "${text}"`);
              return;
            }
            // ── Filter pure noise (no CJK, no letters, no digits) ──
            const hasContent = /[a-zA-Z一-鿿㐀-䶿\d]/.test(text);
            if (!hasContent) {
              logger.info(`[Audio] Ignored pure noise: "${text}"`);
              return;
            }

            if (!isVoiceprintGateOpen(session)) {
              blockUnverifiedVoice(socket, session, 'Ignored transcript before command/barge-in');
              resetSilenceTimer(session, socket);
              return;
            }

            if (session.isProcessing || session.isSpeaking) {
              const explicitInterrupt = isExplicitInterruptCommand(text);
              // Speaking (TTS playing): only long or explicit speech → barge-in
              // Short fragments (< 4 chars) are likely speaker echo, not user speech
              if (session.isSpeaking) {
                if (!explicitInterrupt && isEchoText(text)) {
                  logger.info(`[Audio] Echo cancelled during speech: "${text}"`);
                  return;
                }
                logger.info(`[Audio] Barge-in during speech: "${text}" — aborting`);
                cancelActiveVoiceTurn(session);
                socket.emit("audio:status", { status: "interrupted" });
                socket.emit("audio:interrupt-ack", {});
                if (isPureInterruptCommand(text)) {
                  socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, socket);
                  return;
                }
              } else {
                // Processing but not speaking (LLM thinking / tool exec):
                // Any real speech → barge-in, abort current pipeline
                logger.info(`[Audio] Barge-in during processing: "${text}" — aborting`);
                cancelActiveVoiceTurn(session);
                socket.emit("audio:status", { status: "interrupted" });
                socket.emit("audio:interrupt-ack", {});
                if (isPureInterruptCommand(text)) {
                  socket.emit("audio:status", { status: "listening" });
                  resetSilenceTimer(session, socket);
                  return;
                }
                // Fall through to processInput with new speech
              }
            }

            // Echo confirmation — brief window for user to see what was heard and interrupt if wrong
            // 记录真实用户语音时间（回声/填充/噪声已被上面过滤）— 环境音分类据此区分"环境噪音"与"对话场景"
            session.lastTranscriptAt = Date.now();
            socket.emit("audio:confirm", { text });
            logger.info(`[Audio] Heard: "${text}"`);

            if (session.transcriptionOnly) {
              socket.emit("audio:transcript", { text, isFinal: true });
              socket.emit("audio:status", { status: "listening" });
              resetSilenceTimer(session, socket);
              return;
            }

            // Brief delay before processing (user can barge-in during this window)
            session.bargeinTimer = setTimeout(() => {
              session.bargeinTimer = null;
              if (!session.isActive) return;
              processVoiceInput(socket, session, text, llmGetters, sensoryFn).catch(err => {
                logger.error("[Voice Error]:", err);
                session.isSpeaking = false;
                session.isProcessing = false;
                socket.emit("audio:status", { status: "listening" });
              });
            }, 600);
          } else if (result.text && !result.isFinal) {
            socket.emit("audio:transcript", { text: result.text, isFinal: false });
          }
        });

        session.sttSession.onError((err: Error) => {
          logger.error("[Audio STT Error]:", err);
          socket.emit("audio:error", { message: err.message });
        });

        socket.emit("audio:status", { status: "listening" });
      } catch (err: any) {
        logger.error("[Audio Start Error]:", err);
        socket.emit("audio:error", { message: err.message });
      }
    } else {
      socket.emit("audio:status", { status: "listening" });
      socket.emit("audio:error", { message: "No STT provider configured. Set DASHSCOPE_API_KEY or DEEPGRAM_API_KEY." });
    }
  });

  let chunkCount = 0;
  socket.on("audio:chunk", (data: Buffer) => {
    const session = getAudioSession(socket);
    if (!session.isActive) return;
    session.lastChunkTime = Date.now();
    resetSilenceTimer(session, socket);
    if (session.sttSession) {
      session.sttSession.sendAudio(data);
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 50 === 0) {
        logger.info(`[Audio] Sent ${chunkCount} chunks (${data.length} bytes each)`);
      }
    }
  });

  // ── Voiceprint: receive MFCC match results from frontend hook ──
  socket.on("voiceprint:result", (data: { isOwnerSpeaking: boolean; confidence: number; source?: string; quality?: number; reason?: string }) => {
    const session = getAudioSession(socket);
    session.voiceprintMatched = data.isOwnerSpeaking;
    session.voiceprintConfidence = data.confidence;
    session.voiceprintLastAt = Date.now();
    logger.info(`[Voiceprint] result source=${data.source || 'unknown'} matched=${data.isOwnerSpeaking} conf=${Number(data.confidence || 0).toFixed(2)} quality=${typeof data.quality === 'number' ? data.quality.toFixed(2) : '-'} reason=${data.reason || '-'}`);
  });

  // ── Presence: periodic heartbeat from usePresence hook ──
  socket.on("presence:heartbeat", (data: { facePresent: boolean; faceConfidence: number; voiceprintMatched: boolean; voiceprintConfidence: number; userId: string }) => {
    const state = updatePresence(data.userId, data);
    const status = state.isAway ? 'away' : (state.facePresent || state.voiceprintMatched ? 'present' : 'uncertain');
    socket.emit('presence:state_change', { isAway: state.isAway, status });
  });

  socket.on("audio:interrupt", () => {
    logger.info(`[Audio] Interrupt from ${socket.id}`);
    const session = getAudioSession(socket);
    cancelActiveVoiceTurn(session);
    socket.emit("audio:status", { status: "interrupted" });
    socket.emit("audio:interrupt-ack", {});
  });

  socket.on("audio:stop", () => {
    logger.info(`[Audio] Voice call ended by ${socket.id}`);
    const session = getAudioSession(socket);
    session.isActive = false;
    session.transcriptionOnly = false;
    cancelActiveVoiceTurn(session);
    if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
    if (session.sttSession) {
      session.sttSession.end();
      session.sttSession = null;
    }
    // Clear tracked timers to prevent post-session mutations
    socket.emit("audio:status", { status: "idle" });
  });

  // Track ambient noise level for environment-gated proactive speech
  socket.on("ambient:noise_level", (data: { rms: number; isSpeaking: boolean; callState: string }) => {
    ambientRms = data.rms;
    ambientRmsLastUpdate = Date.now();
    // 环境音分类 + 有节制的温馨提示（阶段三）
    const ambientSession = getAudioSession(socket);
    if (ambientSession && ambientSession.isActive) {
      maybeEnvironmentTip(socket, ambientSession, data);
    }
  });

  /**
   * Night / Focus quiet mode: determine whether Peppa should suppress proactive speech.
   */
  function shouldStayQuiet(userId: string): { quiet: boolean; reason: string } {
    const hour = new Date().getHours();
    const nightHours = hour >= 23 || hour < 7;

    if (nightHours) {
      return { quiet: true, reason: 'night_hours' };
    }

    try {
      const idleState = getIdleState(userId);
      if (idleState.isIdle && idleState.idleSince) {
        const idleMs = Date.now() - new Date(idleState.idleSince).getTime();
        const idleHours = idleMs / (1000 * 60 * 60);
        if (idleHours > 2) {
          return { quiet: true, reason: 'user_flow_state' };
        }
      }
    } catch {}

    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.15) {
      return { quiet: true, reason: 'meeting_detected' };
    }

    return { quiet: false, reason: '' };
  }

  socket.on("proactive:request_speak", async (data: { message: string }) => {
    const session = getAudioSession(socket);
    const userId = getUserId(socket);
    if (!userId || !data.message) return;

    session.isSpeaking = true;
    const resetSpeaking = () => { session.isSpeaking = false; };

    // Gate: night/focus/meeting quiet mode
    const quietCheck = shouldStayQuiet(userId);
    if (quietCheck.quiet) {
      resetSpeaking();
      logger.info(`[ProactiveVoice] Suppressed for ${userId}: ${quietCheck.reason}`);
      return;
    }

    // Resolve voiceId: session first, then personality config, then give up
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.get(session.personalityId || 'peppa');
      voiceId = personalityCfg?.ttsVoiceId || null;
    }
    if (!voiceId) { resetSpeaking(); return; }

    // Gate: check initiative level — Peppa only speaks first when comfortable enough
    const es = loadEmotionalState(userId);
    if (es.initiative < 0.4) { resetSpeaking(); return; }

    // Gate: don't interrupt when environment is noisy (user likely in a meeting)
    const noise = getAmbientNoise();
    if (noise !== null && noise > 0.08) { resetSpeaking(); return; }

    const ttsProvider = resolveVoiceTtsProvider({ provider: session.currentVoiceProvider || undefined });
    if (!ttsProvider) { resetSpeaking(); return; }

    const proactiveVoice = resolveEmotionVoice(voiceId, es);

    try {
      ttsSpeakingCount++;
      addEchoText(data.message);
      const result = await synthesizeSpeech(data.message, {
        provider: ttsProvider,
        voiceId: proactiveVoice.voiceId,
        speechRate: proactiveVoice.speechRate,
        pitch: proactiveVoice.pitch,
        volume: proactiveVoice.volume,
      });
      ttsSpeakingCount = Math.max(0, ttsSpeakingCount - 1);
      const proactiveGain = computeVolumeGain();
      socket.emit("audio:proactive_speak", {
        audioBuffer: result.audioBuffer,
        text: data.message,
        timestamp: new Date().toISOString(),
        volumeGain: proactiveGain,
      });
      logger.info(`[ProactiveVoice] Spoke to ${userId}: "${data.message.slice(0, 60)}"`);
      resetSpeaking();
    } catch (err: any) {
      resetSpeaking();
      logger.warn(`[ProactiveVoice] TTS failed: ${err.message}`);
    }
  });

  // LLM-generated greeting — replaces hardcoded templates with personalized, scene-aware greetings
  socket.on("greeting:generate", async (data: { scene?: string }) => {
    const userId = getUserId(socket);
    if (!userId) return;

    const session = getAudioSession(socket);
    let voiceId = session.currentVoiceId;
    if (!voiceId) {
      const personalityCfg = personalityRegistry.get(session.personalityId || 'peppa');
      voiceId = personalityCfg?.ttsVoiceId || null;
    }
    if (!voiceId) return;

    const es = loadEmotionalState(userId);
    if (es.initiative < 0.3) return; // Lower gate for greetings

    // Build temporal context for scene-aware generation
    let temporalBlock = '';
    try {
      const { generateTemporalContext } = await import('../time/temporal_context');
      temporalBlock = await generateTemporalContext(userId);
    } catch {}

    // Fetch a few recent memories for personalization
    let memoryContext = '';
    try {
      const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.5, domain: session.domain, orgId: session.orgId });
      if (recentMemories.length > 0) {
        memoryContext = recentMemories.map(m => `- ${m.content.slice(0, 150)}`).join('\n');
      }
    } catch {}

    // Fetch recent greetings to avoid repetition (greeting dedup)
    let dedupContext = '';
    try {
      const recentGreetings = queryMemories({
        userId,
        query: 'greeting',
        limit: 8,
        minConfidence: 0.5,
        domain: session.domain,
        orgId: session.orgId,
      });
      const greetingTexts = recentGreetings
        .filter(m => m.content.includes('[Greeting]') || m.keywords.includes('greeting'))
        .map(m => m.content.replace(/^\[Greeting\]\s*/, '').slice(0, 80));
      if (greetingTexts.length > 0) {
        dedupContext = `\nRecently used greetings (DO NOT repeat these — be completely fresh):\n${greetingTexts.map(g => `- "${g}"`).join('\n')}`;
      }
    } catch {}

    const scene = data.scene || 'return';
    const intimacy = es.intimacy || 0.3;
    const tone = intimacy > 0.6 ? 'warm and intimate' : intimacy > 0.3 ? 'friendly and natural' : 'polite and gentle';

    const greetingPrompt = [
      `Generate a brief, natural spoken greeting in Chinese (under 60 characters).`,
      `Scene: user just ${scene === 'return' ? 'returned to their computer after being away' : scene === 'morning' ? 'started their day' : scene === 'evening' ? 'is winding down' : ' needs a check-in'}.`,
      `Tone: ${tone}.`,
      temporalBlock ? `\nCurrent context:\n${temporalBlock}` : '',
      memoryContext ? `\nRecent topics:\n${memoryContext}\nReference one naturally if relevant.` : '',
      dedupContext,
      `\nDo NOT sound like a report or template. Sound like a friend who noticed they're back. Vary your phrasing — never repeat the same greeting.`,
    ].filter(Boolean).join('\n');

    try {
      const greetingLLM = { ...getUserPreferredLLMConfig(session.userId, { maxTokens: 120, domain: session.domain, orgId: session.orgId }), scene: 'voice_greet' };
      const response = await makeLLMCall(
        [{ role: 'user', content: greetingPrompt }],
        [],
        greetingLLM,
        llmGetters.getDeepSeek,
        llmGetters.getGemini,
        llmGetters.getOpenAI,
        llmGetters.getAnthropic,
        llmGetters.getQwen,
        llmGetters.getOllama,
        llmGetters.getLmStudio,
        llmGetters.getArk,
        llmGetters.getXiaomi,
        llmGetters.getKimi,
        llmGetters.getGlm,
        llmGetters.getRelay,
      );

      recordTokenUsage(session.userId, greetingLLM.provider, greetingLLM.model, response.usage, `voice_greet_${Date.now()}`, 'voice');

      const greeting = response.text?.trim() || '';
      if (!greeting) throw new Error('Empty LLM response');

      const ttsProvider = resolveVoiceTtsProvider({ provider: session.currentVoiceProvider || undefined });
      if (!ttsProvider) return;

      const result = await synthesizeSpeech(greeting, { provider: ttsProvider, voiceId });
      socket.emit("audio:proactive_speak", {
        audioBuffer: result.audioBuffer,
        text: greeting,
        timestamp: new Date().toISOString(),
        volumeGain: computeVolumeGain(),
      });
      // Store greeting in memory for dedup
      addMemory({
        userId,
        type: 'fact',
        content: `[Greeting] ${greeting}`,
        keywords: ['greeting', scene, new Date().toISOString().slice(0, 10)],
        confidence: 1.0,
        sourceInteractionId: `greeting_${Date.now()}`,
        agentId: undefined,
      } as any, { tier: 'episodic', perspective: 'shared_memory', importance: 0.2, domain: session.domain, orgId: session.orgId, source: 'voice' });
      logger.info(`[Greeting] LLM-generated for ${userId}: "${greeting}"`);
    } catch (err: any) {
      logger.warn(`[Greeting] LLM generation failed, using fallback: ${err.message}`);
      // 【重构·模块4】固定话术模板移除（原: 按 6/12/18 小时写死问候句，目标⑥④）：回退由
      // composeTriggerContent 心智润色组成（实时状态数据 → 心智内核组织表述），离线再回退结构化摘要（容灾）。
      const fallback = await composeTriggerContent('voice_return_greeting', {
        hour: new Date().getHours(),
        intimacy: (es.intimacy || 0.3).toFixed(2),
        scene: data.scene || 'return',
      });
      try {
        const ttsProvider = resolveVoiceTtsProvider({ provider: session.currentVoiceProvider || undefined });
        if (ttsProvider) {
          const result = await synthesizeSpeech(fallback, { provider: ttsProvider, voiceId });
          socket.emit("audio:proactive_speak", { audioBuffer: result.audioBuffer, text: fallback, timestamp: new Date().toISOString(), volumeGain: computeVolumeGain() });
        }
      } catch {}
    }
  });

  socket.on("audio:switch-personality", (data: { personalityId: string }) => {
    const session = getAudioSession(socket);
    if (session.isActive) {
      session.personalityId = data.personalityId;
      logger.info(`[Audio] Personality switched to ${data.personalityId} mid-call`);
    }
  });

  socket.on("disconnect", () => {
    const session = socket.data.audioSession as AudioSession | undefined;
    if (session) {
      if (session.silenceTimer) { clearTimeout(session.silenceTimer); session.silenceTimer = null; }
      if (session.bargeinTimer) { clearTimeout(session.bargeinTimer); session.bargeinTimer = null; }
      for (const t of session.ttsDecayTimers) { clearTimeout(t); }
      session.ttsDecayTimers = [];
      if (session.sttSession) {
        session.sttSession.end();
        session.sttSession = null;
      }
    }
    logger.info(`[Socket] Client disconnected: ${socket.id}`);
  });
}
