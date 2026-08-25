// server/runtime/backgroundGate.ts
// Phase-2 综合修复：后台 LLM 任务并发门闸 + 资源防护（item 5/6/13）
//
// 职责（全部为调度/限流层，不改任何业务逻辑）：
//   1) 并发限流：同一时刻最多 PEPPA_BG_MAX_CONCURRENT（默认 2）个后台 LLM 任务执行，
//      其余排队延后（队列上限 PEPPA_BG_QUEUE_MAX，超出放弃本轮 → 下一调度周期再试）；
//   2) 排队等待上限：PEPPA_BG_WAIT_MAX_MS（默认 120s），超时放弃本轮（不无限堆积）；
//   3) Token 预算熔断：额度耗尽 → 直接放弃本轮（用户对话不走本模块，不受影响）；
//   4) 内存保护：进程堆超 PEPPA_BG_MEM_MAX_MB（默认 2048）→ 拒绝启动新后台任务，
//      避免大 prompt 对象堆积导致内存继续膨胀；
//   5) 埋点：每次排队/跳过/放弃输出原因（供 [BgGate] 排查）。
//
// 边界：用户 chat 链路绝不调用本模块（scheduler 后台任务独占）；后台 LLM 任务
// 失败不重试（handler 抛错由 scheduler.runTask 捕获即放弃本轮，见 scheduler.ts）。

import { logger } from '../lib/logger';
import { isBackgroundBudgetExhausted } from './tokenBudget';

const TAG = '[BgGate]';

export type GateStatus = 'ran' | 'queued' | 'deferred';

export interface GateResult {
  ok: boolean;
  status: GateStatus;
  /** 未执行时的原因（埋点用） */
  reason?: string;
  /** 已执行时透传 handler 返回值（供 scheduler 广播 proactive 消息） */
  message?: unknown;
}

interface QueueItem {
  label: string;
  fn: () => Promise<unknown>;
  resolve: (r: GateResult) => void;
  timer: NodeJS.Timeout;
}

function envNum(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function envMb(name: string, fallbackMb: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallbackMb;
}

/** 配置（每次调用读取环境变量，运行中改 .env 重启即生效） */
export function getGateConfig(): { maxConcurrent: number; maxQueue: number; waitMaxMs: number; memMaxMb: number } {
  return {
    maxConcurrent: envNum('PEPPA_BG_MAX_CONCURRENT', 2, 1, 8),
    maxQueue: envNum('PEPPA_BG_QUEUE_MAX', 8, 0, 100),
    waitMaxMs: envNum('PEPPA_BG_WAIT_MAX_MS', 120_000, 1_000, 30 * 60 * 1000),
    memMaxMb: envMb('PEPPA_BG_MEM_MAX_MB', 2048),
  };
}

class BackgroundGate {
  private running = 0;
  private queue: QueueItem[] = [];

  /** 内存保护：堆使用超阈值 → 拒绝启动新后台 LLM 任务（防止大 prompt 堆积膨胀） */
  private isMemoryAboveThreshold(): { above: boolean; heapMb: number } {
    const cfg = getGateConfig();
    const heapMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    return { above: heapMb >= cfg.memMaxMb, heapMb };
  }

  /** 当前运行中任务数（测试/观测用） */
  getRunningCount(): number {
    return this.running;
  }

  /** 当前排队任务数（测试/观测用） */
  getQueueLength(): number {
    return this.queue.length;
  }

  private dequeue(): void {
    while (this.running < getGateConfig().maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      clearTimeout(item.timer);
      this.running++;
      logger.info(`${TAG} 任务 ${item.label} 开始执行（运行中 ${this.running}/${getGateConfig().maxConcurrent}）`);
      item.fn()
        .then((result) => item.resolve({ ok: true, status: 'ran', message: result }))
        .catch(() => {
          // handler 内部异常由 scheduler.runTask 捕获；此处仅释放槽位并标记已执行
          item.resolve({ ok: true, status: 'ran' });
        })
        .finally(() => {
          this.running--;
          logger.info(`${TAG} 任务 ${item.label} 结束（运行中 ${this.running}/${getGateConfig().maxConcurrent}）`);
          this.dequeue();
        });
    }
  }

  /**
   * 执行一个后台任务（信号量 + 排队 + 预算/内存判定）。
   * - 槽位空闲 → 立即执行（返回 {ok:true, status:'ran'}）；
   * - 槽位占满 → 入队等待（等待超时或队列满 → 放弃本轮）；
   * - 预算耗尽 / 内存超阈值 → 不执行直接放弃（返回 reason）。
   */
  async run(label: string, fn: () => Promise<unknown>): Promise<GateResult> {
    // ── 预算熔断：额度耗尽只保留用户对话，后台任务跳过 ──
    const budgetReason = isBackgroundBudgetExhausted();
    if (budgetReason) {
      logger.warn(`${TAG} 任务 ${label} 跳过: ${budgetReason}（本轮放弃，等待下一调度周期）`);
      return { ok: false, status: 'deferred', reason: budgetReason };
    }

    // ── 内存保护：堆超阈值拒绝启动新后台 LLM 任务 ──
    const mem = this.isMemoryAboveThreshold();
    if (mem.above) {
      logger.warn(`${TAG} 任务 ${label} 跳过: 内存超阈值（堆 ${mem.heapMb}MB ≥ ${getGateConfig().memMaxMb}MB），拒绝送入 LLM`);
      return { ok: false, status: 'deferred', reason: `内存超阈值(${mem.heapMb}MB)` };
    }

    // ── 并发限流：槽位空闲 → 立即执行 ──
    const cfg = getGateConfig();
    if (this.running < cfg.maxConcurrent) {
      this.running++;
      logger.info(`${TAG} 任务 ${label} 开始执行（运行中 ${this.running}/${cfg.maxConcurrent}）`);
      try {
        const result = await fn();
        return { ok: true, status: 'ran', message: result };
      } finally {
        this.running--;
        logger.info(`${TAG} 任务 ${label} 结束（运行中 ${this.running}/${cfg.maxConcurrent}）`);
        this.dequeue();
      }
    }

    // ── 排队：队列满 → 放弃本轮（下一调度周期再试，杜绝任务堆积）──
    if (this.queue.length >= cfg.maxQueue) {
      logger.warn(`${TAG} 任务 ${label} 放弃: 排队队列已满（${this.queue.length}/${cfg.maxQueue}），本轮放弃`);
      return { ok: false, status: 'deferred', reason: `排队队列已满(${this.queue.length}/${cfg.maxQueue})` };
    }

    return new Promise<GateResult>((resolve) => {
      logger.info(`${TAG} 任务 ${label} 排队等待（运行中 ${this.running}/${cfg.maxConcurrent}，队列 ${this.queue.length + 1}/${cfg.maxQueue}）`);
      const timer = setTimeout(() => {
        // 等待超时 → 出队放弃本轮
        const idx = this.queue.findIndex((i) => i.label === label);
        if (idx >= 0) this.queue.splice(idx, 1);
        logger.warn(`${TAG} 任务 ${label} 排队超时放弃（${cfg.waitMaxMs}ms 内未获得执行槽）`);
        resolve({ ok: false, status: 'deferred', reason: `排队超时(${Math.round(cfg.waitMaxMs / 1000)}s)` });
      }, cfg.waitMaxMs);
      this.queue.push({ label, fn, resolve, timer });
    });
  }
}

export const backgroundGate = new BackgroundGate();
