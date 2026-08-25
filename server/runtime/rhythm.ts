// server/runtime/rhythm.ts
// Phase-2 综合修复：动态节律调度模块（活跃 / 半休眠 / 深度休眠）
//
// 职责：
//   1) 按「最后用户交互时间」计算当前节律模式（active / half_sleep / deep_sleep）；
//   2) 输出 inner_tick（旧 life TICK）动态间隔：active=10min / half=60min / deep=120-180min；
//   3) 模式切换去重日志 + 埋点（供 [Rhythm] 排查）；
//   4) onUserActivity()：用户发消息立即切回活跃（调度层下一周期自动恢复短间隔）。
//
// 硬性边界：本模块只输出「模式/间隔/判定」，不做任何业务写库；
// 不修改 chat / inner_tick / consolidate / dream 等核心业务逻辑。
// 全部阈值/间隔由环境变量控制（见 docs/PHASE2_SCHEDULER_FIX.md 环境变量表）。

import { logger } from '../lib/logger';
import { getLastUserMessageAt } from '../life/userState';

const TAG = '[Rhythm]';

export type RhythmMode = 'active' | 'half_sleep' | 'deep_sleep';

export interface RhythmConfig {
  /** 活跃阈值（分钟）：最后一次交互距今 < 该值 → active */
  activeMin: number;
  /** 半休眠阈值（小时）：空闲 > 该值 → half_sleep */
  halfSleepHours: number;
  /** 深度休眠阈值（小时）：空闲 > 该值 → deep_sleep */
  deepSleepHours: number;
  /** 活跃模式 inner_tick 间隔（分钟） */
  activeTickMin: number;
  /** 半休眠模式 inner_tick 间隔（分钟） */
  halfTickMin: number;
  /** 深度休眠模式 inner_tick 间隔（分钟，限定 120-180） */
  deepTickMin: number;
  /** 调试：true 时只记录日志，不真正改变任何调度行为 */
  dryRun: boolean;
}

function envNum(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** 节律配置（每次读取环境变量，运行中改 .env 重启即生效） */
export function getRhythmConfig(): RhythmConfig {
  return {
    activeMin: envNum('PEPPA_RHYTHM_ACTIVE_MIN', 30, 1, 24 * 60),
    halfSleepHours: envNum('PEPPA_RHYTHM_HALF_SLEEP_HOURS', 2, 1, 72),
    deepSleepHours: envNum('PEPPA_RHYTHM_DEEP_SLEEP_HOURS', 6, 2, 24 * 30),
    activeTickMin: envNum('PEPPA_RHYTHM_ACTIVE_TICK_MIN', 10, 1, 120),
    halfTickMin: envNum('PEPPA_RHYTHM_HALF_TICK_MIN', 60, 10, 12 * 60),
    deepTickMin: envNum('PEPPA_RHYTHM_DEEP_TICK_MIN', 120, 120, 180),
    dryRun: envBool('PEPPA_RHYTHM_DRY_RUN', false),
  };
}

/**
 * 纯函数：由空闲毫秒数计算节律模式（导出供测试直接断言）。
 * 规则（与任务规格对齐）：
 *   - 空闲 < activeMin → active
 *   - activeMin ≤ 空闲 < halfSleep → active（规格只定义 >2h 为半休眠，30min-2h 区间归活跃，不降频）
 *   - halfSleep ≤ 空闲 < deepSleep → half_sleep
 *   - 空闲 ≥ deepSleep → deep_sleep
 *   - idleMs <= 0（从未交互/未知）→ active（未知状态不降频，避免新环境行为回归）
 */
export function computeRhythmMode(idleMs: number, cfg: RhythmConfig): RhythmMode {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return 'active';
  const idleHours = idleMs / (60 * 60 * 1000);
  if (idleHours >= cfg.deepSleepHours) return 'deep_sleep';
  if (idleHours >= cfg.halfSleepHours) return 'half_sleep';
  return 'active';
}

/** 当前节律模式（读取最后用户交互时间计算） */
export function getRhythmMode(): RhythmMode {
  const cfg = getRhythmConfig();
  const last = getLastUserMessageAt();
  const idleMs = last > 0 ? Date.now() - last : 0;
  return computeRhythmMode(idleMs, cfg);
}

/** 当前空闲时长（毫秒；从未交互返回 0） */
export function getIdleMs(): number {
  const last = getLastUserMessageAt();
  return last > 0 ? Math.max(0, Date.now() - last) : 0;
}

/** 当前模式下的 inner_tick 间隔（毫秒）；dry-run 模式恒返回活跃间隔（只观测不生效） */
export function getInnerTickIntervalMs(mode?: RhythmMode): number {
  const cfg = getRhythmConfig();
  if (cfg.dryRun) return cfg.activeTickMin * 60 * 1000;
  const m = mode ?? getRhythmMode();
  const minutes = m === 'deep_sleep' ? cfg.deepTickMin : m === 'half_sleep' ? cfg.halfTickMin : cfg.activeTickMin;
  return minutes * 60 * 1000;
}

/**
 * 节律判定：sleepMode='full' 任务是否应在本轮跳过。
 * - deep_sleep：一律跳过（dream / growth_journal 等直接放弃本轮）；
 * - half_sleep：按日期奇偶降频（隔一个自然日执行一次；同一天重复触发 → 跳过）；
 *   幂等：以「上次实际执行日」为准，而非日历奇偶（避免日期变化导致双跑/漏跑）。
 * 返回跳过原因字符串（不跳过返回 null）。
 */
const lastRanDayByTask = new Map<string, string>();

export function shouldSkipFullTask(taskId: string): string | null {
  const mode = getRhythmMode();
  const cfg = getRhythmConfig();
  if (cfg.dryRun) return null; // dry-run：只观测，不真正跳过

  if (mode === 'deep_sleep') {
    return '深度休眠（空闲超阈值，任务本轮跳过，等待活跃模式）';
  }
  if (mode === 'half_sleep') {
    const today = new Date().toISOString().slice(0, 10);
    const lastDay = lastRanDayByTask.get(taskId);
    if (lastDay === today) {
      return '半休眠降频（同日已执行过一次）';
    }
    lastRanDayByTask.set(taskId, today);
    return null;
  }
  // active：全部任务正常运行
  return null;
}

/** 测试用：清空 half_sleep 降频状态 */
export function resetRhythmDayState(): void {
  lastRanDayByTask.clear();
}

/** 当前模式描述（埋点用） */
export function getRhythmLogLine(): string {
  const mode = getRhythmMode();
  const idleMs = getIdleMs();
  const idleHours = (idleMs / (60 * 60 * 1000)).toFixed(1);
  const nextMs = getInnerTickIntervalMs(mode);
  return `${TAG} mode=${mode} idle=${idleMs > 0 ? idleHours + 'h' : 'unknown'} next_tick=${Math.round(nextMs / 60000)}min`;
}

// ── 模式切换去重日志 ──
let lastLoggedMode: RhythmMode | null = null;

/** 模式切换埋点（去重：仅模式变化时输出一行）；由调度层周期性调用 */
export function logRhythmModeIfChanged(): RhythmMode {
  const mode = getRhythmMode();
  if (mode !== lastLoggedMode) {
    const idleMs = getIdleMs();
    const idleDesc = idleMs > 0 ? `空闲 ${(idleMs / (60 * 60 * 1000)).toFixed(1)}h` : '空闲未知';
    logger.info(`${TAG} 模式切换 ${lastLoggedMode ?? '(启动)'} → ${mode} (${idleDesc})`);
    lastLoggedMode = mode;
  }
  return mode;
}

/**
 * 用户产生新交互时调用（chat 链路 touchUserActivity 已设置时间戳，本函数只负责
 * 模式切换日志 + 复位降频状态）。调度层下一周期自动恢复活跃间隔。
 */
export function onUserActivity(): void {
  resetRhythmDayState();
  const mode = getRhythmMode();
  if (mode === 'active' && lastLoggedMode === 'active') return;
  logger.info(`${TAG} 用户交互，切回活跃模式（当前判定=${mode}）`);
  lastLoggedMode = 'active';
}

/** 测试用：重置模块内记忆状态 */
export function resetRhythmState(): void {
  lastLoggedMode = null;
  lastRanDayByTask.clear();
}
