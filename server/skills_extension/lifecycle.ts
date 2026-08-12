// 阶段三·技能生命周期管理 — mcp_skill_store（元数据/来源/风险标记/成功率统计）
// 安装(install) / 启用(enable) / 禁用(disable) / 卸载(uninstall) / 调用结果回写(recordSkillCall)。
// 每次生命周期动作输出结构化事件日志 + skills_audit 审计，记录来源：
//   community（社区下载）/ registry（内置目录）/ api（第三方API）/ self_build（AI自主生成），
// 以及风险等级与成功率统计。mcp_skill_store 为独立表，不与任何旧业务表混杂。

import { logger } from '../lib/logger';
import {
  appendAudit, upsertSkillStoreEntry, updateSkillStoreStatus, updateSkillStoreStats,
  setSkillStoreStats, getSkillStoreEntry, listSkillStoreEntries, queryMetricStats,
} from './database';
import { logSkillEvent } from './switch';
import { classifyBuiltinToolRisk } from './risk_policy';
import { assertGlobalCap } from './breakers';
import type { SkillStoreEntry, SkillStoreSource } from './types';

export interface InstallSkillInput {
  toolName: string;
  version?: string;
  source: SkillStoreSource;
  origin?: string;
  riskLevel?: 'safe' | 'medium' | 'high';
  securityLevel?: string;
  complianceDomain?: string;
  needsCredential?: boolean;
  metadata?: Record<string, unknown>;
}

/** 安装登记：全局限额校验 → 入库（幂等 upsert）→ 审计 + 结构化日志 */
export async function installSkill(input: InstallSkillInput): Promise<{ ok: boolean; message: string; entry?: SkillStoreEntry }> {
  const cap = await assertGlobalCap();
  if (!cap.ok) {
    logger.warn(`[SkillsLifecycle] ${cap.reason}`);
    return { ok: false, message: cap.reason! };
  }
  await upsertSkillStoreEntry({
    toolName: input.toolName,
    version: input.version || '1.0.0',
    source: input.source,
    origin: input.origin || '',
    riskLevel: input.riskLevel || classifyBuiltinToolRisk('fallback-unknown-lifecycle-tool'),
    securityLevel: input.securityLevel || classifyBuiltinToolRisk('fallback-unknown-tool'),
    complianceDomain: input.complianceDomain || 'none',
    needsCredential: !!input.needsCredential,
    metadata: JSON.stringify(input.metadata || {}),
  });
  const entry = await getSkillStoreEntry(input.toolName);
  await appendAudit('install', input.toolName, `安装登记（来源=${input.source} 风险=${entry?.riskLevel || input.riskLevel || classifyBuiltinToolRisk('fallback-unknown-log-tool')} 版本=${input.version || '1.0.0'}）`);
  logSkillEvent({
    event: 'install', subject: input.toolName, ok: true,
    source: input.source, riskLevel: entry?.riskLevel || input.riskLevel, version: input.version || '1.0.0',
    detail: `来源=${input.source} 风险=${entry?.riskLevel || input.riskLevel || classifyBuiltinToolRisk('fallback-unknown-log-tool')}`,
  });
  logger.info(`[SkillsLifecycle] 安装登记: ${input.toolName}（来源 ${input.source} / 风险 ${entry?.riskLevel || input.riskLevel || classifyBuiltinToolRisk('fallback-unknown-log-tool')}）`);
  return { ok: true, message: `已登记 ${input.toolName} v${input.version || '1.0.0'}`, entry };
}

/** 生命周期状态变更：启用 / 禁用 / 卸载（卸载保留统计记录，status=uninstalled） */
export async function setSkillStatus(
  toolName: string,
  status: 'enabled' | 'disabled' | 'uninstalled',
  by = 'system',
): Promise<{ ok: boolean; message: string }> {
  const cur = await getSkillStoreEntry(toolName);
  if (!cur) return { ok: false, message: `工具 ${toolName} 未在技能库登记` };
  await updateSkillStoreStatus(toolName, status);
  await appendAudit(status, toolName, `生命周期变更（${by}）`);
  logSkillEvent({
    event: status, subject: toolName, ok: true,
    source: cur.source, riskLevel: cur.riskLevel, detail: `变更执行者: ${by}`,
  });
  logger.info(`[SkillsLifecycle] ${toolName} → ${status}（${by}）`);
  return { ok: true, message: `${toolName} → ${status}` };
}

/** 调用结果回写（成功/失败/超时 → mcp_skill_store 成功率统计；未登记工具静默跳过） */
export async function recordSkillCall(toolName: string, status: 'ok' | 'error' | 'timeout'): Promise<void> {
  const cur = await getSkillStoreEntry(toolName);
  if (!cur) return;
  await updateSkillStoreStats(toolName, status === 'ok');
  if (status !== 'ok') {
    logSkillEvent({
      event: 'call', subject: toolName, ok: false,
      source: cur.source, riskLevel: cur.riskLevel, detail: `调用${status}，失败累计+1`,
    });
  }
}

/**
 * P2-5 3-3：调用成功结构化事件（call-ok）。
 * 来源/风险标记从技能库（mcp_skill_store）读取补全；未登记（测试期/未部署）静默跳过。
 * 由适配器（社区路径）与沙箱宿主（自研路径）的成功分支以 fire-and-forget 方式调用。
 */
export async function logCallOkEvent(toolName: string): Promise<void> {
  const cur = await getSkillStoreEntry(toolName);
  if (!cur) return;
  logSkillEvent({
    event: 'call-ok', subject: toolName, ok: true,
    source: cur.source, riskLevel: cur.riskLevel,
    detail: `调用成功（来源=${cur.source} 风险=${cur.riskLevel}）`,
  });
}

/**
 * 从 tool_monitoring 重算成功率（巡检周期调用；tool_monitoring 为运行指标权威源，
 * mcp_skill_store 只做聚合统计，两者独立表，不混杂）。
 */
export async function syncCallStatsFromMonitoring(): Promise<number> {
  const entries = await listSkillStoreEntries();
  let updated = 0;
  for (const e of entries) {
    const s = await queryMetricStats(e.toolName);
    if (s.total === 0) continue;
    const okCount = s.total - s.errors - s.timeouts;
    await setSkillStoreStats(e.toolName, s.total, okCount);
    updated++;
  }
  if (updated > 0) logger.info(`[SkillsLifecycle] 成功率统计同步完成: ${updated} 个工具`);
  return updated;
}

export async function listInstalledSkills(): Promise<SkillStoreEntry[]> {
  return listSkillStoreEntries();
}
