// 阶段三·模块2b — 外部工具自动适配改造引擎（路径A执行器）
// 将七维评估合格的外部候选 → 统一出入参对接 → 多层超时重试降级 → 强制合规免责 → 风格匹配
// → 版本管理 → 热加载注册（无需重启主服务），失败自动回滚旧版本。
//
// 安全红线（本模块强制）：
//   1. SSRF 防护：仅允许 HTTPS 公网域名，禁止 localhost/内网/保留地址段，禁止任意本地文件/配置读写；
//   2. 密钥不落地：适配器永远不接收明文密钥，仅通过注入的 resolveCredential（由 auth_gateway 接线提供）
//      在授权网关注册后代理调用；心智层不可读明文；
//   3. 金融/医疗域强制注入合规免责（不可移除）；
//   4. 付费 API 不自动开通：needsCredential 工具在授权前返回"待授权"降级文案，不发起外部请求。
//
// 顶层业务规则：本模块只处理"已判定 reuse（路径A）"的合格候选；路径裁决在 search_engine/gap_detector。

import * as fs from 'fs';
import * as path from 'path';
import { toolRegistry } from '../tools/registry';
import type { ToolDefinition } from '../tools/types';
import { personalityRegistry } from '../personality';
import { logger } from '../lib/logger';
import { appendAudit, insertMetric, getSandboxRoot } from './database';
import { addMemory } from '../memory/store';
import type { ToolCandidate, RiskLevel } from './types';
// 阶段三·风险闸门 / 单会话熔断 / 技能库安装登记（mcp_skill_store）
import { assertDeployAllowed, classifyBuiltinToolRisk } from './risk_policy';
import { consumeSessionSlot } from './breakers';
import { installSkill, logCallOkEvent } from './lifecycle';

// ── 常量 ──

export const ADAPTER_TIMEOUT_MS = 8_000;
export const ADAPTER_RETRIES = 2;            // 仅对 5xx/超时重试
export const ADAPTER_MAX_BODY_BYTES = 200_000; // 响应截断，防滥用
export const ADAPTER_MAX_VERSIONS = 5;       // 每工具最多保留的版本栈深度

/** 金融合规免责（阶段一金融合规保留项，适配器强制注入、不可移除） */
const FINANCE_DISCLAIMER = '\n\n⚠️ 以上仅为客观数据陈列，不构成任何投资建议。投资有风险，决策需自行判断。';
/** 医疗健康免责 */
const MEDICAL_DISCLAIMER = '\n\n⚠️ 以上内容仅供科普参考，不能替代专业医疗诊断与治疗建议；如有不适请及时就医。';

const FINANCE_HINTS = ['stock', 'finance', '行情', '股票', '基金', '外汇', '汇率', '加密', 'coin', '币价'];
const MEDICAL_HINTS = ['医疗', '药品', '药物', 'health', 'medical', '就诊', '医院'];

// P2-8：真实风险等级复用判定。securityLevel 已是 RiskLevel 枚举（safe/medium/high）时直接复用，
// 不再二次调用 classifyRisk —— classifyRisk 仅识别 high 显式声明，无法识别 medium 输入，
// 会把 realRiskLevel=medium 的工具降级成 safe，造成 mcp_skill_store.risk_level 与 security_level 展示口径失真。
function isRiskLevelValue(v: string | undefined): v is RiskLevel {
  return v === 'safe' || v === 'medium' || v === 'high';
}

// ── SSRF 防护（沙箱最小权限：只读公网网络，不触碰本地） ──
// P2-1：与 sandbox_child.ts 隔离子进程守卫【完全一致】——补齐云元数据段 169.254.0.0/16、
// 0.0.0.0 及 .internal/.lan/.localhost/.localdomain 内网主机后缀，适配器与子进程 SSRF 规则对齐。

function assertPublicHttpsUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error(`适配器仅允许 HTTPS 出站（收到 ${u.protocol}）`);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') ||
      host.endsWith('.localhost') || host.endsWith('.localdomain')) {
    throw new Error(`适配器禁止访问本地/内网主机 ${host}（沙箱隔离）`);
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 169 && parts[1] === 254)) {
      throw new Error(`适配器禁止访问内网地址 ${host}（沙箱隔离）`);
    }
  }
  return u;
}

/**
 * SSRF 守卫测试钩子（P2-5 修复：测试流水线用例4 的真实拦截断言；不参与业务执行链）。
 * 对每个地址直接调用进程内 SSRF 守卫，返回是否被拦截及守卫文案。
 */
export function ssrfProbeInProcess(urls: string[]): Array<{ url: string; blocked: boolean; detail: string }> {
  return urls.map(url => {
    try {
      assertPublicHttpsUrl(url);
      return { url, blocked: false, detail: '守卫未拦截（内网泄露风险）' };
    } catch (e: any) {
      return { url, blocked: true, detail: e?.message || String(e) };
    }
  });
}

// ── 认证注入点（auth_gateway 接线时提供；未接线 = 无密钥服务） ──
// 安全红线：密钥明文永不出网关 —— 适配器仅注入 proxyFetcher（由 auth_gateway 解密密钥后代理请求），
// 适配器/心智层不接触明文密钥。

export type ProxyFetcher = (serviceName: string, url: string, init: RequestInit) => Promise<Response>;
let proxyFetcher: ProxyFetcher | null = null;

/** 由 index.ts 在 auth_gateway 初始化后注入（网关持有密钥明文，代理发出请求） */
export function setProxyFetcher(fn: ProxyFetcher): void {
  proxyFetcher = fn;
}

// ── 适配器骨架：统一出入参 + 超时重试降级 + 免责 + 指标 + 记忆复盘 ──

export interface AdapterConfig {
  toolName: string;
  serviceName: string;
  /** 候选来源描述（写记忆复盘用） */
  origin: string;
  /** 外部接口模板（支持 {param} 占位符） */
  endpointTemplate: string;
  method?: 'GET' | 'POST';
  /** 出入参映射：统一入参名 → 外部参数字段 */
  paramMap?: Record<string, string>;
  /** 结果提取器：返回原始 JSON 中用户可读的文本字段 */
  extractor: (data: any) => string;
  /** 合规域：finance / medical / none */
  complianceDomain: 'finance' | 'medical' | 'none';
  needsCredential?: boolean;
  description: string;
  securityLevel?: 'safe' | 'confirm';
  /** P2-4：工具来源（上线时由 meta.source 注入；指标写入 tool_monitoring.source） */
  source?: ToolCandidate['source'] | 'sandbox';
}

interface AdaptedToolMeta {
  name: string;
  serviceName: string;
  /** P2-2：自研工具可携带创建阶段 realRiskLevel（safe/medium/high），故放宽为 string（落 mcp_skill_store.security_level） */
  securityLevel: string;
  /** registry（内置目录）/ community（社区检索）/ api（第三方 API）/ sandbox（沙箱自研） */
  source: ToolCandidate['source'] | 'sandbox';
  origin: string;
  version: string;
  deployedAt: string;
}

/** 标准适配骨架（真实执行逻辑）：超时 → 重试 → 降级 → 免责 → 指标/记忆联动 */
function createAdaptedHandler(cfg: AdapterConfig) {
  const domain = cfg.complianceDomain;
  const disclaimer =
    domain === 'finance' ? FINANCE_DISCLAIMER :
    domain === 'medical' ? MEDICAL_DISCLAIMER : '';

  return async (args: Record<string, any>): Promise<string> => {
    const started = Date.now();
    const startResult = (status: 'ok' | 'error' | 'timeout') => {
      // 测试模式（test_pipeline 执行期）不写入运行监控，避免开发期数据污染健康判定
      if (process.env.SKILLS_TEST_METRICS === '1') return;
      insertMetric({ toolName: cfg.toolName, status, latencyMs: Date.now() - started, userNegative: -1, source: cfg.source || 'community' }).catch(() => {});
    };

    try {
      // 密钥工具：未授权不发起外部请求（不自动开通付费 API）；授权后经网关代理（明文不出网关）
      const viaProxy = cfg.needsCredential && !!proxyFetcher;

      // 出入参对接：统一入参 → 外部字段
      const mapped: Record<string, string> = {};
      for (const [uniform, external] of Object.entries(cfg.paramMap || {})) {
        if (args[uniform] !== undefined) mapped[external] = String(args[uniform]);
      }
      // 未映射的原始参数透传（容错：外部工具参数名与统一名一致时直接可用）
      for (const [k, v] of Object.entries(args)) {
        if (!(k in (cfg.paramMap || {}))) mapped[k] = String(v);
      }

      let url: string;
      try {
        url = cfg.endpointTemplate.replace(/\{(\w+)\}/g, (_, key: string) => mapped[key] ?? '');
        assertPublicHttpsUrl(url);
      } catch (e: any) {
        startResult('error');
        return `⚠️ 工具 ${cfg.toolName} 请求被沙箱拦截：${e.message}`;
      }

      // 多层超时重试降级链
      let lastErr: Error | null = null;
      let lastStatus = 0;
      for (let attempt = 0; attempt <= ADAPTER_RETRIES; attempt++) {
        try {
          const init: RequestInit = {
            method: cfg.method || 'GET',
            headers: { Accept: 'application/json', 'User-Agent': 'PeppaOS-Adapter' },
            signal: AbortSignal.timeout(ADAPTER_TIMEOUT_MS),
          };
          let res: Response;
          if (cfg.needsCredential) {
            if (!proxyFetcher) {
              startResult('error');
              return `⚠️ 工具 ${cfg.toolName} 需要 API 密钥授权，当前未授权。请在「技能拓展 → 密钥管理」中录入密钥后重试。`;
            }
            res = await proxyFetcher(cfg.serviceName, url, init);
          } else {
            res = await fetch(url, init);
          }
          lastStatus = res.status;
          if (!res.ok) {
            if (res.status >= 500 && attempt < ADAPTER_RETRIES) continue; // 5xx 重试
            startResult('error');
            return `⚠️ 工具 ${cfg.toolName} 外部服务返回 ${res.status}，已重试 ${attempt} 次仍失败。请稍后重试。`;
          }
          const raw = await res.text();
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw.slice(0, ADAPTER_MAX_BODY_BYTES); }
          let body = cfg.extractor(data);
          if (typeof body !== 'string') body = JSON.stringify(body).slice(0, ADAPTER_MAX_BODY_BYTES);
          if (body.length > ADAPTER_MAX_BODY_BYTES) body = body.slice(0, ADAPTER_MAX_BODY_BYTES) + '\n…(响应超长已截断)';

          startResult('ok');
          // P2-5 3-3：调用成功结构化事件（call-ok；来源/风险取自技能库，未登记静默跳过）
          void logCallOkEvent(cfg.toolName).catch(() => {});
          // 记忆复盘写入（异步友好：同步 API 不阻塞回复）
          try {
            addMemory({
              userId: 'default',
              content: `工具调用复盘：${cfg.toolName} 成功响应（${
                Date.now() - started
              }ms），用于满足用户实时需求，来源：${cfg.origin}`,
              type: 'fact',
              keywords: ['技能拓展', cfg.toolName],
              confidence: 0.7,
              sourceInteractionId: '',
            }, { tier: 'internalized', perspective: 'owner_trait', importance: 0.3 });
          } catch { /* 记忆写入失败不影响工具结果 */ }
          return disclaimer ? body + disclaimer : body;
        } catch (e: any) {
          lastErr = e;
          if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            if (attempt < ADAPTER_RETRIES) continue; // 超时重试
            startResult('timeout');
            return `⚠️ 工具 ${cfg.toolName} 响应超时（${ADAPTER_TIMEOUT_MS / 1000}s×${attempt + 1} 次尝试）。已降级处理，请稍后重试。`;
          }
        }
      }
      void lastErr; void lastStatus;
      startResult('error');
      return `⚠️ 工具 ${cfg.toolName} 调用失败：${lastErr?.message || '未知错误'}。已自动降级，不影响本次回复。`;
    } catch (e: any) {
      startResult('error');
      return `⚠️ 工具 ${cfg.toolName} 内部错误：${e.message}`;
    }
  };
}

// ── 风格匹配（人格关系风格：语气/篇幅倾向） ──

function matchStyle(description: string): string {
  try {
    const p = personalityRegistry.getDefault();
    const tone = p?.expressionStyle?.tone;
    if (tone && typeof tone === 'string') return `${description}（适配当前人格语气：${tone}）`;
  } catch { /* 人格不可用时保持原描述 */ }
  return description;
}

// ── 版本管理（升级/回滚） ──

interface VersionEntry {
  version: string;
  deployedAt: string;
  definition: ToolDefinition;
  meta: Omit<AdaptedToolMeta, 'version' | 'deployedAt'>;
}

const versionStack = new Map<string, VersionEntry[]>(); // toolName → 版本栈（新→旧）
const adaptedLedger: AdaptedToolMeta[] = [];

export function getAdaptedLedger(): AdaptedToolMeta[] {
  return [...adaptedLedger];
}

export function listAdapterVersions(toolName: string): Array<{ version: string; deployedAt: string }> {
  return (versionStack.get(toolName) || []).map(v => ({ version: v.version, deployedAt: v.deployedAt }));
}

/** 注册到 ToolRegistry 并热加载（无重启）；重复注册先注销旧版 */
function hotRegister(entry: VersionEntry): boolean {
  if (toolRegistry.get(entry.definition.name)) {
    toolRegistry.unregister(entry.definition.name);
    logger.info(`[SkillsAdapter] 热加载替换: ${entry.definition.name} → v${entry.version}`);
  }
  return toolRegistry.register(entry.definition);
}

/** 升级到新版本：注册新 handler，失败自动回滚旧版本 */
export function upgradeTool(toolName: string, nextCfg: AdapterConfig, version: string, meta: Omit<AdaptedToolMeta, 'version' | 'deployedAt'>): { ok: boolean; message: string } {
  // 风险闸门（升级同样受控）：高风险配置拒绝升级，中风险告警放行
  const guard = assertDeployAllowed({
    securityLevel: nextCfg.securityLevel, source: meta.source, origin: meta.origin,
    needsCredential: nextCfg.needsCredential, complianceDomain: nextCfg.complianceDomain,
  });
  if (!guard.ok) return { ok: false, message: `升级被风险闸门拦截：${guard.reason}` };
  const stack = versionStack.get(toolName) || [];
  const next: VersionEntry = {
    version,
    deployedAt: new Date().toISOString(),
    definition: {
      name: nextCfg.toolName,
      description: matchStyle(nextCfg.description),
      parameters: {}, // 入参由 LLM 心智按描述自由给出（统一适配骨架内部做映射）
      // P2-4：handler 携带来源（指标写入 tool_monitoring.source），不修改原 cfg 对象
      handler: createAdaptedHandler({ ...nextCfg, source: meta.source }),
      permission: 'public',
      securityLevel: nextCfg.securityLevel || classifyBuiltinToolRisk('fallback-unknown-tool'),
    },
    meta,
  };
  const prev = stack[0];
  const ok = hotRegister(next);
  if (!ok) return { ok: false, message: `注册失败：${toolName} 仍处于占用状态` };

  stack.unshift(next);
  if (stack.length > ADAPTER_MAX_VERSIONS) stack.pop(); // 仅保留最近 5 版
  versionStack.set(toolName, stack);

  adaptedLedger.push({ ...meta, version, deployedAt: new Date().toISOString() });
  appendAudit('upgrade', toolName, `升级至 v${version}`);

  // 首次上线（无历史版本）→ 技能库安装登记（社区下载类工具同样入册；fire-and-forget，失败仅告警）
  if (!prev) {
    const storeSource: 'registry' | 'community' | 'api' | 'self_build' = meta.source === 'sandbox' ? 'self_build' : meta.source;
    // P2-8：已传入有效 RiskLevel 直接复用写入 risk_level；仅风险等级为空/非枚举时回退 classifyRisk 重新计算
    const risk: RiskLevel = isRiskLevelValue(nextCfg.securityLevel)
      ? nextCfg.securityLevel
      : assertDeployAllowed({ securityLevel: nextCfg.securityLevel, source: meta.source, origin: meta.origin }).level;
    void installSkill({
      toolName, version, source: storeSource, origin: meta.origin,
      riskLevel: risk, securityLevel: nextCfg.securityLevel || classifyBuiltinToolRisk('fallback-unknown-tool'),
    }).then(r => {
      if (!r.ok) logger.warn(`[SkillsAdapter] ${toolName} 技能库登记被拒: ${r.message}`);
    }).catch((e: any) => logger.warn(`[SkillsAdapter] ${toolName} 技能库登记失败: ${e?.message || e}`));
  }

  if (prev) {
    // 冒烟自检：对新版本 handler 立即探测（2s 竞速，失败/超时即回滚旧版本）
    const probe = Promise.race([
      next.definition.handler({}),
      new Promise<string>(r => setTimeout(() => r('⚠️ 冒烟探测超时'), 2000)),
    ]);
    void probe.then((r) => {
      if (r.startsWith('⚠️')) {
        logger.warn(`[SkillsAdapter] ${toolName} v${version} 冒烟失败 → 自动回滚 v${prev.version}`);
        rollbackTool(toolName);
      }
    });
  }
  return { ok: true, message: `已热加载 ${toolName} v${version}` };
}

/** 直接注册已生成的 ToolDefinition（沙箱审批上线复用统一版本栈管理） */
export function registerDefinition(
  toolName: string,
  definition: ToolDefinition,
  version: string,
  meta: Omit<AdaptedToolMeta, 'version' | 'deployedAt'>,
): { ok: boolean; message: string } {
  const stack = versionStack.get(toolName) || [];
  const prev = stack[0];
  const ok = hotRegister({ version, deployedAt: new Date().toISOString(), definition, meta });
  if (!ok) return { ok: false, message: `注册失败：${toolName} 仍处于占用状态` };
  stack.unshift({ version, deployedAt: new Date().toISOString(), definition, meta });
  if (stack.length > ADAPTER_MAX_VERSIONS) stack.pop();
  versionStack.set(toolName, stack);
  adaptedLedger.push({ ...meta, version, deployedAt: new Date().toISOString() });
  appendAudit(prev ? 'upgrade' : 'deploy', toolName, `v${version}${prev ? `（替换 v${prev.version}）` : ''}`);
  // 首次上线 → 技能库安装登记（mcp_skill_store：来源/风险标记/成功率统计；fire-and-forget，失败仅告警不阻断上线）
  if (!prev) {
    // 沙箱自研统一记为 self_build（AI自主生成）；其余透传 registry/community/api
    const storeSource: 'registry' | 'community' | 'api' | 'self_build' = meta.source === 'sandbox' ? 'self_build' : meta.source;
    // P2-8：meta.securityLevel 已是 realRiskLevel 枚举（safe/medium/high）时直接复用写入 risk_level，
    // 不再二次 classifyRisk（无法识别 medium 会把风险降级成 safe 造成展示失真）；仅空值回退重新计算
    const risk: RiskLevel = isRiskLevelValue(meta.securityLevel)
      ? meta.securityLevel
      : assertDeployAllowed({ securityLevel: meta.securityLevel, source: meta.source, origin: meta.origin }).level;
    void installSkill({
      toolName, version, source: storeSource, origin: meta.origin,
      riskLevel: risk, securityLevel: meta.securityLevel,
    }).then(r => {
      if (!r.ok) logger.warn(`[SkillsAdapter] ${toolName} 技能库登记被拒: ${r.message}`);
    }).catch((e: any) => logger.warn(`[SkillsAdapter] ${toolName} 技能库登记失败: ${e?.message || e}`));
  }
  if (prev) {
    void prev.definition.handler({}).then((r) => {
      if (r.startsWith('⚠️')) {
        logger.warn(`[SkillsAdapter] ${toolName} v${version} 冒烟失败 → 自动回滚 v${prev.version}`);
        rollbackTool(toolName);
      }
    });
  }
  return { ok: true, message: `已上线 ${toolName} v${version}` };
}

/** 回滚到上一版本（失败回滚旧版本的核心实现） */
export function rollbackTool(toolName: string): { ok: boolean; message: string } {
  const stack = versionStack.get(toolName) || [];
  if (stack.length < 2) return { ok: false, message: `${toolName} 无历史版本可回滚` };
  const [current, prev] = stack;
  const reRegistered = hotRegister(prev);
  if (!reRegistered) return { ok: false, message: `回滚注册失败：${toolName}` };
  stack.shift();
  versionStack.set(toolName, stack);
  appendAudit('rollback', toolName, `v${current.version} → v${prev.version}（失败自动回滚）`);
  logger.info(`[SkillsAdapter] ${toolName} 已回滚 v${current.version} → v${prev.version}`);
  return { ok: true, message: `已回滚 ${toolName} 至 v${prev.version}` };
}

// ── 适配快照落盘（审计用，与运行 handler 同一配置来源） ──

export function renderAdapterSource(cfg: AdapterConfig, candidate: ToolCandidate, version: string): string {
  const paramMap = Object.entries(cfg.paramMap || {}).map(([k, v]) => `  ${k}: '${v}'`).join(',\n');
  return `// 适配快照 ${cfg.toolName} v${version} — 由 skills_extension/adapter 自动生成（审计留存，非执行代码）
// 候选来源: ${candidate.origin}
// 七维评分: ${JSON.stringify(candidate.scores)}
// 合规域: ${cfg.complianceDomain}（免责强制注入，不可移除）

export const adapterConfig = {
  toolName: '${cfg.toolName}',
  serviceName: '${cfg.serviceName}',
  endpointTemplate: '${cfg.endpointTemplate}',
  method: '${cfg.method || 'GET'}',
  complianceDomain: '${cfg.complianceDomain}',
  needsCredential: ${!!cfg.needsCredential},
  paramMap: {
${paramMap}
  },
  description: '${cfg.description}',
  securityLevel: '${cfg.securityLevel || classifyBuiltinToolRisk('fallback-unknown-tool')}',
};
`;
}

/** 将快照写入沙箱适配目录（sandbox_auto_mcp/adapters/<name>/）并返回路径 */
export function writeAdapterSnapshot(cfg: AdapterConfig, candidate: ToolCandidate, version: string): string {
  const dir = path.join(getSandboxRoot(), 'adapters', cfg.toolName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `adapter_v${version}.ts`);
  fs.writeFileSync(file, renderAdapterSource(cfg, candidate, version), 'utf-8');
  return file;
}

// ── 主入口：候选 → 适配 → 暂存（审批通过后才进入工具池） ──

export interface AdaptResult {
  ok: boolean;
  toolName?: string;
  version?: string;
  snapshotPath?: string;
  message: string;
}

/** 暂存登记（已适配、待审批；批准前不注册进 ToolRegistry = 批准前不可进入工具池） */
interface StagedAdaptation {
  cfg: AdapterConfig;
  meta: Omit<AdaptedToolMeta, 'version' | 'deployedAt'>;
  version: string;
  stagedAt: string;
}
const stagedAdaptations = new Map<string, StagedAdaptation>();

export function listStagedAdaptations(): Array<{ toolName: string; version: string; stagedAt: string; origin: string }> {
  return Array.from(stagedAdaptations.entries()).map(([name, s]) => ({
    toolName: name,
    version: s.version,
    stagedAt: s.stagedAt,
    origin: s.meta.origin,
  }));
}

/**
 * 自动适配改造并暂存（路径A执行，审批闸门内）。
 * 适配产物：① 快照落盘审计 ② handler 构建完成 ③ 暂存登记。
 * 测试流水线（模块5）对暂存工具执行 6 类用例；审批通过（commitStagedAdaptation）后热加载上线。
 */
export async function adaptCandidate(
  candidate: ToolCandidate,
  adapterCfg: AdapterConfig,
  version = '1.0.0',
  opts: { sessionId?: string } = {},
): Promise<AdaptResult> {
  if (!candidate.eligible) {
    return { ok: false, message: `候选 ${candidate.name} 未通过七维评估，拒绝适配（淘汰原因：${candidate.disqualifyReasons.join(';')}）` };
  }
  // 风险闸门：高风险技能直接拦截（禁止暂存/部署），中风险告警放行
  const guard = assertDeployAllowed({
    securityLevel: adapterCfg.securityLevel, source: candidate.source, origin: candidate.origin,
    needsCredential: adapterCfg.needsCredential, complianceDomain: adapterCfg.complianceDomain,
  });
  if (!guard.ok) return { ok: false, message: `适配被风险闸门拦截：${guard.reason}` };
  // 单会话熔断：窗口内新增工具数量上限（防疯狂生成大量工具）
  const slot = consumeSessionSlot(opts.sessionId || 'default');
  if (!slot.ok) return { ok: false, message: `适配被熔断拦截：${slot.reason}` };
  if (adapterCfg.toolName !== candidate.name) adapterCfg.toolName = candidate.name;

  const meta: Omit<AdaptedToolMeta, 'version' | 'deployedAt'> = {
    name: candidate.name,
    serviceName: adapterCfg.serviceName,
    securityLevel: adapterCfg.securityLevel || classifyBuiltinToolRisk('fallback-unknown-tool'),
    source: candidate.source,
    origin: candidate.origin,
  };

  const snapshotPath = writeAdapterSnapshot(adapterCfg, candidate, version);
  stagedAdaptations.set(candidate.name, { cfg: adapterCfg, meta, version, stagedAt: new Date().toISOString() });

  await appendAudit('adapt', candidate.name, `七维${JSON.stringify(candidate.scores)} → 适配 v${version}（暂存待审批），快照 ${snapshotPath}`);
  logger.info(`[SkillsAdapter] ${candidate.name} 适配完成并暂存（待测试+审批）v${version}`);
  return { ok: true, toolName: candidate.name, version, snapshotPath, message: `已适配并暂存 ${candidate.name} v${version}，进入测试与审批闸门` };
}

/** 审批通过后：暂存适配提交上线（进入工具池） */
export function commitStagedAdaptation(toolName: string): { ok: boolean; message: string } {
  const staged = stagedAdaptations.get(toolName);
  if (!staged) return { ok: false, message: `无暂存适配：${toolName}` };
  const r = upgradeTool(toolName, staged.cfg, staged.version, staged.meta);
  if (r.ok) {
    stagedAdaptations.delete(toolName);
    appendAudit('deploy', toolName, `审批通过 → 暂存适配上线 v${staged.version}`);
  }
  return r;
}

/** 构建暂存适配的测试对象（供测试流水线执行） */
export function getStagedTestableTool(toolName: string): TestableToolLike | null {
  const staged = stagedAdaptations.get(toolName);
  if (!staged) return null;
  return {
    name: toolName,
    handler: createAdaptedHandler(staged.cfg),
    complianceDomain: staged.cfg.complianceDomain,
    endpointTemplate: staged.cfg.endpointTemplate,
  };
}

/** 测试对象形状（避免循环依赖：仅形状声明） */
export interface TestableToolLike {
  name: string;
  handler: (args: Record<string, any>) => Promise<string>;
  complianceDomain: 'finance' | 'medical' | 'none';
  endpointTemplate: string;
}
