// 统一消息路由引擎 — 本能层 → 工具层 → 认知层 → 深度推理 → Orchestrator
// 规则处理明确类型（0 Token），LLM 仅用于模糊边界
import { logger } from '../lib/logger.js';
import { isDeepReasoningQuery } from './deepReasoning.js';

// ── 路由层级 ──
export type RouteLayer = 'instinct' | 'tool' | 'cognitive' | 'deep_reasoning' | 'orchestrator' | 'unknown';

export interface RouteResult {
  layer: RouteLayer;
  reason: string;
  trace: string[];           // 完整决策路径
}

// ── 第1层：本能层模式 ──
const INSTINCT_PATTERNS: RegExp[] = [
  /你还好吗|你还好么|你怎么样|感觉怎么样|你累不累|你现在状态|你感觉如何|你最近怎么样|你在吗|你还在吗|你忙不忙|你有没有精力|你是不是累了|你的状态怎么样|你还活着吗|你还有电吗|好点没|缓过来了吗/i,
  // 身份认知
  /你是谁|你是什么|你是谁呀|介绍一下你自己|你叫什么|你是谁呢|你到底是谁|你究竟是.*谁|说说你自己|介绍一下你|讲讲你自己|你是个什么样.*(人|存在|AI|程序|东西)/i,
];

// 身份识别模式（独立导出，供 chat.ts 区分 identity vs self-aware）
const IDENTITY_PATTERNS: RegExp[] = [
  /你是谁|你是什么|你是谁呀|介绍一下你自己|你叫什么|你是谁呢|你到底是谁|你究竟是.*谁|说说你自己|介绍一下你|讲讲你自己|你是个什么样.*(人|存在|AI|程序|东西)/i,
];

function isInstinctQuery(text: string): boolean {
  return INSTINCT_PATTERNS.some(p => p.test(text));
}

function isIdentityQuery(text: string): boolean {
  return IDENTITY_PATTERNS.some(p => p.test(text));
}

// ── 第2层：工具层模式 ──
const STOCK_PATTERNS: RegExp[] = [
  /股票|股价|行情|收盘价|开盘价|涨跌幅|市盈率|市净率|成交量|换手率|市值|PE|PB|ROE|EPS|K线|大盘|指数|涨停|跌停|板块|财报|查.*股|查.*价/u,
  /\b(stock|market|price|kline|index|finance|ticker)\b/i,
];

const LOOKUP_PATTERNS: RegExp[] = [
  /查|搜|找|看|去查|去搜|去找|去看|帮我查|帮我搜|帮我找|帮我看|搜索|查询|查找|联网|浏览|网页|网址|链接|验证|调研|知不知道|知道吗|告诉我|介绍|有什么|有哪些|什么是|怎么样|如何|是谁|在哪里|什么时候|多少钱/u,
  /\b(search|look\s*up|browse|fetch|research|find|check)\b/i,
];

const WEATHER_PATTERNS: RegExp[] = [
  /天气|气温|温度|晴|雨|雪|风|雾|霾|台风|空气质量|雾霾|降水|日出|日落|紫外线|穿衣|防晒|带伞/u,
];

function hasToolIntent(text: string): boolean {
  return STOCK_PATTERNS.some(p => p.test(text))
    || WEATHER_PATTERNS.some(p => p.test(text))
    || LOOKUP_PATTERNS.some(p => p.test(text) && text.length > 10);
}

// ── 第3层：认知复杂度检测（从 orchestrator 导入）──
let classifyComplexityFn: ((text: string) => 'simple' | 'moderate' | 'complex') | null = null;
async function getClassifyComplexity(): Promise<(text: string) => 'simple' | 'moderate' | 'complex'> {
  if (!classifyComplexityFn) {
    const mod = await import('../agents/orchestrator.js');
    classifyComplexityFn = (text: string) => mod.classifyComplexity(text, {} as any);
  }
  return classifyComplexityFn;
}

// ── 主导出：统一路由入口 ──
export async function routeMessage(
  text: string,
  operationMode: string = 'autonomous',
): Promise<RouteResult> {
  const trace: string[] = [];
  const trimmed = text.trim();

  // 空消息
  if (!trimmed) {
    return { layer: 'unknown', reason: 'empty_text', trace: ['rejected: empty'] };
  }

  // 第1层：本能层（规则，0 Token）
  if (isInstinctQuery(trimmed)) {
    trace.push('instinct: matched self-aware pattern');
    logger.info(`[Router] ${trimmed.slice(0, 30)} → instinct`);
    return { layer: 'instinct', reason: 'self_aware_query', trace };
  }

  // 第2层：工具层（规则，0 Token）
  if (hasToolIntent(trimmed)) {
    trace.push('tool: matched tool intent pattern');
    logger.info(`[Router] ${trimmed.slice(0, 30)} → tool`);
    return { layer: 'tool', reason: 'tool_intent_detected', trace };
  }

  // 第2.5层：深度推理（规则，0 Token）— 观点/分析/对比类问题
  if (isDeepReasoningQuery(trimmed)) {
    trace.push('deep_reasoning: matched deep reasoning pattern');
    logger.info(`[Router] ${trimmed.slice(0, 30)} → deep_reasoning`);
    return { layer: 'deep_reasoning', reason: 'deep_reasoning_triggered', trace };
  }

  // 第3层：认知层（复杂度判断）
  try {
    const classifyFn = await getClassifyComplexity();
    const complexity = classifyFn(trimmed);

    if (complexity === 'simple') {
      trace.push(`cognitive: complexity=${complexity} → direct LLM`);
      logger.info(`[Router] ${trimmed.slice(0, 30)} → cognitive (simple)`);
      return { layer: 'cognitive', reason: 'simple_direct_llm', trace };
    }

    // 第4层：Orchestrator（LLM 任务拆解）
    trace.push(`cognitive: complexity=${complexity} → orchestrator`);
    logger.info(`[Router] ${trimmed.slice(0, 30)} → orchestrator (${complexity})`);
    return { layer: 'orchestrator', reason: `complex_${complexity}`, trace };
  } catch {
    trace.push('cognitive: classification failed → fallback to direct LLM');
    return { layer: 'cognitive', reason: 'classification_error_fallback', trace };
  }
}

// ── 辅助导出：供外部直接使用 ──
export { isInstinctQuery, isIdentityQuery, hasToolIntent };
