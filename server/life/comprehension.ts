// server/life/comprehension.ts

import { logger } from '../lib/logger.js';

export interface ComprehensionState {
  eventCompleteness: number;   // 知道对方在说什么事吗？（0-1）
  contextCompleteness: number; // 知道来龙去脉吗？（0-1）
  relatedCompleteness: number; // 知道相关的外部信息吗？（0-1）
  certainty: number;          // 整体把握程度（0-1）
  overall: number;            // 整体理解度（自动计算）
  lastUpdated: string;
  currentTopic?: string;
  missingAspects: string[];
}

const DEFAULT_STATE: ComprehensionState = {
  eventCompleteness: 1.0,
  contextCompleteness: 0.5,
  relatedCompleteness: 0.3,
  certainty: 0.6,
  overall: 0.6,
  lastUpdated: new Date().toISOString(),
  missingAspects: [],
};

let currentState: ComprehensionState = { ...DEFAULT_STATE };

export function getComprehensionState(): ComprehensionState {
  return { ...currentState };
}

export function updateComprehension(
  userInput: string,
  context?: {
    conversationHistory?: string[];
    knownEntities?: string[];
  }
): ComprehensionState {
  const lower = userInput.toLowerCase();
  const state = { ...currentState };

  const hasEvent = /工作|换|去|做|选|决定|想|要|能|会|什么|怎么|如何/.test(lower);
  state.eventCompleteness = hasEvent ? 0.8 : 0.4;

  const hasBackground = /因为|所以|可是|但是|之前|曾经|一直|经常|最近|今天|昨天/.test(lower);
  state.contextCompleteness = hasBackground ? 0.7 : 0.4;

  const hasRelatedInfo = /新闻|消息|听说|有人|网上|看到|知道|查|问/.test(lower);
  state.relatedCompleteness = hasRelatedInfo ? 0.6 : 0.3;

  const avg = (state.eventCompleteness + state.contextCompleteness + state.relatedCompleteness) / 3;
  state.certainty = Math.min(1, avg + 0.2);
  state.overall = avg;

  state.missingAspects = [];
  if (state.eventCompleteness < 0.6) state.missingAspects.push('具体事件');
  if (state.contextCompleteness < 0.6) state.missingAspects.push('背景信息');
  if (state.relatedCompleteness < 0.6) state.missingAspects.push('外部相关信息');

  state.lastUpdated = new Date().toISOString();
  currentState = state;

  return state;
}

export function shouldClarify(state: ComprehensionState): boolean {
  return state.overall < 0.6 && state.missingAspects.length > 0;
}

export function generateClarification(state: ComprehensionState): string | null {
  if (!shouldClarify(state)) return null;

  const missing = state.missingAspects;
  const questions: string[] = [];

  for (const aspect of missing) {
    switch (aspect) {
      case '具体事件':
        questions.push('能具体说说是什么事吗？');
        break;
      case '背景信息':
        questions.push('这件事的背景是怎样的？');
        break;
      case '外部相关信息':
        questions.push('你了解过相关的信息吗？');
        break;
      default:
        questions.push('能多说一点吗？');
    }
  }

  const selected = questions.slice(0, 2);
  const intro = ['嗯，我想先了解一下。', '我先确认一下：', '我想把情况弄清楚：'];
  const selectedIntro = intro[Math.floor(Math.random() * intro.length)];

  if (selected.length === 1) {
    return selected[0];
  }

  return `${selectedIntro}\n${selected.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
}

export function resetComprehension(): void {
  currentState = { ...DEFAULT_STATE };
  currentState.lastUpdated = new Date().toISOString();
}

export function tickComprehension(): void {
  currentState.certainty = Math.max(0.3, currentState.certainty - 0.01);
  currentState.overall = (currentState.eventCompleteness + currentState.contextCompleteness + currentState.relatedCompleteness) / 3;
  currentState.lastUpdated = new Date().toISOString();
}
