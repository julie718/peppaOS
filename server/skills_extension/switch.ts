// 阶段三·总开关 / 熔断阈值 / 风险策略 / 结构化事件日志
// 全模块唯一配置源。PEPPA_PHASE3_SKILL_AUTO_ENABLE=false 时整套 Phase3 能力
// （检索 / 评估 / 沙箱生成 / 审批上线 / 监控自修复 / 例行巡检 / 全部路由）一键停用。
// 默认 true：与任务指令一致（默认开启，可用环境变量一键关闭）。

import { logger } from '../lib/logger';

export interface Phase3Config {
  /** 总开关：一键关闭整套 Phase3（PEPPA_PHASE3_SKILL_AUTO_ENABLE，默认 true） */
  enabled: boolean;
  /** 单会话熔断窗口内最大新增工具数量（PEPPA_PHASE3_MAX_TOOLS_PER_SESSION，默认 10） */
  maxToolsPerSession: number;
  /** 熔断统计窗口分钟数（PEPPA_PHASE3_BREAKER_WINDOW_MINUTES，默认 60） */
  breakerWindowMinutes: number;
  /** 全局限额：累计安装工具上限（PEPPA_PHASE3_GLOBAL_MAX_TOOLS，默认 30） */
  globalMaxTools: number;
  /** 风险策略：strict=高风险拦截部署+中风险告警；warn=全部放行仅告警（默认 strict） */
  riskPolicy: 'strict' | 'warn';
  /** 结构化事件日志开关（PEPPA_PHASE3_STRUCTURED_LOG，默认 true） */
  structuredLog: boolean;
}

function parseBool(v: string | undefined, dft: boolean): boolean {
  if (v === undefined || v === '') return dft;
  return v.toLowerCase() !== 'false' && v !== '0';
}

function parseIntSafe(v: string | undefined, dft: number): number {
  const n = Number.parseInt(v || '', 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}

/** 从环境变量加载全部 Phase3 配置 */
export function loadPhase3Config(): Phase3Config {
  const e = process.env;
  return {
    enabled: parseBool(e.PEPPA_PHASE3_SKILL_AUTO_ENABLE, true),
    maxToolsPerSession: parseIntSafe(e.PEPPA_PHASE3_MAX_TOOLS_PER_SESSION, 10),
    breakerWindowMinutes: parseIntSafe(e.PEPPA_PHASE3_BREAKER_WINDOW_MINUTES, 60),
    globalMaxTools: parseIntSafe(e.PEPPA_PHASE3_GLOBAL_MAX_TOOLS, 30),
    riskPolicy: e.PEPPA_PHASE3_RISK_POLICY === 'warn' ? 'warn' : 'strict',
    structuredLog: parseBool(e.PEPPA_PHASE3_STRUCTURED_LOG, true),
  };
}

let _cfg: Phase3Config | null = null;

/** 读取配置（惰性缓存；测试/运维可通过 loadPhase3Config 重新装载） */
export function phase3Config(): Phase3Config {
  if (!_cfg) _cfg = loadPhase3Config();
  return _cfg;
}

/** 总开关查询：整套 Phase3 是否启用 */
export function isPhase3Enabled(): boolean {
  return phase3Config().enabled;
}

/** 测试/运维用：清空惰性缓存，下次 phase3Config() 重新读取环境变量 */
export function resetPhase3SwitchCache(): void {
  _cfg = null;
}

export interface SkillEventPayload {
  /** 事件名：search / assess / risk_assess / install / generate / call / enable / disable / uninstall / upgrade / rollback / breach / blocked */
  event: string;
  /** 对象（工具名 / 缺口关键词 / 项目） */
  subject: string;
  ok: boolean;
  /** 来源：community（社区下载）/ registry（内置目录）/ api（第三方API）/ self_build（AI自主生成） */
  source?: string;
  /** 风险标记：safe / medium / high */
  riskLevel?: string;
  version?: string;
  detail?: string;
}

/**
 * 结构化事件日志：每一次 检索 / 评估 / 安装 / 生成 / 调用 / 卸载 = 一条 JSON 事件行。
 * 记录来源（社区下载 / AI自主生成）、风险等级、成功与否。开关 PEPPA_PHASE3_STRUCTURED_LOG 可关。
 */
export function logSkillEvent(p: SkillEventPayload): void {
  if (!phase3Config().structuredLog) return;
  const line = JSON.stringify({ phase3: true, ts: new Date().toISOString(), ...p });
  if (p.ok) logger.info(`[SkillsEvent] ${line}`);
  else logger.warn(`[SkillsEvent] ${line}`);
}
