// 阶段三·P1阻断项修复【方案A：进程级沙箱隔离】— 父子进程 IPC 消息类型定义（1-3）
//
// 只定义消息形状（type-only，运行时零开销），由 sandbox_host（主进程侧）与
// sandbox_child（隔离子进程侧）共享。所有跨进程通信必须经过本文件定义的消息类型，
// 禁止在 IPC 通道上传递函数或不可序列化对象（消息必须 JSON 可序列化）。

/** 测试期 mock 端点（子进程内生效；镜像 test_pipeline 的进程内 mock 语义，不改生成代码） */
export interface SandboxMockEndpoint {
  /** 端点 URL 前缀（支持 {param} 占位符通配） */
  url: string;
  /** HTTP 状态（默认 200） */
  status?: number;
  /** JSON 响应体 */
  body?: unknown;
  /** 响应延迟 ms */
  delayMs?: number;
  /** 模拟网络超时（抛 TimeoutError） */
  abort?: boolean;
}

/** 自研工具元信息（由子进程加载编译产物后从模块导出读取，主进程不加载源码） */
export interface SandboxToolMeta {
  name: string;
  complianceDomain: 'finance' | 'medical' | 'none';
  endpointTemplate: string;
  securityLevel: string;
}

/** SSRF 探测结果（子进程内对每个地址的真实守卫拦截结果） */
export interface SandboxProbeResult {
  url: string;
  /** true = 已被进程级守卫拦截（未触网） */
  blocked: boolean;
  /** 守卫拦截文案（风险报错）或未拦截原因 */
  detail: string;
}

/** 宿主 → 子进程 */
export type HostToChildMessage =
  | {
      type: 'invoke';
      requestId: string;
      projectId: number;
      /** 沙箱项目绝对路径（子进程自行拼接 dist/index.mjs 并 file:// 加载） */
      projectDir: string;
      /** 编译产物内容哈希（子进程按 hash 缓存模块；hash 变化即重新 import） */
      sourceHash: string;
      args: Record<string, any>;
      /** 测试期 mock 快照（每次调用全量下发，子进程调用前整体替换） */
      mocks: SandboxMockEndpoint[];
    }
  | {
      type: 'describe';
      requestId: string;
      projectId: number;
      projectDir: string;
      sourceHash: string;
    }
  | { type: 'ssrf-probe'; requestId: string; urls: string[] }
  | { type: 'ping' }
  | { type: 'destroy' };

/** 子进程 → 宿主 */
export type ChildToHostMessage =
  | { type: 'ready'; pid: number }
  | { type: 'pong' }
  | {
      type: 'invoke-result';
      requestId: string;
      /** false = handler 抛异常/加载失败（宿主转 throw，语义与旧版主进程直接执行一致） */
      ok: boolean;
      result: string;
      error?: string;
    }
  | {
      type: 'describe-result';
      requestId: string;
      ok: boolean;
      meta?: SandboxToolMeta;
      error?: string;
    }
  | {
      type: 'probe-result';
      requestId: string;
      ok: boolean;
      results?: SandboxProbeResult[];
      error?: string;
    }
  | {
      // P2-4：模板 setReportHook 接线的运行指标上报（工具内部自评状态；宿主落地 tool_monitoring）
      type: 'metric-report';
      /** 关联 invoke 的 requestId（宿主据此判断该次调用是否已有工具级指标，避免与宿主侧传输指标重复计数） */
      requestId?: string;
      toolName: string;
      /** 工具自身评估：ok / error / timeout（与社区适配器 startResult 语义一致） */
      status: 'ok' | 'error' | 'timeout';
      latencyMs: number;
    }
  | { type: 'child-error'; requestId?: string; message: string };
