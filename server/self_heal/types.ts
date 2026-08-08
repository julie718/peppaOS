// 阶段二·自诊疗模块 — 类型定义
// 独立解耦模块：不依赖人格/情绪/记忆/MCP 业务主流程，仅通过文件路径与 rootDir 交互。

/** 缺陷严重级别 */
export type DefectSeverity = 'P1' | 'P2' | 'P3';

/** 缺陷分类：①标准化已知高频 bug（模板可命中）②未知新型逻辑缺陷（需人工） */
export type DefectCategory = 'known' | 'unknown';

/** 四类故障来源 */
export type DefectSource = 'assertion_failure' | 'runtime_error' | 'dead_code' | 'hardcoded_const' | 'template_mismatch';

/** 结构化缺陷描述 */
export interface Defect {
  id: string;                 // 缺陷编号，如 D20260808-0001
  source: DefectSource;       // 故障来源
  category: DefectCategory;   // 已知/未知分类
  severity: DefectSeverity;   // 分级
  file: string;               // 对应文件（rootDir 相对路径）
  line?: number;              // 对应行号（尽力定位）
  symptom: string;            // 故障现象
  criterion: string;          // 判定标准
  templateId?: string;        // 修复模板匹配标识（命中时）
  autoRepairable: boolean;    // 可自动修复
  humanRequired: boolean;     // 需人工介入
  resolved: boolean;          // 是否已修复
  repairedBy?: string;        // 修复模板 id
  repairedAt?: string;        // 修复时间 ISO
}

/** 内置标准断言定义（73 条原始标准映射） */
export interface AssertionDef {
  id: string;                 // SH-A001 起
  name: string;               // 对应原始 E2E 断言名
  file?: string;              // 主要归因文件（rootDir 相对路径，供缺陷溯源定位）
  check: () => boolean;       // 离线检查（只读源码/纯逻辑，不触业务库）
}

/** 修复模板定义 */
export interface RepairTemplate {
  id: string;                 // 如 TPL-L1
  name: string;               // 模板名
  category: string;           // 情绪收敛/TTL链路/GC扫描/人格冷却/模型档位/置信度
  target: string | string[];  // 目标文件（rootDir 相对路径）
  detect: (root: string, files: Record<string, string>) => string | null; // 返回缺陷现象，null=未命中
  apply: (src: string) => string;   // 安全修改：仅替换匹配代码段
  verify: (src: string) => boolean; // 修复后校验
  severity: DefectSeverity;
}

/** 单次自检报告 */
export interface SelfHealReport {
  runId: string;              // 自检轮次 id
  startedAt: string;
  finishedAt: string;
  assertionTotal: number;     // 执行的断言数
  assertionPassed: number;
  assertionFailed: number;
  defects: Defect[];          // 本次发现的缺陷（含未解决）
  autoRepaired: number;       // 自动修复成功数
  rollbackCount: number;      // 回滚次数
  healthScore: number;        // 0-100
  verdict: 'healthy' | 'degraded' | 'critical';
  isolated: boolean;          // 是否隔离环境执行
}

/** 历史自检记录（持久化行） */
export interface SelfHealRecord {
  runId: string;
  startedAt: string;
  defectCount: number;
  autoRepaired: number;
  rollbackCount: number;
  healthScore: number;
  verdict: string;
  summary: string;
}

/** 修复执行结果 */
export interface RepairExecution {
  defect: Defect;
  applied: boolean;
  appliedFile?: string;
  snapshotPath?: string;
  syntaxOk?: boolean;
  verifyOk?: boolean;
  rolledBack?: boolean;
  rollbackReason?: string;
  reloadApplied?: boolean;    // 热重载是否生效（false=建议重启进程）
}

/** 健康状态对外查询响应 */
export interface SystemHealthResponse {
  latestReport: SelfHealReport | null;
  openDefects: number;
  pendingAutoRepairs: number;
  history: SelfHealRecord[];
  healthScore: number;
  lastRunAt: string | null;
}
