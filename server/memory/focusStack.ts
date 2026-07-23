// BaiLongma 风格焦点栈 — 话题层级管理 + LLM 压缩摘要
import { addInteractionMemory } from '../db/lifeDb.js';
import { makeLLMCall, NormalizedMessage } from '../llm/providers.js';
import { logger } from '../lib/logger.js';

interface TopicFrame {
  topic: string;
  context: string;        // 用户消息上下文
  timestamp: number;
  summary: string | null; // 弹出时 LLM 生成
}

interface FocusStackState {
  stack: TopicFrame[];
  updatedAt: number;
}

const MAX_STACK_DEPTH = 8;
const SUMMARY_MAX_CHARS = 100;

// 内存单例
let state: FocusStackState = { stack: [], updatedAt: Date.now() };

/** LLM 摘要 prompt */
function buildSummaryPrompt(topic: string, context: string): NormalizedMessage[] {
  return [
    {
      role: 'user',
      content: `请用不超过${SUMMARY_MAX_CHARS}个字的中文，总结以下对话话题的核心内容：

话题：${topic}
内容：${context.slice(0, 2000)}

只返回摘要文本，不要加任何前缀或解释。`,
    },
  ];
}

/** 调用 LLM 生成摘要 */
async function compressTopic(
  topic: string,
  context: string,
  providerGetters?: {
    getDeepSeek?: () => any;
    getGemini?: () => any;
  },
): Promise<string> {
  if (!providerGetters?.getDeepSeek) {
    // 无 LLM 可用 → 简单截断
    return context.slice(0, SUMMARY_MAX_CHARS);
  }

  try {
    const messages = buildSummaryPrompt(topic, context);
    const response = await makeLLMCall(
      messages,
      [],
      { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 200 },
      providerGetters.getDeepSeek!,
      providerGetters.getGemini || (() => null),
    );
    const summary = (response.text || '').trim().slice(0, SUMMARY_MAX_CHARS);
    return summary || context.slice(0, SUMMARY_MAX_CHARS);
  } catch (e: any) {
    logger.warn('[FocusStack] LLM 摘要生成失败，使用截断:', e.message);
    return context.slice(0, SUMMARY_MAX_CHARS);
  }
}

/** 检查是否切换话题 */
function isTopicSwitch(newTopic: string, currentTopic: string | null): boolean {
  if (!currentTopic) return true;
  const a = newTopic.trim().toLowerCase();
  const b = currentTopic.trim().toLowerCase();
  // 完全相同或包含关系 → 不切换
  if (a === b || a.includes(b) || b.includes(a)) return false;
  // 关键词重叠度低 → 切换
  const aWords = new Set(a.split(/\s+/));
  const bWords = new Set(b.split(/\s+/));
  const intersection = [...aWords].filter(w => bWords.has(w)).length;
  const overlap = intersection / Math.max(aWords.size, bWords.size, 1);
  return overlap < 0.3;
}

/** 推入新话题 */
export async function pushTopic(
  topic: string,
  context: string,
  providerGetters?: { getDeepSeek?: () => any; getGemini?: () => any },
): Promise<TopicFrame> {
  const current = getCurrentContext();

  // 同一话题不重复推入
  if (current && !isTopicSwitch(topic, current.topic)) {
    current.context += '\n' + context;
    current.timestamp = Date.now();
    state.updatedAt = Date.now();
    logger.info(`[FocusStack] 延续话题: "${current.topic}"`);
    return current;
  }

  // 栈满 → 弹出最旧的
  if (state.stack.length >= MAX_STACK_DEPTH) {
    const oldest = state.stack.shift()!;
    logger.info(`[FocusStack] 栈满，弹出最旧话题: "${oldest.topic}"`);
  }

  const frame: TopicFrame = {
    topic,
    context,
    timestamp: Date.now(),
    summary: null,
  };

  state.stack.push(frame);
  state.updatedAt = Date.now();
  logger.info(`[FocusStack] ✅ 推入话题: "${topic}" (栈深度 ${state.stack.length})`);

  return frame;
}

/** 弹出当前话题 → 压缩摘要 + 持久化 */
export async function popTopic(
  providerGetters?: { getDeepSeek?: () => any; getGemini?: () => any },
): Promise<TopicFrame | null> {
  const frame = state.stack.pop();
  if (!frame) return null;

  // LLM 压缩摘要
  frame.summary = await compressTopic(frame.topic, frame.context, providerGetters);

  // 持久化到 interaction_memories
  try {
    await addInteractionMemory(
      'focus_stack_topic',
      {
        topic: frame.topic,
        context: frame.context.slice(0, 500),
        summary: frame.summary,
        stackDepth: state.stack.length,
      },
      0.7, // 焦点栈话题默认高显著性
    );
    logger.info(`[FocusStack] 📝 话题摘要已保存: "${frame.topic}" → "${frame.summary}"`);
  } catch (e: any) {
    logger.error('[FocusStack] 摘要持久化失败:', e.message);
  }

  state.updatedAt = Date.now();
  return frame;
}

/** 获取当前活跃话题 */
export function getCurrentContext(): TopicFrame | null {
  if (state.stack.length === 0) return null;
  return state.stack[state.stack.length - 1];
}

/** 获取完整话题层级 */
export function getFullStack(): { stack: TopicFrame[]; depth: number; current: TopicFrame | null } {
  return {
    stack: [...state.stack],
    depth: state.stack.length,
    current: getCurrentContext(),
  };
}

/** 检测话题切换并自动 push/pop */
export async function detectAndSwitchTopic(
  newUserText: string,
  providerGetters?: { getDeepSeek?: () => any; getGemini?: () => any },
): Promise<{ switched: boolean; previousTopic: string | null; currentTopic: string }> {
  // 从用户消息中提取话题关键词（取前 30 字作为话题标签）
  const topicLabel = newUserText.trim().slice(0, 30);

  const current = getCurrentContext();
  const previousTopic = current?.topic || null;

  if (current && isTopicSwitch(topicLabel, current.topic)) {
    // 话题已切换 → 弹出旧话题
    await popTopic(providerGetters);
    await pushTopic(topicLabel, newUserText, providerGetters);
    return { switched: true, previousTopic, currentTopic: topicLabel };
  }

  // 延续当前话题
  await pushTopic(topicLabel, newUserText, providerGetters);
  return { switched: false, previousTopic, currentTopic: current?.topic || topicLabel };
}

/** 获取当前状态摘要 */
export function getStackSummary(): string {
  const { stack, current } = getFullStack();
  if (!current) return '无活跃话题';
  const layers = stack.map((f, i) => `${i + 1}. ${f.topic}`);
  return `当前话题: ${current.topic} | 栈深度: ${stack.length}\n${layers.join('\n')}`;
}

/** 重置焦点栈 */
export function resetFocusStack(): void {
  state = { stack: [], updatedAt: Date.now() };
}
