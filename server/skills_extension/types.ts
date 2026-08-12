// 阶段三·自主技能拓展系统 — 类型定义
// 全部类型集中在独立模块，不触碰阶段一/二任何类型。

// ── 风险等级（P2-3：ToolCandidate / P2-2：realRiskLevel 共用；与 risk_policy 同构） ──

export type RiskLevel = 'safe' | 'medium' | 'high';

// ── 能力缺口 ──

export interface SkillGap {
  id: string;
  /** 缺口关键词（如 "美股行情"） */
  keyword: string;
  /** 用户原始需求示例（含表达样本） */
  evidence: string[];
  /** 高频无法处理次数 */
  frequency: number;
  /** 最近一次出现时间 ISO */
  lastSeenAt: string;
  /** 当前处理状态：pending / searching / adapting / sandboxing / testing / awaiting_approval / approved / rejected / failed */
  status: SkillGapStatus;
  /** 选定的决策路径：reuse（路径A）/ self_build（路径B） */
  chosenPath?: 'reuse' | 'self_build';
  /** 完整推理链路（存记忆复盘的 JSON 序列化） */
  reasoningChain?: string;
  createdAt: string;
}

export type SkillGapStatus =
  | 'pending' | 'searching' | 'adapting' | 'sandboxing'
  | 'testing' | 'awaiting_approval' | 'approved' | 'rejected' | 'failed';

// ── 工具评估（七维评分） ──

export interface ToolCandidate {
  id: string;
  name: string;
  /** 来源：registry（内置目录）/ community（社区检索）/ api（第三方 API 目录） */
  source: 'registry' | 'community' | 'api';
  /** 检索到的原始描述/仓库地址/接口地址 */
  origin: string;
  providerUrl?: string;
  /** 是否付费 */
  paid: boolean;
  /** 预估调用成本（元/千次，0 表示免费） */
  estimatedCostPer1k?: number;
  /** 是否附带合规免责 */
  hasDisclaimer: boolean;
  /** 是否带密钥需求（付费 API 需要用户录入） */
  needsCredential: boolean;
  /** 七维评分 0-1（任一维度 < 0.6 判定淘汰） */
  scores: {
    stability: number;        // 接口稳定性
    maintenance: number;      // 更新维护频率
    errorRate: number;        // 报错率（1=低报错）
    compliance: number;       // 合规完整性
    cost: number;             // 调用成本（1=免费/低成本）
    protocolFit: number;      // 协议适配度（与 PeppaOS 调度协议兼容）
    userMatch: number;        // 用户交互匹配度
  };
  /** 是否通过七维评估（任一 < 0.6 淘汰） */
  eligible: boolean;
  /** 淘汰原因（不达标维度） */
  disqualifyReasons: string[];
  /** 决策：reuse（路径A）/ self_build（路径B） */
  decision: 'reuse' | 'self_build';
  /** 版本号（P2-3：检索可得时填充；注册表/社区命中无版本数据时置 null） */
  version: string | null;
  /** 依赖清单（P2-3：自包含工具为空数组；无法获取时为空数组） */
  dependencies: string[];
  /** 风险等级（P2-3：经 risk_policy 分级填充；无法评估时置 null） */
  riskLevel: RiskLevel | null;
  assessedAt: string;
}

// ── 沙箱 MCP 生成 ──

export interface SandboxProject {
  id: number;
  /** 对应缺口 keyword */
  keyword: string;
  /** 沙箱绝对路径 */
  dir: string;
  /** 生成的服务名（MCP 工具前缀） */
  serviceName: string;
  /** 源码主文件内容（供审计） */
  mainSource: string;
  /** tsc 迭代轮数 */
  tscIterations: number;
  /** 是否通过 tsc 校验 */
  tscPassed: boolean;
  /** 待修复原因（5 轮失败标记） */
  pendingReason?: string;
  /** 风险等级（P2-2：创建阶段由 risk_policy 分级，审批上线继承，不再硬编码 safe） */
  riskLevel?: RiskLevel;
  /** 创建时间 ISO（7 天未审批自动清理） */
  createdAt: string;
  status: 'building' | 'testing' | 'awaiting_approval' | 'approved' | 'rejected' | 'expired' | 'failed';
}

// ── 测试与审批 ──

export interface ToolTestReport {
  projectId: string;
  toolName: string;
  cases: Array<{ name: string; pass: boolean; detail: string }>;
  total: number;
  passed: number;
  iterations: number;
  /** 是否达到上线门槛（全部通过） */
  gatePassed: boolean;
  /** 5 轮无效标记 */
  needsHumanOptimization?: boolean;
  report: string; // 标准化工具开发报告
  ranAt: string;
}

export interface ApprovalRecord {
  id: number;
  toolName: string;
  projectId: string;
  /** pending / approved / rejected / expired */
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  /** 人工操作者 */
  decidedBy?: string;
  /** 驳回修改意见 */
  rejectReason?: string;
  /** 审批时间 */
  decidedAt?: string;
  createdAt: string;
}

// ── 网关凭证 ──

export interface GatewayCredential {
  id: number;
  /** 工具/服务名 */
  serviceName: string;
  /** AES-256-GCM 密文（base64: iv:tag:ciphertext） */
  encryptedKey: string;
  /** 绑定权限的工具白名单 */
  boundTools: string;
  /** 是否启用 */
  enabled: number;
  /** 授权用户（空 = 全局） */
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── 监控指标 ──

export interface ToolMetric {
  id: number;
  toolName: string;
  /** ok / error / timeout */
  status: 'ok' | 'error' | 'timeout';
  /** 响应耗时 ms */
  latencyMs: number;
  /** 用户负面情绪标记（-1 表示未知） */
  userNegative: number;
  /** 指标来源（P2-4：self_build 自研工具显式标记；默认 community） */
  source?: string;
  createdAt: string;
}

// ── 审计 ──

export interface SkillsAuditEntry {
  id: number;
  /** 审计动作：gap_detected / search / adapt / sandbox_generate / test / approval / approve / reject / deploy / rollback / credential_set / credential_delete / api_call / upgrade / expire_cleanup / optimization */
  action: string;
  /** 关联对象（工具名/项目ID/缺口ID） */
  subject: string;
  detail: string;
  createdAt: string;
}

// ── 技能库（mcp_skill_store：元数据/来源/风险标记/成功率统计） ──

export type SkillStoreSource = 'registry' | 'community' | 'api' | 'self_build';

export interface SkillStoreEntry {
  id: number;
  toolName: string;
  version: string;
  /** 来源：registry（内置目录）/ community（社区下载）/ api（第三方 API）/ self_build（AI自主生成） */
  source: SkillStoreSource;
  /** 仓库地址/接口地址/生成来源 */
  origin: string;
  /** 风险标记：safe / medium / high */
  riskLevel: RiskLevel;
  securityLevel: string;
  complianceDomain: string;
  needsCredential: boolean;
  /** installed（已登记）/ enabled（已启用）/ disabled（已禁用）/ uninstalled（已卸载，记录保留） */
  status: 'installed' | 'enabled' | 'disabled' | 'uninstalled';
  /** 成功率统计 */
  successCount: number;
  failCount: number;
  totalCalls: number;
  successRate: number; // 0~1
  metadata: string; // JSON 字符串
  installedAt: string;
  updatedAt: string;
}

// ── 健康面板数据（模块6 扩展 health-check） ──

export interface SkillsHealthBoard {
  sandboxPending: Array<Pick<SandboxProject, 'id' | 'keyword' | 'serviceName' | 'status' | 'createdAt'>>;
  toolLedger: Array<{ toolName: string; source: string; deployedAt: string; version: string }>;
  apiBilling: Array<{ serviceName: string; calls: number; costEstimate: number }>;
  skillHistory: Array<SkillsAuditEntry>;
  faultStats: Array<{ toolName: string; errors: number; timeouts: number; avgLatencyMs: number }>;
  gapSummary: Array<{ keyword: string; frequency: number; status: SkillGapStatus }>;
}
