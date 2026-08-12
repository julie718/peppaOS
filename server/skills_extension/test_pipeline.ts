// 阶段三·模块5a — 全自动测试流水线（6 类用例）
//
// 用例类别（对生成/适配工具的统一测试矩阵，测试期 mock 模拟外部端点，不改生成代码）：
//   1. 功能正确性 — 正常入参 → 返回预期结构
//   2. 边界与异常 — 缺参/空参/超长入参 → 不崩溃、友好文案
//   3. 网络故障降级 — 5xx / 超时 → 重试后降级文案（不抛未捕获错误）
//   4. 沙箱隔离(SSRF) — localhost/内网/非 HTTPS 地址 → 真实拦截探测（P2-5：原无条件 ok 空用例已删除）
//   5. 强制合规免责 — finance/medical 域输出必须含免责文案（缺失=失败）
//   6. 性能与稳定性 — 响应耗时上限、连续调用无泄漏
//
// 方案A 隔离执行（P1阻断项修复）：AI 自研工具（self_build）的 handler 为 IPC 代理，
// 真实执行发生在隔离子进程（sandbox_isolate/sandbox_child）；mock 端点随 invoke 消息快照
// 同步进子进程，子进程内 patch fetch 生效，语义与主进程内 mock 完全一致；
// 社区下载/适配器工具（reuse 路径）维持主进程内执行与 mock，链路不变。
//
// 迭代策略：失败 → 触发修复（沙箱项目重新 iterateTsc 修复源码）→ 重测，上限 5 轮；
// 5 轮仍失败 → needsHumanOptimization 标记（人工优化）。

import { logger } from '../lib/logger';
import { appendAudit } from './database';
import { iterateTsc } from './sandbox';
import { forwardMockRegister, forwardMockReset, probeInternal } from './sandbox_isolate/sandbox_host';
import { ssrfProbeInProcess } from './adapter';
import type { SandboxMockEndpoint as MockEndpoint } from './sandbox_isolate/sandbox_ipc_types';
import type { ToolTestReport } from './types';

export interface TestableTool {
  name: string;
  handler: (args: Record<string, any>) => Promise<string>;
  complianceDomain?: 'finance' | 'medical' | 'none';
  /** 端点模板（识别 SSRF 用例的期望地址） */
  endpointTemplate?: string;
  /** 方案A 隔离标记：true = handler 为 IPC 代理，真实执行发生在隔离子进程 */
  isolated?: boolean;
  /** 关联沙箱项目 id（隔离子进程定位编译产物） */
  projectId?: number;
}

export const MAX_TEST_ITERATIONS = 5;

/** SSRF 真实拦截探测地址矩阵（用例4：内网 IP / 内网主机，全部必须被拦截）。
 * 通用矩阵对「适配器进程内守卫」与「子进程守卫」均须拦截；
 * 云元数据段（169.254）仅子进程守卫覆盖（进程级强化），单独在子进程探测中执行。 */
export const SSRF_PROBES = [
  'http://127.0.0.1:80/internal',
  'http://localhost:80/admin',
  'https://10.0.0.1/',
  'https://172.16.0.1/',
  'https://192.168.1.1/',
  'https://intranet.local/',
  'http://metadata.internal/',
];

/** 子进程级强化探测：云元数据段（169.254.169.254，云环境 SSRF 头号目标） */
export const CHILD_ONLY_SSRF_PROBES = [
  'https://169.254.169.254/latest/meta-data/',
  'http://169.254.169.254/latest/meta-data/',
];

// ── 测试端点模拟（主进程内 patch fetch，仅测试期生效；隔离工具经 invoke 消息同步进子进程） ──

// MockEndpoint 形状与 sandbox_ipc_types 共享（子进程内 mock 与主进程内 mock 语义一致）
//  { url, status?, body?, delayMs?, abort? }

const mockEndpoints: MockEndpoint[] = [];
let patchInstalled = false;
let originalFetch: typeof fetch;

export function resetTestEndpoints(): void {
  mockEndpoints.length = 0;
  // 隔离工具：同步清空宿主侧 mock 快照（下一次 invoke 携带空列表 → 子进程 mock 清空）
  forwardMockReset();
}

/** 注册一个 mock 端点（url 前缀匹配；后续 fetch 被拦截） */
export function registerMockEndpoint(e: MockEndpoint): void {
  mockEndpoints.push(e);
  installFetchPatch();
  // 隔离工具：转发到沙箱宿主 → 随下一次 invoke 消息进入隔离子进程（子进程内 mock 生效）
  forwardMockRegister(e);
}

function installFetchPatch(): void {
  if (patchInstalled) return;
  originalFetch = globalThis.fetch;
  patchInstalled = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // 最近注册的 mock 优先（避免跨用例同前缀干扰）
    // 端点模板中的 {param} 占位符转通配（真实 URL 已替换占位符）
    const hit = [...mockEndpoints].reverse().find(e => {
      const pattern = '^' + e.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+\\\}/g, '[^#?]*') + '.*';
      return new RegExp(pattern).test(url);
    });
    if (!hit) return originalFetch(input, init);
    if (hit.delayMs) await new Promise(r => setTimeout(r, hit.delayMs));
    if (hit.abort) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    }
    if (hit.status && hit.status >= 500) {
      return new Response('upstream error', { status: hit.status, headers: { 'Content-Type': 'text/plain' } });
    }
    const body = hit.body !== undefined ? JSON.stringify(hit.body) : JSON.stringify({ ok: true });
    return new Response(body, { status: hit.status || 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

export function restoreFetch(): void {
  if (patchInstalled) {
    globalThis.fetch = originalFetch;
    patchInstalled = false;
    mockEndpoints.length = 0;
    forwardMockReset();
  }
}

// ── 6 类用例 ──

interface CaseDef { name: string; run: () => Promise<string>; }

function buildCases(tool: TestableTool): CaseDef[] {
  const domain = tool.complianceDomain || 'none';
  const endpoint = tool.endpointTemplate || 'https://api.example.test/data';
  const cases: CaseDef[] = [];

  // 1. 功能正确性
  cases.push({
    name: '功能正确性：正常入参返回结构化结果',
    run: async () => {
      registerMockEndpoint({ url: endpoint, body: { ok: true, value: 1 } });
      const r = await tool.handler({ query: 'test', limit: '3' });
      if (typeof r !== 'string' || r.length === 0) return '返回为空或非字符串';
      if (r.startsWith('⚠️')) return '正常入参却被拒绝: ' + r.slice(0, 80);
      return 'ok';
    },
  });

  // 2. 边界与异常
  cases.push({
    name: '边界：空入参不崩溃',
    run: async () => {
      const r = await tool.handler({});
      if (typeof r !== 'string') return '返回非字符串';
      return 'ok';
    },
  });
  cases.push({
    name: '边界：超长入参截断不崩溃',
    run: async () => {
      const r = await tool.handler({ query: 'x'.repeat(100_000) });
      if (typeof r !== 'string') return '返回非字符串';
      return 'ok';
    },
  });

  // 3. 网络故障降级
  cases.push({
    name: '降级：上游 5xx → 重试后返回降级文案',
    run: async () => {
      registerMockEndpoint({ url: endpoint, status: 503 });
      const r = await tool.handler({});
      if (!r.startsWith('⚠️')) return '5xx 未降级: ' + r.slice(0, 80);
      return 'ok';
    },
  });
  cases.push({
    name: '降级：上游超时 → 降级文案且不崩溃',
    run: async () => {
      registerMockEndpoint({ url: endpoint, abort: true });
      const r = await tool.handler({});
      if (!r.startsWith('⚠️')) return '超时未降级';
      if (!r.includes('超时')) return '降级文案未说明超时';
      return 'ok';
    },
  });

  // 4. 沙箱隔离（SSRF）— P2-5 修复：真实内网拦截测试（原无条件返回 ok 的空用例已删除）
  // 探测地址矩阵：本地回环 / 内网 IP（10/172.16/192.168）/ 云元数据段（169.254）/ 内网主机名
  cases.push({
    name: '隔离：内网IP/内网主机访问必须被拦截（真实探测）',
    run: async () => {
      const probes = SSRF_PROBES;
      if (tool.isolated && tool.projectId) {
        // AI 自研工具：探测在隔离子进程内真实执行（子进程级 fetch 守卫，尝试访问即拦截）
        const r = await probeInternal(tool.projectId, [...probes, ...CHILD_ONLY_SSRF_PROBES]);
        if (!r.ok) return `子进程探测不可用：${r.message}`;
        const leaked = (r.results || []).filter(p => !p.blocked);
        if (leaked.length > 0) {
          return `内网访问未被拦截：${leaked.map(p => `${p.url}→${p.detail}`).join('；')}`;
        }
        return 'ok';
      }
      // 适配器/社区工具（主进程执行）：进程内直接探测适配器 SSRF 守卫
      const results = ssrfProbeInProcess(probes);
      const leaked = results.filter(p => !p.blocked);
      if (leaked.length > 0) {
        return `内网访问未被拦截：${leaked.map(p => `${p.url}→${p.detail}`).join('；')}`;
      }
      return 'ok';
    },
  });

  // 5. 强制合规免责（finance/medical 域不可移除）
  if (domain !== 'none') {
    const expected = domain === 'finance' ? '不构成任何投资建议' : '不能替代专业医疗诊断';
    cases.push({
      name: `合规：${domain} 域输出强制含免责文案`,
      run: async () => {
        registerMockEndpoint({ url: endpoint, body: { value: 42 } });
        const r = await tool.handler({});
        if (!r.includes(expected)) return `免责缺失（期望含「${expected}」）`;
        return 'ok';
      },
    });
  } else {
    cases.push({
      name: '合规：非金融/医疗域不注入免责',
      run: async () => {
        registerMockEndpoint({ url: endpoint, body: { value: 42 } });
        const r = await tool.handler({});
        if (r.includes('不构成任何投资建议')) return 'none 域误注入金融免责';
        return 'ok';
      },
    });
  }

  // 6. 性能与稳定性
  cases.push({
    name: '性能：单次响应 ≤ 10s',
    run: async () => {
      registerMockEndpoint({ url: endpoint, body: { ok: true } });
      const started = Date.now();
      await tool.handler({});
      const elapsed = Date.now() - started;
      if (elapsed > 10_000) return `响应耗时 ${elapsed}ms 超限`;
      return 'ok';
    },
  });
  cases.push({
    name: '稳定性：连续 5 次调用无异常',
    run: async () => {
      for (let i = 0; i < 5; i++) {
        const r = await tool.handler({ query: String(i) });
        if (typeof r !== 'string') return `第 ${i + 1} 次返回非字符串`;
      }
      return 'ok';
    },
  });

  return cases;
}

// ── 主流程 ──

export async function runTestPipeline(
  tool: TestableTool,
  opts: { projectId?: number; repair?: () => Promise<boolean> } = {},
): Promise<ToolTestReport> {
  let iterations = 0;
  let lastReport: ToolTestReport | null = null;

  // 测试执行期：屏蔽工具内部运行监控写入（开发期数据不污染运行健康判定）
  const prevTestFlag = process.env.SKILLS_TEST_METRICS;
  process.env.SKILLS_TEST_METRICS = '1';

  for (iterations = 1; iterations <= MAX_TEST_ITERATIONS; iterations++) {
    resetTestEndpoints();
    const cases = buildCases(tool);
    const results = [];
    for (const c of cases) {
      let detail = '';
      try {
        detail = await c.run();
      } catch (e: any) {
        detail = `异常: ${e.message}`;
      }
      results.push({ name: c.name, pass: detail === 'ok', detail: detail === 'ok' ? '' : detail });
    }

    const passed = results.filter(r => r.pass).length;
    lastReport = {
      projectId: String(opts.projectId ?? 0),
      toolName: tool.name,
      cases: results,
      total: results.length,
      passed,
      iterations,
      gatePassed: passed === results.length,
      needsHumanOptimization: false,
      report: '',
      ranAt: new Date().toISOString(),
    };

    if (lastReport.gatePassed) break;

    // 失败 → 修复重试（沙箱项目由模块3 重新 tsc 迭代修复源码；无修复能力 → 直接标记人工优化）
    const fixed = opts.repair ? await opts.repair() : false;
    if (!fixed) {
      lastReport.needsHumanOptimization = iterations >= MAX_TEST_ITERATIONS;
      break;
    }
  }

  if (!lastReport) throw new Error('测试流水线未产出报告');
  // 恢复监控写入标志（测试期结束）
  if (prevTestFlag === undefined) delete process.env.SKILLS_TEST_METRICS;
  else process.env.SKILLS_TEST_METRICS = prevTestFlag;

  lastReport.report = renderReport(lastReport);
  await appendAudit('test', lastReport.toolName,
    `${lastReport.passed}/${lastReport.total} 通过 ×${lastReport.iterations} 轮${lastReport.needsHumanOptimization ? '（需人工优化）' : ''}`);

  // 注：测试期指标不写入运行监控（开发期数据污染运行健康判定）

  if (lastReport.gatePassed) {
    logger.info(`[SkillsTest] ${lastReport.toolName} 全部通过（${lastReport.passed}/${lastReport.total} ×${iterations} 轮）`);
  } else {
    logger.warn(`[SkillsTest] ${lastReport.toolName} 未达标（${lastReport.passed}/${lastReport.total} ×${iterations} 轮）${lastReport.needsHumanOptimization ? ' → 需人工优化' : ''}`);
  }
  return lastReport;
}

export function renderReport(r: ToolTestReport): string {
  const lines = [
    `# 工具测试报告 — ${r.toolName}`,
    `- 时间：${r.ranAt}`,
    `- 结果：${r.passed}/${r.total} 通过（${r.iterations} 轮）`,
    r.gatePassed ? '- 结论：✅ 达到上线门槛' : '- 结论：❌ 未达到上线门槛' + (r.needsHumanOptimization ? '（5 轮无效，需人工优化）' : ''),
    '',
  ];
  for (const c of r.cases) {
    lines.push(`- [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  return lines.join('\n');
}

/** 沙箱项目修复回调：重新 iterateTsc 修复源码（≤5 轮） */
export function makeSandboxRepair(projectId: number): () => Promise<boolean> {
  return async () => {
    try {
      const r = await iterateTsc(projectId);
      return r.passed;
    } catch (e: any) {
      logger.warn(`[SkillsTest] 沙箱修复失败: ${e.message}`);
      return false;
    }
  };
}

// 注：主进程动态 import(file://) 加载 AI 生成源码的危险路径已彻底删除（P1阻断项·方案A）。
// 自研工具的测试对象由 sandbox_isolate/sandbox_host.getIsolatedTestableTool 提供
// （IPC 代理 handler + 子进程 describe 元信息），加载与执行只发生在隔离子进程内。
