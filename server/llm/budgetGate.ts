// server/llm/budgetGate.ts
// Token 预算熔断保护（任务5）— 纯云端防烧钱
//
// 规则：
//   - 统计每日 Pro（核心心智）模型实际消耗 token（含缓存命中 token，按 DeepSeek 计费口径
//     prompt 部分计 hit+miss 之和；此处保守口径：totalTokens = prompt+completion，缓存命中
//     单独记录供观察，不计入「预算已用」时减去——若命中率高，缓存 token 计费极低。
//     实现口径：预算消耗按 totalTokens（prompt+completion）全量计，命中 token 独立记录）。
//   - 未达预算：全部逻辑正常运行。
//   - 接近预算（>= budget*warnRatio）：输出告警日志（每日一次）。
//   - 耗尽预算（>= budget）：进入休眠只读状态 — 禁止核心心智 LLM 调用（pro 调用被
//     mindRouter 拦截并抛出 BudgetSleepError），NAS 数据库完整保留全部记忆/人格/欲望状态
//     （不丢失数据）；额度恢复（新的一天自动重置 / 手动重置 / 上调预算）后自动恢复运行。
//   - 只限制 pro 核心心智调用；flash 外围调用不受此熔断约束。
//
// 持久化：每日汇总存 db.settings key `llm_router_daily`，跨进程/重启不丢失。

import { readDB, writeDB } from '../../db_layer';
import { logger } from '../lib/logger';
import { getRouterConfig } from './routerConfig';

export const DAILY_USAGE_KEY = 'llm_router_daily';

export type BudgetState = 'normal' | 'warn' | 'sleep';

export interface DailyProUsage {
  date: string;            // YYYY-MM-DD
  proTokens: number;       // 今日 pro 核心心智消耗 total tokens
  proCacheHitTokens: number; // 今日 pro 缓存命中 prompt tokens（独立观察，不计入消耗口径）
  proCalls: number;
  state: BudgetState;
  warnedAt?: string;       // 告警时间（每日一次）
  exhaustedAt?: string;    // 进入休眠时间
}

/** 当日日期键（本地时区） */
function todayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function readDaily(): DailyProUsage {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === DAILY_USAGE_KEY);
    if (setting?.value) {
      const raw = JSON.parse(setting.value) as DailyProUsage;
      // 跨天自动滚动：新的一天 → 重置为 normal
      if (raw.date !== todayKey()) {
        const fresh: DailyProUsage = { date: todayKey(), proTokens: 0, proCacheHitTokens: 0, proCalls: 0, state: 'normal' };
        writeDaily(fresh);
        return fresh;
      }
      return raw;
    }
  } catch { /* 未初始化 */ }
  const fresh: DailyProUsage = { date: todayKey(), proTokens: 0, proCacheHitTokens: 0, proCalls: 0, state: 'normal' };
  try { writeDaily(fresh); } catch { /* 忽略持久化失败（内存态可继续工作） */ }
  return fresh;
}

function writeDaily(usage: DailyProUsage): void {
  try {
    const db = readDB();
    if (!db.settings) (db as any).settings = [];
    const idx = (db.settings as any[]).findIndex((s: any) => s.key === DAILY_USAGE_KEY);
    if (idx >= 0) {
      (db.settings as any[])[idx].value = JSON.stringify(usage);
    } else {
      (db.settings as any[]).push({ key: DAILY_USAGE_KEY, value: JSON.stringify(usage) });
    }
    writeDB(db);
  } catch (e: any) {
    logger.warn(`[BudgetGate] 汇总持久化失败: ${e?.message || e}`);
  }
}

function computeState(usage: DailyProUsage, budget: number, warnRatio: number): BudgetState {
  if (budget <= 0) return 'normal';
  if (usage.proTokens >= budget) return 'sleep';
  if (usage.proTokens >= budget * warnRatio) return 'warn';
  return 'normal';
}

/**
 * 记录一次 pro 核心心智调用的 token 消耗，并推进预算状态。
 * 返回推进后的预算状态。
 */
export function recordProTokens(tokens: { promptTokens: number; completionTokens: number; cacheHitTokens: number }): BudgetState {
  const cfg = getRouterConfig();
  const usage = readDaily();
  usage.proTokens += (tokens.promptTokens || 0) + (tokens.completionTokens || 0);
  usage.proCacheHitTokens += tokens.cacheHitTokens || 0;
  usage.proCalls += 1;

  const next = computeState(usage, cfg.dailyProTokenBudget, cfg.budgetWarnRatio);

  if (next === 'sleep' && usage.state !== 'sleep') {
    usage.exhaustedAt = new Date().toISOString();
    logger.error(
      `[BudgetGate-SLEEP] ⚠️ 今日 Pro token 预算已耗尽（${usage.proTokens}/${cfg.dailyProTokenBudget}）→ 进入休眠只读模式：` +
      `核心心智深度推演（InnerTick/TICK/自我反思）全部暂停；记忆/人格/欲望数据完整保留，` +
      `新的一天（或手动重置/上调预算）自动恢复运行。`,
    );
  } else if (next === 'warn' && usage.state !== 'warn') {
    usage.warnedAt = new Date().toISOString();
    logger.warn(
      `[BudgetGate-WARN] 今日 Pro token 消耗已达预算 ${Math.round((usage.proTokens / cfg.dailyProTokenBudget) * 100)}%` +
      `（${usage.proTokens}/${cfg.dailyProTokenBudget}），接近上限，请注意控制核心心智推演频率。`,
    );
  } else if (next === 'normal' && usage.state === 'sleep') {
    // 预算上调（或手动重置）后自动恢复
    logger.info(`[BudgetGate] 预算状态恢复正常（新预算 ${cfg.dailyProTokenBudget}），自动恢复核心心智运行。`);
  }

  usage.state = next;
  writeDaily(usage);
  return next;
}

/** 当前预算状态（休眠判断由 mindRouter 调用） */
export function getBudgetState(): BudgetState {
  const cfg = getRouterConfig();
  if (cfg.dailyProTokenBudget <= 0) return 'normal';
  return computeState(readDaily(), cfg.dailyProTokenBudget, cfg.budgetWarnRatio);
}

/** 今日 pro 消耗汇总（供状态接口） */
export function getTodayProUsage(): DailyProUsage {
  return readDaily();
}

/** 手动重置今日消耗（测试/额度提前恢复用）：清零并恢复 normal，不删历史记忆数据 */
export function resetTodayUsage(): DailyProUsage {
  const fresh: DailyProUsage = { date: todayKey(), proTokens: 0, proCacheHitTokens: 0, proCalls: 0, state: 'normal' };
  writeDaily(fresh);
  logger.info('[BudgetGate] 今日 Pro 消耗已手动重置 → 恢复运行');
  return fresh;
}

/** 休眠只读模式专用错误：上层（innerTick 等）捕获后按「推演失败零写入」路径处理，数据不丢失 */
export class BudgetSleepError extends Error {
  readonly code = 'BUDGET_SLEEP';
  constructor(budget: number, used: number) {
    super(`[BudgetGate] 今日 Pro token 预算已耗尽（${used}/${budget}），核心心智处于休眠只读模式：` +
      `本轮深度推演已跳过（不消耗任何额外 token），全部记忆/人格/欲望数据保留在 NAS 数据库中；新的一天自动恢复。`);
    this.name = 'BudgetSleepError';
  }
}
