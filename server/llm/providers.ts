import { ParsedToolCall, NormalizedLLMResponse } from '../tools/types';
import { withCloudResilience } from '../cloud/resilience';
import { isStrictPrivacy, requireLocalProvider } from '../config/privacy';
import { getScopedPreferredLLM } from './user_preferences';
import { getUserPreferredVision } from './vision_preferences';
import { llmCallsTotal, llmTokensTotal, llmCallDuration, llmCallsCancelledTotal, llmCallsErrorTotal } from '../lib/metrics';
import { logger } from '../lib/logger';
// DeepSeek 外部强制路由中间层（任务2/5/7）：心智层只产出内容，不知道存在两套模型；
// 全部模型分发（核心心智→pro / 外围→flash）、预算熔断、故障降级、调用记录都在此收敛。
import { resolveRoute, beforeCall, afterCall, shouldFallbackToFlash } from './mindRouter';
import { getRouterConfig } from './routerConfig';

// P2-11: 统一 LLM 调用配置 — scene 标记调用场景（chat/review/monologue/…）用于结构化埋点
export interface LLMCallConfig {
  provider: 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen' | 'ark' | 'ollama' | 'lmstudio' | 'xiaomi' | 'kimi' | 'glm' | 'relay' | 'auto';
  model: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
  signal?: AbortSignal;
  scene?: string;
  /** Phase-2（item 9）：重试次数覆盖（透传 withCloudResilience maxRetries）。
   *  不传 → 保持原默认 2 次（用户 chat 链路行为不变）；后台任务传 0（PEPPA_BG_LLM_RETRY）。 */
  retries?: number;
}

function recordLLMMetrics(provider: string, model: string, usage: any, startMs: number, opts?: { cancelled?: boolean; error?: string; scene?: string }) {
  try {
    llmCallsTotal.inc({ provider, model });
    if (usage?.promptTokens) llmTokensTotal.inc({ provider, model, type: 'input' }, usage.promptTokens);
    if (usage?.completionTokens) llmTokensTotal.inc({ provider, model, type: 'output' }, usage.completionTokens);
    llmCallDuration.observe({ provider, model }, (Date.now() - startMs) / 1000);
    if (opts?.cancelled) llmCallsCancelledTotal.inc({ provider, model });
    if (opts?.error) llmCallsErrorTotal.inc({ provider, model });
    // P2-11: 结构化日志埋点 — 场景/模型/供应商/tokens/耗时/取消/错误
    // 任务7：缓存命中（DeepSeek prompt_cache_hit_tokens）随调用日志输出，供前缀缓存命中率观测
    const status = opts?.cancelled ? 'cancelled' : opts?.error ? 'error' : 'ok';
    logger.info(
      `[LLM] ${status} scene=${opts?.scene || 'unknown'} provider=${provider} model=${model} promptTokens=${usage?.promptTokens ?? 0} completionTokens=${usage?.completionTokens ?? 0} cacheHitTokens=${usage?.cacheHitTokens ?? 0} durationMs=${Date.now() - startMs}${opts?.error ? ` error="${opts.error}"` : ''}`
    );
  } catch {}
}

export type MessageContent =
  | string
  | null
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }>;

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  toolCalls?: ParsedToolCall[];
  toolCallId?: string;
  name?: string;
  reasoningContent?: string | null;
}

interface ToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

type OpenAICompatibleMessage = {
  role: string;
  content: MessageContent;
  tool_calls?: any;
  tool_call_id?: string;
  name?: string;
};

function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map(part => part.type === 'text' ? part.text : '[image]')
    .join('\n')
    .trim();
}

function hasMeaningfulContent(content: MessageContent): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!content) return false;
  return content.length > 0;
}

function isQwenVisionModel(model: string): boolean {
  return /(?:qwen.*vl|vl-|vl_|vision)/i.test(model || '');
}

function assertQwenAllowedByUserPrefs(config: { provider: string; model: string; userId?: string; domain?: string; orgId?: string }): void {
  if (config.provider !== 'qwen') return;

  if (!config.userId) {
    throw new Error('Qwen model call blocked: missing user preference context. Pass userId so Peppa can respect the selected brain/vision provider.');
  }

  if (isQwenVisionModel(config.model)) {
    const vision = getUserPreferredVision(config.userId);
    if (vision.provider === 'qwen') return;
    throw new Error(`Qwen-VL call blocked: current vision provider is ${vision.provider}/${vision.model}. Change Vision Model to Qwen-VL to use Alibaba vision.`);
  }

  const preferred = getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId });
  if (preferred.provider !== 'qwen') {
    throw new Error(`Qwen LLM call blocked: current primary reasoning brain is ${preferred.provider}/${preferred.model}. Change Primary Reasoning Brain to Qwen to use Alibaba LLM.`);
  }
}

function toolResultAsUserMessage(m: NormalizedMessage): OpenAICompatibleMessage | null {
  const text = contentToText(m.content).trim();
  if (!text) return null;
  const name = m.name ? ` ${m.name}` : '';
  return {
    role: 'user',
    content: `[Tool result${name}]\n${text}`,
  };
}

function buildOpenAICompatibleMessages(messages: NormalizedMessage[]): OpenAICompatibleMessage[] {
  const raw: OpenAICompatibleMessage[] = [];

  for (const m of messages) {
    const roleMap: Record<string, string> = { assistant: 'assistant', tool: 'tool', system: 'system', user: 'user' };
    const role = roleMap[m.role] || 'user';

    if (role === 'tool') {
      if (!m.toolCallId) {
        const fallback = toolResultAsUserMessage(m);
        if (fallback) raw.push(fallback);
        continue;
      }
      raw.push({
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: m.toolCallId,
        ...(m.name ? { name: m.name } : {}),
      });
      continue;
    }

    const validToolCalls = (m.toolCalls || [])
      .filter(tc => tc?.id && tc?.name)
      .map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      }));

    if (!hasMeaningfulContent(m.content) && validToolCalls.length === 0) continue;

    raw.push({
      role,
      content: m.content ?? '',
      ...(validToolCalls.length > 0 ? { tool_calls: validToolCalls } : {}),
    });
  }

  const sanitized: OpenAICompatibleMessage[] = [];
  const expectedToolIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];

    if (entry.role === 'assistant' && Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
      const ids = entry.tool_calls.map((tc: any) => tc.id).filter(Boolean);
      const following = raw.slice(i + 1, i + 1 + ids.length);
      const hasImmediateResults =
        ids.length === entry.tool_calls.length &&
        following.length === ids.length &&
        following.every(next => next.role === 'tool' && next.tool_call_id && ids.includes(next.tool_call_id));

      if (hasImmediateResults) {
        sanitized.push(entry);
        ids.forEach(id => expectedToolIds.add(id));
      } else if (hasMeaningfulContent(entry.content)) {
        const { tool_calls, ...plainAssistant } = entry;
        sanitized.push(plainAssistant);
      }
      continue;
    }

    if (entry.role === 'tool') {
      if (entry.tool_call_id && expectedToolIds.has(entry.tool_call_id)) {
        sanitized.push(entry);
        expectedToolIds.delete(entry.tool_call_id);
      } else {
        const fallback = toolResultAsUserMessage({
          role: 'tool',
          content: entry.content,
          toolCallId: entry.tool_call_id,
          name: entry.name,
        });
        if (fallback) sanitized.push(fallback);
      }
      continue;
    }

    sanitized.push(entry);
  }

  // ── DeepSeek 前缀缓存适配（任务3）：system 消息稳定置顶 ──
  // KV 缓存按「请求前缀」命中：固定不变的 system prompt / schema / MCP 定义必须位于消息序列
  // 最前，动态对话、动态状态永远追加在后。此处做最终顺序保障：所有 system 消息稳定前移
  // （保持彼此相对顺序），其余消息顺序不变。
  // ⚠️ 注意：频繁修改 system 头部内容会破坏 KV 缓存命中率 —— 新增动态素材必须追加到
  // system 末尾或作为后续 user 消息，禁止插入到 system 头部。
  if (sanitized.length > 1 && sanitized[0]?.role !== 'system') {
    const systemMsgs = sanitized.filter(m => m.role === 'system');
    if (systemMsgs.length > 0) {
      const restMsgs = sanitized.filter(m => m.role !== 'system');
      return [...systemMsgs, ...restMsgs];
    }
  }
  return sanitized;
}

// ── DeepSeek (OpenAI-compatible) ──

export function formatDeepSeekRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
  userId?: string;
}): {
  model: string;
  messages: Array<{ role: string; content: MessageContent; tool_calls?: any; tool_call_id?: string }>;
  tools?: ToolDeclaration[];
  tool_choice?: string;
  max_tokens?: number;
  user?: string;
} {
  const openaiMessages = buildOpenAICompatibleMessages(params.messages);

  const hasTools = params.toolDeclarations.length > 0;

  // ── DeepSeek 前缀缓存适配（任务3）：请求组装顺序 = [固定 system 头部] → [固定 tools/schema]
  // → [动态消息]。
  //   1. messages 内 system 已由 buildOpenAICompatibleMessages 保证置顶（稳定前缀）；
  //   2. toolDeclarations（MCP/技能定义）为静态清单，紧随其后（字段顺序与缓存无关，但保持
  //      稳定一致即可最大化前缀复用）；
  //   3. 动态对话、动态状态（快照/摘要）全部位于消息序列末尾，永不插入头部。
  // ⚠️ 注意：频繁修改 system 头部内容会破坏 KV 缓存命中率；业务侧新增动态素材必须追加在尾。
  return {
    model: params.model,
    messages: openaiMessages,
    ...(hasTools ? { tools: params.toolDeclarations, tool_choice: 'auto' } : {}),
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    ...(params.userId ? { user: params.userId.replace(/[^a-zA-Z0-9_-]/g, '_') } : {}),
  };
}

function extractUsage(rawResponse: any) {
  const usage = rawResponse.usage || rawResponse.usageMetadata;
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens || usage.promptTokenCount || usage.input_tokens || usage.inputTokens || 0,
    completionTokens: usage.completion_tokens || usage.candidatesTokenCount || usage.output_tokens || usage.outputTokens || 0,
    totalTokens: usage.total_tokens || usage.totalTokenCount || 0,
    // 任务3/7：DeepSeek 前缀缓存命中 token（prompt_cache_hit_tokens）— 用于观测 KV 缓存命中率
    cacheHitTokens: usage.prompt_cache_hit_tokens || usage.cached_content_token_count || 0,
  };
}

export function parseDeepSeekResponse(rawResponse: any): NormalizedLLMResponse {
  const message = rawResponse.choices?.[0]?.message;
  if (!message) return { text: null, toolCalls: null };

  // Keep hidden reasoning hidden. `reasoning_content` is useful for diagnostics
  // and follow-up model calls, but it must never become user-visible text/TTS.
  const text = message.content || null;
  const reasoningContent = message.reasoning_content || null;
  const usage = extractUsage(rawResponse);

  if (message.tool_calls && message.tool_calls.length > 0) {
    const toolCalls: ParsedToolCall[] = message.tool_calls.map((tc: any) => {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch { /* ignore parse errors */ }
      return { id: tc.id, name: tc.function?.name || '', arguments: args };
    });
    return { text, toolCalls, reasoningContent, usage };
  }

  return { text, toolCalls: null, reasoningContent, usage };
}

// ── Gemini ──

function geminiPartsFromContent(content: MessageContent): any[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!content) return [{ text: '' }];

  const parts: any[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
      continue;
    }

    const url = part.image_url?.url || '';
    const dataUrl = url.match(/^data:([^;]+);base64,(.+)$/);
    if (dataUrl) {
      parts.push({
        inlineData: {
          mimeType: dataUrl[1],
          data: dataUrl[2],
        },
      });
    } else if (url) {
      parts.push({
        fileData: {
          mimeType: 'image/jpeg',
          fileUri: url,
        },
      });
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

export function formatGeminiRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
}): {
  modelConfig: { model: string; systemInstruction?: string; tools?: Array<{ functionDeclarations: any[] }> };
  contents: Array<{ role: string; parts: any[] }>;
} {
  // Extract system message for Gemini's separate systemInstruction param
  let systemInstruction: string | undefined;
  const nonSystemMessages = params.messages.filter(m => {
    if (m.role === 'system' && m.content) {
      systemInstruction = m.content as string;
      return false;
    }
    return true;
  });

  // Convert messages to Gemini contents format
  const contents: Array<{ role: string; parts: any[] }> = [];

  for (const m of nonSystemMessages) {
    if (m.role === 'tool') {
      // Tool results become user messages with functionResponse
      const prevContent = contents.length > 0 ? contents[contents.length - 1] : null;
      if (prevContent && prevContent.role === 'model') {
        // Append functionResponse to a new user message
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.name || '',
              response: { content: m.content || '' },
            },
          }],
        });
      } else {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.name || '',
              response: { content: m.content || '' },
            },
          }],
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) {
        parts.push(...geminiPartsFromContent(m.content));
      }
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.arguments,
            },
          });
        }
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // user messages
    contents.push({
      role: 'user',
      parts: geminiPartsFromContent(m.content),
    });
  }

  const hasTools = params.toolDeclarations.length > 0;

  const modelConfig: any = { model: params.model };
  if (systemInstruction) modelConfig.systemInstruction = systemInstruction;
  if (hasTools) {
    modelConfig.tools = [{
      functionDeclarations: params.toolDeclarations.map(td => ({
        name: td.function.name,
        description: td.function.description,
        parameters: td.function.parameters,
      })),
    }];
  }

  return { modelConfig, contents };
}

export function parseGeminiResponse(rawResponse: any): NormalizedLLMResponse {
  const candidate = rawResponse.candidates?.[0];
  if (!candidate) return { text: null, toolCalls: null };

  const parts = candidate.content?.parts || [];
  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];

  for (const part of parts) {
    if (part.text) {
      textParts.push(part.text);
    }
    if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${toolCalls.length}`,
        name: part.functionCall.name || '',
        arguments: part.functionCall.args || {},
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage: extractUsage(rawResponse),
  };
}

// ── OpenAI (same API format as DeepSeek) ──

export const formatOpenAIRequest = formatDeepSeekRequest;
export const parseOpenAIResponse = parseDeepSeekResponse;

// ── Qwen / DashScope (OpenAI-compatible API) ──

export function formatQwenRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
  userId?: string;
}): {
  model: string;
  messages: Array<{ role: string; content: MessageContent; tool_calls?: any; tool_call_id?: string }>;
  tools?: ToolDeclaration[];
  tool_choice?: string;
  max_tokens?: number;
} {
  const openaiMessages = buildOpenAICompatibleMessages(params.messages);

  const hasTools = params.toolDeclarations.length > 0;

  return {
    model: params.model,
    messages: openaiMessages,
    ...(hasTools ? { tools: params.toolDeclarations, tool_choice: 'auto' } : {}),
    ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    // DashScope does not support the OpenAI `user` parameter — omit it
  };
}

// ── Anthropic ──

export function formatAnthropicRequest(params: {
  model: string;
  messages: NormalizedMessage[];
  toolDeclarations: ToolDeclaration[];
  maxTokens?: number;
}): { model: string; max_tokens: number; system?: string; messages: any[]; tools?: any[] } {
  // Extract system message to top-level
  let system: string | undefined;
  const nonSystem = params.messages.filter(m => {
    if (m.role === 'system' && m.content) {
      system = m.content as string;
      return false;
    }
    return true;
  });

  const anthropicMessages: any[] = [];

  for (const m of nonSystem) {
    if (m.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '' }],
      });
    } else if (m.role === 'assistant') {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
      }
      anthropicMessages.push({ role: 'assistant', content });
    } else {
      anthropicMessages.push({ role: 'user', content: m.content || '' });
    }
  }

  const hasTools = params.toolDeclarations.length > 0;
  const tools = hasTools
    ? params.toolDeclarations.map(td => ({
        name: td.function.name,
        description: td.function.description,
        input_schema: td.function.parameters,
      }))
    : undefined;

  return {
    model: params.model,
    max_tokens: params.maxTokens || 4096,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
    ...(tools ? { tools } : {}),
  };
}

export function parseAnthropicResponse(rawResponse: any): NormalizedLLMResponse {
  const content = rawResponse.content || [];
  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    usage: extractUsage(rawResponse),
  };
}

// ── LLM Call Router ──

async function makeLLMCallCore(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<NormalizedLLMResponse> {
  assertQwenAllowedByUserPrefs(config);
  const _start = Date.now();

  // Phase-2（item 9）：重试收紧 — 后台任务经门闸注入 retries=0（PEPPA_BG_LLM_RETRY，失败即放弃，
  // 防重试风暴）；用户 chat 链路不传 → 保持原默认 2 次重试行为不变。
  const retries = config.retries ?? 2;

  // ── Privacy gate: strict mode blocks cloud providers ──
  // Reasoning models need high token budget — their CoT eats into max_tokens
  const maxTokens = isReasoningModel(config.model)
    ? Math.max(config.maxTokens || 8000, 4000)
    : config.maxTokens;

  if (isStrictPrivacy()) {
    if (config.provider === 'auto') {
      // In strict mode, auto routes to local-only dispatch
      const { dispatchLLMCall } = await import('./dispatch');
      const localGetters = { getDeepSeek, getGemini, getOpenAI: getOpenAI || (() => null), getAnthropic: getAnthropic || (() => null), getQwen: getQwen || (() => null), getArk: getArk || (() => null), getOllama, isOllamaAvailable: () => !!getOllama?.(), getLmStudio, isLmStudioAvailable: () => !!getLmStudio?.() };
      if (getOllama?.()) {
        try {
          const req = formatDeepSeekRequest({ model: 'llama3.2', messages, toolDeclarations, maxTokens: maxTokens, userId: config.userId });
          const client = getOllama();
          const res = await withCloudResilience(
            () => client.chat.completions.create(req, { signal: config.signal }),
            { provider: 'ollama', maxRetries: 1 }
          );
          return parseOpenAIResponse(res);
        } catch {
          if (getLmStudio?.()) {
            try {
              const req = formatDeepSeekRequest({ model: config.model, messages, toolDeclarations, maxTokens: maxTokens, userId: config.userId });
              const client = getLmStudio();
              // P1-1: 本地非流式调用同样透传 AbortSignal + 熔断包装，上层取消时中止在途请求
              const res = await withCloudResilience(
                () => client.chat.completions.create(req, { signal: config.signal }),
                { provider: 'lmstudio', maxRetries: 1 },
              );
              return parseOpenAIResponse(res);
            } catch {}
          }
          throw new Error('[Privacy] Strict mode: no local LLM available. Start Ollama or LM Studio.');
        }
      }
      if (getLmStudio?.()) {
        const req = formatDeepSeekRequest({ model: config.model, messages, toolDeclarations, maxTokens: maxTokens, userId: config.userId });
        const client = getLmStudio();
        const res = await withCloudResilience(
          () => client.chat.completions.create(req, { signal: config.signal }),
          { provider: 'lmstudio', maxRetries: 1 },
        );
        return parseOpenAIResponse(res);
      }
      throw new Error('[Privacy] Strict mode: no local LLM provider available. Set up Ollama or LM Studio.');
    }
    requireLocalProvider(config.provider);
  }

  // ── Auto/hybrid dispatch: local Ollama → cloud DeepSeek fallback ──
  if (config.provider === 'auto' && getOllama) {
    const { dispatchLLMCall } = await import('./dispatch');
    const getters = { getDeepSeek, getGemini, getOpenAI: getOpenAI || (() => null), getAnthropic: getAnthropic || (() => null), getQwen: getQwen || (() => null), getArk: getArk || (() => null), getOllama, isOllamaAvailable: () => !!getOllama?.(), getLmStudio, isLmStudioAvailable: () => !!getLmStudio?.() };
    const result = await dispatchLLMCall(messages, toolDeclarations, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: maxTokens, userId: config.userId, signal: config.signal, scene: config.scene }, getters);
    recordLLMMetrics(config.provider, config.model, result.usage, _start, { scene: config.scene });
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage };
  }

  // OpenAI-compatible path: DeepSeek, Qwen, Ark, Ollama, LM Studio
  if (config.provider === 'deepseek' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const client = config.provider === 'deepseek' ? getDeepSeek()
      : config.provider === 'qwen' ? getQwen?.()
      : config.provider === 'ark' ? getArk?.()
      : config.provider === 'lmstudio' ? getLmStudio?.()
      : config.provider === 'xiaomi' ? getXiaomi?.()
      : config.provider === 'kimi' ? getKimi?.()
      : config.provider === 'glm' ? getGlm?.()
      : config.provider === 'relay' ? getRelay?.()
      : getOllama?.();
    if (!client) throw new Error(`${config.provider} not configured`);

    const fmt = config.provider === 'qwen' ? formatQwenRequest : formatDeepSeekRequest;
    const isLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
    const params = fmt({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      ...(isLocal ? {} : { userId: config.userId }),
    });

    const response = await withCloudResilience(
      () => client.chat.completions.create(params, { signal: config.signal }),
      { provider: config.provider, model: config.model, maxRetries: retries },
    );
    const _res = parseDeepSeekResponse(response); recordLLMMetrics(config.provider, config.model, _res.usage, _start, { scene: config.scene }); return _res;
  }

  if (config.provider === 'gemini') {
    const client = getGemini();
    if (!client) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');

    const { modelConfig, contents } = formatGeminiRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    const result = await withCloudResilience(
      () => modelInstance.generateContent({ contents }, { signal: config.signal }),
      { provider: 'gemini', model: config.model, maxRetries: retries },
    );
    const _res = parseGeminiResponse(result); recordLLMMetrics(config.provider, config.model, _res.usage, _start, { scene: config.scene }); return _res;
  }

  if (config.provider === 'openai') {
    const client = getOpenAI?.();
    if (!client) throw new Error('OpenAI not configured (OPENAI_API_KEY missing)');

    const params = formatOpenAIRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      userId: config.userId,
    });

    const response = await withCloudResilience(
      () => client.chat.completions.create(params, { signal: config.signal }),
      { provider: 'openai', model: config.model, maxRetries: retries },
    );
    const _res = parseOpenAIResponse(response); recordLLMMetrics(config.provider, config.model, _res.usage, _start, { scene: config.scene }); return _res;
  }

  if (config.provider === 'anthropic') {
    const client = getAnthropic?.();
    if (!client) throw new Error('Anthropic not configured (ANTHROPIC_API_KEY missing)');

    const params = formatAnthropicRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const response = await withCloudResilience(
      () => client.messages.create(params, { signal: config.signal }),
      { provider: 'anthropic', model: config.model, maxRetries: retries },
    );
    const _res = parseAnthropicResponse(response); recordLLMMetrics(config.provider, config.model, _res.usage, _start, { scene: config.scene }); return _res;
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}

/** 用户对话场景：重试保持 2 次（可靠优先，与 tokenBudget 用户白名单一致） */
const USER_RETRY_SCENES: ReadonlySet<string> = new Set([
  'chat', 'task', 'voice', 'summary', 'classifier', 'identity_check', 'music', 'stream',
]);

/**
 * Phase-2（item 9）：后台场景默认重试次数。
 * PEPPA_BG_LLM_RETRY（默认 0）— 后台任务失败即放弃本轮（防重试风暴），
 * 用户对话场景恒为 2 次（chat 重试行为保持不变）。调用方显式传 config.retries 优先。
 */
function defaultRetriesForScene(scene?: string): number {
  if (scene && USER_RETRY_SCENES.has(scene)) return 2;
  const v = Number(process.env.PEPPA_BG_LLM_RETRY);
  return Number.isFinite(v) && v >= 0 ? Math.min(5, Math.floor(v)) : 0;
}

// P2-11: 统一埋点包装 — 成功路径由 core 各分支 recordLLMMetrics 记录，取消/失败在此兜底
// ── DeepSeek 外部强制路由（任务2/5/7）挂钩点：
//   1. beforeCall   — 预算熔断：休眠只读态下核心心智调用直接拒绝（不发起任何 LLM 请求）；
//   2. resolveRoute — 模型强制分发：核心心智→deepseek-v4-pro / 外围→deepseek-v4-flash；
//   3. 故障降级     — pro 主模型 API 报错/限流/余额不足时应急降级 flash 重试一次
//                     （scene=inner_tick 例外：降级状态禁止触发完整 InnerTick 深度推演）；
//   4. afterCall    — 预算记账 + 全量调用记录（模型/来源/输入输出token/耗时/缓存命中/是否降级）。
// 心智层业务代码（innerTick/life TICK/自我反思）零改动，路由完全在调用汇聚点外置执行。
export async function makeLLMCall(...args: Parameters<typeof makeLLMCallCore>): Promise<NormalizedLLMResponse> {
  const [messages, toolDeclarations, config] = args;
  const start = Date.now();

  // ① 预算熔断（核心心智休眠只读模式）
  beforeCall(config.scene);

  // ② 模型强制分发
  const routed = resolveRoute(config);
  // Phase-2（item 9）：重试默认值注入 — 后台场景 0 次（PEPPA_BG_LLM_RETRY），用户对话场景 2 次
  const retries = config.retries ?? defaultRetriesForScene(config.scene);
  const effective: LLMCallConfig = routed
    ? { ...config, provider: routed.provider as LLMCallConfig['provider'], model: routed.model, retries }
    : { ...config, retries };
  const coreArgs = [messages, toolDeclarations, effective, ...args.slice(3)] as Parameters<typeof makeLLMCallCore>;

  try {
    const result = await makeLLMCallCore(...coreArgs);
    // ③ 预算记账 + 调用记录（成功路径）
    afterCall(routed, effective, result.usage, start);
    return result;
  } catch (err: any) {
    // ④ 故障降级：仅核心心智 + API 报错/限流/余额不足 → flash 应急重试一次
    if (routed?.tier === 'core_mind' && shouldFallbackToFlash(config.scene, err)) {
      const flashModel = getRouterConfig().flashModel;
      logger.warn(`[LLMRouter] pro 主模型故障（${String(err?.message || err).slice(0, 160)}）→ 应急降级 ${flashModel} 重试一次（仅本次，接口恢复后自动切回 pro）`);
      try {
        const fbConfig: LLMCallConfig = { ...effective, model: flashModel };
        const fbArgs = [messages, toolDeclarations, fbConfig, ...args.slice(3)] as Parameters<typeof makeLLMCallCore>;
        const fbResult = await makeLLMCallCore(...fbArgs);
        afterCall(routed, fbConfig, fbResult.usage, start, { degraded: true });
        return fbResult;
      } catch (fbErr: any) {
        afterCall(routed, effective, undefined, start, { error: `pro失败(${String(err?.message || err).slice(0, 120)}) + flash降级也失败(${String(fbErr?.message || fbErr).slice(0, 120)})` });
        const msg = String(err?.message || err);
        const cancelled = err?.name === 'AbortError' || err?.name?.includes('Abort') || /abort/i.test(msg);
        recordLLMMetrics(config.provider, config.model, undefined, start, {
          cancelled,
          error: cancelled ? undefined : msg.slice(0, 300),
          scene: config.scene,
        });
        throw err;
      }
    }

    const msg = String(err?.message || err);
    const cancelled = err?.name === 'AbortError' || err?.name?.includes('Abort') || /abort/i.test(msg);
    afterCall(routed, effective, undefined, start, { error: cancelled ? undefined : msg.slice(0, 300) });
    recordLLMMetrics(config.provider, config.model, undefined, start, {
      cancelled,
      error: cancelled ? undefined : msg.slice(0, 300),
      scene: config.scene,
    });
    throw err;
  }
}

// ── Streaming LLM Call Router ──

export type StreamCallback = (chunk: string) => void;

function isReasoningModel(model: string): boolean {
  return /reasoner|v4-(pro|flash)|o[13]|o4-mini|r1/i.test(model);
}

async function makeLLMCallStreamingCore(
  messages: NormalizedMessage[],
  toolDeclarations: ToolDeclaration[],
  config: LLMCallConfig,
  onChunk: StreamCallback,
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
): Promise<NormalizedLLMResponse> {
  assertQwenAllowedByUserPrefs(config);
  const _start = Date.now();

  // Phase-2（item 9）：重试收紧 — 同非流式，后台任务 retries=0，用户链路默认 2 次不变
  const retries = config.retries ?? 2;

  // ── Privacy gate ──
  if (isStrictPrivacy() && config.provider !== 'auto') {
    requireLocalProvider(config.provider);
  }

  // Reasoning models need high token budget
  const maxTokens = isReasoningModel(config.model)
    ? Math.max(config.maxTokens || 8000, 4000)
    : config.maxTokens;

  // ── Auto/hybrid dispatch: local Ollama → cloud DeepSeek fallback ──
  if (config.provider === 'auto' && getOllama) {
    const { dispatchLLMCallStreaming } = await import('./dispatch');
    const getters = { getDeepSeek, getGemini, getOpenAI: getOpenAI || (() => null), getAnthropic: getAnthropic || (() => null), getQwen: getQwen || (() => null), getArk: getArk || (() => null), getOllama, isOllamaAvailable: () => !!getOllama?.(), getLmStudio, isLmStudioAvailable: () => !!getLmStudio?.() };
    const result = await dispatchLLMCallStreaming(messages, toolDeclarations, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: maxTokens, userId: config.userId, signal: config.signal, scene: config.scene }, onChunk, getters);
    recordLLMMetrics(config.provider, config.model, result.usage, _start, { scene: config.scene });
    return { text: result.text, toolCalls: result.toolCalls, usage: result.usage };
  }

  // ── DeepSeek / OpenAI / Qwen / Ark / Ollama / LM Studio (OpenAI-compatible streaming) ──
  if (config.provider === 'deepseek' || config.provider === 'openai' || config.provider === 'qwen' || config.provider === 'ark' || config.provider === 'ollama' || config.provider === 'lmstudio' || config.provider === 'xiaomi' || config.provider === 'kimi' || config.provider === 'glm' || config.provider === 'relay') {
    const client = config.provider === 'deepseek' ? getDeepSeek()
      : config.provider === 'openai' ? getOpenAI?.()
      : config.provider === 'qwen' ? getQwen?.()
      : config.provider === 'ark' ? getArk?.()
      : config.provider === 'lmstudio' ? getLmStudio?.()
      : config.provider === 'xiaomi' ? getXiaomi?.()
      : config.provider === 'kimi' ? getKimi?.()
      : config.provider === 'glm' ? getGlm?.()
      : config.provider === 'relay' ? getRelay?.()
      : getOllama?.();
    if (!client) throw new Error(`${config.provider} not configured`);

    const fmt = config.provider === 'qwen' ? formatQwenRequest : formatDeepSeekRequest;
    const isLocal = config.provider === 'ollama' || config.provider === 'lmstudio';
    const params: any = fmt({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
      ...(isLocal ? {} : { userId: config.userId }),
    });
    params.stream = true;

    const stream: any = await withCloudResilience(
      () => client.chat.completions.create(params, { signal: config.signal }),
      { provider: config.provider, model: config.model, maxRetries: retries },
    );
    const accumulatedText: string[] = [];
    const accumulatedReasoning: string[] = [];
    const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();
    let streamUsage: any = undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta) {
        if (delta.content) {
          accumulatedText.push(delta.content);
          onChunk(delta.content);
        }

        if (delta.reasoning_content) {
          accumulatedReasoning.push(delta.reasoning_content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulators.has(idx)) {
              toolCallAccumulators.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
            }
            const acc = toolCallAccumulators.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }
      }
      if (chunk.usage) streamUsage = chunk.usage;
    }

    // P2 修复：本地 Ollama/LM Studio 在 abort 信号时静默结束流（不抛 AbortError）→
    // for-await 自然退出会误记为 ok。信号已中断时改记 cancelled，token 置 0（与云端行为一致）。
    // 云端模型 abort 会抛 AbortError 走异常路径，不经过此分支，原有埋点逻辑不受影响。
    if ((config.provider === 'ollama' || config.provider === 'lmstudio') && config.signal?.aborted) {
      const usage0 = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      recordLLMMetrics(config.provider, config.model, usage0, _start, { scene: config.scene, cancelled: true });
      return { text: null, toolCalls: null, reasoningContent: null, usage: usage0 };
    }

    const usage = extractUsage({ usage: streamUsage });
    recordLLMMetrics(config.provider, config.model, usage, _start, { scene: config.scene });

    const text = accumulatedText.length > 0 ? accumulatedText.join('') : null;
    const reasoningContent = accumulatedReasoning.length > 0 ? accumulatedReasoning.join('') : null;
    if (toolCallAccumulators.size > 0) {
      const toolCalls: ParsedToolCall[] = [...toolCallAccumulators.values()].map(acc => {
        let args: Record<string, any> = {};
        try { args = JSON.parse(acc.args || '{}'); } catch { /* ignore parse errors */ }
        return { id: acc.id, name: acc.name, arguments: args };
      });
      return { text, toolCalls, reasoningContent, usage };
    }
    return { text, toolCalls: null, reasoningContent, usage };
  }

  // ── Gemini streaming ──
  if (config.provider === 'gemini') {
    const client = getGemini();
    if (!client) throw new Error('Gemini not configured (GEMINI_API_KEY missing)');

    const { modelConfig, contents } = formatGeminiRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const modelInstance = client.getGenerativeModel(modelConfig);
    const result: any = await withCloudResilience(
      () => modelInstance.generateContentStream({ contents }),
      { provider: 'gemini', model: config.model, maxRetries: retries },
    );

    const accumulatedText: string[] = [];
    const toolCalls: ParsedToolCall[] = [];

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        accumulatedText.push(text);
        onChunk(text);
      }
      const calls = chunk.functionCalls();
      if (calls) {
        for (let i = 0; i < calls.length; i++) {
          toolCalls.push({
            id: `gemini-${Date.now()}-${toolCalls.length}`,
            name: calls[i].name || '',
            arguments: calls[i].args || {},
          });
        }
      }
    }

    // Also check the aggregated response for function calls + usage
    const aggregated = await result.response;
    const parsed = parseGeminiResponse(aggregated);
    recordLLMMetrics(config.provider, config.model, parsed.usage, _start, { scene: config.scene });

    return {
      text: accumulatedText.length > 0 ? accumulatedText.join('') : parsed.text,
      toolCalls: parsed.toolCalls && parsed.toolCalls.length > 0 ? parsed.toolCalls : (toolCalls.length > 0 ? toolCalls : null),
      usage: parsed.usage,
    };
  }

  // ── Anthropic streaming ──
  if (config.provider === 'anthropic') {
    const client = getAnthropic?.();
    if (!client) throw new Error('Anthropic not configured (ANTHROPIC_API_KEY missing)');

    const params = formatAnthropicRequest({
      model: config.model,
      messages,
      toolDeclarations,
      maxTokens: maxTokens,
    });

    const stream: any = await withCloudResilience(
      () => client.messages.stream(params),
      { provider: 'anthropic', model: config.model, maxRetries: retries },
    );

    const textParts: string[] = [];
    const toolCalls: ParsedToolCall[] = [];
    // Accumulate tool_use blocks during stream (not just from finalMessage)
    const toolUseAccumulators: Map<string, { id: string; name: string; args: Record<string, any> }> = new Map();

    for await (const event of stream) {
      if (event.type === 'text' && event.text) {
        textParts.push(event.text);
        onChunk(event.text);
      }
      if (event.type === 'content_block_start' && (event as any).content_block?.type === 'tool_use') {
        const block = (event as any).content_block;
        toolUseAccumulators.set(block.id, { id: block.id, name: block.name, args: {} });
      }
      if (event.type === 'content_block_delta' && (event as any).delta?.type === 'input_json_delta') {
        const delta = (event as any).delta;
        // Partial JSON — accumulate for complete parse at end
        const acc = [...toolUseAccumulators.values()].find(a => !a.name || Object.keys(a.args).length === 0);
        if (acc) {
          try { acc.args = { ...acc.args, ...JSON.parse(delta.partial_json || '{}') }; } catch {}
        }
      }
    }

    // Get final message for complete tool use blocks + usage
    const finalMessage = await stream.finalMessage();
    // Prefer stream-accumulated tool calls; fall back to finalMessage blocks
    if (toolUseAccumulators.size > 0) {
      for (const acc of toolUseAccumulators.values()) {
        toolCalls.push({ id: acc.id, name: acc.name, arguments: acc.args });
      }
    } else {
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input || {},
          });
        }
      }
    }

    const finalUsage = extractUsage(finalMessage);
    recordLLMMetrics(config.provider, config.model, finalUsage, _start, { scene: config.scene });

    return {
      text: textParts.length > 0 ? textParts.join('') : null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage: finalUsage,
    };
  }

  throw new Error(`Unsupported streaming provider: ${config.provider}`);
}

// P2-11: 统一埋点包装（流式）— 取消/失败兜底记录
// ── DeepSeek 外部强制路由挂钩点（与 makeLLMCall 一致：预算熔断 + 模型强制分发 + 调用记录）。
// 注：流式路径不做 pro→flash 降级重试 —— 流式调用目前全部为外围场景（chat/voice），
// 且中途降级会向客户端重复推送已发出的 chunk，得不偿失。
export async function makeLLMCallStreaming(...args: Parameters<typeof makeLLMCallStreamingCore>): Promise<NormalizedLLMResponse> {
  const [messages, toolDeclarations, config] = args;
  const start = Date.now();

  // ① 预算熔断（核心心智休眠只读模式）
  beforeCall(config.scene);

  // ② 模型强制分发
  const routed = resolveRoute(config);
  // Phase-2（item 9）：重试默认值注入（流式同非流式 — 后台场景 0 次，用户对话场景 2 次）
  const retries = config.retries ?? defaultRetriesForScene(config.scene);
  const effective: LLMCallConfig = routed
    ? { ...config, provider: routed.provider as LLMCallConfig['provider'], model: routed.model, retries }
    : { ...config, retries };
  const coreArgs = [messages, toolDeclarations, effective, ...args.slice(3)] as Parameters<typeof makeLLMCallStreamingCore>;

  try {
    const result = await makeLLMCallStreamingCore(...coreArgs);
    // ③ 预算记账 + 调用记录（成功路径）
    afterCall(routed, effective, result.usage, start);
    return result;
  } catch (err: any) {
    const msg = String(err?.message || err);
    const cancelled = err?.name === 'AbortError' || err?.name?.includes('Abort') || /abort/i.test(msg);
    afterCall(routed, effective, undefined, start, { error: cancelled ? undefined : msg.slice(0, 300) });
    recordLLMMetrics(config.provider, config.model, undefined, start, {
      cancelled,
      error: cancelled ? undefined : msg.slice(0, 300),
      scene: config.scene,
    });
    throw err;
  }
}

// ── Token estimation ──────────────────────────────────────────────────────

/**
 * Quick token count heuristic.
 * English: ~4 chars/token. CJK: ~1.5 chars/token.
 * Fallback: 3 chars/token for mixed content.
 */
export function estimateTokenCount(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk++;
    } else if (code < 0x80) {
      ascii++;
    } else {
      // Punctuation, emoji, etc — count as 1 token each
      cjk++;
    }
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);
}
