/**
 * 意图识别 — 【重构】移除全部正则池（GREETINGS/SMALL_TALK/COMMAND_PATTERNS/QUESTION/CODE/WEB/FILE/SYSTEM/AGENT）
 * 原实现：关键词/正则前置分类（0 Token 捷径），并附带正则→工具直调（directToolCall）。
 * 重构后：**原始输入直送心智内核** —— 意图类别、实体、情绪倾向全部由 LLM 分类器一次判定
 * （classifyIntentLLM，缓存兜底）；正则池与 directToolCall 静态映射整体删除。
 * 仅保留：类型定义 + LLM 分类器 + 情绪数据透传。
 */

export interface SentimentResult {
  valence: number;      // -1..1 正向/负向
  urgency: number;      // 0..1 紧迫度
  frustration: number;  // 0..1 挫败度
}

export type IntentCategory =
  | 'command'       // Operational: open, list, run, create, delete
  | 'question'      // Information seeking
  | 'conversation'  // Casual chat, greeting, small talk
  | 'code'          // Code: read, write, fix, refactor, review
  | 'web'           // Web: search, fetch URL
  | 'file'          // File operations: read, list, find
  | 'system'        // System info, status
  | 'agent'         // Agent management: create, configure, list
  | 'analysis'      // Deep analysis: compare, evaluate, summarize, research
  | 'unknown';      // Fallback — needs LLM

export interface IntentResult {
  category: IntentCategory;
  confidence: number;       // 0–1
  entities: Record<string, string>;  // Extracted entities (file names, URLs, queries, music, etc.)
  subIntent?: string;       // e.g. for command: "open", "create", "delete"
  needsLLM: boolean;        // Whether this intent requires LLM text generation
  sentiment?: SentimentResult; // 情绪倾向（心智判定，替代原正则情绪识别）
}

/** 情绪数据透传：有心智判定值则返回，否则中性默认（不再做正则情绪猜测） */
export function extractSentiment(_text: string, intentSentiment?: SentimentResult): SentimentResult {
  return intentSentiment ?? { valence: 0, urgency: 0, frustration: 0 };
}

const intentCache = new Map<string, IntentResult>();
const INTENT_CACHE_MAX = 200;

const CLASSIFIER_PROMPT = `Classify this user input into exactly one category. Return ONLY a JSON object.

Categories: command, question, conversation, code, web, file, system, agent, analysis

Rules:
- command: action requests (open, create, run, delete, start, stop, set, toggle)
- question: information seeking (what, how, why, when, where, who, explain, tell me about)
- conversation: casual chat, greetings, thanks, small talk, emotional expression
- code: programming, debugging, code review, refactoring
- web: web search, fetch URL, browse
- file: file reading, writing, listing, finding
- system: OS info, settings, status
- agent: AI agent management, creation, configuration
- analysis: deep reasoning, comparison, evaluation, summarization, research

Entity extraction:
- If the user asks to play/listen to/pause music or a song, set entities.music to the song/artist/action (e.g. "周杰伦的歌", "我喜欢的歌", "换一首").
- If the user asks to analyze their liked-songs / music taste profile (网易云/喜欢的歌/音乐画像/听歌偏好), set entities.musicProfile to "true".
- If the user explicitly asks for background/async/delegated processing (后台处理/异步/不要等/分派给子agent), set entities.background to "true".
- If the user is correcting or contradicting Peppa (e.g. "不是…", "不对", "你错了", "不是这样的", "wrong", "incorrect", "actually", "you're wrong", correcting a previous claim), set entities.correction to "true".
- Otherwise extract any key noun (file path, URL, topic) into entities.

Sentiment: always estimate the user's tone:
- valence: -1 (very negative) .. 1 (very positive), 0 = neutral
- urgency: 0..1 how urgent the request feels
- frustration: 0..1 how frustrated/upset the user seems

Return: {"category":"...","confidence":0.X,"subIntent":"...","entities":{...},"sentiment":{"valence":0.0,"urgency":0.0,"frustration":0.0}}`;

/**
 * LLM 心智分类器（唯一意图判定通道，带 LRU 缓存）。
 * LLM 不可用时返回传入的兜底结果（保持管道不中断）。
 */
export async function classifyIntentLLM(
  text: string,
  base: IntentResult,
  llmCall: (prompt: string, userText: string) => Promise<string>,
): Promise<IntentResult> {
  const cached = intentCache.get(text);
  if (cached) return cached;

  try {
    const response = await llmCall(CLASSIFIER_PROMPT, text);
    const parsed = JSON.parse(response.trim());
    const rawEntities: Record<string, any> = { ...base.entities, ...(parsed.entities || {}) };
    // 【重构·校验修复】实体归一化：LLM 可能返回布尔 true / 'true' / "true"，下游门控统一按字符串 'true' 判定
    if (rawEntities.correction !== undefined) {
      rawEntities.correction = String(rawEntities.correction) === 'true' ? 'true' : String(rawEntities.correction);
    }
    const result: IntentResult = {
      category: parsed.category || base.category,
      confidence: parsed.confidence ?? base.confidence,
      entities: rawEntities,
      subIntent: parsed.subIntent || base.subIntent,
      needsLLM: base.needsLLM !== false,
      sentiment: parsed.sentiment && typeof parsed.sentiment === 'object'
        ? {
            valence: Number(parsed.sentiment.valence) || 0,
            urgency: Number(parsed.sentiment.urgency) || 0,
            frustration: Number(parsed.sentiment.frustration) || 0,
          }
        : undefined,
    };

    // LRU eviction
    if (intentCache.size >= INTENT_CACHE_MAX) {
      const first = intentCache.keys().next().value;
      if (first) intentCache.delete(first);
    }
    intentCache.set(text, result);
    return result;
  } catch {
    return base;
  }
}

/** 心智内核入口：原始输入 → LLM 意图判定（无正则前置） */
export async function classifyIntent(
  input: string,
  llmCall: (prompt: string, userText: string) => Promise<string>,
): Promise<IntentResult> {
  const text = input.trim();
  if (!text) {
    return { category: 'unknown', confidence: 0, entities: {}, needsLLM: true };
  }
  const base: IntentResult = { category: 'unknown', confidence: 0.3, entities: {}, needsLLM: true };
  return classifyIntentLLM(text, base, llmCall);
}
