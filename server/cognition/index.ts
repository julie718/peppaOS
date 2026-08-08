/**
 * Peppa Cognitive Engine — the independent decision-making layer.
 *
 * 【重构】移除正则前置分类与 directToolCall 静态映射（模块1/模块5）：
 * 原流程"正则意图 → 直接工具执行(0 Token)"整体移除，意图全部由 LLM 心智判定，
 * 工具调度由心智在 runWithTools 中自主完成（DAG 由 LLM 决策）。
 *
 * Architecture:
 *   User Input → [Cognitive Engine: LLM 心智分类] → LLM (带工具自主调度)
 *
 * Peppa is the dominant decision-maker. The LLM is just a swappable
 * text generation module — Peppa's identity and safety boundaries work independently of it.
 */

import { classifyIntent, classifyIntentLLM, extractSentiment, IntentResult, SentimentResult } from './intent';
import { logger } from '../lib/logger';
import { generateFallback, isLLMDown } from './fallback';
import { getModeConfig, ConversationMode, ModeConfig } from './modes';

export { classifyIntent, classifyIntentLLM, extractSentiment, generateFallback, isLLMDown, getModeConfig };
export type { IntentResult, SentimentResult } from './intent';
export type { FallbackResponse } from './fallback';
export type { ConversationMode, ModeConfig } from './modes';

export interface CognitiveContext {
  userId: string;
  agentId?: string;
  personalityId: string;
  personalityName: string;
  llmProvider: string;
  llmModel: string;
  isLLMAvailable: boolean;
}

export interface CognitiveResult {
  /** The final response text to send to the user (null/'' = pass through to LLM) */
  responseText: string;
  /** The classified intent (LLM 心智判定) */
  intent: IntentResult;
  /** Whether the LLM was actually called */
  llmWasCalled: boolean;
  /** Whether a direct tool was executed (no LLM) — 重构后恒 false（心智调度） */
  directToolExecuted: boolean;
  /** Result from direct tool execution, if any */
  toolResult?: string;
  /** Whether the response came from the fallback system */
  isFallback: boolean;
}

/**
 * Run the full cognitive pipeline on a user input.
 *
 * Flow:
 * 1. LLM 心智分类意图（classifier 快速调用，50 tokens）
 * 2. 返回意图供上层决策；所有消息均进入 LLM 主链路（心智自主决定工具调度）
 *
 * Returns a CognitiveResult with responseText = '' signaling "pass through to LLM".
 */
export async function processInput(
  input: string,
  ctx: CognitiveContext,
  llmClassifier?: (prompt: string, userText: string) => Promise<string>,
): Promise<CognitiveResult> {
  // ── 心智分类：LLM 一次判定类别/实体/情绪（无正则前置） ──
  let intent: IntentResult;
  if (llmClassifier) {
    try {
      intent = await classifyIntent(input, llmClassifier);
    } catch (e: any) {
      logger.warn(`[Cognition] 心智分类失败，走默认意图: ${e?.message}`);
      intent = { category: 'conversation', confidence: 0.5, entities: {}, needsLLM: true };
    }
  } else {
    intent = { category: 'conversation', confidence: 0.5, entities: {}, needsLLM: true };
  }

  logger.info(`[Cognition] 心智判定: ${intent.category} (${intent.confidence.toFixed(2)}) sentiment=${intent.sentiment ? JSON.stringify(intent.sentiment) : 'neutral'}`);

  // ── 所有消息统一直送 LLM 主链路（心智自主调度工具） ──
  return {
    responseText: '',
    intent,
    llmWasCalled: false,
    directToolExecuted: false,
    isFallback: false,
  };
}

/**
 * Handle LLM failure by generating a fallback response based on the intent.
 */
export function handleLLMFailure(
  intent: IntentResult,
  error: Error,
  toolResult?: string,
): CognitiveResult {
  const down = isLLMDown(error);
  const fallback = generateFallback(intent, toolResult);

  if (fallback && !fallback.isPlaceholder) {
    return {
      responseText: fallback.text,
      intent,
      llmWasCalled: true,
      directToolExecuted: false,
      toolResult,
      isFallback: true,
    };
  }

  if (down) {
    return {
      responseText: `Peppa 的语言模块暂时不可用（${error.message.slice(0, 80)}）。\n\n但我核心功能还在 — 你可以直接给我指令，比如"打开记事本"、"搜索文件"、"列出桌面"。`,
      intent,
      llmWasCalled: true,
      directToolExecuted: false,
      isFallback: true,
    };
  }

  return {
    responseText: `出错了：${error.message}`,
    intent,
    llmWasCalled: true,
    directToolExecuted: false,
    isFallback: true,
  };
}
