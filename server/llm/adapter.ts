import { ToolRegistry } from '../tools/registry';
import { ToolExecutionRecord, ToolContext } from '../tools/types';
import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from './providers';
import { recordWorkflow, WorkflowStep } from '../skills/worklog';

export interface LLMConfig {
  provider: 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'qwen';
  model: string;
  maxTokens?: number;
  userId?: string;
}

export interface LLMResult {
  text: string;
  toolCalls: ToolExecutionRecord[];
}

export async function runWithTools(
  messages: NormalizedMessage[],
  toolRegistry: ToolRegistry,
  config: LLMConfig,
  onToolCall?: (record: ToolExecutionRecord) => void,
  maxIterations: number = 5,
  getDeepSeek?: () => any,
  getGemini?: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  onStreamChunk?: StreamCallback,
  context?: ToolContext,
): Promise<LLMResult> {
  const executionLog: ToolExecutionRecord[] = [];
  const conversationHistory: NormalizedMessage[] = [...messages];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Check for cancellation between iterations
    if (context?.isCancelled?.()) {
      return {
        text: 'Task was cancelled by the user.',
        toolCalls: executionLog,
      };
    }
    const toolDeclarations = toolRegistry.getToolDeclarations();

    const response = onStreamChunk
      ? await makeLLMCallStreaming(
          conversationHistory,
          toolDeclarations,
          config,
          onStreamChunk,
          getDeepSeek || (() => null),
          getGemini || (() => null),
          getOpenAI || (() => null),
          getAnthropic || (() => null),
          getQwen || (() => null),
        )
      : await makeLLMCall(
          conversationHistory,
          toolDeclarations,
          config,
          getDeepSeek || (() => null),
          getGemini || (() => null),
          getOpenAI || (() => null),
          getAnthropic || (() => null),
          getQwen || (() => null),
        );

    if (!response.toolCalls || response.toolCalls.length === 0) {
      recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
      return {
        text: response.text || 'No response.',
        toolCalls: executionLog,
      };
    }

    // Check for duplicate tool calls (prevents infinite loops within maxIterations)
    const lastAssistantMsg = conversationHistory
      .filter(m => m.role === 'assistant')
      .slice(-1)[0];
    if (lastAssistantMsg?.toolCalls) {
      const sameTools = lastAssistantMsg.toolCalls.every((tc, i) =>
        response.toolCalls![i] &&
        tc.name === response.toolCalls![i].name &&
        JSON.stringify(tc.arguments) === JSON.stringify(response.toolCalls![i].arguments)
      );
      if (sameTools && lastAssistantMsg.toolCalls.length === response.toolCalls.length) {
        recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
        return {
          text: response.text || 'The same tools were called repeatedly. Breaking the loop to prevent infinite execution.',
          toolCalls: executionLog,
        };
      }
    }

    conversationHistory.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
      reasoningContent: response.reasoningContent,
    });

    for (const tc of response.toolCalls) {
      let result: string;
      let error: string | undefined;

      try {
        result = await toolRegistry.execute(tc.name, tc.arguments, context);
      } catch (e: any) {
        result = '';
        error = e.message;
      }

      const record: ToolExecutionRecord = {
        name: tc.name,
        arguments: tc.arguments,
        result,
        error,
      };
      executionLog.push(record);
      onToolCall?.(record);

      conversationHistory.push({
        role: 'tool',
        content: error ? `Error: ${error}` : result,
        toolCallId: tc.id,
        name: tc.name,
      });
    }
  }

  recordWorkflowIfToolsUsed(executionLog, messages, config.userId);
  return {
    text: 'Maximum tool call iterations reached.',
    toolCalls: executionLog,
  };
}

/** Record workflow from tool execution trace, if any tools were actually called */
function recordWorkflowIfToolsUsed(
  executionLog: ToolExecutionRecord[],
  messages: NormalizedMessage[],
  userId?: string,
): void {
  if (executionLog.length === 0) return;
  const userMsg = messages.find(m => m.role === 'user')?.content || '';
  recordWorkflow({
    userId: userId || 'anonymous',
    userIntent: userMsg.slice(0, 200),
    toolSequence: executionLog.map(e => ({
      name: e.name,
      args: e.arguments,
      resultSummary: (e.result || e.error || '').slice(0, 200),
    })),
    conversationExcerpt: userMsg.slice(0, 500),
  });
}
