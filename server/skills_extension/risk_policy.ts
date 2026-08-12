// 阶段三·风险分级与部署拦截
// 安全红线落地：① 高风险技能直接拦截、禁止部署；② 中风险记录日志告警；
// ③ 检索阶段对社区命中的高风险标记（恶意/后门/凭证窃取类）先行过滤，不进候选。
// 分级为确定性规则（非 LLM），与七维评估正交：七维管"好不好用"，本模块管"能不能用"。

import { logger } from '../lib/logger';
import { phase3Config, logSkillEvent } from './switch';
// P2-3：风险等级单一来源统一到 types.ts（本模块引入使用并再导出，保持既有 import 兼容）
import type { RiskLevel } from './types';
export type { RiskLevel };
// 静态内置工具（server/tools/definitions）映射到注册表安全级别所需类型（仅类型引用，编译期擦除，无运行时依赖）
import type { SecurityLevel } from '../tools/types';

export interface RiskInput {
  /** 适配/沙箱模板既有字段：safe / confirm / high */
  securityLevel?: string;
  /** 来源：registry / community / api / self_build */
  source?: string;
  /** 描述 / 仓库地址 / 接口地址（扫描高风险标记） */
  origin?: string;
  needsCredential?: boolean;
  /** 合规域：finance / medical / none */
  complianceDomain?: string;
}

/** 高风险文本标记（社区检索元数据命中即过滤/拦截；双语言覆盖常见恶意描述） */
const HIGH_RISK_MARKERS = [
  // 恶意/后门/凭证窃取类（英文）
  'exploit', 'hacking', 'cracked', 'credential dump', 'credential harvesting',
  'steal', 'bypass security', 'undetectable', 'phishing', 'keylogger',
  'malware', 'rootkit', 'backdoor', 'spyware', 'cheat engine', 'token grabber',
  'password dump', 'botnet', 'rat payload', 'crypto miner', 'credential-stealing',
  // 中文恶意描述
  '注入', '破解', '盗取', '免杀', '远控', '后门', '木马', '钓鱼', '撞库', '脱库',
];

/** 文本是否命中高风险标记 */
export function hasHighRiskMarker(text: string): boolean {
  const t = (text || '').toLowerCase();
  return HIGH_RISK_MARKERS.some(m => t.includes(m));
}

/** 社区命中预过滤：命中高风险标记 → 不进入候选（检索阶段即拦截） */
export function isHighRiskCommunityHit(hit: { name: string; description?: string; repoUrl?: string }): boolean {
  return hasHighRiskMarker(`${hit.name} ${hit.description || ''} ${hit.repoUrl || ''}`);
}

/**
 * 风险分级（确定性规则）：
 *   high   — 显式高危声明（securityLevel=high）或来源文本含高风险标记
 *   medium — 需外部密钥且未声明合规域（来源信息不足的付费接口）；社区来源且无可追溯来源
 *   safe   — 其余
 */
/**
 * 静态内置工具风险计算辅助（server/tools/definitions 统一使用，替代字面量硬编码 securityLevel）：
 * 复用 classifyRisk 确定性分级逻辑，依据工具描述文本 + 能力标签自动计算风险等级。
 * classifyRisk 产出 RiskLevel（safe/medium/high），映射为注册表 SecurityLevel（safe/confirm/forbidden）：
 *   safe   → 'safe'      （自动执行）
 *   medium → 'confirm'   （需用户确认：能力标签含 credential 等中风险信号）
 *   high   → 'forbidden' （高风险标记命中：拦截禁用）
 * 注意：本函数仅用于"静态内置工具定义"的风险分级；沙箱生成 / 审批入库 / 运行时链路仍走 assertDeployAllowed。
 */
export function classifyBuiltinToolRisk(description: string, tags: string[] = []): SecurityLevel {
  const { level } = classifyRisk({
    securityLevel: undefined,
    source: 'builtin',
    origin: description,
    needsCredential: tags.includes('credential'),
    complianceDomain: 'none',
  });
  return level === 'high' ? 'forbidden' : level === 'medium' ? 'confirm' : 'safe';
}

export function classifyRisk(input: RiskInput): { level: RiskLevel; reason: string } {
  if (input.securityLevel === 'high' || hasHighRiskMarker(input.origin || '')) {
    return { level: 'high', reason: `显式高危声明或高风险标记：${(input.origin || '').slice(0, 80)}` };
  }
  if (input.needsCredential && (input.complianceDomain || 'none') === 'none') {
    return { level: 'medium', reason: '需外部密钥且未声明合规域（来源信息不足，中风险告警）' };
  }
  if (input.source === 'community' && !input.origin) {
    return { level: 'medium', reason: '社区来源且无可追溯来源信息（中风险告警）' };
  }
  return { level: 'safe', reason: '无高危声明、来源可追溯' };
}

export interface DeployGuardResult {
  ok: boolean;
  blocked: boolean;
  level: RiskLevel;
  reason: string;
}

/**
 * 部署闸门（适配暂存 / 版本升级 / 沙箱生成 共用）：
 *   strict（默认）：high → 拦截（拒绝暂存/生成）；medium → 放行但告警记录
 *   warn：high/medium 全部放行，仅告警记录
 */
export function assertDeployAllowed(input: RiskInput): DeployGuardResult {
  const { level, reason } = classifyRisk(input);
  const policy = phase3Config().riskPolicy;
  const blocked = level === 'high' && policy === 'strict';
  const result: DeployGuardResult = blocked
    ? { ok: false, blocked: true, level, reason: `高风险技能被拦截（风险策略=${policy}）：${reason}` }
    : { ok: true, blocked: false, level, reason };
  if (level !== 'safe' || blocked) {
    logger.warn(`[SkillsRisk] 风险分级=${level}（${reason}）→ ${blocked ? '拦截部署' : '告警放行'} | 对象: ${(input.origin || '(unknown)').slice(0, 60)}`);
    logSkillEvent({
      event: 'risk_assess', subject: input.origin || '(unknown)', ok: !blocked,
      source: input.source, riskLevel: level, detail: result.reason,
    });
  }
  return result;
}
