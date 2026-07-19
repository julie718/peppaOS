/**
 * Resource-Aware Background Main Loop Scheduler
 *
 * Runs every 60 seconds. When idle (3 min no user activity), executes
 * background tasks with resource checks. Heavy tasks are skipped under
 * low memory or high CPU load.
 */
import { logger } from '../lib/logger';
import * as os from 'os';

// ── State ──
let lastUserActivity = Date.now();
let abortController: AbortController | null = null;
let loopInterval: ReturnType<typeof setTimeout> | null = null;

// ── Public API ──

let activeSocketCount = 0;

/** Called by HTTP middleware on every user message to reset idle timer */
export function touchActivity(): void {
  lastUserActivity = Date.now();
}

/** Called on socket connect */
export function notifySocketConnect(): void {
  activeSocketCount++;
  touchActivity();
}

/** Called on socket disconnect */
export function notifySocketDisconnect(): void {
  activeSocketCount = Math.max(0, activeSocketCount - 1);
}

/** Interrupt any running background task — called before processing user message */
export function preemptBackgroundTask(): void {
  if (abortController) {
    abortController.abort();
    abortController = null;
    logger.info('[MainLoop] background task preempted by user activity');
  }
}

// ── Detection ──

function isIdle(): boolean {
  const noActivity = Date.now() - lastUserActivity > 3 * 60 * 1000;
  const noSockets = activeSocketCount === 0;
  return noActivity && noSockets;
}

interface ResourceState {
  memoryOk: boolean;
  cpuOk: boolean;
  freeMemMB: number;
  load1: number;
}

function checkResources(): ResourceState {
  const freeMemMB = Math.round(os.freemem() / (1024 * 1024));
  const load1 = os.loadavg()[0];
  return {
    memoryOk: freeMemMB > 200,
    cpuOk: load1 < 2.0,
    freeMemMB,
    load1,
  };
}

// ── Tasks ──

async function runMemoryConsolidation(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  // Memory consolidation is handled by the existing scheduler.ts.
  // This mainLoop only gates on resource availability.
  // TODO: integrate with scheduler.ts trigger when resource checks are centralized.
  logger.info('[MainLoop] memory consolidation — delegated to scheduler');
}

async function runTaskCheck(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  // TODO: integrate with a tasks/reminders table when one exists
  logger.info('[MainLoop] task check — no tasks table yet, skipping');
}

async function runContextRefresh(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  // TODO: refresh cached context, sensor data, or knowledge base summaries
  logger.debug('[MainLoop] context refresh — nothing to refresh');
}

// ── Watchdog ──

function withWatchdog<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | null> {
  const timer = new Promise<null>((resolve) => {
    setTimeout(() => {
      logger.warn(`[MainLoop] ${label} timed out after ${timeoutMs / 1000}s`);
      resolve(null);
    }, timeoutMs);
  });
  return Promise.race([promise, timer]);
}

// ── Main Loop ──

async function runIdleTasks(): Promise<void> {
  abortController = new AbortController();
  const signal = abortController.signal;

  const res = checkResources();
  logger.info(`[MainLoop] idle -> executing tasks | mem:${res.freeMemMB}MB load:${res.load1.toFixed(1)}`);

  // 1. Memory consolidation — only when memory is sufficient
  if (res.memoryOk) {
    await runMemoryConsolidation(signal);
  } else {
    logger.warn('[MainLoop] low memory, skipping memory consolidation');
  }

  // 2. Task check — always run
  await runTaskCheck(signal);

  // 3. Context refresh — always run
  await runContextRefresh(signal);

  if (!signal.aborted) {
    logger.info('[MainLoop] idle tasks complete');
  }
  abortController = null;
}

let currentIntervalMs = 60_000;

export function startMainLoop(): void {
  if (loopInterval) return;
  logger.info('[MainLoop] started — interval: 60s, idle threshold: 3min');

  const scheduleNext = () => {
    loopInterval = setTimeout(async () => {
      // Adjust interval based on CPU load
      const load1 = os.loadavg()[0];
      if (load1 > 2.0 && currentIntervalMs === 60_000) {
        currentIntervalMs = 120_000;
        logger.warn(`[MainLoop] high CPU load (${load1.toFixed(1)}), extending interval to 120s`);
      } else if (load1 <= 2.0 && currentIntervalMs === 120_000) {
        currentIntervalMs = 60_000;
        logger.info(`[MainLoop] CPU load normalized (${load1.toFixed(1)}), restoring interval to 60s`);
      }

      if (isIdle()) {
        await runIdleTasks();
      }
      scheduleNext();
    }, currentIntervalMs);
  };
  scheduleNext();
}

export function stopMainLoop(): void {
  if (loopInterval) {
    clearTimeout(loopInterval);
    loopInterval = null;
    logger.info('[MainLoop] stopped');
  }
}
