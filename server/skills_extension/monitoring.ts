// 阶段三·模块6a — 工具监控与自修复
// 监控维度：延迟 / 失败率 / 超时 / 用户负面情绪。
// 故障判定（数据驱动阈值，非固定话术）：
//   failureRate = (errors + timeouts) / total；样本 ≥ 5 且 failureRate > 0.5 → degraded（触发自修复）
// 自修复链路：复测（测试流水线）→ 有旧版本先回滚 → 仍失败 → 下线（unregister）+ 审计 + 记忆通知。
// 负面情绪联动：工具调用后用户表达不满（负向情绪事件）→ 标记该工具负面，纳入故障加权。

import { logger } from '../lib/logger';
import { toolRegistry } from '../tools/registry';
import { appendAudit, insertMetric, queryMetricStats, listMetricSummary } from './database';
import { rollbackTool, listAdapterVersions } from './adapter';
import { runTestPipeline, loadSandboxTool, makeSandboxRepair } from './test_pipeline';
import { listSandboxProjects } from './database';

export interface ToolHealthSnapshot {
  toolName: string;
  total: number;
  errors: number;
  timeouts: number;
  avgLatencyMs: number;
  negativeCount: number;
  failureRate: number;
  /** healthy / watch（样本不足或低故障）/ degraded（触发自修复） */
  verdict: 'healthy' | 'watch' | 'degraded';
}

export const FAULT_MIN_SAMPLES = 5;
export const FAULT_RATE_THRESHOLD = 0.5;

// ── 指标采集 ──

export async function recordToolResult(toolName: string, status: 'ok' | 'error' | 'timeout', latencyMs: number): Promise<void> {
  await insertMetric({ toolName, status, latencyMs, userNegative: -1 });
}

/** 用户负面情绪标记（来自情绪引擎/交互反馈） */
export async function recordUserNegative(toolName: string): Promise<void> {
  await insertMetric({ toolName, status: 'ok', latencyMs: 0, userNegative: 1 });
  await appendAudit('optimization', toolName, '用户负面情绪标记，纳入监控加权');
}

// ── 故障判定 ──

export async function getToolHealthSnapshot(toolName: string, hours = 24 * 7): Promise<ToolHealthSnapshot> {
  const s = await queryMetricStats(toolName, hours);
  const failureRate = s.total > 0 ? (s.errors + s.timeouts) / s.total : 0;
  let verdict: ToolHealthSnapshot['verdict'] = 'healthy';
  if (s.total < FAULT_MIN_SAMPLES) verdict = 'watch';
  else if (failureRate > FAULT_RATE_THRESHOLD) verdict = 'degraded';
  return {
    toolName,
    total: s.total,
    errors: s.errors,
    timeouts: s.timeouts,
    avgLatencyMs: s.avgLatencyMs,
    negativeCount: s.negativeCount,
    failureRate: Math.round(failureRate * 100) / 100,
    verdict,
  };
}

export async function listDegradedTools(): Promise<ToolHealthSnapshot[]> {
  const summary = await listMetricSummary();
  const snapshots: ToolHealthSnapshot[] = [];
  for (const s of summary) {
    if (s.errors + s.timeouts < FAULT_MIN_SAMPLES) continue;
    const total = s.errors + s.timeouts + 1; // listMetricSummary 不含 ok 计数 → 用快照重算
    const snap = await getToolHealthSnapshot(s.toolName);
    if (snap.total < FAULT_MIN_SAMPLES) continue;
    if (snap.failureRate > FAULT_RATE_THRESHOLD) snapshots.push(snap);
    void total;
  }
  return snapshots;
}

// ── 自修复 ──

export interface RemediationResult {
  toolName: string;
  action: 'rollback' | 'retest_ok' | 'removed' | 'no_action' | 'not_registered';
  detail: string;
}

/**
 * 自修复入口：degraded 工具 → 复测 → 回滚/下线。
 * 由 hooks.scheduler 巡检调用，也可由监控面板手动触发。
 */
export async function autoRemediate(toolName: string): Promise<RemediationResult> {
  const snap = await getToolHealthSnapshot(toolName);
  const fail = { toolName, action: 'no_action' as const, detail: '样本不足或未达故障阈值，无需修复' };
  if (snap.total < FAULT_MIN_SAMPLES || snap.failureRate <= FAULT_RATE_THRESHOLD) {
    return fail;
  }
  const registered = !!toolRegistry.get(toolName);
  if (!registered) {
    // 未注册但监控有故障 → 记录，不处置
    return { toolName, action: 'not_registered', detail: '工具未在工具池，跳过（仅记录）' };
  }

  // 1) 复测：能加载沙箱项目 → 重测；适配器工具 → 冒烟复测
  const project = (await listSandboxProjects()).find(p => p.serviceName === toolName && (p.status === 'approved' || p.status === 'testing'));
  if (project) {
    const tool = await loadSandboxTool(project.id);
    if (tool) {
      const report = await runTestPipeline(tool, { projectId: project.id, repair: makeSandboxRepair(project.id) });
      if (report.gatePassed) {
        await appendAudit('optimization', toolName, `故障复测通过（${report.passed}/${report.total}）`);
        return { toolName, action: 'retest_ok', detail: `复测 ${report.passed}/${report.total} 通过，维持在线` };
      }
    }
  }

  // 2) 有历史版本 → 回滚旧版本
  const versions = listAdapterVersions(toolName);
  if (versions.length >= 2) {
    const r = rollbackTool(toolName);
    if (r.ok) {
      await appendAudit('optimization', toolName, `故障率 ${snap.failureRate} 超标 → 自动回滚旧版本`);
      return { toolName, action: 'rollback', detail: r.message };
    }
  }

  // 3) 仍失败 → 下线（unregister）
  const removed = toolRegistry.unregister(toolName);
  if (removed) {
    await appendAudit('optimization', toolName, `故障率 ${snap.failureRate} 超标且复测失败 → 已下线`);
    logger.warn(`[SkillsMonitor] ${toolName} 因故障率 ${snap.failureRate} 已自动下线`);
    return { toolName, action: 'removed', detail: '复测失败且无旧版本可回滚 → 已从工具池下线' };
  }
  return { toolName, action: 'no_action', detail: '下线失败（工具状态异常）' };
}

/** 巡检全部故障工具（scheduler 每 5 分钟触发） */
export async function reapSkillFaults(): Promise<RemediationResult[]> {
  const degraded = await listDegradedTools();
  const results: RemediationResult[] = [];
  for (const d of degraded) {
    results.push(await autoRemediate(d.toolName));
  }
  if (results.length > 0) logger.info(`[SkillsMonitor] 巡检 ${results.length} 个故障工具完成`);
  return results;
}
