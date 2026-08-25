// server/runtime/tokenBudget.ts
// Phase-2 综合修复：每日后台 token 预算（熔断基础，item 6/14）
//
// 职责：
//   1) 记账：由 mindRouter.afterCall 挂接（每个 LLM 调用完成后调用 recordUsage），
//      非用户场景（chat/task/voice 等）消耗计入「后台额度」；
//   2) 熔断判定：isBackgroundBudgetExhausted() 供 backgroundGate 在启动后台任务前查询；
//      额度耗尽 → 后台任务跳过/延后，用户对话永不经过本模块判定（user 场景不计入）；
//   3) 埋点：每日消耗日志（每 PEPPA_TOKEN_BUDGET_LOG_INTERVAL_MIN 输出一行），
//      熔断时立即输出（供排查跳过原因）。
//
// 边界：只做观测 + 判定，绝不在 makeLLMCall 层对 user/peripheral 场景抛异常
//（用户对话最高优先级，不受后台额度影响）。

import { logger } from '../lib/logger';

const TAG = '[TokenBudget]';

/** 用户场景白名单：这些 scene 的 token 消耗不计入后台额度（用户对话优先级最高） */
const USER_SCENES: ReadonlySet<string> = new Set([
  'chat',
  'task',
  'voice',
  'summary',
  'classifier',
  'identity_check',
  'music',
  'stream',
]);

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** 每日后台 token 预算（0 = 不限制） */
export function getDailyBudget(): number {
  return envNum('PEPPA_DAILY_TOKEN_BUDGET', 8_000_000);
}

/** 预算日志间隔（分钟，0 = 不输出周期日志） */
function getLogIntervalMin(): number {
  return envNum('PEPPA_TOKEN_BUDGET_LOG_INTERVAL_MIN', 60);
}

interface DailyUsage {
  dayKey: string;             // 本地日期 YYYY-MM-DD（午夜重置）
  backgroundTokens: number;   // 后台场景累计消耗（prompt+completion）
  lastLogAt: number;          // 上次周期日志时间戳
}

let usage: DailyUsage = { dayKey: '', backgroundTokens: 0, lastLogAt: 0 };

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureToday(): void {
  const key = todayKey();
  if (usage.dayKey !== key) {
    if (usage.dayKey) {
      logger.info(`${TAG} 日期变更 ${usage.dayKey} → ${key}，后台额度重置（昨日消耗 ${usage.backgroundTokens} tokens）`);
    }
    usage = { dayKey: key, backgroundTokens: 0, lastLogAt: 0 };
  }
}

/** 是否为后台场景（非用户白名单且非空） */
export function isUserScene(scene?: string): boolean {
  if (!scene) return false;
  return USER_SCENES.has(scene);
}

/**
 * 记账入口（mindRouter.afterCall 挂接；单次调用失败不抛错、不阻断主流程）。
 * @param scene 调用场景标记
 * @param usage 归一化 usage（promptTokens + completionTokens）
 */
export function recordUsage(scene: string | undefined, tokens: { promptTokens?: number; completionTokens?: number } | undefined): void {
  try {
    if (isUserScene(scene)) return; // 用户对话不计入后台额度
    if (!tokens) return;
    ensureToday();
    usage.backgroundTokens += (tokens.promptTokens || 0) + (tokens.completionTokens || 0);

    const budget = getDailyBudget();
    if (budget > 0 && usage.backgroundTokens >= budget) {
      logger.warn(`${TAG} 今日后台额度已耗尽 ${formatNum(usage.backgroundTokens)} / ${formatNum(budget)}（后续后台任务将跳过/延后，用户对话不受影响）`);
      usage.lastLogAt = Date.now();
      return;
    }

    const intervalMin = getLogIntervalMin();
    if (intervalMin > 0 && Date.now() - usage.lastLogAt >= intervalMin * 60 * 1000) {
      usage.lastLogAt = Date.now();
      logger.info(`${TAG} 今日后台消耗 ${formatNum(usage.backgroundTokens)} / ${formatNum(budget)} (剩余 ${formatNum(Math.max(0, budget - usage.backgroundTokens))})`);
    }
  } catch {
    // 记账失败绝不阻断 LLM 调用
  }
}

function formatNum(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 今日后台 token 累计消耗 */
export function getBackgroundUsage(): number {
  ensureToday();
  return usage.backgroundTokens;
}

/**
 * 后台任务可否启动（额度判定）。返回 null = 允许；返回字符串 = 拒绝原因（熔断日志用）。
 * budget=0 表示不限制 → 恒允许。
 */
export function isBackgroundBudgetExhausted(): string | null {
  ensureToday();
  const budget = getDailyBudget();
  if (budget <= 0) return null;
  if (usage.backgroundTokens >= budget) {
    return `token预算耗尽（今日后台 ${formatNum(usage.backgroundTokens)} / ${formatNum(budget)}）`;
  }
  return null;
}

/** 测试用：重置当日计数 */
export function resetTokenBudgetForTest(): void {
  usage = { dayKey: todayKey(), backgroundTokens: 0, lastLogAt: 0 };
}
