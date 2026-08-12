// 阶段三·P1阻断项修复【方案A：进程级沙箱隔离】— 主进程侧沙箱管理器（1-2）
//
// 职责：
//   1) 编译自研 MCP 源码 → sandbox_auto_mcp/<项目>/dist/index.mjs（tsc 产物落盘沙箱目录）；
//   2) 子进程生命周期：spawn（fork，开发期继承 tsx 加载器）/ 销毁 / 超时杀死卡死子进程 / 崩溃回收；
//   3) IPC 转发：invoke（随消息携带测试期 mock 快照，子进程内生效）/ describe / ssrf-probe / ping；
//   4) 受控进程池：上限 ISOLATION_POOL_MAX，busy 互斥 + 等待队列，防疯狂创建进程耗尽 NAS 资源；
//   5) 上线注册：为自研工具生成「代理 handler」——主进程只发 IPC 拿结果，绝不执行生成代码。
//
// 硬边界（本模块红线）：不存在任何 `await import(file://...)` 加载生成代码的路径；
// 生成代码的加载与执行只发生在 sandbox_child 隔离子进程内，主进程仅持有代理 handler。
//
// 原有链路叠加（不改变）：模板校验（生成前）→ tsc 编译校验（iterateTsc）→ 风险分级（risk_policy）
// → 人工审批（approval）→ 熔断限额（breakers）全部保留，本模块只替换「加载与执行」一段。

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import { logger } from '../../lib/logger';
import { readProjectSource } from '../sandbox';
// P2-4：自研隔离工具运行指标闭环 —— 宿主侧写入 tool_monitoring（来源 self_build）
import { insertMetric } from '../database';
import { logCallOkEvent } from '../lifecycle';
import type { ChildToHostMessage, HostToChildMessage, SandboxMockEndpoint, SandboxProbeResult } from './sandbox_ipc_types';

const execAsync = promisify(exec);

// ── 资源上限（受控进程池） ──

export const ISOLATION_POOL_MAX = 3;         // 最大并发子进程数（防疯狂创建耗尽 NAS 资源）
export const INVOKE_TIMEOUT_MS = 50_000;     // 宿主侧调用超时（> 模板最坏 3×8s 重试链）
export const CHILD_WATCHDOG_MS = 45_000;     // 子进程侧看门狗（子进程自毁优先触发，宿主 kill 兜底）
export const CHILD_MEMORY_MB = 256;          // 子进程 V8 堆上限（--max-old-space-size）
export const CHILD_SPAWN_TIMEOUT_MS = 10_000; // 子进程启动握手超时
export const PROBE_TIMEOUT_MS = 15_000;      // SSRF 探测超时
export const IDLE_TTL_MS = 30 * 60 * 1000;   // 空闲超时回收（资源卫生）

// ── 编译（tsc 产物落盘沙箱目录；主进程只读产物文件，不 import） ──

const BUILD_TSCONFIG_JSON = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    outDir: 'dist',
    types: [],
    lib: ['ES2022', 'DOM'],
  },
  include: ['src/**/*.ts'],
}, null, 2);

function resolveTscBin(): string {
  const local = path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (fs.existsSync(local)) return local;
  return process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
}

async function compileProject(dir: string): Promise<{ ok: boolean; message: string }> {
  try {
    const tscCfg = path.join(dir, 'tsconfig.build.json');
    fs.writeFileSync(tscCfg, BUILD_TSCONFIG_JSON, 'utf-8');
    await execAsync(`"${resolveTscBin()}" -p "${tscCfg}"`, {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const emitted = path.join(dir, 'dist', 'index.js');
    const out = path.join(dir, 'dist', 'index.mjs');
    if (!fs.existsSync(emitted)) return { ok: false, message: 'tsc 通过但未产出 dist/index.js' };
    fs.renameSync(emitted, out); // 沙箱目录无 package.json → .mjs 强制 ESM 语义
    return { ok: true, message: '' };
  } catch (e: any) {
    const out = (e?.stdout || '') + (e?.stderr || '');
    const errs = out.split('\n').filter(l => /error TS\d+/.test(l)).map(l => l.trim()).slice(0, 10);
    return { ok: false, message: `沙箱编译失败：${errs[0] || e?.message || '未知错误'}` };
  }
}

export interface SandboxBuildResult {
  ok: boolean;
  projectDir?: string;
  sourceHash?: string;
  message?: string;
}

/** 确保沙箱项目已编译（源码比产物新 → 重新编译）；返回产物路径与内容哈希 */
export async function ensureSandboxBuilt(projectId: number): Promise<SandboxBuildResult> {
  const loaded = await readProjectSource(projectId);
  if (!loaded) return { ok: false, message: `沙箱项目 ${projectId} 不存在` };
  const srcPath = path.join(loaded.project.dir, 'src', 'index.ts');
  const outPath = path.join(loaded.project.dir, 'dist', 'index.mjs');
  if (!fs.existsSync(srcPath)) return { ok: false, message: '沙箱源码缺失（src/index.ts）' };
  if (!fs.existsSync(outPath) || fs.statSync(srcPath).mtimeMs > fs.statSync(outPath).mtimeMs) {
    const r = await compileProject(loaded.project.dir);
    if (!r.ok) return { ok: false, message: r.message };
  }
  const sourceHash = crypto.createHash('md5').update(fs.readFileSync(outPath)).digest('hex').slice(0, 16);
  return { ok: true, projectDir: loaded.project.dir, sourceHash };
}

// ── 子进程池 ──

interface ChildSlot {
  id: number;
  proc: ChildProcess | null;
  alive: boolean;
  spawning: boolean;
  busy: boolean;
  spawnedAt: number;
  lastMsgAt: number;
}

interface PendingInvoke {
  slot: ChildSlot;
  timer: ReturnType<typeof setTimeout>;
  resolve: (msg: ChildToHostMessage) => void;
  reject: (e: Error) => void;
}

interface Waiter {
  resolve: (s: ChildSlot) => void;
  reject: (e: Error) => void;
}

const slots: ChildSlot[] = [];
const waiters: Waiter[] = [];
const pending = new Map<string, PendingInvoke>();
const testMockState: SandboxMockEndpoint[] = [];
// P2-4：已收到工具级指标（metric-report）的 requestId 集合。
// 子进程 metric-report 先于 invoke-result 到达（同通道 FIFO），宿主据此避免与传输层指标重复计数，
// 保证与社区 MCP「一次调用一行指标」的行为对齐。
const metricReportedRequestIds = new Set<string>();
let nextChildId = 1;

/** 自研工具运行指标写入（来源 self_build；测试期不写入，避免开发期数据污染健康判定，与适配器行为一致） */
function recordIsolatedMetric(toolName: string, status: 'ok' | 'error' | 'timeout', latencyMs: number): void {
  if (!toolName) return;
  if (process.env.SKILLS_TEST_METRICS === '1') return;
  void insertMetric({ toolName, status, latencyMs, userNegative: -1, source: 'self_build' })
    .catch((e: any) => logger.warn(`[SandboxHost] 自研工具指标写入失败: ${e?.message || e}`));
}

/** 子进程入口解析：生产取独立打包产物；开发（tsx）直接 fork TS 入口并继承加载器 */
function resolveChildEntry(): string {
  const prod = path.resolve(process.cwd(), 'dist-server', 'sandbox_child.mjs');
  if (fs.existsSync(prod)) return prod;
  return path.resolve(process.cwd(), 'server', 'skills_extension', 'sandbox_isolate', 'sandbox_child.ts');
}

function aliveCount(): number {
  return slots.filter(s => s.alive || s.spawning).length;
}

function spawnSlot(): Promise<ChildSlot> {
  const slot: ChildSlot = {
    id: nextChildId++,
    proc: null,
    alive: false,
    spawning: true,
    busy: true,
    spawnedAt: Date.now(),
    lastMsgAt: Date.now(),
  };
  slots.push(slot);

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(resolveChildEntry(), [], {
        // 开发期：process.execArgv 含 tsx 加载器标志（--require preflight / --import loader），子进程可加载 TS；
        // 生产：产物为 .mjs，无需加载器。
        // 注：Windows 隐藏控制台由 entry.cjs 的 cp.fork monkey-patch 兜底，此处不重复设置。
        execArgv: [...process.execArgv, `--max-old-space-size=${CHILD_MEMORY_MB}`],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, PEPPA_SANDBOX_CHILD: '1', PEPPA_SANDBOX_SLOT: String(slot.id) },
      });
    } catch (e: any) {
      slot.spawning = false;
      logger.error(`[SandboxHost] 子进程 #${slot.id} fork 失败：${e?.message || e}`);
      reject(new Error(`隔离子进程启动失败：${e?.message || e}`));
      return;
    }
    slot.proc = child;

    const spawnTimer = setTimeout(() => {
      if (!slot.alive) {
        slot.spawning = false;
        try { child.kill(); } catch { /* 已退出 */ }
        logger.error(`[SandboxHost] 子进程 #${slot.id} 启动握手超时`);
        reject(new Error(`隔离子进程启动超时（${CHILD_SPAWN_TIMEOUT_MS / 1000}s）`));
      }
    }, CHILD_SPAWN_TIMEOUT_MS);

    child.on('message', (msg: ChildToHostMessage) => {
      slot.lastMsgAt = Date.now();
      if (msg.type === 'ready') {
        clearTimeout(spawnTimer);
        slot.spawning = false;
        slot.alive = true;
        logger.info(`[SandboxHost] 子进程 #${slot.id} 就绪（pid=${msg.pid}，池 ${aliveCount()}/${ISOLATION_POOL_MAX}）`);
        resolve(slot);
      } else {
        handleChildMessage(slot, msg);
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(spawnTimer);
      slot.spawning = false;
      slot.alive = false;
      slot.proc = null;
      handleChildExit(slot, `隔离子进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
    });
    child.on('error', (e: Error) => {
      slot.spawning = false;
      slot.alive = false;
      slot.proc = null;
      handleChildExit(slot, `隔离子进程错误：${e.message}`);
    });
  });
}

function handleChildMessage(slot: ChildSlot, msg: ChildToHostMessage): void {
  switch (msg.type) {
    case 'invoke-result':
    case 'describe-result':
    case 'probe-result': {
      const p = pending.get(msg.requestId);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.requestId);
        p.resolve(msg);
      }
      break;
    }
    case 'child-error': {
      if (msg.requestId) {
        const p = pending.get(msg.requestId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.requestId);
          p.reject(new Error(msg.message));
        }
      }
      logger.warn(`[SandboxHost] 子进程 #${slot.id} 上报：${msg.message}`);
      break;
    }
    case 'metric-report': {
      // P2-4：子进程工具级指标（模板 setReportHook 接线）→ 落地 tool_monitoring（来源 self_build）
      if (msg.toolName && msg.requestId) metricReportedRequestIds.add(msg.requestId);
      recordIsolatedMetric(msg.toolName, msg.status, msg.latencyMs);
      break;
    }
    case 'ready':
    case 'pong':
      break;
  }
}

/** 子进程退出/崩溃 → 回收：拒绝其挂起调用，有等待者则补 spawn（池上限内） */
function handleChildExit(slot: ChildSlot, reason: string): void {
  for (const [rid, p] of pending) {
    if (p.slot === slot) {
      clearTimeout(p.timer);
      pending.delete(rid);
      p.reject(new Error(reason));
    }
  }
  logger.warn(`[SandboxHost] 子进程 #${slot.id} 已回收：${reason}`);
  // 清理死槽（防数组无限膨胀；保留最近存活记录）
  if (slots.filter(s => s.alive || s.spawning).length === 0 && slots.length > ISOLATION_POOL_MAX) {
    slots.length = 0;
  }
  while (waiters.length > 0 && aliveCount() < ISOLATION_POOL_MAX) {
    const w = waiters.shift()!;
    void spawnSlot().then(w.resolve, (e: Error) => w.reject(e));
  }
}

/** 销毁指定子进程（超时杀死卡死子进程；宿主不等待其自然退出） */
function destroySlot(slot: ChildSlot, reason: string): void {
  slot.alive = false;
  slot.spawning = false;
  const proc = slot.proc;
  if (proc) {
    try { proc.send({ type: 'destroy' } satisfies HostToChildMessage); } catch { /* 通道已断 */ }
    setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } }, 500);
  }
  logger.warn(`[SandboxHost] 销毁子进程 #${slot.id}：${reason}`);
}

/** 进程池获取：空闲复用 → 未满 spawn → 排队等待（调用侧 busy 互斥，绝不超限并发） */
function acquire(): Promise<ChildSlot> {
  const idle = slots.find(s => s.alive && !s.busy);
  if (idle) return Promise.resolve(idle);
  if (aliveCount() < ISOLATION_POOL_MAX) return spawnSlot();
  return new Promise<ChildSlot>((resolve, reject) => { waiters.push({ resolve, reject }); });
}

function release(slot: ChildSlot): void {
  slot.busy = false;
  if (!slot.alive) {
    // 槽已被销毁/崩溃回收 → 不能交给等待者，改为补 spawn 新进程
    if (waiters.length > 0 && aliveCount() < ISOLATION_POOL_MAX) {
      const w = waiters.shift()!;
      void spawnSlot().then(w.resolve, (e: Error) => w.reject(e));
    }
    return;
  }
  const w = waiters.shift();
  if (w) {
    slot.busy = true;
    w.resolve(slot);
    return;
  }
  // 空闲超时回收：闲置过久且池内还有其余存活 → 销毁（资源卫生）
  if (Date.now() - slot.lastMsgAt > IDLE_TTL_MS && slots.filter(s => s.alive && s !== slot).length > 0) {
    destroySlot(slot, `空闲超时（${IDLE_TTL_MS / 60000}min）回收`);
  }
}

/** 宿主超时错误标记（P2-4：隔离 handler 据此区分超时/报错指标状态） */
export const INVOKE_TIMEOUT_CODE = 'INVOKE_TIMEOUT';

/** 统一 IPC 调用：发消息 → 等对应应答（超时即杀子进程回收并拒绝） */
function invokeChild(slot: ChildSlot, msg: HostToChildMessage, timeoutMs: number): Promise<ChildToHostMessage> {
  return new Promise((resolve, reject) => {
    const requestId = 'requestId' in msg ? msg.requestId : '';
    const timer = setTimeout(() => {
      pending.delete(requestId);
      destroySlot(slot, `宿主超时（${Math.round(timeoutMs / 1000)}s）无响应，杀死卡死子进程`);
      const err: any = new Error(`隔离调用超时（${Math.round(timeoutMs / 1000)}s），子进程已回收`);
      err.code = INVOKE_TIMEOUT_CODE;
      reject(err);
    }, timeoutMs);
    pending.set(requestId, { slot, timer, resolve, reject });
    try {
      if (!slot.proc) throw new Error('隔离子进程已退出');
      slot.proc.send(msg);
    } catch (e: any) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error(`隔离调用发送失败：${e?.message || e}`));
    }
  });
}

// ── 对外 API ──

/** 测试期 mock 转发：随下一次 invoke 消息快照进入子进程（子进程内生效，不改生成代码） */
export function forwardMockRegister(e: SandboxMockEndpoint): void {
  testMockState.push(e);
}

export function forwardMockReset(): void {
  testMockState.length = 0;
}

/**
 * 自研工具代理 handler 工厂（2-3）：注册进 ToolRegistry 的只是代理——
 * 只发 IPC 消息给隔离子进程拿结果，主进程不执行业务代码。
 */
export function createIsolatedHandler(projectId: number, toolName: string): (args: Record<string, any>) => Promise<string> {
  return async (args: Record<string, any>): Promise<string> => {
    const built = await ensureSandboxBuilt(projectId);
    if (!built.ok || !built.projectDir || !built.sourceHash) {
      throw new Error(`工具 ${toolName} 沙箱编译失败：${built.message || '未知错误'}`);
    }
    const slot = await acquire();
    slot.busy = true;
    const started = Date.now();
    const requestId = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let metricRecorded = false;
    // P2-4：每次调用落地一行运行指标（与社区 MCP 对齐，一次调用一行，不重复计数）。
    // 状态优先级：子进程工具自评（metric-report 先于 invoke-result 到达）> 宿主传输结果（超时/崩溃/无钩子）。
    const recordCallMetric = (status: 'ok' | 'error' | 'timeout') => {
      if (metricRecorded) return;
      metricRecorded = true;
      if (!metricReportedRequestIds.has(requestId)) {
        recordIsolatedMetric(toolName, status, Date.now() - started);
      }
    };
    try {
      const resp = await invokeChild(slot, {
        type: 'invoke',
        requestId,
        projectId,
        projectDir: built.projectDir,
        sourceHash: built.sourceHash,
        args,
        mocks: [...testMockState],
      }, INVOKE_TIMEOUT_MS);
      if (resp.type === 'invoke-result') {
        if (resp.ok) {
          recordCallMetric('ok');
          // P2-5：调用成功结构化事件（来源/风险取自技能库）
          void logCallOkEvent(toolName).catch(() => {});
          return resp.result;
        }
        recordCallMetric('error');
        throw new Error(`工具 ${toolName} 执行异常：${resp.error || '未知错误'}`);
      }
      recordCallMetric('error');
      throw new Error(`工具 ${toolName} 隔离调用响应异常：${(resp as any)?.error || '未知响应类型'}`);
    } catch (e: any) {
      // 宿主侧超时（子进程已被回收）→ timeout；其余（崩溃/发送失败等）→ error
      recordCallMetric(e?.code === INVOKE_TIMEOUT_CODE ? 'timeout' : 'error');
      throw e;
    } finally {
      metricReportedRequestIds.delete(requestId);
      release(slot);
    }
  };
}

/** 自研工具的测试对象（供测试流水线执行；元信息由子进程加载产物后描述，主进程不读源码） */
export interface IsolatedTestableTool {
  name: string;
  handler: (args: Record<string, any>) => Promise<string>;
  complianceDomain: 'finance' | 'medical' | 'none';
  endpointTemplate: string;
  isolated: true;
  projectId: number;
}

export async function getIsolatedTestableTool(projectId: number): Promise<IsolatedTestableTool | null> {
  const built = await ensureSandboxBuilt(projectId);
  if (!built.ok || !built.projectDir || !built.sourceHash) {
    logger.warn(`[SandboxHost] 测试对象不可用（项目 #${projectId}）：${built.message || '编译失败'}`);
    return null;
  }
  const slot = await acquire();
  slot.busy = true;
  try {
    const resp = await invokeChild(slot, {
      type: 'describe',
      requestId: `desc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      projectDir: built.projectDir,
      sourceHash: built.sourceHash,
    }, CHILD_SPAWN_TIMEOUT_MS * 5);
    if (resp.type !== 'describe-result' || !resp.ok || !resp.meta) {
      logger.warn(`[SandboxHost] 工具描述失败（项目 #${projectId}）：${(resp as any)?.error || '未知'}`);
      return null;
    }
    const { name, complianceDomain, endpointTemplate } = resp.meta;
    return {
      name,
      handler: createIsolatedHandler(projectId, name),
      complianceDomain,
      endpointTemplate,
      isolated: true,
      projectId,
    };
  } finally {
    release(slot);
  }
}

/** SSRF 真实拦截探测：子进程内逐个地址尝试访问，返回每个地址的守卫拦截结果（P2-5 用例支撑） */
export async function probeInternal(projectId: number, urls: string[]): Promise<{ ok: boolean; results?: SandboxProbeResult[]; message?: string }> {
  const built = await ensureSandboxBuilt(projectId);
  if (!built.ok || !built.projectDir || !built.sourceHash) {
    return { ok: false, message: built.message || '沙箱项目不可用' };
  }
  const slot = await acquire();
  slot.busy = true;
  try {
    const resp = await invokeChild(slot, {
      type: 'ssrf-probe',
      requestId: `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      urls,
    }, PROBE_TIMEOUT_MS);
    if (resp.type === 'probe-result' && resp.ok) {
      return { ok: true, results: resp.results };
    }
    return { ok: false, message: (resp as any)?.error || '探测失败' };
  } finally {
    release(slot);
  }
}

/** 优雅关闭全部隔离子进程（供测试/停机使用；父进程退出时子进程经 disconnect 自动退出） */
export async function shutdownIsolation(): Promise<void> {
  for (const s of slots) {
    if (s.alive && s.proc) {
      try { s.proc.send({ type: 'destroy' } satisfies HostToChildMessage); } catch { /* 通道已断 */ }
    }
  }
  await new Promise(r => setTimeout(r, 300));
  for (const s of slots) {
    if (s.alive && s.proc) {
      try { s.proc.kill(); } catch { /* 已退出 */ }
    }
  }
  for (const w of waiters) w.reject(new Error('沙箱隔离已关闭'));
  waiters.length = 0;
  slots.length = 0;
  testMockState.length = 0;
  metricReportedRequestIds.clear();
  logger.info('[SandboxHost] 沙箱隔离子进程已全部关闭');
}

/** 池状态（可观测/审计） */
export function sandboxHostStatus(): {
  poolMax: number;
  slots: Array<{ id: number; alive: boolean; busy: boolean; spawnedAt: number; lastMsgAt: number }>;
  pendingCount: number;
  testMockCount: number;
} {
  return {
    poolMax: ISOLATION_POOL_MAX,
    slots: slots.map(s => ({ id: s.id, alive: s.alive, busy: s.busy, spawnedAt: s.spawnedAt, lastMsgAt: s.lastMsgAt })),
    pendingCount: pending.size,
    testMockCount: testMockState.length,
  };
}
