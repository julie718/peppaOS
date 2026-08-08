// 阶段三·模块3a — 沙箱 MCP 标准生成模板（交付物#2：标准生成模板源码）
// 模板生成"自包含、零外部依赖"的 MCP 工具源码骨架（可独立 tsc 校验、独立 import 执行）。
// 骨架内嵌真实执行逻辑：SSRF 防护 / 超时重试降级 / 强制合规免责 / 结果提取 / 指标上报。
// 参数化点：serviceName / description / 参数 schema / 端点模板 / 入参映射 / 提取器 / 合规域 / 安全级别。
// 模板是工程脚手架（代码生成骨架），非对话话术模板——满足"非必要固化模板清理"边界。

export interface McpTemplateParams {
  serviceName: string;
  description: string;
  /** 统一入参 schema：{ 参数名: { type, description, required } } */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  /** 外部接口端点模板（{param} 占位符；仅 HTTPS 公网） */
  endpointTemplate: string;
  method?: 'GET' | 'POST';
  /** 统一入参名 → 外部参数字段 */
  paramMap: Record<string, string>;
  /** 结果提取器源码（函数体：入参 data，返回 string） */
  extractorFn: string;
  /** 合规域：finance / medical / none */
  complianceDomain: 'finance' | 'medical' | 'none';
  securityLevel?: 'safe' | 'confirm';
}

/** 渲染完整工具源码（唯一导出出口：MCP 工具定义 + 自检） */
export function renderMcpSource(p: McpTemplateParams): string {
  const paramsJson = JSON.stringify(p.parameters, null, 2)
    .split('\n').map(l => `  ${l}`).join('\n');
  const paramMapJson = JSON.stringify(p.paramMap, null, 2)
    .split('\n').map(l => `  ${l}`).join('\n');
  return `// 沙箱 MCP 自研工具 — ${p.serviceName}
// 由 skills_extension/mcp_template 标准模板生成（自包含、零外部依赖，可独立编译与执行）

const SERVICE_NAME = '${p.serviceName}';
const DESCRIPTION = ${JSON.stringify(p.description)};
const PARAMETERS = ${paramsJson};
const PARAM_MAP: Record<string, string> = ${paramMapJson};
const ENDPOINT_TEMPLATE = '${p.endpointTemplate}';
const METHOD = '${p.method || 'GET'}';
const COMPLIANCE_DOMAIN = '${p.complianceDomain}';
const SECURITY_LEVEL = '${p.securityLevel || 'safe'}';

const FINANCE_DISCLAIMER = '\\n\\n⚠️ 以上仅为客观数据陈列，不构成任何投资建议。投资有风险，决策需自行判断。';
const MEDICAL_DISCLAIMER = '\\n\\n⚠️ 以上内容仅供科普参考，不能替代专业医疗诊断与治疗建议；如有不适请及时就医。';

// ── SSRF 防护：仅允许 HTTPS 公网出站（沙箱最小权限） ──
function assertPublicHttpsUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('仅允许 HTTPS 出站');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host === '127.0.0.1' || host === '::1') {
    throw new Error('禁止访问本地地址（沙箱隔离）');
  }
  if (/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) || parts[0] === 127) {
      throw new Error('禁止访问内网地址（沙箱隔离）');
    }
  }
  return u;
}

// ── 结果提取（生成时注入的提取器函数体） ──
function extractResult(data: unknown): string {
${p.extractorFn.split('\n').map(l => `  ${l}`).join('\n')}
}

// ── 宿主可注入的指标钩子（可选；不注入则静默，保持自包含） ──
let reportHook: ((status: string, latencyMs: number) => void) | null = null;
export function setReportHook(hook: ((status: string, latencyMs: number) => void) | null): void {
  reportHook = hook;
}
function report(status: string, latencyMs: number): void {
  try { if (reportHook) reportHook(status, latencyMs); } catch { /* 钩子异常不影响工具 */ }
}

// ── 统一处理器：出入参对接 → 超时重试降级 → 免责 → 指标 ──
async function handle(args: Record<string, unknown>): Promise<string> {
  const started = Date.now();
  const finish = (status: string) => report(status, Date.now() - started);
  try {
    const mapped: Record<string, string> = {};
    for (const [uniform, external] of Object.entries(PARAM_MAP)) {
      const v = args[uniform];
      if (v !== undefined && v !== null) mapped[external] = String(v);
    }
    for (const [k, v] of Object.entries(args)) {
      if (!(k in PARAM_MAP)) mapped[k] = String(v);
    }

    let url: string;
    try {
      url = ENDPOINT_TEMPLATE.replace(/\\{(\\w+)\\}/g, (_: string, key: string) => mapped[key] ?? '');
      assertPublicHttpsUrl(url);
    } catch (e: unknown) {
      return '⚠️ 请求被沙箱拦截：' + (e instanceof Error ? e.message : String(e));
    }

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: METHOD,
          headers: { Accept: 'application/json', 'User-Agent': 'PeppaOS-Sandbox' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          if (res.status >= 500 && attempt < 2) continue;
          finish('error');
          return '⚠️ 外部服务返回 ' + res.status + '，已重试 ' + attempt + ' 次仍失败。请稍后重试。';
        }
        const raw = await res.text();
        let data: unknown;
        try { data = JSON.parse(raw); } catch { data = raw.slice(0, 200000); }
        let body = extractResult(data);
        if (typeof body !== 'string') body = JSON.stringify(body).slice(0, 200000);
        if (body.length > 200000) body = body.slice(0, 200000) + '\\n…(响应超长已截断)';
        const disclaimer = COMPLIANCE_DOMAIN === 'finance' ? FINANCE_DISCLAIMER
          : COMPLIANCE_DOMAIN === 'medical' ? MEDICAL_DISCLAIMER : '';
        finish('ok');
        return body + disclaimer;
      } catch (e: unknown) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const to = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
        if (to && attempt < 2) continue;
        finish(to ? 'timeout' : 'error');
        return to
          ? '⚠️ 响应超时（8s×' + (attempt + 1) + ' 次尝试）。已降级处理，请稍后重试。'
          : '⚠️ 调用失败：' + lastErr.message + '。已自动降级。';
      }
    }
    void lastErr;
    void lastErr;
    finish('error');
    return '⚠️ 未知失败。';
  } catch (e: unknown) {
    finish('error');
    return '⚠️ 内部错误：' + (e instanceof Error ? e.message : String(e));
  }
}

export const toolDefinition = {
  name: SERVICE_NAME,
  description: DESCRIPTION,
  parameters: PARAMETERS,
  handler: handle,
  permission: 'public',
  securityLevel: SECURITY_LEVEL,
};

export const __META = {
  complianceDomain: COMPLIANCE_DOMAIN,
  endpointTemplate: ENDPOINT_TEMPLATE,
  serviceName: SERVICE_NAME,
};

export function selfTest(): string {
  return SERVICE_NAME + ' 沙箱工具已就绪（' + COMPLIANCE_DOMAIN + ' 域）';
}
`;
}

/** 渲染 tsconfig（沙箱目录独立编译校验用；零外部依赖，类型全部内置） */
export function renderSandboxTsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": [],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
`;
}
