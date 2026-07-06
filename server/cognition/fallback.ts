/**
 * Fallback Response System — Peppa's LLM-independent voice.
 *
 * When the LLM is unreachable or the intent is simple enough to handle locally,
 * Peppa responds using this deterministic response engine. This ensures Peppa
 * always has a voice, regardless of which LLM is connected (or even if none is).
 */

import { IntentResult } from './intent';

const GREETING_RESPONSES = [
  '嘿，我在呢。有什么需要我帮忙的吗？',
  '你好！我是 Peppa，随时为你服务。',
  'Hi！我在。说吧，我能做什么？',
  'Peppa 在线。需要我帮你做什么吗？',
];

const THANKS_RESPONSES = [
  '不客气，随时找我。',
  '应该的。还有别的需要吗？',
  '哈哈，小事一桩。',
];

const GOODBYE_RESPONSES = [
  '回头见，我一直都在。',
  '拜拜，需要我的时候叫一声。',
  '好的，去忙吧。我在这儿守着。',
];

const UNKNOWN_RESPONSES = [
  '抱歉，我的语言模块暂时不可用。不过你可以试试直接给我指令，比如"打开记事本"或者"搜索文件"。',
  '我现在的语言理解能力有限（LLM 没有连接），但我可以执行直接的操作指令。你想让我做什么？',
  '语言模型离线中，但我的核心功能还能用。试试用指令式语句，比如"列出文件"、"打开计算器"。',
];

const SYSTEM_INFO_RESPONSE = (info: string) =>
  `这是当前系统状态：\n${info}\n\n有其他需要吗？`;

const COMMAND_ACK_RESPONSES: Record<string, string[]> = {
  open: [
    '好的，正在打开。',
    '马上为你启动。',
    '这就开。',
  ],
  list_files: [
    '这是当前目录的文件。',
    '好的，列表如下。',
  ],
  system_info: [
    '这是系统信息。',
    '当前运行状态如下。',
  ],
};

export interface FallbackResponse {
  text: string;
  /** If true, the caller should still attempt an LLM call and replace this */
  isPlaceholder: boolean;
}

/**
 * Generate a local, LLM-free response based on the classified intent.
 * Returns null if this intent should be handled by the LLM.
 */
export function generateFallback(intent: IntentResult, toolResult?: string): FallbackResponse | null {
  const { category, subIntent } = intent;

  switch (category) {
    case 'conversation': {
      if (subIntent === 'greeting' || !subIntent) {
        return {
          text: GREETING_RESPONSES[Math.floor(Math.random() * GREETING_RESPONSES.length)],
          isPlaceholder: false,
        };
      }
      // For other conversation, we need LLM
      return null;
    }

    case 'command': {
      // If a direct tool was called and succeeded
      if (toolResult) {
        const acks = COMMAND_ACK_RESPONSES[subIntent || ''] || ['搞定了。'];
        const ack = acks[Math.floor(Math.random() * acks.length)];
        return {
          text: `${ack}\n\n${toolResult}`,
          isPlaceholder: false,
        };
      }
      // Command recognized but couldn't execute — give guidance
      return {
        text: '我理解你想执行一个操作，但需要更具体的指令。你想打开什么？或者列出什么文件？',
        isPlaceholder: false,
      };
    }

    case 'system': {
      if (toolResult) {
        return {
          text: SYSTEM_INFO_RESPONSE(toolResult),
          isPlaceholder: false,
        };
      }
      return null;
    }

    case 'question': {
      // Questions need LLM for quality answers
      return null;
    }

    case 'code': {
      // Code operations need LLM
      return null;
    }

    case 'web': {
      if (toolResult) {
        return {
          text: `搜索结果如下：\n\n${toolResult}`,
          isPlaceholder: false,
        };
      }
      return null;
    }

    case 'file': {
      if (toolResult) {
        return {
          text: toolResult,
          isPlaceholder: false,
        };
      }
      return null;
    }

    case 'unknown':
    default: {
      return {
        text: UNKNOWN_RESPONSES[Math.floor(Math.random() * UNKNOWN_RESPONSES.length)],
        isPlaceholder: true, // Still try LLM, use this as fallback
      };
    }
  }
}

/**
 * Check if an LLM error indicates the service is completely down (vs. a transient error).
 * If the LLM is down, we should use fallback rather than retrying.
 */
export function isLLMDown(error: Error): boolean {
  const msg = error.message?.toLowerCase() || '';
  return (
    msg.includes('not configured') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('unreachable') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key')
  );
}
