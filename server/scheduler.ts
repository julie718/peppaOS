// Proactive agent scheduler - cron-like check-ins
// Each check-in fires a socket event to the UI so the user sees "Peppa checked in"

import { Server as SocketIOServer } from 'socket.io';
import { logger } from './lib/logger';
// Phase3: 全局功能开关 — 控制 scheduler 自主任务（周报月报等）是否执行
import { MIND_SWITCH } from '../src/config/mindSwitch';
// Phase4: 旧模块 addMemory 直接写入迁移 — 事件封装后经 runInnerTick 统一落库（仅 innerTick.ts 内部允许 addMemory）
import { runInnerTick } from '../src/core/innerTick';
import type { MentalEventItem } from '../src/types/innerTickSchema';
import { queryMemories, getDueReminders, fireReminder, runBehavioralAnalysis, decayMemories, dynamicDecayMemories, promoteMemories, getUnconsolidatedEpisodic, autoMarkCrossAgentShare } from './memory';
import { consolidateEpisodic, consolidateNarrative, ConsolidationContext } from './memory/consolidator';
import { runDreamCycle } from './memory/dream';
import { buildTree, ensureBranch, moveNode } from './memory/tree';
import { makeLLMCall, estimateTokenCount } from './llm/providers';
// Phase-2 综合修复：节律调度 / 后台门闸 / 技能拓展总闸（仅调度层，不改业务逻辑）
import { getRhythmMode, shouldSkipFullTask } from './runtime/rhythm';
import { backgroundGate } from './runtime/backgroundGate';
import { getWeatherBrief } from './services/weather';
// 【重构·模块4】固定话术模板剔除：晨间/晚间摘要由心智润色组成（触发数据 → LLM 组织表述）
import { composeTriggerContent } from './proactive/rhythm';
import { autoGenerateSkill } from './skills/generator';
import { autoGenerateWorkflows } from './agents/workflows';
import { runHealthAudit, HealthReport } from './agents/health_audit';
import { readDB, writeDB } from '../db_layer';
import { AgentRuntime, AgentRecord } from './agents/runtime';
import { personalityRegistry } from './personality';
import { evolvePersonality, generateReviewPrompt, shouldEvolve } from './personality/evolution';
import { getActiveSocketCount } from './core/mainLoop';
import { loadEmotionalState } from './personality/state';
import { getSameMonthDayPast, getMonthDayFromISO } from './time/utils';
import { detectSpatiotemporalPatterns } from './time/spatiotemporal';
import { cleanupEphemeralAgents } from './agents/orchestrator';
import { getRecentActivity } from './context/activity_stream';
import { runDailyScan, isFirstBootComplete } from './autonomy/system_explorer';
import { getTodayPlanSummary } from './autonomy/planner';
import { getGateConfig } from './autonomy/safety_gate';
import { parseStoredOperationMode } from './cognition/operation_modes';
import { getUserPreferredLLMConfig } from './llm/user_preferences';

interface ScheduledTask {
  id: string;
  cron: string;
  lastRun: string | null;
  handler: () => Promise<string | null>;
  /** If true, result is stored internally but NOT broadcast as a proactive notification */
  quiet?: boolean;
  /** If false, task is paused and will not fire */
  enabled?: boolean;
  /** P1-2 防重入：handler 执行中置位；下一周期触发时若仍为 true 则跳过本轮 */
  running?: boolean;
  // ── Phase-2 综合修复：调度元数据 ──
  /** LLM 后台任务：经 backgroundGate 限并发/排队/预算/内存（用户对话链路不经过） */
  background?: boolean;
  /** 节律门控：full=休眠降频/跳过；critical=深度休眠延后但任务保留；always=不受节律影响（默认） */
  sleepMode?: 'full' | 'critical' | 'always';
}

type LLMGetters = {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
};

class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  io: SocketIOServer | null = null;
  private llmGetters: LLMGetters | null = null;
  private disabledTasks: Set<string> = new Set();
  /** Phase-2 时钟回跳防护：记录上一轮墙钟，检测系统时间回拨 */
  private _lastRunWall = 0;

  setIO(io: SocketIOServer) {
    this.io = io;
  }

  setLLMGetters(getters: LLMGetters) {
    this.llmGetters = getters;
  }

  register(task: ScheduledTask) {
    // Restore enable/disable state from persistence
    const storedDisabled = this.loadDisabledState();
    if (storedDisabled.has(task.id)) {
      task.enabled = false;
      this.disabledTasks.add(task.id);
    }
    this.tasks.push(task);
    this.scheduleTask(task);
  }

  /** Load disabled task IDs from DB */
  private loadDisabledState(): Set<string> {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      if (setting?.value) {
        return new Set(JSON.parse(setting.value));
      }
    } catch {}
    return new Set();
  }

  /** Persist disabled task IDs to DB */
  private persistDisabledState() {
    try {
      const db = readDB();
      let setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      const value = JSON.stringify([...this.disabledTasks]);
      if (setting) {
        setting.value = value;
      } else {
        if (!db.settings) db.settings = [];
        db.settings.push({ key: 'scheduler_disabled_tasks', value });
      }
      writeDB(db);
    } catch {}
  }

  disableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = false;
    this.disabledTasks.add(id);
    this.clearTimer(id);
    this.persistDisabledState();
    logger.info(`[Scheduler] Task "${id}" disabled`);
    return true;
  }

  enableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = true;
    this.disabledTasks.delete(id);
    this.scheduleTask(task);
    this.persistDisabledState();
    logger.info(`[Scheduler] Task "${id}" enabled`);
    return true;
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  toggleTask(id: string): { enabled: boolean; found: boolean } {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return { enabled: false, found: false };
    if (task.enabled !== false) {
      this.disableTask(id);
      return { enabled: false, found: true };
    } else {
      this.enableTask(id);
      return { enabled: true, found: true };
    }
  }

  listTasks() {
    return this.tasks.map(task => ({
      id: task.id,
      cron: task.cron,
      lastRun: task.lastRun,
      active: this.timers.has(task.id),
      enabled: task.enabled !== false,
    }));
  }

  /** Persist a proactive message as an interaction so it survives restarts */
  private saveProactiveMessage(taskId: string, message: string, timestamp: string) {
    try {
      const db = readDB();
      // Find the first valid userId — proactive messages are typically for a single user
      const userIds = new Set<string>();
      for (const m of db.memories || []) { if (m.userId) userIds.add(m.userId); }
      for (const i of db.interactions || []) { if (i.userId) userIds.add(i.userId); }
      const userId = userIds.size > 0 ? [...userIds][0] : 'anonymous';

      if (!db.interactions) db.interactions = [];
      db.interactions.push({
        id: `proactive_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId,
        agentId: 'peppa',
        conversationId: '',
        module: 'peppa',
        message: `[${taskId}] ${message}`,
        response: '',
        role: 'assistant',
        personality: 'peppa',
        mode: 'proactive',
        toolCalls: '',
        timestamp,
      });
      writeDB(db);
    } catch (err: any) {
      logger.warn(`[Scheduler] Failed to persist proactive message:`, err.message);
    }
  }

  private scheduleTask(task: ScheduledTask) {
    if (task.enabled === false) {
      logger.info(`[Scheduler] Task "${task.id}" is disabled — skipping schedule`);
      return;
    }
    const parsed = this.parseCron(task.cron);

    if (parsed.type === 'interval') {
      // Phase-2 错峰：单轮触发封装复用（防重入跳过时本轮不算执行，lastRun 不更新）
      const runOnce = async () => {
        const { ran, message } = await this.runTask(task);
        if (!ran) return; // P1-2 防重入 / 节律跳过 / 门闸延后：本轮未执行
        task.lastRun = new Date().toISOString();
        if (message && this.io) {
          this.saveProactiveMessage(task.id, message, task.lastRun);
          if (!task.quiet) {
            this.io.emit('agent:proactive', {
              taskId: task.id,
              message,
              timestamp: task.lastRun,
            });
          }
        }
      };

      // 短周期任务（≤6h）注册时首次触发加随机抖动（PEPPA_SCHEDULER_STAGGER_MAX_MS，
      // 默认 60s）→ 破坏各任务相位对齐，避免启动后同周期任务齐射并发（内存膨胀根源）；
      // 24h/7d 等长周期任务保持原「启动后整周期」语义（如每日晨间/晚间摘要不因重启提前触发）。
      const isLongCycle = parsed.intervalMs > 6 * 60 * 60 * 1000;
      let firstDelayMs = parsed.intervalMs;
      let staggerSec = 0;
      if (!isLongCycle) {
        const staggerMaxMs = getSchedulerStaggerMaxMs();
        staggerSec = staggerMaxMs > 0 ? Math.floor(Math.random() * staggerMaxMs) : 0;
        firstDelayMs = staggerSec;
      }
      const timer = setTimeout(async () => {
        await runOnce();
        // 转固定周期：后续按 intervalMs 稳定触发（相位已被抖动错开）
        const intervalTimer = setInterval(runOnce, parsed.intervalMs);
        this.timers.set(task.id, intervalTimer);
      }, firstDelayMs);
      this.timers.set(task.id, timer);
      logger.info(
        `[Scheduler] Registered task "${task.id}" every ${parsed.intervalMs / 1000}s` +
        `${task.quiet ? ' (quiet)' : ''}${staggerSec > 0 ? ` (stagger ${(staggerSec / 1000).toFixed(0)}s)` : ''}`,
      );
    } else {
      // Real cron expression — use recursive setTimeout to hit exact times
      const runAndReschedule = async () => {
        const { ran, message } = await this.runTask(task);
        if (ran) {
          task.lastRun = new Date().toISOString();
          if (message && this.io) {
            this.saveProactiveMessage(task.id, message, task.lastRun);
            if (!task.quiet) {
              this.io.emit('agent:proactive', {
                taskId: task.id,
                message,
                timestamp: task.lastRun,
              });
            }
          }
        }
        // Schedule next run（防重入跳过时仍按原周期排程，不因慢执行积累偏移）
        const nextMs = this.nextCronTime(parsed.fields!);
        this.setTaskTimeout(task.id, runAndReschedule, nextMs);
      };
      const firstMs = this.nextCronTime(parsed.fields!);
      this.setTaskTimeout(task.id, runAndReschedule, firstMs);
      const [m, h, dom, mon, dow] = parsed.fields!;
      logger.info(`[Scheduler] Registered cron task "${task.id}" — ${m} ${h} ${dom} ${mon} ${dow} (next in ${Math.round(firstMs / 1000)}s)`);
    }
  }

  private setTaskTimeout(id: string, callback: () => void | Promise<void>, delayMs: number): NodeJS.Timeout {
    const maxDelay = 2_147_483_647; // Node timers are signed 32-bit milliseconds.
    const safeDelay = Math.max(1000, Math.min(delayMs, maxDelay));
    const remainingAfterThisChunk = Math.max(0, delayMs - safeDelay);

    const timer = setTimeout(() => {
      if (remainingAfterThisChunk > 0) {
        this.setTaskTimeout(id, callback, remainingAfterThisChunk);
        return;
      }
      void callback();
    }, safeDelay);

    this.timers.set(id, timer);
    return timer;
  }

  /**
   * P1-2 任务防重入：interval 与 cron 两条路径共用的执行外壳。
   * handler 执行期间再次触发（慢 LLM 调用跨过多个调度周期）→ 跳过本轮，
   * 防止并发执行导致 LLM token 爆炸 / SQLite 写风暴（同任务多实例）。
   * ran=false 表示被跳过（本轮不算执行，lastRun 不更新）；handler 异常
   * 已在此捕获并记录（保持原 try/catch 行为）。
   *
   * Phase-2 四层防护（均在 handler 之外，全部带原因日志）：
   *   1) 时钟回跳：Date.now() 比上一轮墙钟回退 >5s → 本轮跳过（容器时钟回拨防护）；
   *   2) 节律检查：sleepMode='full' 休眠降频/跳过；'critical' 深度休眠延后（任务保留）；
   *   3) 后台门闸：background 任务经 backgroundGate（并发/排队/预算/内存，用户对话不经过）；
   *   4) 错峰：interval 注册时相位抖动（见 scheduleTask）。
   */
  private async runTask(task: ScheduledTask): Promise<{ ran: boolean; message: string | null }> {
    if (task.running) {
      logger.warn(`[Scheduler] Task "${task.id}" 仍在上轮执行中，跳过本轮触发（防重入）`);
      return { ran: false, message: null };
    }

    // ── Phase-2 防护1：时钟回跳 ──
    const nowWall = Date.now();
    if (this._lastRunWall > 0 && nowWall < this._lastRunWall - 5000) {
      const diffSec = Math.round((this._lastRunWall - nowWall) / 1000);
      logger.warn(`[Scheduler] ⏰ 时钟回跳防护: 墙钟从 ${this._lastRunWall} 回退到 ${nowWall}（相差 ${diffSec}s），本轮全部任务跳过`);
      this._lastRunWall = nowWall;
      return { ran: false, message: null };
    }
    this._lastRunWall = nowWall;

    // ── Phase-2 防护2：节律检查 ──
    const mode = getRhythmMode();
    if (task.sleepMode === 'full' && mode !== 'active') {
      const reason = shouldSkipFullTask(task.id);
      if (reason) {
        logger.info(`[Scheduler] 任务 "${task.id}" 跳过: ${reason}`);
        return { ran: false, message: null };
      }
    }
    if (task.sleepMode === 'critical' && mode === 'deep_sleep') {
      // consolidate 类任务：只延后不删除，活跃模式自动恢复
      logger.info(`[Scheduler] 任务 "${task.id}" 延后: 深度休眠（任务保留注册表，活跃模式自动恢复）`);
      return { ran: false, message: null };
    }

    task.running = true;
    try {
      // ── Phase-2 防护3：后台门闸（并发/排队/token预算/内存阈值；用户对话链路不经过）──
      if (task.background) {
        const gate = await backgroundGate.run(task.id, () => task.handler());
        return { ran: true, message: gate.ok ? ((gate.message as string | null) ?? null) : null };
      }
      return { ran: true, message: await task.handler() };
    } catch (err: any) {
      logger.warn(`[Scheduler] Task "${task.id}" failed:`, err?.message ?? err);
      return { ran: true, message: null };
    } finally {
      task.running = false;
    }
  }

  /** Parse a cron string — returns either a fixed interval or cron field array */
  private parseCron(cron: string): { type: 'interval'; intervalMs: number } | { type: 'cron'; fields: number[] } {
    // Aliases (backward compatible)
    // P1-2 修复：原实现缺失 every_10s/every_1m/every_hour/every_24h → 静默 fallback 到 1h，
    // 导致 ambient_activity_poll(10s)、idle_check(1m)、auto_workflow_gen(every_hour)、
    // daily_system_scan(24h) 全部退化为 1 小时周期（idle 检测 1m→1h，扫描 24h→1h 空转）。
    switch (cron) {
      case 'every_10s': return { type: 'interval', intervalMs: 10 * 1000 };
      case 'every_1m': return { type: 'interval', intervalMs: 60 * 1000 };
      case 'every_5m': return { type: 'interval', intervalMs: 5 * 60 * 1000 };
      case 'every_1h': return { type: 'interval', intervalMs: 60 * 60 * 1000 };
      case 'every_hour': return { type: 'interval', intervalMs: 60 * 60 * 1000 };
      case 'every_6h': return { type: 'interval', intervalMs: 6 * 60 * 60 * 1000 };
      case 'every_24h': return { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 };
      case 'daily_9am': return { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 };
      case 'evening_8pm': return { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 };
      case 'every_30m': return { type: 'interval', intervalMs: 30 * 60 * 1000 };
      case 'every_2h': return { type: 'interval', intervalMs: 2 * 60 * 60 * 1000 };
      case 'every_7d': return { type: 'interval', intervalMs: 7 * 24 * 60 * 60 * 1000 };
    }

    // Phase2 模块4：动态小时间隔（every_Nh，N 整数 ≥1），供记忆权重衰减周期等 .env 可配置任务
    const dynamicHours = cron.match(/^every_(\d+)h$/);
    if (dynamicHours) {
      const hours = Math.max(1, Math.min(24 * 7, Number(dynamicHours[1]) || 1));
      return { type: 'interval', intervalMs: hours * 60 * 60 * 1000 };
    }

    // Real cron: 5 fields — minute hour dom month dow
    const parts = cron.trim().split(/\s+/);
    if (parts.length === 5) {
      const fields = parts.map(p => {
        const n = parseInt(p, 10);
        return isNaN(n) ? -1 : n; // -1 = wildcard (*)
      });
      return { type: 'cron', fields };
    }

    // Fallback: treat as interval alias
    return { type: 'interval', intervalMs: 60 * 60 * 1000 };
  }

  /** Compute milliseconds until the next cron match */
  private nextCronTime(fields: number[]): number {
    const [minute, hour, dom, month, dow] = fields;
    const now = new Date();
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);

    // Try up to 366 days ahead (cover a full year)
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const m = next.getMinutes();
      const h = next.getHours();
      const d = next.getDate();
      const mo = next.getMonth() + 1;
      const w = next.getDay();

      const mMatch = minute < 0 || m === minute;
      const hMatch = hour < 0 || h === hour;
      const domMatch = dom < 0 || d === dom;
      const monMatch = month < 0 || mo === month;
      const dowMatch = dow < 0 || w === dow;

      if (mMatch && hMatch && domMatch && monMatch && dowMatch) {
        const ms = next.getTime() - now.getTime();
        return Math.max(1000, ms); // Minimum 1 second
      }

      next = new Date(next.getTime() + 60000); // +1 minute
    }

    return 60 * 60 * 1000; // Fallback: 1 hour
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
      clearTimeout(timer); // Also clear cron timeouts
    }
    this.timers.clear();
  }
}

export const scheduler = new Scheduler();

/**
 * Register built-in proactive tasks.
 * Accepts LLM provider getters so consolidation and self-reflection can call the LLM.
 */
export function registerScheduledTasks(
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
) {
  /** Get all unique user IDs from DB (registered users + anonymous fallback) */
  function getAllUserIds(): string[] {
    const db = readDB();
    const ids = new Set<string>();
    for (const u of db.users || []) {
      if (u.uid) ids.add(u.uid);
    }
    for (const m of db.memories || []) {
      if (m.userId) ids.add(m.userId);
    }
    for (const i of db.interactions || []) {
      if (i.userId) ids.add(i.userId);
    }
    if (ids.size === 0) ids.add('anonymous');
    return [...ids];
  }

  // Reminder check-in (every 5 min) — checks all users' reminders
  scheduler.register({
    id: 'reminder_check',
    cron: 'every_5m',
    lastRun: null,
    handler: async () => {
      const due = getDueReminders();
      if (due.length === 0) return null;

      // Phase-2 防洪（item 4/11）：容器重启/长期停机后提醒堆积 → 单轮最多触发
      // PEPPA_REMINDER_MAX_PER_ROUND 条；过期超过 PEPPA_REMINDER_MAX_STALE_HOURS 的
      // 标记跳过（不删除、不补发），杜绝重启后批量轰炸。
      const maxPerRound = getSchedulerEnv('PEPPA_REMINDER_MAX_PER_ROUND', 5, 1, 50);
      const maxStaleHours = getSchedulerEnv('PEPPA_REMINDER_MAX_STALE_HOURS', 24, 1, 24 * 30);
      const now = Date.now();
      let triggered = 0;
      let staleSkipped = 0;
      const messages: string[] = [];

      for (const r of due) {
        if (triggered >= maxPerRound) break;
        const dueTs = r.dueAt ? new Date(r.dueAt).getTime() : 0;
        const staleMs = dueTs > 0 ? now - dueTs : 0;
        if (staleMs > maxStaleHours * 60 * 60 * 1000) {
          staleSkipped++;
          logger.warn(
            `[Scheduler] reminder 跳过: 已过期 ${(staleMs / 3600000).toFixed(1)}h 超 ${maxStaleHours}h ` +
            `（超时未触发，不删除不补发）`,
          );
          continue;
        }
        fireReminder(r.id);
        triggered++;
        messages.push(r.content);
      }
      logger.info(`[Scheduler] reminder_check 本轮触发 ${triggered} 条${staleSkipped > 0 ? `，跳过过期 ${staleSkipped} 条` : ''}`);
      return messages.length > 0 ? `Reminder: ${messages.join(' | ')}` : null;
    },
  });

  // Phase2 模块7：磁盘水位巡检（默认每 30 分钟）— 铁则4：只输出告警，绝不自动删除任何数据
  // 超限时输出告警日志；同时 chatWarnings.buildAmbientWarnings() 会在每轮对话回复的 warnings 数组里带上磁盘告警。
  scheduler.register({
    id: 'disk_space_check',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const { checkDiskStatus } = await import('./monitor/disk');
      const disk = await checkDiskStatus();
      if (disk && !disk.ok) {
        return `[磁盘告警] ${disk.warning}`; // scheduler 将输出到日志（主动推送走独立通道，不混入对话）
      }
      return null;
    },
  });

  // Memory decay — value-modulated tier-based decay for all users (every 6h, .env 可配置)
  // Phase2 模块4：MEMORY_DECAY_INTERVAL_HOURS 控制维护周期（默认 6h；衰减量为 MEMORY_DECAY_RATE）
  const decayIntervalHours = (() => {
    const n = Number(process.env.MEMORY_DECAY_INTERVAL_HOURS);
    return Number.isFinite(n) && n >= 1 ? Math.min(168, Math.floor(n)) : 6;
  })();
  scheduler.register({
    id: 'memory_decay',
    cron: `every_${decayIntervalHours}h`,
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      for (const userId of userIds) {
        dynamicDecayMemories(userId);
      }
      const lowConf = queryMemories({ minConfidence: 0, limit: 5 });
      const decayed = lowConf.filter(m => m.confidence < 0.25 && m.confidence > 0.1);
      if (decayed.length > 0) {
        return `Some memories are fading. Would you like me to refresh what I know about you?`;
      }
      return null;
    },
  });

  // Memory crystallization — auto-promote high-value memories (every 1h)
  // Cross-system fusion: higher intimacy lowers promotion thresholds
  scheduler.register({
    id: 'memory_crystallization',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const userIds = getAllUserIds();
      let totalPromoted = 0;
      for (const userId of userIds) {
        const emotionalState = loadEmotionalState(userId);
        totalPromoted += promoteMemories(userId, emotionalState.intimacy);
        // Auto-mark newly crystallized memories as cross-agent shareable
        autoMarkCrossAgentShare(userId);
      }
      if (totalPromoted > 0) {
        return `${totalPromoted} memories have crystallized into deeper knowledge.`;
      }
      return null;
    },
  });

  // Memory consolidation (every 30 min) — triggers when >=10 unconsolidated episodic
  scheduler.register({
    id: 'memory_consolidation',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；consolidate 只延后不删除（critical：深度休眠延后，活跃自动恢复）
    background: true,
    sleepMode: 'critical',
    handler: async () => {
      // Phase4: enableOldSchedulerAutonomy 开关 — false 时跳过记忆固化整套旧逻辑（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        const episodic = getUnconsolidatedEpisodic(userId);
        if (episodic.length < 10) continue;
        const ctx: ConsolidationContext = getUserPreferredLLMConfig(userId);
        const consolidated = await consolidateEpisodic(
          ctx, 10,
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
          getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
        );
        if (consolidated) {
          messages.push(`[${userId}] I've grown from our conversations: ${consolidated.content.slice(0, 200)}`);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Narrative memory consolidation (every 6h) — weaves episodic memories into storylines
  scheduler.register({
    id: 'narrative_consolidation',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase4: enableOldSchedulerAutonomy 开关 — false 时跳过叙事固化整套旧逻辑（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = getUserPreferredLLMConfig(userId);
          const result = await consolidateNarrative(
            ctx, 7, 6,
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
            getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
          );
          if (result) {
            const title = result.content.match(/^\[(.+?)\]/)?.[1] || '叙事记忆';
            messages.push(`[${userId}] 记忆叙事已生成: "${title}"`);
          }
        } catch (err: any) {
          logger.warn(`[NarrativeConsolidation] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0
        ? `叙事记忆更新 — ${messages.join('\n')}`
        : null;
    },
  });

  // Sleep / dream cycle — quiet memory maintenance during night or idle rest.
  scheduler.register({
    id: 'sleep_dream_cycle',
    cron: '17 3 * * *',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase4: enableOldSchedulerAutonomy 开关 — false 时跳过梦境整理整套旧逻辑（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];
      const getters: LLMGetters = {
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
      };

      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = getUserPreferredLLMConfig(userId, { maxTokens: 900 });
          const report = await runDreamCycle(
            ctx,
            {
              reason: 'scheduled_night_rest',
              cooldownHours: 6,
              windowHours: 48,
              minRecentMemories: 3,
            },
            getters,
          );
          if (report.status === 'dreamed') {
            messages.push(`[${userId}] ${report.dreamTitle || '梦境整理'}: ${String(report.dreamSummary || '').slice(0, 120)}`);
            if (scheduler.io) {
              scheduler.io.to(userId).emit('peppa:sleep_cycle', report);
            }
          }
        } catch (err: any) {
          logger.warn(`[SleepDreamCycle] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? `Peppa finished dreaming.\n${messages.join('\n')}` : null;
    },
  });

  // Morning briefing with weather — LLM-generated for natural warmth
  scheduler.register({
    id: 'daily_summary',
    cron: 'daily_9am',
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸（每日摘要为定时推送，不受节律降频，确保不漏）
    background: true,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const weather = await getWeatherBrief();
          const pending = getDueReminders();
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4 });

          // 【重构·模块4】固定话术模板移除（原: getTimeGreeting 固定问候 + "N 条待办/记得你最近聊过" 模板句）：
          // 晨间摘要由 composeTriggerContent 心智润色组成（实时触发数据 → 心智内核组织表述），
          // 离线时回退结构化摘要（容灾），不再存在任何固定句子。
          const content = await composeTriggerContent('morning_digest', {
            weather: weather || '无天气数据',
            pendingCount: pending.length,
            pending: pending.map(r => r.content).join('; ').slice(0, 80),
            recentMemory: recentMemories.length > 0 ? recentMemories[0].content.slice(0, 50) : '无',
          });
          messages.push(`[${userId}] ${content}`);
          logger.info(`[DailySummary] 心智润色晨间摘要: ${userId}`);
        } catch (err: any) {
          logger.warn(`[DailySummary] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Evening wrap-up — LLM-generated with reflection
  scheduler.register({
    id: 'evening_wrapup',
    cron: 'evening_8pm',
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸（晚间回顾为定时推送，不受节律降频，确保不漏）
    background: true,
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const pending = getDueReminders();
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4 });

          const habits = recentMemories.filter(m => m.type === 'habit');
          if (pending.length === 0 && habits.length === 0) continue;

          // 【重构·模块4】固定话术模板移除（原: "N 条待办仍然未完成" / "今天注意到:" / "晚间回顾 —" 固定句）：
          // 晚间回顾由 composeTriggerContent 心智润色组成，离线回退结构化摘要。
          const content = await composeTriggerContent('evening_wrapup', {
            pendingCount: pending.length,
            pending: pending.map(r => r.content).join('; ').slice(0, 80),
            habit: habits.length > 0 ? habits[0].content.slice(0, 50) : '无',
          });
          messages.push(`[${userId}] ${content}`);
          logger.info(`[EveningWrapup] 心智润色晚间回顾: ${userId}`);
        } catch (err: any) {
          logger.warn(`[EveningWrapup] Failed for ${userId}:`, err.message);
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Behavioral pattern analysis (every 6h) — for all users
  scheduler.register({
    id: 'behavioral_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      // Phase4: enableOldSchedulerAutonomy 开关 — false 时跳过行为分析整套旧逻辑（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      let totalCount = 0;
      for (const userId of userIds) {
        totalCount += runBehavioralAnalysis(userId);
      }
      if (totalCount > 0) {
        return `I've discovered ${totalCount} new behavioral patterns from your interactions. Check Memory Explorer to review.`;
      }
      return null;
    },
  });

  // Memory tree auto-organize (every 6h) — LLM groups orphan leaves into topic branches
  scheduler.register({
    id: 'memory_auto_organize',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠模式降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      const userIds = getAllUserIds();
      let totalBranches = 0;
      let totalAssigned = 0;

      for (const userId of userIds) {
        try {
          const db = readDB();
          const allMemories: any[] = db.memories || [];
          const orphans = allMemories.filter(
            (m: any) => m.userId === userId && m.nodeType !== 'branch' && !m.parentId,
          );
          if (orphans.length < 3) continue;

          // ── Phase-2 修复（item 2/11/13/15）：memory_tree prompt 炸弹 — 价值排序 + 上限采样 + token 硬截断 ──
          // 旧实现把全部 orphan 与全部 tree 节点无上限装进 prompt（数千条记忆可超 1M token）。
          // 新实现：orphan 按 importance×confidence 降序采样前 maxOrphans 条（每条 content 截断），
          // tree 只取前 maxTreeNodes 节点，构建后 estimateTokenCount 硬截断至 maxPromptTokens。
          // 业务行为不变：分组/挂枝仍按原始记忆全量执行（仅 prompt 输入被采样）。
          const maxOrphans = getMemoryTreeEnv('PEPPA_MEMORY_TREE_MAX_ORPHANS', 80, 10, 500);
          const maxTreeNodes = getMemoryTreeEnv('PEPPA_MEMORY_TREE_MAX_TREE_NODES', 60, 10, 500);
          const maxPromptTokens = getMemoryTreeEnv('PEPPA_MEMORY_TREE_MAX_PROMPT_TOKENS', 4000, 500, 20000);

          // 价值降序采样（importance×confidence，缺失按 0.5 计）
          let orphansChosen: any[] = orphans
            .map((m: any) => ({ m, score: (Number(m.importance) || 0.5) * (Number(m.confidence) || 0.5) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, maxOrphans)
            .map(({ m }) => ({ ...m, content: String(m.content || '').slice(0, 120) }));

          const fullTree = buildTree(allMemories.filter((m: any) => m.userId === userId));
          const treeNodes = fullTree.slice(0, maxTreeNodes);
          const treeSummary = treeNodes.map(
            t => `- ${t.node.content} [${t.node.nodeType}] (${t.children.length} children)`,
          ).join('\n');

          const buildPrompt = () => `You are organizing a memory tree. Below is the current tree structure and a list of unorganized memories.

CURRENT TREE:
${treeSummary || '(empty)'}

UNORGANIZED MEMORIES:
${orphansChosen.map((m: any) => `- [${m.id}] ${m.content}`).join('\n')}

Group these unorganized memories into 3-8 topic branches. For each memory, decide which topic it belongs to.
Return JSON:
{
  "branches": [
    { "title": "Topic name (short, 2-4 words)", "memoryIds": ["mem_xxx", "mem_yyy"] }
  ]
}

Rules:
- Every unorganized memory MUST be assigned to exactly one branch
- Branch titles should be meaningful topic names
- Create as few branches as necessary (merge similar topics)
- Return ONLY valid JSON, no markdown`;

          let prompt = buildPrompt();
          const promptTokensBefore = estimateTokenCount(prompt);

          // 超限 → 按最低价值 orphan 逐步剔除（列表已按价值降序，从尾部弹）
          while (orphansChosen.length > 0 && estimateTokenCount(prompt) > maxPromptTokens) {
            orphansChosen.pop();
            prompt = buildPrompt();
          }
          // 字符兜底（极端情况：tree 摘要本身超限）— 二分求「估算 token ≤ 上限」的最大前缀，
          // 保证 estimateTokenCount(prompt) ≤ maxPromptTokens（estimator 单调不减，CJK 1.5 字符/token，
          // 按字符数上限截断无法保证 token 上限，此处直接以 estimator 为目标迭代）
          if (estimateTokenCount(prompt) > maxPromptTokens) {
            let lo = 0;
            let hi = prompt.length;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              if (estimateTokenCount(prompt.slice(0, mid)) <= maxPromptTokens) lo = mid;
              else hi = mid - 1;
            }
            prompt = prompt.slice(0, Math.max(400, lo));
          }

          logger.info(
            `[Scheduler] memory_tree prompt_tokens=${estimateTokenCount(prompt)} (截断前 ${promptTokensBefore}, ` +
            `orphans ${orphansChosen.length}/${orphans.length}, tree ${treeNodes.length}/${fullTree.length} nodes, 上限 ${maxPromptTokens})`,
          );

          const llmResult = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            { ...getUserPreferredLLMConfig(userId), scene: 'memory_tree' },
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );

          // Phase-2（item 13）：大 prompt 对象用后立即释放引用，让 GC 尽快回收
          prompt = '' as any;
          orphansChosen = null as any;
          treeNodes.length = 0;

          let plan: { branches: { title: string; memoryIds: string[] }[] };
          try {
            const json = (llmResult.text || '').replace(/```json|```/g, '').trim();
            plan = JSON.parse(json);
          } catch {
            logger.warn(`[Scheduler] Auto-organize: LLM returned invalid JSON for ${userId}`);
            continue;
          }

          for (const branch of plan.branches) {
            if (!branch.title || !Array.isArray(branch.memoryIds)) continue;
            const branchNode = ensureBranch(userId, branch.title, '', null);
            totalBranches++;
            for (const memId of branch.memoryIds) {
              const ok = moveNode(memId, branchNode.id);
              if (ok) totalAssigned++;
            }
          }

          if (plan.branches.length > 0) {
            logger.info(
              `[Scheduler] Auto-organized ${userId}: ${plan.branches.length} branches, ` +
              `${plan.branches.reduce((s, b) => s + b.memoryIds.length, 0)} memories`,
            );
          }
        } catch (err: any) {
          logger.warn(`[Scheduler] Auto-organize failed for ${userId}:`, err.message);
        }
      }

      if (totalBranches > 0) {
        return `I've organized ${totalAssigned} memories into ${totalBranches} topic branches for easier recall.`;
      }
      return null;
    },
  });

  // Personality evolution (every 6h, gated by new-memory threshold)
  // Peppa's personality grows toward the owner through accumulated interaction data.
  // No fixed 7-day cooldown — evolves whenever enough new owner_trait memories accumulate.
  scheduler.register({
    id: 'personality_evolution',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.get('peppa');
          if (!config) continue;
          if (personalityRegistry.isEvolutionFrozen('peppa')) continue;

          // Gate: only evolve if enough new owner_trait memories since last evolution
          const db = readDB();
          const lastEvolvedAt = (config as any).lastEvolvedAt as string | undefined;
          const newMemoriesSince = lastEvolvedAt
            ? (db.memories || []).filter((m: any) =>
                m.userId === userId &&
                m.perspective === 'owner_trait' &&
                m.createdAt > lastEvolvedAt
              ).length
            : 999; // First time: always try

          if (newMemoriesSince < 20) {
            continue; // Not enough new data for a meaningful full evolution
          }

          const evolutionConfig = personalityRegistry.getEvolutionConfig('peppa');

          // L-3: 冷却门控接线 — shouldEvolve 校验 7 天冷却期（修复前函数无调用方，
          // 演化仅靠"新记忆≥20条"数据门槛，冷却时间戳形同虚设）
          const evolveGate = shouldEvolve(config, evolutionConfig);
          if (!evolveGate.canEvolve) {
            logger.info(`[Scheduler] 人格演化跳过: ${evolveGate.reason}`);
            continue;
          }

          const emotionalState = loadEmotionalState(userId);

          const step = await evolvePersonality(
            config,
            userId,
            emotionalState.connection,
            getDeepSeek,
            getGemini,
            getOpenAI || (() => null),
            getAnthropic || (() => null),
            getQwen || (() => null),
            evolutionConfig,
          );

          if (step) {
            personalityRegistry.applyEvolution('peppa', step);
            messages.push(
              `I've grown closer to understanding you. ${step.narrative}`
            );
            logger.info(`[Scheduler] Personality evolution complete for ${userId}: ${step.version}`);
          }
        } catch (err: any) {
          logger.error(`[Scheduler] Personality evolution failed for ${userId}:`, err.message);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Weekly review — every 7 days: Peppa reflects on what she learned this week
  scheduler.register({
    id: 'weekly_review',
    cron: 'every_7d',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          const config = personalityRegistry.get('peppa');
          if (!config) continue;
          const db = readDB();
          const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

          const weekMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && m.createdAt >= weekAgo,
          );
          const weekInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp >= weekAgo,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('peppa');
          const weekEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= weekAgo);

          const prompt = generateReviewPrompt({
            depth: 'weekly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: weekEvolutions,
            newMemoryCount: weekMemories.length,
            newInteractionCount: weekInteractions.length,
            topMemoryTopics: [...new Set<string>(weekMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 10),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            { ...getUserPreferredLLMConfig(userId, { maxTokens: 400 }), scene: 'weekly_report' },
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
            const evt: MentalEventItem = {
              source: 'scheduler',
              eventType: 'weekly_review',
              brief: '生成每周自我回顾',
              payload: { reviewContent: narrative, week: new Date().toISOString().slice(0, 10) },
            };
            eventList.push(evt);
            logger.info(`[WeeklyReview] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          logger.error(`[WeeklyReview] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Monthly review — 1st of each month: Peppa reflects on monthly growth trajectory
  scheduler.register({
    id: 'monthly_review',
    cron: '1 0 1 * *',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          const config = personalityRegistry.get('peppa');
          if (!config) continue;
          const db = readDB();
          const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();

          const monthMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && m.createdAt >= monthAgo,
          );
          const monthInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp >= monthAgo,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('peppa');
          const monthEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= monthAgo);

          const prompt = generateReviewPrompt({
            depth: 'monthly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: monthEvolutions,
            newMemoryCount: monthMemories.length,
            newInteractionCount: monthInteractions.length,
            topMemoryTopics: [...new Set<string>(monthMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 15),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            { ...getUserPreferredLLMConfig(userId, { maxTokens: 600 }), scene: 'monthly_report' },
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
            const evt: MentalEventItem = {
              source: 'scheduler',
              eventType: 'monthly_review',
              brief: '生成月度自我回顾',
              payload: { reviewContent: narrative, month: new Date().toISOString().slice(0, 7) },
            };
            eventList.push(evt);
            logger.info(`[MonthlyReview] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          logger.error(`[MonthlyReview] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Yearly review — Jan 1st: Peppa's deep annual retrospective
  scheduler.register({
    id: 'yearly_review',
    cron: '0 0 1 1 *',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          const config = personalityRegistry.get('peppa');
          if (!config) continue;
          const db = readDB();
          const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();

          const yearMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && m.createdAt >= yearAgo,
          );
          const yearInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp >= yearAgo,
          );
          const fullEvolutionHistory = personalityRegistry.getEvolutionHistory('peppa');
          const yearEvolutions = fullEvolutionHistory.filter((e: any) => e.timestamp >= yearAgo);

          const prompt = generateReviewPrompt({
            depth: 'yearly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: yearEvolutions,
            newMemoryCount: yearMemories.length,
            newInteractionCount: yearInteractions.length,
            topMemoryTopics: [...new Set<string>(yearMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 20),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            { ...getUserPreferredLLMConfig(userId, { maxTokens: 800 }), scene: 'yearly_report' },
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
            const evt: MentalEventItem = {
              source: 'scheduler',
              eventType: 'yearly_review',
              brief: '生成年度自我回顾',
              payload: { reviewContent: narrative, year: new Date().toISOString().slice(0, 4) },
            };
            eventList.push(evt);
            logger.info(`[YearlyReview] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          logger.error(`[YearlyReview] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Auto skill generation (every 30 min) — detects repeatable workflows
  scheduler.register({
    id: 'auto_skill_gen',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      const result = await autoGenerateSkill(
        getDeepSeek,
        getGemini,
        getOpenAI,
        getAnthropic,
        getQwen,
      );
      if (result && result.success) {
        return `I've learned a new skill: "${result.skillName}" — now I can handle this type of task more efficiently.`;
      }
      return null;
    },
  });

  // Auto workflow generation (every hour) — detects repeated tool patterns and creates named workflows
  scheduler.register({
    id: 'auto_workflow_gen',
    cron: 'every_hour',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      try {
        const created = await autoGenerateWorkflows();
        if (created > 0) {
          const userIds = getAllUserIds();
          for (const userId of userIds) {
            if (scheduler.io) {
              scheduler.io.to(userId).emit('agent:proactive', {
                type: 'workflow_auto_generated',
                message: `我发现了你的 ${created} 个操作习惯模式，已自动创建为工作流。你可以说"运行[名称]"来快速复用。`,
                count: created,
                timestamp: new Date().toISOString(),
              });
            }
          }
          return `Created ${created} new workflow(s) from repeated patterns`;
        }
      } catch (err) {
        logger.error('[Scheduler] auto_workflow_gen failed:', err);
      }
      return null;
    },
  });

  // [阶段二·自诊疗] 每日 3:00 后台静默全域定时自检（隔离库、只读诊断；缺陷自动修复+回滚留痕）
  scheduler.register({
    id: 'self_heal_daily',
    cron: '0 3 * * *',
    quiet: true,
    lastRun: null,
    handler: async () => {
      try {
        const { runSelfHeal } = await import('./self_heal/engine');
        const report = await runSelfHeal({ isolated: false });
        if (report.defects.length > 0) {
          logger.info(`[SelfHeal] 完成一轮自检: 断言 ${report.assertionPassed}/${report.assertionTotal}, 缺陷 ${report.defects.length}, 自动修复 ${report.autoRepaired}, 回滚 ${report.rollbackCount}, 健康分 ${report.healthScore}(${report.verdict})`);
        }
        return `SelfHeal: ${report.verdict} score=${report.healthScore}`;
      } catch (err) {
        logger.error('[Scheduler] self_heal_daily failed:', err);
      }
      return null;
    },
  });

  // System health audit (every 6 hours) — self-diagnose and notify if issues found
  scheduler.register({
    id: 'health_audit',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸（健康审计为系统维护，不受节律降频）
    background: true,
    handler: async () => {
      try {
        const userIds = getAllUserIds();
        for (const userId of userIds) {
          const report = runHealthAudit(userId);
          if (report.recommendations.length > 0 && scheduler.io) {
            scheduler.io.to(userId).emit('agent:proactive', {
              type: 'health_audit',
              report: {
                overallStatus: report.overallStatus,
                recommendations: report.recommendations.slice(0, 3),
                evolutionInsight: report.evolutionInsight,
              },
              timestamp: report.timestamp,
            });
          }
        }
      } catch (err) {
        logger.error('[Scheduler] health_audit failed:', err);
      }
      return null;
    },
  });

  // ── Peppa Growth Journal (daily) — auto-generated summary of what Peppa learned ──
  scheduler.register({
    id: 'growth_journal',
    cron: 'daily_9am',
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          const db = readDB();
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // Collect yesterday's stats
          const newMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && m.createdAt && m.createdAt >= yesterday,
          );
          const newInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp && i.timestamp >= yesterday,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('peppa');
          const recentEvolution = evolutionHistory.filter((e: any) => e.timestamp >= yesterday);

          // Memory stats by type and tier
          const byType: Record<string, number> = {};
          const byTier: Record<string, number> = {};
          for (const m of newMemories) {
            byType[m.type] = (byType[m.type] || 0) + 1;
            const tier = (m as any).tier || 'episodic';
            byTier[tier] = (byTier[tier] || 0) + 1;
          }

          // Conversation stats
          const conversations = (db.conversations || []).filter((c: any) =>
            c.userId === userId && c.lastActiveAt && c.lastActiveAt >= yesterday,
          );

          // Skill changes
          const newSkills = (db.interactions || []).filter((i: any) =>
            i.userId === userId && i.timestamp && i.timestamp >= yesterday && (i as any).mode === 'skill_gen',
          );

          // Build summary data
          const summaryData = {
            date: now.toISOString().slice(0, 10),
            newMemories: newMemories.length,
            memoriesByType: byType,
            memoriesByTier: byTier,
            newInteractions: newInteractions.length,
            activeConversations: conversations.filter((c: any) => c.status === 'active').length,
            closedConversations: conversations.filter((c: any) => c.status === 'closed').length,
            personalityEvolved: recentEvolution.length > 0,
            evolutionVersion: recentEvolution[0]?.version || null,
            evolutionNarrative: recentEvolution[0]?.narrative || null,
            newSkillsGenerated: newSkills.length,
            // Sample of new memories
            memoryHighlights: newMemories
              .filter((m: any) => (m as any).tier === 'growth' || m.confidence >= 0.8)
              .slice(0, 5)
              .map((m: any) => m.content),
            // Top interaction topics
            interactionSample: newInteractions.slice(0, 3).map((i: any) =>
              (i.content || i.message || '').slice(0, 80)
            ),
          };

          // Generate narrative summary via LLM
          try {
            const narrativePrompt = `You are Peppa's growth journal writer. Write a brief, warm Chinese narrative (3-5 sentences) summarizing what Peppa learned and experienced today.

Today's data (${summaryData.date}):
- ${summaryData.newMemories} new memories formed (${Object.entries(summaryData.memoriesByType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})
- ${summaryData.newInteractions} interactions
- ${summaryData.activeConversations} active conversations, ${summaryData.closedConversations} closed
- Memory tiers: ${Object.entries(summaryData.memoriesByTier).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}
${summaryData.personalityEvolved ? `- Personality evolved to ${summaryData.evolutionVersion}: ${summaryData.evolutionNarrative}` : '- No personality evolution today'}
${summaryData.newSkillsGenerated > 0 ? `- ${summaryData.newSkillsGenerated} new skills generated` : ''}
${summaryData.memoryHighlights.length > 0 ? `- Key memories: ${summaryData.memoryHighlights.join('; ')}` : ''}

Write in first-person as Peppa, warm and introspective tone. Keep it under 150 Chinese characters. Output only the narrative — no preamble, no labels.`;

            const narrativeResult = await makeLLMCall(
              [{ role: 'user', content: narrativePrompt }],
              [],
              { ...getUserPreferredLLMConfig(userId, { maxTokens: 300 }), scene: 'growth_journal' },
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );

            const narrative = narrativeResult.text?.trim() || `${summaryData.newMemories} 条新记忆，${summaryData.newInteractions} 次对话 — Peppa 在成长。`;

            // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
            const evt: MentalEventItem = {
              source: 'scheduler',
              eventType: 'growth_journal',
              brief: '生成成长日记叙事',
              payload: { journalContent: narrative, date: summaryData.date },
            };
            eventList.push(evt);

            // Phase4: 结构化数据同步封装为事件（原 growth_journal_data 直接写入）
            const evtData: MentalEventItem = {
              source: 'scheduler',
              eventType: 'growth_journal_data',
              brief: '成长日记结构化数据',
              payload: { summaryData },
            };
            eventList.push(evtData);

            logger.info(`[GrowthJournal] Generated for ${userId}: ${narrative.slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          } catch (llmErr: any) {
            logger.warn(`[GrowthJournal] LLM generation failed for ${userId}:`, llmErr.message);
            // Fallback: simple stats summary
            const fallback = `${summaryData.date}: ${summaryData.newMemories} 条新记忆, ${summaryData.newInteractions} 次互动, ${summaryData.activeConversations} 个活跃对话。`;
            // Phase4: LLM 失败兜底 → 封装为 MentalEventItem 一并派发
            const evtFallback: MentalEventItem = {
              source: 'scheduler',
              eventType: 'growth_journal_fallback',
              brief: '成长日记生成失败，回退统计摘要',
              payload: { fallback, date: summaryData.date },
            };
            eventList.push(evtFallback);
          }
        } catch (err: any) {
          logger.warn(`[GrowthJournal] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }

      return messages.length > 0
        ? `📖 Growth journal updated for ${messages.length} user(s).`
        : null;
    },
  });

  // Agent autonomous tick (every 30 min) — LLM-driven reflective analysis
  scheduler.register({
    id: 'agent_autonomous_tick',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const db = readDB();
      const agents: AgentRecord[] = db.agents || [];
      const autonomousAgents = agents.filter(
        (a: AgentRecord) => a.autonomyLevel === 'scheduled' || a.autonomyLevel === 'autonomous',
      );

      if (autonomousAgents.length === 0) return null;

      const messages: string[] = [];

      for (const agentRecord of autonomousAgents) {
        try {
          const personality = personalityRegistry.get(agentRecord.personalityId || 'peppa') || personalityRegistry.getDefault();
          const userId = agentRecord.ownerUid || agentRecord.userId || 'anonymous';

          // Gather recent data for analysis
          const recentMemories = queryMemories({
            userId,
            limit: 30,
            minConfidence: 0.3,
            agentId: agentRecord.memoryScope === 'private' ? agentRecord.id : undefined,
          });
          const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
          const recentInteractions = (db.interactions || [])
            .filter((i: any) => i.userId === userId && i.timestamp >= sixHoursAgo)
            .slice(0, 20);

          if (recentMemories.length < 3 && recentInteractions.length < 3) continue;

          // Use AgentRuntime for unified tick logic
          const { AgentRuntime } = await import('./agents/runtime');
          const runtime = new AgentRuntime(agentRecord, personality);
          runtime.loadState(userId);

          const analyze = async (prompt: string): Promise<string> => {
            const result = await makeLLMCall(
              [{ role: 'user', content: prompt }],
              [],
              { ...getUserPreferredLLMConfig(userId, { maxTokens: 200 }), scene: 'runtime_tick' },
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
            return result.text?.trim() || '';
          };

          const tickResult = await runtime.autonomousTick(userId, recentMemories, recentInteractions, analyze);

          // Store reflection via runtime's addMemory (with proper scoping)
          if (tickResult.memoryUpdate) {
            // Memory already stored inside autonomousTick() via runtime.addMemory()
          }

          if (tickResult.message) {
            messages.push(`[${agentRecord.name}] ${tickResult.message}`);
          }
        } catch (err: any) {
          // Skip agents that fail to tick
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // ── Proactive Peppa Scan (every 1h) — background anomaly/pattern detection ──
  scheduler.register({
    id: 'proactive_peppa_scan',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    // Phase-2：休眠降频（full）——handler 为纯模板（无直接 LLM 调用），仅节律门控
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          const db = readDB();
          const now = new Date();
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
          const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // 1. Memory spike detection: unusually high memory creation rate
          const recentMemories = (db.memories || []).filter(
            (m: any) => m.userId === userId && m.createdAt >= oneHourAgo,
          );
          const dayMemories = (db.memories || []).filter(
            (m: any) => m.userId === userId && m.createdAt >= twentyFourHoursAgo,
          );

          const anomalySignals: string[] = [];

          // Memory spike: >10 memories in the last hour
          if (recentMemories.length >= 10) {
            anomalySignals.push(`过去一小时内产生了 ${recentMemories.length} 条新记忆，远超正常水平`);
          }

          // Type concentration: >70% of today's memories are same type
          if (dayMemories.length >= 8) {
            const typeCounts: Record<string, number> = {};
            for (const m of dayMemories) {
              typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
            }
            const maxType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
            if (maxType && maxType[1] / dayMemories.length > 0.7) {
              const typeLabels: Record<string, string> = {
                preference: '偏好', fact: '事实', habit: '习惯', knowledge: '知识',
              };
              anomalySignals.push(`最近24小时记忆集中在${typeLabels[maxType[0]] || maxType[0]}类型(${maxType[1]}/${dayMemories.length})`);
            }
          }

          // 2. Long inactivity check: >24h since last interaction
          const userInteractions = (db.interactions || [])
            .filter((i: any) => i.userId === userId)
            .sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
          if (userInteractions.length > 0) {
            const lastTs = new Date(userInteractions[0].timestamp).getTime();
            const hoursIdle = (now.getTime() - lastTs) / (1000 * 60 * 60);
            if (hoursIdle > 24 && hoursIdle < 168) {
              anomalySignals.push(`用户已 ${Math.round(hoursIdle)} 小时未互动`);
            }
          }

          // 3. Generate a proactive check-in if signals detected
          if (anomalySignals.length > 0) {
            const signalsStr = anomalySignals.join('; ');

            // P1-4: 固定场景纯模板化 — 异常巡检关怀移除 LLM 调用（成本优化）
            const checkIn = `注意到一些变化 — ${anomalySignals.join('；')}`;
            messages.push(`[${userId}] ${checkIn}`);
            logger.info(`[ProactiveScan] 纯模板巡检关怀 (LLM 调用已移除): ${userId}`);

            // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
            const evt: MentalEventItem = {
              source: 'scheduler',
              eventType: 'proactive_scan',
              brief: '异常信号巡检关怀',
              payload: { signals: signalsStr, checkIn },
            };
            eventList.push(evt);
          }

          // 4. Predictive assistant — anticipate what the user might do next based on time-of-day + history
          try {
            const currentHour = now.getHours();
            const currentDay = now.getDay(); // 0=Sun, 6=Sat
            const isWeekday = currentDay >= 1 && currentDay <= 5;

            // Check behavioral patterns for active hour prediction
            const behaviorMemories = queryMemories({
              userId,
              type: 'habit',
              limit: 10,
              minConfidence: 0.3,
            });
            const activeHourPattern = behaviorMemories.find(
              m => m.type === 'habit' && m.content.includes('most active during hours'),
            );
            const toolPattern = behaviorMemories.find(
              m => m.type === 'habit' && m.content.includes('Most used tools'),
            );

            // Check recent activity for window context
            const recentActivity = getRecentActivity(userId, 20);
            const recentWindows = recentActivity
              .filter(e => e.type === 'window_changed' && e.data?.process_name)
              .slice(0, 5);
            const appNames = [...new Set(recentWindows.map(e => e.data!.process_name as string))];

            // Check if current time aligns with known active hours
            let hourContext = '';
            if (activeHourPattern) {
              const hourMatch = activeHourPattern.content.match(/hours (\d+):00 and (\d+):00/);
              if (hourMatch) {
                const h1 = parseInt(hourMatch[1]);
                const h2 = parseInt(hourMatch[2]);
                const nearPeak = Math.abs(currentHour - h1) <= 1 || Math.abs(currentHour - h2) <= 1;
                if (nearPeak) {
                  hourContext = `当前时间接近用户历史活跃时段(${h1}:00-${h2}:00)`;
                } else if (isWeekday && currentHour >= 8 && currentHour <= 10) {
                  hourContext = '工作日上午，用户可能准备开始一天的工作';
                } else if (isWeekday && currentHour >= 13 && currentHour <= 14) {
                  hourContext = '午后时段，用户可能刚用完午餐回到工位';
                } else if (currentHour >= 21 && currentHour <= 23) {
                  hourContext = '晚间时段，用户可能在放松或个人学习';
                }
              }
            }

            // Build prediction context
            const predictionHints: string[] = [];
            if (hourContext) predictionHints.push(hourContext);
            if (appNames.length > 0) {
              const appList = appNames.map(a => a.replace(/\.exe$/i, '')).join('、');
              predictionHints.push(`用户最近在使用：${appList}`);
            }
            if (toolPattern) {
              predictionHints.push(toolPattern.content);
            }

            if (predictionHints.length >= 1) {
              // P1-4: 固定场景纯模板化 — 主动预测移除 LLM 调用（成本优化），
              // 基于上下文确定性拼接（上下文提示已为人类可读表述）
              const humanized = predictionHints.map(h =>
                h
                  .replace(/当前时间接近用户历史活跃时段/, '现在接近你通常活跃的时段')
                  .replace(/用户可能/g, '你可能')
                  .replace(/用户在/g, '你在'),
              );
              const prediction = `${humanized.join('，')}，需要我帮忙做点什么吗？`;
              messages.push(`[${userId}] 🔮 ${prediction}`);
              logger.info(`[PredictiveAssistant] 纯模板预测 (LLM 调用已移除): ${userId}`);

              // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
              const evt: MentalEventItem = {
                source: 'scheduler',
                eventType: 'predictive_assistant',
                brief: '主动预测提示',
                payload: { prediction, contextHints: predictionHints },
              };
              eventList.push(evt);
            }
          } catch (predErr: any) {
            // Predictive assistant failure is non-critical
            logger.warn(`[PredictiveAssistant] Failed for ${userId}:`, predErr.message);
          }
        } catch (err: any) {
          logger.warn(`[ProactiveScan] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // ── "This Day in History" (daily) — find memories from this day in past years ──
  scheduler.register({
    id: 'memory_this_day',
    cron: 'daily_9am',
    quiet: true,
    lastRun: null,
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          // Look back across all past years for today's month-day
          const now = new Date();
          const month = now.getMonth() + 1;
          const day = now.getDate();

          const pastMemories: { content: string; year: number }[] = [];
          // Check last 3 years
          for (let yearOffset = 1; yearOffset <= 3; yearOffset++) {
            const year = now.getFullYear() - yearOffset;
            const after = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
            const before = `${year}-${String(month).padStart(2, '0')}-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`;

            const matches = queryMemories({
              userId,
              after,
              before,
              limit: 20,
            });

            for (const m of matches) {
              pastMemories.push({ content: m.content.slice(0, 100), year });
            }
          }

          if (pastMemories.length > 0) {
            const sample = pastMemories.slice(0, 3);
            const refs = sample.map(m => `"${m.content}" (${m.year}年)`).join('; ');
            const yearsAgo = pastMemories[0].year;
            messages.push(
              `[${userId}] 历史上的今天: ${pastMemories.length} 条过去${now.getFullYear() - yearsAgo}年${month}月${day}日的记忆: ${refs}`,
            );

            // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
            const evt: MentalEventItem = {
              source: 'scheduler',
              eventType: 'this_day_in_history',
              brief: '历史上的今天记忆回顾',
              payload: { month, day, sampleContents: sample.map(m => m.content) },
            };
            eventList.push(evt);
          }
        } catch (err: any) {
          logger.warn(`[MemoryThisDay] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }

      return messages.length > 0
        ? `历史上的今天 — ${messages.join('\n')}`
        : null;
    },
  });

  // ── Spatiotemporal pattern analysis (every 6h) — detect location+time patterns ──
  scheduler.register({
    id: 'spatiotemporal_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        // Phase4: 本用户派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
        const eventList: MentalEventItem[] = [];
        try {
          const patterns = detectSpatiotemporalPatterns(userId);
          if (patterns.length > 0) {
            const newPatterns = patterns.filter(p => p.confidence >= 0.5);
            for (const p of newPatterns.slice(0, 3)) {
              // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
              const evt: MentalEventItem = {
                source: 'scheduler',
                eventType: 'spatiotemporal_pattern',
                brief: '发现时空行为模式',
                payload: { description: p.description, patternType: p.type, confidence: p.confidence },
              };
              eventList.push(evt);
            }
            messages.push(
              `[${userId}] 发现 ${newPatterns.length} 个时空行为模式`,
            );
          }
        } catch (err: any) {
          logger.warn(`[SpatiotemporalAnalysis] Failed for ${userId}:`, err.message);
        }
        // Phase4: 任务末尾派发本用户派生心智事件（非阻塞，失败不影响主流程）
        if (eventList.length > 0) {
          void runInnerTick({ userId, derivedMentalEvents: eventList }).catch((e) => console.error('mental event dispatch fail', e));
        }
      }

      return messages.length > 0
        ? `时空模式分析 — ${messages.join('\n')}`
        : null;
    },
  });

  // Ephemeral agent cleanup (every 1h) — removes orphaned auto-created workers
  scheduler.register({
    id: 'ephemeral_cleanup',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    handler: async () => {
      const removed = cleanupEphemeralAgents(6);
      if (removed > 0) {
        return `Cleaned up ${removed} ephemeral worker agents`;
      }
      return null;
    },
  });

  // ── Ambient Awareness Tasks ──

  // Activity poll (every 10s) — requests ambient state from all connected Tauri clients
  scheduler.register({
    id: 'ambient_activity_poll',
    cron: 'every_10s',
    lastRun: null,
    handler: async () => {
      if (scheduler.io) {
        scheduler.io.emit('ambient:poll_request', { timestamp: new Date().toISOString() });
      }
      return null; // Silent — frontend handles the actual work
    },
  });

  // Idle check (every 1min) — suppresses notifications during active use
  scheduler.register({
    id: 'idle_check',
    cron: 'every_1m',
    lastRun: null,
    handler: async () => {
      if (scheduler.io) {
        // Broadcast idle check request; frontend reports back with idle time
        scheduler.io.emit('ambient:idle_check', { timestamp: new Date().toISOString() });
      }
      return null;
    },
  });

  // ── Autonomous work cycle — background task generation + execution ──
  // L-15: 待机成本控制 — 原 every_10m（待机 24h ≈ 144 次 LLM 调用）降频为 every_2h（≤12 次/天），
  // 且用户在线（有 socket 连接）时跳过，避免与用户对话竞争上下文；模型档位见 task_generator 的 light 场景
  scheduler.register({
    id: 'autonomous_work_cycle',
    cron: 'every_2h',
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸；休眠降频（full）
    background: true,
    sleepMode: 'full',
    handler: async () => {
      // Phase3: enableOldSchedulerAutonomy 开关 — false 时跳过整套旧自主任务（代码本体保留）
      if (!MIND_SWITCH.enableOldSchedulerAutonomy) return null;
      if (!scheduler.io) return null;

      // L-15: 用户活跃期（有在线连接）跳过 — 后台自主任务不打扰对话、不抢占上下文
      if (getActiveSocketCount() > 0) {
        logger.info('[AutoTasks] 用户在线，跳过本轮自主工作周期');
        return null;
      }

      const userIds = getAllUserIds();
      let totalGenerated = 0;
      let totalExecuted = 0;

      const getters: LLMGetters = {
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
      };

      for (const userId of userIds) {
        try {
          // Check if user has autonomous mode enabled
          const db = readDB();
          const modeSetting = (db.settings || []).find((s: any) =>
            s.key === `op_mode_${userId}`
          );
          const mode = modeSetting ? parseStoredOperationMode(modeSetting.value) : 'assistant';
          if (mode !== 'autonomous') continue;

          // Generate tasks
          const { generateAutonomousTasks } = await import('./autonomy/task_generator');
          const generated = await generateAutonomousTasks(userId, getters);
          totalGenerated += generated;

          // Execute pending tasks, bounded by the current safety gate.
          const { executeNextAutonomousTask } = await import('./autonomy/task_executor');
          const maxTasks = Math.max(1, Math.min(10, getGateConfig().maxConsecutiveTasks || 1));
          for (let i = 0; i < maxTasks; i++) {
            const result = await executeNextAutonomousTask(scheduler.io!, getters);
            if (!result.executed) break;
            totalExecuted++;
          }
        } catch (err: any) {
          logger.warn(`[AutoWorkCycle] Failed for ${userId}:`, err.message);
        }
      }

      if (totalGenerated > 0 || totalExecuted > 0) {
        return `Generated ${totalGenerated} tasks, executed ${totalExecuted}`;
      }
      return null;
    },
  });

  // ── Daily System Scan — Peppa checks the PC's health ──
  scheduler.register({
    id: 'daily_system_scan',
    cron: 'every_24h',
    lastRun: null,
    handler: async () => {
      if (!isFirstBootComplete()) return null;
      const snapshot = runDailyScan();
      if (!snapshot) return null;

      // Emit the scan result to all connected clients
      if (scheduler.io) {
        scheduler.io.emit('system:scan_result', {
          timestamp: snapshot.timestamp,
          hostname: snapshot.hardware.hostname,
          summary: snapshot.changeSummary,
          diskFree: snapshot.hardware.disks.map(d => `${d.name}: ${d.freeGB.toFixed(1)}GB free`),
          appCount: snapshot.software.installedApps.length,
          planSummary: getTodayPlanSummary(),
        });
      }

      return snapshot.changeSummary || 'Scan complete';
    },
  });

  // ── T80: IdleBrain 待机检查（每 5 分钟，静默） ──
  scheduler.register({
    id: 'idle_brain_check',
    cron: 'every_5m',
    quiet: true,
    lastRun: null,
    // Phase-2：LLM 后台任务走门闸（IdleBrain 含 LLM 推演；系统维护不受节律降频）
    background: true,
    handler: async () => {
      try {
        const { idleBrainCheck } = await import('./autonomy/idle_brain');
        return await idleBrainCheck();
      } catch {
        return null;
      }
    },
  });

}

// ══════════════ Phase-2 调度环境变量读取（模块外，供 runTask/scheduleTask/handler 使用） ══════════════

/** 整数环境变量读取（越界截断），缺省用默认值 */
function getSchedulerEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** interval 任务错峰抖动上限（毫秒；0 = 不错峰） */
function getSchedulerStaggerMaxMs(): number {
  return getSchedulerEnv('PEPPA_SCHEDULER_STAGGER_MAX_MS', 60_000, 0, 10 * 60 * 1000);
}

/** memory_tree prompt 构建上限参数（数量/节点数/token 上限，越界截断到安全区间） */
function getMemoryTreeEnv(name: string, fallback: number, min: number, max: number): number {
  return getSchedulerEnv(name, fallback, min, max);
}



