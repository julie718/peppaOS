// test/p2_rhythm_fix.test.ts
// Phase-2 综合修复验证（对应规格 9 个验证点 + 计划 12 个用例）。
//
// 覆盖：
//   1. computeRhythmMode 边界（active / half_sleep / deep_sleep / 未知→active）
//   2. getInnerTickIntervalMs 环境变量覆盖（含 deep 120-180 钳制 + dry-run）
//   3. 用户发消息 → 模式立即切回 active（touchUserActivity + onUserActivity）
//   4. memory_tree prompt 硬上限 ≤ PEPPA_MEMORY_TREE_MAX_PROMPT_TOKENS（5000 条幽灵记忆注入）
//   5. reminder 防洪：单轮最多 PEPPA_REMINDER_MAX_PER_ROUND 条、过期跳过（不删除）
//   6. 时钟回跳防护：Date.now 回拨 1h → runTask 跳过本轮
//   7. token 预算熔断：后台额度耗尽 → backgroundGate 延后；用户 chat 场景不计入、不受影响
//   8. 门闸并发：maxConcurrent=1 排队、队列满延后、等待超时延后
//   9. PEPPA_PHASE3_SKILL_AUTO_ENABLE=false → p3_skill_gap_scan handler 短路
//  10. 深度休眠：full 任务跳过 / critical(consolidate) 延后不删除；半休眠按日奇偶降频
//  11. 后台 LLM 失败不重试（scene=memory_tree → 1 次），用户 chat 保持 3 次尝试
//  12. inner_tick 休眠模式 prompt 瘦身：slim 召回条数减量（mock lifeDb 读取函数断言参数）
//
// 硬性边界：不触碰任何真实数据（LUMI_DATA_DIR 指向临时目录）；不改任何业务逻辑（只断言行为）。

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// ── 隔离数据目录（必须在导入业务模块之前设置）──
const tmpRoot = path.join(os.tmpdir(), `peppa_p2_${crypto.randomUUID().slice(0, 8)}`);
fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'data', '.migration_skip'), '');
process.env.LUMI_DATA_DIR = tmpRoot;
process.env.JWT_SECRET = 'test-jwt-test-jwt';

// 保存原始 PEPPA_* 环境变量（afterEach 恢复，避免测试间串扰）
const SAVED_PEPPA_ENV: Record<string, string> = {};
for (const k of Object.keys(process.env)) {
  if (k.startsWith('PEPPA_')) SAVED_PEPPA_ENV[k] = process.env[k]!;
}

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { logger } from '../server/lib/logger';
import {
  computeRhythmMode,
  getRhythmMode,
  getInnerTickIntervalMs,
  getRhythmConfig,
  onUserActivity,
  resetRhythmState,
  resetRhythmDayState,
} from '../server/runtime/rhythm';
import { touchUserActivity } from '../server/life/userState';
import { scheduler, registerScheduledTasks } from '../server/scheduler';
import { backgroundGate } from '../server/runtime/backgroundGate';
import {
  recordUsage,
  getBackgroundUsage,
  isUserScene,
  isBackgroundBudgetExhausted,
  resetTokenBudgetForTest,
} from '../server/runtime/tokenBudget';
import { makeLLMCall } from '../server/llm/providers';
import { resetPhase3SwitchCache } from '../server/skills_extension/switch';
import { resetPhase3ConfigCache } from '../server/phase3/config';
import { runInnerTick } from '../src/core/innerTick';
import * as lifeDb from '../server/db/lifeDb';

// ── inner_tick 瘦身测试：mock life.db 快照读取函数（importOriginal 保留其余真实实现）──
vi.mock('../server/db/lifeDb', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/db/lifeDb')>();
  return {
    ...mod,
    // 快照读取 → 空数据 + 记录调用参数（loadLifeSnapshotAsText 全部 try/catch，返回空数组安全）
    getPersonality: vi.fn().mockResolvedValue(null),
    getRecentEmotions: vi.fn().mockResolvedValue([]),
    getActiveDesires: vi.fn().mockResolvedValue([]),
    getTopDesire: vi.fn().mockResolvedValue(null),
    getRecentReflections: vi.fn().mockResolvedValue([]),
    getSignificantMemories: vi.fn().mockResolvedValue([]),
    getLatestRelationship: vi.fn().mockResolvedValue(null),
    getUnresolvedThoughts: vi.fn().mockResolvedValue([]),
    getRecentEvents: vi.fn().mockResolvedValue([]),
    // LLM 失败路径为「零写入兜底」，以下函数不应被调用；mock 掉以防误触真实库
    logSystemEvent: vi.fn().mockResolvedValue(undefined),
    insertInnerTickSnapshot: vi.fn().mockResolvedValue(undefined),
    countInnerTickSnapshots: vi.fn().mockResolvedValue(0),
  };
});

const mockedLifeDb = lifeDb as unknown as Record<string, ReturnType<typeof vi.fn>>;

// ── 通用工具 ──
function findHandler(taskId: string): () => Promise<unknown> {
  const task = (scheduler as any).tasks.find((t: any) => t.id === taskId);
  if (!task) throw new Error(`task ${taskId} 未注册`);
  return task.handler;
}

function setLastUserMessageAt(ms: number): void {
  (global as any).__lastUserMessageAt = ms;
}

function clearLastUserMessageAt(): void {
  delete (global as any).__lastUserMessageAt;
}

beforeAll(async () => {
  await initDatabase();
  // 注册全部调度任务（dummy LLM getters），随后立即停掉所有定时器 —— 测试只直呼 handler，
  // 避免 10s 级定时任务在测试期间触发写库/LLM 造成串扰
  registerScheduledTasks(
    () => null, () => null, () => null, () => null, () => null, () => null,
    () => null, () => null, () => null, () => null, () => null, () => null,
  );
  (scheduler as any).stop();
});

afterAll(() => {
  (scheduler as any).stop();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearLastUserMessageAt();
  resetRhythmState();
  resetRhythmDayState();
  resetTokenBudgetForTest();
  (scheduler as any)._lastRunWall = 0;
  // 恢复 PEPPA_* 环境变量（测试内设置的统统清掉）
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PEPPA_')) delete process.env[k];
  }
  Object.assign(process.env, SAVED_PEPPA_ENV);
});

describe('1. computeRhythmMode 边界', () => {
  const cfg = getRhythmConfig();

  it('idle=0 / 从未交互 → active', () => {
    expect(computeRhythmMode(0, cfg)).toBe('active');
    expect(computeRhythmMode(-1, cfg)).toBe('active');
    expect(computeRhythmMode(NaN, cfg)).toBe('active');
  });

  it('空闲 < 30min 与 30min–2h 区间均保持 active', () => {
    expect(computeRhythmMode(5 * 60 * 1000, cfg)).toBe('active');
    expect(computeRhythmMode(29 * 60 * 1000, cfg)).toBe('active');
    expect(computeRhythmMode(30 * 60 * 1000, cfg)).toBe('active'); // 30min-2h 不降频（规格）
    expect(computeRhythmMode(90 * 60 * 1000, cfg)).toBe('active');
    expect(computeRhythmMode(119 * 60 * 1000, cfg)).toBe('active');
  });

  it('空闲 2h–6h → half_sleep；≥6h → deep_sleep', () => {
    expect(computeRhythmMode(2 * 60 * 60 * 1000, cfg)).toBe('half_sleep');
    expect(computeRhythmMode(3 * 60 * 60 * 1000, cfg)).toBe('half_sleep');
    expect(computeRhythmMode(5.9 * 60 * 60 * 1000, cfg)).toBe('half_sleep');
    expect(computeRhythmMode(6 * 60 * 60 * 1000, cfg)).toBe('deep_sleep');
    expect(computeRhythmMode(8 * 60 * 60 * 1000, cfg)).toBe('deep_sleep');
    expect(computeRhythmMode(24 * 60 * 60 * 1000, cfg)).toBe('deep_sleep');
  });
});

describe('2. getInnerTickIntervalMs 间隔与 env 覆盖', () => {
  it('默认：active=10min / half=60min / deep=120min', () => {
    expect(getInnerTickIntervalMs('active')).toBe(10 * 60 * 1000);
    expect(getInnerTickIntervalMs('half_sleep')).toBe(60 * 60 * 1000);
    expect(getInnerTickIntervalMs('deep_sleep')).toBe(120 * 60 * 1000);
  });

  it('env 覆盖各模式间隔；deep 钳制在 120–180min', () => {
    process.env.PEPPA_RHYTHM_ACTIVE_TICK_MIN = '25';
    process.env.PEPPA_RHYTHM_HALF_TICK_MIN = '90';
    process.env.PEPPA_RHYTHM_DEEP_TICK_MIN = '180';
    expect(getInnerTickIntervalMs('active')).toBe(25 * 60 * 1000);
    expect(getInnerTickIntervalMs('half_sleep')).toBe(90 * 60 * 1000);
    expect(getInnerTickIntervalMs('deep_sleep')).toBe(180 * 60 * 1000);

    process.env.PEPPA_RHYTHM_DEEP_TICK_MIN = '999'; // 超上限 → 钳制 180
    expect(getInnerTickIntervalMs('deep_sleep')).toBe(180 * 60 * 1000);
    process.env.PEPPA_RHYTHM_DEEP_TICK_MIN = '50'; // 低于下限 → 钳制 120
    expect(getInnerTickIntervalMs('deep_sleep')).toBe(120 * 60 * 1000);
  });

  it('dry-run：恒返回活跃间隔（只观测不生效）', () => {
    process.env.PEPPA_RHYTHM_DRY_RUN = 'true';
    process.env.PEPPA_RHYTHM_DEEP_TICK_MIN = '180';
    expect(getInnerTickIntervalMs('deep_sleep')).toBe(10 * 60 * 1000);
  });
});

describe('3. 用户消息 → 立即切回 active', () => {
  it('半休眠中收到用户消息 → 模式立即 active 且输出切换日志', () => {
    setLastUserMessageAt(Date.now() - 3 * 60 * 60 * 1000); // 3h 前 → half_sleep
    expect(getRhythmMode()).toBe('half_sleep');

    const spy = vi.spyOn(logger, 'info');
    onUserActivity(); // 用户交互钩子：复位降频状态 + 模式切换日志
    touchUserActivity(); // chat 链路已接线的活动时间戳更新
    expect(getRhythmMode()).toBe('active');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('切回活跃模式'))).toBe(true);
  });

  it('active 状态下收到消息不产生多余切换日志（去重）', () => {
    setLastUserMessageAt(Date.now() - 60 * 1000);
    expect(getRhythmMode()).toBe('active');
    onUserActivity(); // 首次：记录 lastLoggedMode = active
    const spy = vi.spyOn(logger, 'info');
    onUserActivity(); // 模式未变化 → 不重复输出切换日志
    expect(spy.mock.calls.some((c) => String(c[0]).includes('切回活跃模式'))).toBe(false);
  });
});

describe('4. memory_tree prompt 硬上限（防 >1M token 炸弹）', () => {
  it('5000 条幽灵记忆 → 采样后 prompt 估算 ≤ 上限，无 context 超限', async () => {
    // 5000 条 orphan（每条 300 字符中文，value 有区分度）
    const db = readDB();
    db.memories = [];
    for (let i = 0; i < 5000; i++) {
      db.memories.push({
        id: `p2_orphan_${i}`,
        userId: 'default',
        nodeType: 'leaf',
        parentId: null,
        content: `测试记忆${i}_${'甲'.repeat(290)}`,
        importance: 0.3 + (i % 5) * 0.1,
        confidence: 0.5,
      });
    }
    writeDB(db);

    const spy = vi.spyOn(logger, 'info');
    // handler 内部 makeLLMCall 在无 provider 时抛错 → 只关心日志，吞掉异常
    await findHandler('memory_auto_organize')().catch(() => null);

    const line = spy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('memory_tree prompt_tokens='));
    expect(line, '应输出 memory_tree prompt 埋点').toBeDefined();

    const finalTokens = Number(line!.match(/prompt_tokens=(\d+)/)?.[1] ?? NaN);
    const beforeTokens = Number(line!.match(/截断前 (\d+)/)?.[1] ?? NaN);
    const orphanMatch = line!.match(/orphans (\d+)\/5000/);
    const maxTokens = 4000;

    expect(finalTokens).toBeLessThanOrEqual(maxTokens); // 硬上限
    expect(beforeTokens).toBeGreaterThan(maxTokens); // 确实超限触发截断
    expect(orphanMatch).not.toBeNull();
    expect(Number(orphanMatch![1])).toBeLessThanOrEqual(80); // 价值采样上限
  });
});

describe('5. reminder 防洪（重启/停机后批量补发防护）', () => {
  it('5 条过期 + 8 条近期 → 单轮最多触发 5 条，过期跳过不删除', async () => {
    const now = Date.now();
    const db = readDB();
    db.reminders = [];
    for (let i = 0; i < 5; i++) {
      db.reminders.push({
        id: `p2_stale_${i}`,
        content: `过期提醒 ${i}`,
        dueAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(), // 48h 前 → 超 24h 过期
        status: 'pending',
        createdAt: new Date(now - 49 * 60 * 60 * 1000).toISOString(),
        firedAt: null,
      });
    }
    for (let i = 0; i < 8; i++) {
      db.reminders.push({
        id: `p2_fresh_${i}`,
        content: `近期提醒 ${i}`,
        dueAt: new Date(now - 60 * 1000).toISOString(), // 1min 前到期
        status: 'pending',
        createdAt: new Date(now - 2 * 60 * 1000).toISOString(),
        firedAt: null,
      });
    }
    writeDB(db);

    const spy = vi.spyOn(logger, 'info');
    await findHandler('reminder_check')();

    const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('reminder_check 本轮触发'));
    expect(line).toBeDefined();
    expect(line!).toContain('触发 5 条');
    expect(line!).toContain('跳过过期 5 条');

    const after = readDB().reminders as Array<{ id: string; status: string; firedAt: string | null }>;
    const fired = after.filter((r) => r.status === 'fired');
    const pending = after.filter((r) => r.status === 'pending');
    expect(fired).toHaveLength(5); // 只触发 5 条（上限）
    expect(pending).toHaveLength(8); // 5 条过期未触发 + 3 条近期未触发（均保留，不删除）
    expect(pending.map((r) => r.id).includes('p2_stale_0')).toBe(true);
    expect(pending.map((r) => r.id).includes('p2_fresh_5')).toBe(true);
  });
});

describe('6. 时钟回跳防护', () => {
  it('墙钟回拨 1h → runTask 跳过本轮，handler 不被调用', async () => {
    const realNow = Date.now();
    const handler = vi.fn().mockResolvedValue('should-not-run');
    (scheduler as any)._lastRunWall = realNow;

    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 60 * 60 * 1000); // 回拨 1h
    const warnSpy = vi.spyOn(logger, 'warn');
    const result = await (scheduler as any).runTask({
      id: 'clock_test',
      cron: 'every_1m',
      lastRun: null,
      running: false,
      sleepMode: 'always',
      handler,
    });

    expect(result.ran).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('时钟回跳防护'))).toBe(true);
    spy.mockRestore();
  });
});

describe('7. token 预算熔断（用户对话不受影响）', () => {
  it('后台额度耗尽 → backgroundGate 延后；chat 场景不计入后台额度', async () => {
    process.env.PEPPA_DAILY_TOKEN_BUDGET = '1000';
    resetTokenBudgetForTest();

    expect(isUserScene('chat')).toBe(true);
    expect(isUserScene('memory_tree')).toBe(false);

    recordUsage('memory_tree', { promptTokens: 600, completionTokens: 500 }); // 1100 ≥ 1000
    expect(getBackgroundUsage()).toBe(1100);
    expect(isBackgroundBudgetExhausted()).toContain('token预算耗尽');

    // 后台任务（经门闸）→ 直接延后
    const gate = await backgroundGate.run('p2_budget_task', async () => 'x');
    expect(gate.ok).toBe(false);
    expect(gate.status).toBe('deferred');
    expect(gate.reason).toContain('token预算耗尽');

    // 用户场景即使 token 巨大也不计入后台额度（白名单短路）
    recordUsage('chat', { promptTokens: 9_000_000, completionTokens: 9_000_000 });
    expect(getBackgroundUsage()).toBe(1100);
  });
});

describe('8. 门闸并发限流', () => {
  it('maxConcurrent=1：第 2 个任务排队，队列满延后，运行中计数 ≤ 1', async () => {
    process.env.PEPPA_BG_MAX_CONCURRENT = '1';
    process.env.PEPPA_BG_QUEUE_MAX = '2';
    process.env.PEPPA_BG_WAIT_MAX_MS = '300000';
    process.env.PEPPA_DAILY_TOKEN_BUDGET = '0'; // 不限额度，专注并发路径

    let releaseA!: (value: string) => void;
    const taskA = backgroundGate.run('A', () => new Promise<string>((r) => (releaseA = r)));
    const taskB = backgroundGate.run('B', async () => 'B');
    const taskC = backgroundGate.run('C', async () => 'C');
    await Promise.resolve(); // 微任务冲刷，保证 A 已占槽

    expect(backgroundGate.getRunningCount()).toBe(1);
    expect(backgroundGate.getQueueLength()).toBe(2);

    const taskD = backgroundGate.run('D', async () => 'D'); // 队列满 → 延后
    const d = await taskD;
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('排队队列已满');

    releaseA('A');
    const [a, b, c] = await Promise.all([taskA, taskB, taskC]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(backgroundGate.getRunningCount()).toBe(0);
    expect(backgroundGate.getQueueLength()).toBe(0);
  });

  it('等待超时 → 延后本轮（不无限堆积）', async () => {
    process.env.PEPPA_BG_MAX_CONCURRENT = '1';
    process.env.PEPPA_BG_QUEUE_MAX = '8';
    process.env.PEPPA_BG_WAIT_MAX_MS = '200';
    process.env.PEPPA_DAILY_TOKEN_BUDGET = '0';

    let releaseE!: (value: string) => void;
    const taskE = backgroundGate.run('E', () => new Promise<string>((r) => (releaseE = r)));
    const taskF = backgroundGate.run('F', async () => 'F'); // 排队 → 200ms 超时

    const f = await taskF;
    expect(f.ok).toBe(false);
    expect(f.reason).toContain('排队超时');
    releaseE('E');
    const e = await taskE;
    expect(e.ok).toBe(true);
    expect(backgroundGate.getRunningCount()).toBe(0);
  });
});

describe('9. skills_extension 总闸联动停用', () => {
  it('PEPPA_PHASE3_SKILL_AUTO_ENABLE=false → p3_skill_gap_scan handler 短路', async () => {
    process.env.PEPPA_PHASE3_SKILL_AUTO_ENABLE = 'false';
    resetPhase3SwitchCache();
    resetPhase3ConfigCache();

    const spy = vi.spyOn(logger, 'info');
    const result = await findHandler('p3_skill_gap_scan')();
    expect(result).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('PEPPA_PHASE3_SKILL_AUTO_ENABLE=false'))).toBe(true);
  });
});

describe('10. 休眠门控（full 跳过 / critical 延后 / 半休眠降频）', () => {
  it('deep_sleep：full 任务跳过，critical(consolidate) 延后不删除', async () => {
    setLastUserMessageAt(Date.now() - 8 * 60 * 60 * 1000); // 8h → deep_sleep
    expect(getRhythmMode()).toBe('deep_sleep');

    const infoSpy = vi.spyOn(logger, 'info');
    const fullHandler = vi.fn().mockResolvedValue('dream-output');
    const full = await (scheduler as any).runTask({
      id: 'sleep_dream_cycle', cron: 'every_1h', lastRun: null, running: false, sleepMode: 'full', handler: fullHandler,
    });
    expect(full.ran).toBe(false);
    expect(fullHandler).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('跳过') && String(c[0]).includes('深度休眠'))).toBe(true);

    const criticalHandler = vi.fn().mockResolvedValue('consolidate-output');
    const critical = await (scheduler as any).runTask({
      id: 'memory_consolidation', cron: 'every_6h', lastRun: null, running: false, sleepMode: 'critical', handler: criticalHandler,
    });
    expect(critical.ran).toBe(false);
    expect(criticalHandler).not.toHaveBeenCalled();
    // 延后 ≠ 删除：任务仍注册在表（可被 enableTask / 后续 runTask 重新触发）
    expect((scheduler as any).tasks.some((t: any) => t.id === 'memory_consolidation')).toBe(true);
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('延后') && String(c[0]).includes('深度休眠'))).toBe(true);
  });

  it('half_sleep：full 任务按日奇偶降频（同日第二次触发跳过）', async () => {
    setLastUserMessageAt(Date.now() - 3 * 60 * 60 * 1000); // 3h → half_sleep
    expect(getRhythmMode()).toBe('half_sleep');
    resetRhythmDayState();

    const handler = vi.fn().mockResolvedValue('journal-output');
    const first = await (scheduler as any).runTask({
      id: 'growth_journal', cron: 'every_6h', lastRun: null, running: false, sleepMode: 'full', handler,
    });
    expect(first.ran).toBe(true); // 今日首跑正常执行
    expect(handler).toHaveBeenCalledTimes(1);

    const infoSpy = vi.spyOn(logger, 'info');
    const second = await (scheduler as any).runTask({
      id: 'growth_journal', cron: 'every_6h', lastRun: null, running: false, sleepMode: 'full', handler,
    });
    expect(second.ran).toBe(false); // 同日第二次 → 降频跳过
    expect(handler).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('半休眠降频'))).toBe(true);
  });
});

describe('11. 后台 LLM 失败不重试（防重试风暴）', () => {
  // makeLLMCallCore = 3 必选 + 12 可选 getter；fake deepseek client 占 getDeepSeek 位，其余 11 个 null
  const nullGetters = [
    () => null, () => null, () => null, () => null, () => null, () => null,
    () => null, () => null, () => null, () => null, () => null,
  ] as const;

  it('scene=memory_tree（后台）→ 1 次尝试（PEPPA_BG_LLM_RETRY=0）', async () => {
    process.env.PEPPA_BG_LLM_RETRY = '0';
    const create = vi.fn().mockRejectedValue(new Error('network error: 503 service unavailable'));
    const client = { chat: { completions: { create } } };

    await expect(
      makeLLMCall(
        [{ role: 'user', content: 'hi' }],
        [],
        { provider: 'deepseek', model: 'p2-retry-bg', scene: 'memory_tree' },
        () => client, ...nullGetters,
      ),
    ).rejects.toThrow('503');
    expect(create).toHaveBeenCalledTimes(1); // 失败即放弃，无重试循环
  }, 15000);

  it('scene=chat（用户）→ 3 次尝试（重试行为保持不变）', async () => {
    const create = vi.fn().mockRejectedValue(new Error('network error: 503 service unavailable'));
    const client = { chat: { completions: { create } } };

    await expect(
      makeLLMCall(
        [{ role: 'user', content: 'hi' }],
        [],
        { provider: 'deepseek', model: 'p2-retry-chat', scene: 'chat' },
        () => client, ...nullGetters,
      ),
    ).rejects.toThrow('503');
    expect(create).toHaveBeenCalledTimes(3); // 首试 + 2 次重试
  }, 30000);

  it('PEPPA_BG_LLM_RETRY=1 时后台场景最多 2 次尝试', async () => {
    process.env.PEPPA_BG_LLM_RETRY = '1';
    const create = vi.fn().mockRejectedValue(new Error('network error: 503 service unavailable'));
    const client = { chat: { completions: { create } } };

    await expect(
      makeLLMCall(
        [{ role: 'user', content: 'hi' }],
        [],
        { provider: 'deepseek', model: 'p2-retry-bg1', scene: 'memory_tree' },
        () => client, ...nullGetters,
      ),
    ).rejects.toThrow('503');
    expect(create).toHaveBeenCalledTimes(2);
  }, 15000);
});

describe('12. inner_tick 休眠模式 prompt 瘦身', () => {
  // 测试环境 .env 有真实 DEEPSEEK/ANTHROPIC key（vitest 默认加载），必须用 llmGetters
  // 注入「立即抛错」的 provider getter，杜绝真实 LLM 调用（测试内零网络、零写库）。
  const failLLMGetters: any = {};
  for (const name of ['getDeepSeek', 'getAnthropic', 'getOpenAI', 'getGemini', 'getQwen', 'getArk', 'getXiaomi', 'getKimi', 'getGlm', 'getRelay', 'getOllama', 'getLmStudio']) {
    failLLMGetters[name] = () => {
      throw new Error('test: LLM disabled');
    };
  }

  it('slim=true 减量召回；slim=false 保持完整召回', async () => {
    // 显式 slim 覆盖（不依赖节律模式判定），两个 userId 规避 3 分钟冷却硬锁
    await runInnerTick({ userId: 'p2-slim-user', slim: true, llmGetters: failLLMGetters }).catch(() => null);

    expect(mockedLifeDb.getRecentEmotions).toHaveBeenLastCalledWith(4);
    expect(mockedLifeDb.getRecentReflections).toHaveBeenLastCalledWith(2);
    expect(mockedLifeDb.getSignificantMemories).toHaveBeenLastCalledWith(0.6, 4);
    expect(mockedLifeDb.getRecentEvents).toHaveBeenLastCalledWith(15);
    expect(mockedLifeDb.getUnresolvedThoughts).toHaveBeenLastCalledWith(1);

    await runInnerTick({ userId: 'p2-full-user', slim: false, llmGetters: failLLMGetters }).catch(() => null);

    expect(mockedLifeDb.getRecentEmotions).toHaveBeenLastCalledWith(10);
    expect(mockedLifeDb.getRecentReflections).toHaveBeenLastCalledWith(5);
    expect(mockedLifeDb.getSignificantMemories).toHaveBeenLastCalledWith(0.6, 10);
    expect(mockedLifeDb.getRecentEvents).toHaveBeenLastCalledWith(50);
    expect(mockedLifeDb.getUnresolvedThoughts).toHaveBeenLastCalledWith(3);
  });

  it('非 active 节律（半休眠）自动启用瘦身', async () => {
    setLastUserMessageAt(Date.now() - 3 * 60 * 60 * 1000); // half_sleep
    expect(getRhythmMode()).toBe('half_sleep');
    await runInnerTick({ userId: 'p2-half-sleep-user', llmGetters: failLLMGetters }).catch(() => null);
    expect(mockedLifeDb.getRecentEmotions).toHaveBeenLastCalledWith(4); // 自动 slim
  });
});
