// 阶段三·P1阻断项修复【方案A：进程级沙箱隔离】— 隔离沙箱子进程入口（1-1）
//
// 职责：只负责加载编译后的自研 MCP 代码（sandbox_auto_mcp/<项目>/dist/index.mjs）、
//       接收宿主 IPC 消息（invoke / describe / ssrf-probe / ping / destroy）、
//       执行 handler、返回结果。主进程永不加载生成代码，加载只发生在本进程内。
//
// 资源限制（本进程内）：
//   1) 每次调用看门狗超时（INVOKE_WATCHDOG_MS）：异步挂起 → 上报宿主后自毁退出；
//   2) V8 堆内存上限：宿主 spawn 时注入 --max-old-space-size（CHILD_MEMORY_MB）；
//   3) 模块缓存上限：同一项目按 (项目路径, 源码哈希) 缓存，总量超限淘汰最旧，防内存无限增长。
//
// 安全边界（纵深防御）：
//   1) 进程级 SSRF 守卫：patch 本进程 globalThis.fetch，内网/本地/非 HTTPS 地址一律先拦截
//      ——即使 AI 生成的代码被改写绕过模板防护，进程边界仍拒绝出站到内网；
//   2) 崩溃即退出：未捕获异常 → 上报宿主 → process.exit(1)，绝不影响父主进程；
//   3) 宿主断开（主服务退出/被回收）→ 自动 exit，不留孤儿进程。
//
// 本文件仅 node 内置模块 + 类型导入 + 一个共享风险函数导入（risk_policy.classifyBuiltinToolRisk，
// 纯函数、无 DB/服务副作用），可被 esbuild 独立打包为
// dist-server/sandbox_child.mjs（生产），或由 tsx 直接加载（开发）。

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type {
  ChildToHostMessage,
  HostToChildMessage,
  SandboxMockEndpoint,
  SandboxProbeResult,
} from './sandbox_ipc_types';
// 兜底风险等级统一复用共享风险函数（仅纯函数，无 DB/服务副作用），
// 避免在子进程内手写硬编码风险判断。
import { classifyBuiltinToolRisk } from '../../skills_extension/risk_policy';

/** 单次调用看门狗（宿主侧 INVOKE_TIMEOUT_MS 略大于此值，子进程自毁优先触发） */
const INVOKE_WATCHDOG_MS = 45_000;
/** 模块缓存条目上限（修复迭代会产生新哈希版本） */
const MODULE_CACHE_MAX = 64;

// ── IPC 发送（仅 fork 通道存在时有效；父进程死亡后 process.send 抛错 → 静默） ──

function send(msg: ChildToHostMessage): void {
  try {
    if (process.send) process.send(msg);
  } catch {
    /* 通道已关闭（父进程退出）→ 忽略 */
  }
}

// ── 进程级 SSRF 守卫（纵深防御；镜像模板防护并加强：云元数据段 169.254 等） ──

function assertPublicHttpsUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`仅允许 HTTPS 出站（收到 ${u.protocol}）`);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') ||
      host.endsWith('.localhost') || host.endsWith('.localdomain')) {
    throw new Error(`禁止访问本地/内网主机 ${host}（沙箱隔离）`);
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 169 && parts[1] === 254)) {
      throw new Error(`禁止访问内网地址 ${host}（沙箱隔离）`);
    }
  }
  return u;
}

// ── 测试期 mock（宿主随 invoke 消息全量下发；镜像 test_pipeline 的进程内 mock 语义） ──

let mocks: SandboxMockEndpoint[] = [];

function applyMocks(next: SandboxMockEndpoint[]): void {
  mocks = Array.isArray(next) ? next : [];
}

/** 端点模板 {param} 占位符 → 通配（与 test_pipeline 逻辑一致） */
function matchMock(raw: string): SandboxMockEndpoint | undefined {
  return [...mocks].reverse().find(e => {
    const pattern = '^' + e.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+\\\}/g, '[^#?]*') + '.*';
    return new RegExp(pattern).test(raw);
  });
}

async function respondMock(hit: SandboxMockEndpoint): Promise<Response> {
  if (hit.delayMs) await new Promise(r => setTimeout(r, hit.delayMs));
  if (hit.abort) {
    throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  }
  if (hit.status && hit.status >= 500) {
    return new Response('upstream error', { status: hit.status, headers: { 'Content-Type': 'text/plain' } });
  }
  const body = hit.body !== undefined ? JSON.stringify(hit.body) : JSON.stringify({ ok: true });
  return new Response(body, { status: hit.status || 200, headers: { 'Content-Type': 'application/json' } });
}

const realFetch = globalThis.fetch;

/** 进程级出站闸口：测试期 mock 优先（不触网）→ SSRF 守卫 → 真实 fetch */
(globalThis as { fetch: typeof fetch }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const hit = matchMock(raw);
  if (hit) return respondMock(hit);
  assertPublicHttpsUrl(raw); // 内网/本地/非 HTTPS 一律先拦截（即使生成代码被改写）
  return realFetch(input, init);
};

// ── 编译产物加载（file:// import 仅发生在子进程内；按源码哈希缓存，哈希变则重载） ──

interface LoadedModule {
  mod: any;
}
const moduleCache = new Map<string, LoadedModule>(); // key: `${projectDir}::${sourceHash}`

async function loadModule(projectDir: string, sourceHash: string): Promise<any> {
  const key = `${projectDir}::${sourceHash}`;
  const cached = moduleCache.get(key);
  if (cached) return cached.mod;
  const entry = path.join(projectDir, 'dist', 'index.mjs');
  if (!fs.existsSync(entry)) throw new Error('沙箱编译产物缺失（dist/index.mjs）');
  const url = pathToFileURL(entry).href + '?t=' + sourceHash; // hash 变化 → 强制重新求值
  const mod = await import(url);
  moduleCache.set(key, { mod });
  if (moduleCache.size > MODULE_CACHE_MAX) {
    const oldest = moduleCache.keys().next().value;
    if (oldest !== undefined) moduleCache.delete(oldest);
  }
  return mod;
}

// ── 消息处理 ──

async function handleInvoke(msg: Extract<HostToChildMessage, { type: 'invoke' }>): Promise<void> {
  applyMocks(msg.mocks);
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  try {
    // 看门狗：handler 异步挂起 → 上报后自毁（同步死循环只能由宿主 kill 兜底）
    watchdog = setTimeout(() => {
      send({ type: 'child-error', requestId: msg.requestId, message: '子进程调用看门狗超时，自毁回收' });
      process.exit(1);
    }, INVOKE_WATCHDOG_MS);
    watchdog.unref?.();

    const mod = await loadModule(msg.projectDir, msg.sourceHash);
    const handler = mod?.toolDefinition?.handler;
    if (typeof handler !== 'function') {
      send({ type: 'invoke-result', requestId: msg.requestId, ok: false, result: '', error: '生成代码未导出可执行的 toolDefinition.handler' });
      return;
    }
    // P2-4：接通模板 setReportHook → 工具内部自评状态（ok/error/timeout）经 IPC 上报宿主落地 tool_monitoring。
    // 上报先于 invoke-result 到达（同通道 FIFO），宿主据此判定该次调用已具工具级指标。
    const hook = mod?.setReportHook;
    if (typeof hook === 'function') {
      try {
        const toolName = String(mod?.toolDefinition?.name || '');
        hook((status: string, latencyMs: number) => {
          if (status !== 'ok' && status !== 'error' && status !== 'timeout') return;
          send({
            type: 'metric-report',
            requestId: msg.requestId,
            toolName,
            status,
            latencyMs: Math.max(0, Math.round(Number(latencyMs) || 0)),
          });
        });
      } catch (e: any) {
        send({ type: 'child-error', requestId: msg.requestId, message: `setReportHook 接线失败: ${e?.message || e}` });
      }
    }
    const result = await handler(msg.args);
    send({
      type: 'invoke-result',
      requestId: msg.requestId,
      ok: true,
      result: typeof result === 'string' ? result : String(result),
    });
  } catch (e: any) {
    send({
      type: 'invoke-result',
      requestId: msg.requestId,
      ok: false,
      result: '',
      error: e?.message || String(e),
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

async function handleDescribe(msg: Extract<HostToChildMessage, { type: 'describe' }>): Promise<void> {
  try {
    const mod = await loadModule(msg.projectDir, msg.sourceHash);
    const def = mod?.toolDefinition;
    const meta = mod?.__META;
    if (!def?.name) {
      send({ type: 'describe-result', requestId: msg.requestId, ok: false, error: '生成代码未导出 toolDefinition（name 缺失）' });
      return;
    }
    send({
      type: 'describe-result',
      requestId: msg.requestId,
      ok: true,
      meta: {
        name: String(def.name),
        complianceDomain: (meta?.complianceDomain as any) || 'none',
        endpointTemplate: String(meta?.endpointTemplate || ''),
        securityLevel: String(def.securityLevel || classifyBuiltinToolRisk('fallback-unknown-tool')),
      },
    });
  } catch (e: any) {
    send({ type: 'describe-result', requestId: msg.requestId, ok: false, error: e?.message || String(e) });
  }
}

/** SSRF 真实拦截探测：对每个地址经同一出站闸口发起（守卫拦截 → 不触网；守卫缺失 → 真实尝试并上报泄露） */
async function handleProbe(msg: Extract<HostToChildMessage, { type: 'ssrf-probe' }>): Promise<void> {
  const results: SandboxProbeResult[] = [];
  for (const url of msg.urls) {
    try {
      await (globalThis as { fetch: typeof fetch }).fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000) });
      results.push({ url, blocked: false, detail: '守卫未拦截（内网泄露风险）' });
    } catch (e: any) {
      results.push({ url, blocked: true, detail: e?.message || String(e) });
    }
  }
  send({ type: 'probe-result', requestId: msg.requestId, ok: true, results });
}

function handleMessage(msg: HostToChildMessage): void {
  switch (msg.type) {
    case 'invoke': void handleInvoke(msg); break;
    case 'describe': void handleDescribe(msg); break;
    case 'ssrf-probe': void handleProbe(msg); break;
    case 'ping': send({ type: 'pong' }); break;
    case 'destroy': process.exit(0); break;
  }
}

// ── 生命周期：崩溃即退出 / 宿主断开即退出 ──

process.on('message', handleMessage);
process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (e: Error) => {
  send({ type: 'child-error', message: `子进程崩溃: ${e?.message || e}` });
  process.exit(1);
});
// 未处理 rejection 不上报退出（保持池内共享进程存活；异常会体现在对应调用结果中）
process.on('unhandledRejection', (reason: unknown) => {
  send({ type: 'child-error', message: `子进程未处理 rejection: ${String(reason)}` });
});

send({ type: 'ready', pid: process.pid });
