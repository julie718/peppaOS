// server/llm/mindRouter.ts
// DeepSeek 最高性价比外部强制路由 — 独立新增中间层（任务2/3/5/7）
//
// 心智层（innerTick / life TICK / 自我反思 / MCP评估）只产出内容，不知道存在两套模型；
// 全部模型分发由本模块按「请求来源（scene）」硬规则执行，不依赖任何心智侧逻辑。
//
// 强制走 deepseek-v4-pro（核心心智，不可更改）：
//   inner_tick          — InnerTick 心智闭环全部推演请求
//   runtime_tick        — life TICK 循环 LLM 推演（情绪/欲望演化）
//   evolution           — 人格演化
//   narrative           — 叙事更新（自我叙事）
//   skill_gen           — MCP 工具自研/技能生成
//   mcp_eval            — MCP 技能可行性评估、MCP 工具自研与排错校验（peppa_server 打标）
//   agent_orchestrator  — 复杂长链条任务规划
//   self_review         — 深度自我复盘
//
// 强制分流 deepseek-v4-flash（外围，不触碰本体心智）：
//   chat/classifier/summary/identity_check            — 用户最终回复渲染润色、闲聊格式化
//   consolidate/memory_tree/memory_trigger/extract/dream/focus_stack — 历史记忆压缩、对话摘要
//   weekly/monthly/yearly_report/growth_journal       — 报告摘要生成
//   proactive/morning_greeting/long_silence/low_mood_comfort 等  — 简单输出/话术
//   未打 scene 的调用                                  — 默认外围（记日志便于调优）
//
// 故障 fallback（任务2）：
//   - 仅当主模型 deepseek-v4-pro 返回 API 报错/限流/余额不足（quota/server_error/network/
//     circuit_open 分类），才自动降级到 deepseek-v4-flash 应急重试一次；
//   - 降级只做应急：InnerTick（scene=inner_tick）降级状态禁止触发完整深度推演 —— 不降级
//     到 flash 做心智推演，直接向上抛原始错误（innerTick 捕获后走「零写入兜底」路径，
//     返回提示告知额度/接口异常）；
//   - 每次调用都先探测 pro（接口恢复后自动切回 pro），降级不是粘滞状态。

import { readDB, writeDB } from '../../db_layer';
import { logger } from '../lib/logger';
import { getRouterConfig, isDeepSeekConfigured } from './routerConfig';
import { getBudgetState, recordProTokens, getTodayProUsage, resetTodayUsage, BudgetSleepError, BudgetState } from './budgetGate';
import { classifyCloudError, CloudErrorCategory } from '../cloud/core';
// 类型导入（type-only）：避免与 providers.ts 运行时互相 import 形成循环依赖
import type { LLMCallConfig } from './providers';
import type { NormalizedLLMResponse } from '../tools/types';

export type RouterTier = 'core_mind' | 'peripheral';

/** 核心心智场景白名单（硬规则：这些请求绝不允许交给 flash） */
const CORE_MIND_SCENES: ReadonlySet<string> = new Set([
  'inner_tick',
  'runtime_tick',
  'evolution',
  'narrative',
  'skill_gen',
  'mcp_eval',
  'agent_orchestrator',
  'self_review',
]);

/** 请求来源分类：心智内核 / 外围输出 */
export function classifyScene(scene?: string): RouterTier {
  if (!scene) {
    // 未打 scene 的调用默认外围（不触碰本体心智）；记录日志便于发现遗漏
    logger.debug('[LLMRouter] 调用未标记 scene，按外围输出处理');
    return 'peripheral';
  }
  if (CORE_MIND_SCENES.has(scene)) return 'core_mind';
  return 'peripheral';
}

export interface RoutedConfig {
  /** 路由是否生效（返回 null = 不干预，保持调用方原配置） */
  tier: RouterTier;
  provider: string;
  model: string;
  /** 是否发生了模型强制改写 */
  forced: boolean;
}

/**
 * 解析路由：对 DeepSeek 服务商生效的调用强制分配模型。
 * - core_mind → deepseek-v4-pro（DeepSeek 可用时强制锁定，包括 provider 从其他服务商切到 deepseek）
 * - peripheral → deepseek-v4-flash（仅当调用方本来就走 deepseek 时强制；其他服务商保持原模型，
 *   避免把 flash 模型名强塞给 qwen/gemini 客户端）
 * 返回 null = 不干预（未启用 / DeepSeek 未配置 / 非 deepseek 服务商的外围调用）。
 */
export function resolveRoute(config: Pick<LLMCallConfig, 'provider' | 'model' | 'scene'>): RoutedConfig | null {
  const cfg = getRouterConfig();
  if (!cfg.enabled) return null;
  if (!isDeepSeekConfigured()) return null;

  const tier = classifyScene(config.scene);
  if (tier === 'core_mind') {
    // 核心心智强制锁定 deepseek-v4-pro：即使调用方配置了其他服务商也强制切到 DeepSeek
    if (config.provider !== 'deepseek' || config.model !== cfg.proModel) {
      return { tier, provider: 'deepseek', model: cfg.proModel, forced: true };
    }
    return { tier, provider: config.provider, model: config.model, forced: false };
  }

  // 外围输出：仅 deepseek 服务商强制用 flash（话术包装不需要 pro）
  if (config.provider === 'deepseek' && config.model !== cfg.flashModel) {
    return { tier, provider: 'deepseek', model: cfg.flashModel, forced: true };
  }
  return null;
}

/**
 * 预算熔断闸门：核心心智调用在休眠态直接抛 BudgetSleepError（不发起任何 LLM 请求）。
 * flash 外围调用不受此熔断约束。调用时机：makeLLMCall/makeLLMCallStreaming 进入 core 前。
 */
export function beforeCall(scene?: string): void {
  const tier = classifyScene(scene);
  if (tier !== 'core_mind') return;
  if (getBudgetState() === 'sleep') {
    const usage = getTodayProUsage();
    const cfg = getRouterConfig();
    throw new BudgetSleepError(cfg.dailyProTokenBudget, usage.proTokens);
  }
}

/**
 * 调用完成后的账务与监控（任务5/7）：pro 核心心智消耗记入预算 + 全量调用记录。
 * @param routed 路由结果（可能为 null = 未干预）
 * @param usage  归一化 usage（prompt/completion/cache）
 * @param startMs 调用开始时间
 * @param degraded 是否本次走了 fallback 降级
 * @param error 调用是否失败
 */
export function afterCall(
  routed: RoutedConfig | null,
  config: Pick<LLMCallConfig, 'provider' | 'model' | 'scene'>,
  usage: { promptTokens?: number; completionTokens?: number; cacheHitTokens?: number } | undefined,
  startMs: number,
  opts?: { degraded?: boolean; error?: string },
): void {
  const tier = routed?.tier ?? classifyScene(config.scene);
  const cacheHit = !!usage && (usage.cacheHitTokens || 0) > 0;

  // ── 任务5：仅 pro 核心心智计入预算（flash 外围不受熔断约束）──
  if (tier === 'core_mind' && usage) {
    try {
      recordProTokens({
        promptTokens: usage.promptTokens || 0,
        completionTokens: usage.completionTokens || 0,
        cacheHitTokens: usage.cacheHitTokens || 0,
      });
    } catch (e: any) {
      logger.warn(`[LLMRouter] 预算记账失败: ${e?.message || e}`);
    }
  }

  // ── 任务7：每一次模型调用记录（模型/来源类型/输入输出token/耗时/缓存命中/是否降级）──
  try {
    const db = readDB();
    if (!db.llmRouterCalls) (db as any).llmRouterCalls = [];
    db.llmRouterCalls.push({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      scene: config.scene || '(none)',
      tier,
      provider: config.provider,
      model: config.model,
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      totalTokens: (usage?.promptTokens || 0) + (usage?.completionTokens || 0),
      cacheHitTokens: usage?.cacheHitTokens || 0,
      cacheHit,
      durationMs: Date.now() - startMs,
      degraded: !!opts?.degraded,
      error: opts?.error?.slice(0, 300) || undefined,
    });
    // 上限保护：只保留最近 5000 条调用记录（防 db 无限膨胀）
    if (db.llmRouterCalls.length > 5000) {
      db.llmRouterCalls = db.llmRouterCalls.slice(-5000);
    }
    writeDB(db);
  } catch { /* 记录失败不影响主流程 */ }

  const status = opts?.error ? 'error' : opts?.degraded ? 'degraded' : 'ok';
  logger.info(
    `[LLMRouter] ${status} tier=${tier} scene=${config.scene || '(none)'} provider=${config.provider} model=${config.model} ` +
    `promptTokens=${usage?.promptTokens ?? 0} completionTokens=${usage?.completionTokens ?? 0} ` +
    `cacheHitTokens=${usage?.cacheHitTokens ?? 0} cacheHit=${cacheHit} durationMs=${Date.now() - startMs}` +
    `${opts?.degraded ? ' fallback=pro→flash' : ''}${opts?.error ? ` error="${opts.error}"` : ''}`,
  );
}

/** 可触发降级的错误分类（API 报错/限流/余额不足/服务端错误/熔断） */
const FALLBACK_ELIGIBLE_CATEGORIES: ReadonlySet<CloudErrorCategory> = new Set([
  'quota',        // 限流(429)/余额不足(402/insufficient balance)
  'server_error', // 5xx
  'network',      // 网络错误
  'circuit_open', // 熔断
]);

export function isFallbackEligibleError(err: any): boolean {
  if (!err) return false;
  if (err?.name === 'AbortError' || err?.name === 'BudgetSleepError' || /abort|cancel/i.test(String(err?.message || ''))) return false;
  // 消息关键字优先匹配（含 402/insufficient balance）：classifyCloudError 会把「402 Insufficient
  // Balance」归为 unknown，无法命中分类集合 —— 必须先按 DeepSeek 真实错误文案兜底
  const msg = String(err?.message || '');
  if (/429|402|insufficient.?balance|quota|exceed|rate.?limit|\b5\d\d\b/i.test(msg)) return true;
  try {
    const cls = classifyCloudError(err);
    return FALLBACK_ELIGIBLE_CATEGORIES.has(cls.category);
  } catch {
    return false;
  }
}

/**
 * 故障降级（任务2）：pro 主模型 API 故障 → flash 应急重试一次。
 * 硬规则：scene=inner_tick 的核心心智推演绝不降级到 flash 深度推演（返回 null，
 * 由调用方把原始 pro 错误抛给 innerTick 的零写入兜底路径）。
 */
export function shouldFallbackToFlash(scene: string | undefined, err: any): boolean {
  if (scene === 'inner_tick') {
    logger.warn(`[LLMRouter] innerTick 主模型失败（${String(err?.message || err).slice(0, 160)}）→ 降级状态禁止触发完整InnerTick深度推演：本轮不上flash，返回额度/接口异常提示，等待接口恢复后自动切回pro`);
    return false;
  }
  return isFallbackEligibleError(err);
}

/** 状态接口（任务7）：配置 + 今日消耗 + 预算状态 + 最近调用统计 */
export function getRouterStatus(): any {
  const cfg = getRouterConfig();
  const budgetState: BudgetState = getBudgetState();
  const today = getTodayProUsage();
  let todayCounts: { calls: number; proCalls: number; flashCalls: number; degraded: number; cacheHits: number; proTokens: number } = {
    calls: 0, proCalls: 0, flashCalls: 0, degraded: 0, cacheHits: 0, proTokens: 0,
  };
  try {
    const db = readDB();
    const day = new Date().toISOString().slice(0, 10);
    const calls = (db.llmRouterCalls || []).filter((c: any) => (c.ts || '').slice(0, 10) === day);
    todayCounts = {
      calls: calls.length,
      proCalls: calls.filter((c: any) => c.tier === 'core_mind').length,
      flashCalls: calls.filter((c: any) => c.tier === 'peripheral').length,
      degraded: calls.filter((c: any) => c.degraded).length,
      cacheHits: calls.filter((c: any) => c.cacheHit).length,
      proTokens: calls.filter((c: any) => c.tier === 'core_mind').reduce((s: number, c: any) => s + (c.totalTokens || 0), 0),
    };
  } catch { /* 读取失败返回空统计 */ }
  return {
    enabled: cfg.enabled,
    proModel: cfg.proModel,
    flashModel: cfg.flashModel,
    dailyProTokenBudget: cfg.dailyProTokenBudget,
    budgetWarnRatio: cfg.budgetWarnRatio,
    idleInnerTickIntervalMs: cfg.idleInnerTickIntervalMs,
    deepSeekConfigured: isDeepSeekConfigured(),
    budgetState,
    today: { ...today, cacheHitTokens: today.proCacheHitTokens },
    todayCounts,
    coreMindScenes: [...CORE_MIND_SCENES],
  };
}

/** 手动重置今日 pro 消耗（预算计数清零，恢复运行；不触碰任何记忆/心智数据） */
export function resetRouterDailyUsage() {
  return resetTodayUsage();
}

export type { BudgetState, NormalizedLLMResponse };
