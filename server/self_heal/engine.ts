// 阶段二·自诊疗模块 — 后台静默全域定时自检引擎（核心编排）
// 一轮自检：73 条内置断言离线执行 → 四类故障源检测 → 已知/未知分类（模板匹配）
//          → 自动修复（快照→语法检查→verify→失败回滚）→ 局部/全量回归 → 结构化报告 → 持久化。
// 隔离性：默认 rootDir=process.cwd()；E2E/手动注入可传隔离 rootDir（/tmp 副本），保证正式代码只读。
import fs from 'fs';
import path from 'path';
import { buildStandardAssertions } from './assertions';
import { scanAssertionFailures, scanRuntimeErrors, scanDeadCode, scanHardcodedConsts, classifyKnownDefects, locateLine, walkSourceTree } from './detector';
import { REPAIR_TEMPLATES } from './templates';
import { applyTemplateFix, checkSyntax, createSnapshot, rollbackFromSnapshot } from './editor';
import { runLocalRegression, runFullRegression, verifyAfterRepair, relatedAssertionIds } from './regression';
import { saveSelfHealRecord } from './store';
import type { Defect, RepairExecution, SelfHealReport } from './types';

export interface RunOptions {
  rootDir?: string;
  isolated?: boolean;           // 隔离环境执行（E2E）
  runtimeErrors?: Array<{ message: string; stack?: string }>;
  fullRegression?: boolean;     // 修复后是否跑全量回归（批量修复用）
}

export interface SelfHealResult extends SelfHealReport {
  repairLogs: RepairExecution[];
}

/** 待扫描源文件清单（全仓含根级文件，排除 self_heal 自身与快照/测试） */
function sourceFiles(root: string): string[] {
  return walkSourceTree(root);
}

/**
 * 健康评分：100 − Σ(P1:20 / P2:10 / P3:2，P3 提示项总扣分封顶 20)。
 * 已修复并回归通过的不扣分；未解决缺陷计入。
 */
export function computeHealthScore(defects: Defect[]): number {
  const unresolved = defects.filter(d => !d.resolved);
  let penalty = 0;
  let p3 = 0;
  for (const d of unresolved) {
    if (d.severity === 'P1') penalty += 20;
    else if (d.severity === 'P2') penalty += 10;
    else p3 += 1;
  }
  penalty += Math.min(p3, 20); // P3 提示项总扣分封顶 20，避免纯提示项误判 critical
  return Math.max(0, 100 - penalty);
}

export function judgeVerdict(score: number, defects: Defect[]): 'healthy' | 'degraded' | 'critical' {
  if (defects.some(d => d.severity === 'P1' && !d.resolved)) return 'critical';
  if (score < 90 || defects.some(d => d.severity === 'P2' && !d.resolved)) return 'degraded';
  if (defects.some(d => !d.resolved)) return 'degraded';
  return 'healthy';
}

/** 单轮自检（核心入口；调度器每日 3:00 与 /api/system/health-check 手动触发共用） */
export async function runSelfHeal(options: RunOptions = {}): Promise<SelfHealResult> {
  const root = options.rootDir || process.cwd();
  const isolated = !!options.isolated;
  const runId = `SH-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const startedAt = new Date().toISOString();
  const seq = { n: 1 };
  const repairLogs: RepairExecution[] = [];

  // 1. 内置标准断言离线执行
  const assertions = buildStandardAssertions(root);
  let assertionPassed = 0;
  const failedIds: string[] = [];
  for (const a of assertions) {
    let ok = false;
    try { ok = a.check(); } catch { ok = false; }
    if (ok) assertionPassed++; else failedIds.push(a.id);
  }

  // 2. 四类故障源检测
  const files = sourceFiles(root);
  const defects: Defect[] = [
    ...scanAssertionFailures(root, assertions, failedIds, seq),
    ...scanRuntimeErrors(root, options.runtimeErrors || [], seq),
    ...scanDeadCode(root, files, seq),
    ...scanHardcodedConsts(root, files, seq),
  ];

  // 3. 已知高频 bug 分类（模板匹配）
  classifyKnownDefects(defects, REPAIR_TEMPLATES, root);

  // 4. 自动修复（仅 known + autoRepairable）：快照→apply→语法检查→verify→失败回滚
  let autoRepaired = 0;
  const repairable = defects.filter(d => d.autoRepairable && !d.resolved && d.templateId);
  for (const d of repairable) {
    const tpl = REPAIR_TEMPLATES.find(t => t.id === d.templateId);
    if (!tpl) continue;
    const exec = applyTemplateFix(root, d, tpl);
    repairLogs.push(exec);
    if (exec.applied) {
      // 5a. 局部回归（关联断言子集）
      const reg = await verifyAfterRepair(root, assertions, exec, options.fullRegression);
      if (reg.ok) {
        autoRepaired++;
        // 全量断言层重验该缺陷相关条目（回归已含，此处仅计数）
      } else {
        repairLogs.push({
          defect: d,
          applied: false,
          appliedFile: exec.appliedFile,
          snapshotPath: exec.snapshotPath,
          rolledBack: reg.rolledBack,
          rollbackReason: reg.rolledBack ? `回归失败已回滚: ${reg.result.failed.join(',')}` : '回归失败且无快照可回滚',
        });
      }
    }
  }

  // 5b. 全量回归（修复后整体断言）
  const fullReg = runFullRegression(assertions);
  // 全量回归失败的（且未回滚）→ 提升告警
  for (const id of fullReg.failed) {
    const d = defects.find(x => x.symptom.includes(`标准断言 ${id} `));
    if (d && d.resolved) {
      d.resolved = false; // 修复被全量回归推翻
      d.repairedBy = undefined;
      d.repairedAt = undefined;
      // 快照回滚兜底（regression.verifyAfterRepair 已处理单点，此处处理批量）
      const exec = repairLogs.find(e => e.defect.id === d.id && e.applied && e.snapshotPath);
      if (exec?.snapshotPath && fs.existsSync(path.join(root, d.file))) {
        rollbackFromSnapshot(root, d.file, exec.snapshotPath);
      }
    }
  }

  const rollbackCount = repairLogs.filter(e => e.rolledBack).length + repairLogs.filter(e => e.rollbackReason && !e.applied).length;
  const healthScore = computeHealthScore(defects);
  const verdict = judgeVerdict(healthScore, defects);

  const report: SelfHealReport = {
    runId, startedAt,
    finishedAt: new Date().toISOString(),
    assertionTotal: assertions.length,
    assertionPassed,
    assertionFailed: assertions.length - assertionPassed,
    defects,
    autoRepaired,
    rollbackCount,
    healthScore,
    verdict,
    isolated,
  };

  // 6. 持久化（隔离环境仅落隔离库或跳过）
  if (!isolated) {
    try { await saveSelfHealRecord(report); } catch { /* 持久化失败不影响自检结果 */ }
  }

  return { ...report, repairLogs };
}

/** 断言子集统计（供回归层复用） */
export { relatedAssertionIds };

/** 手工触发入口（POST /api/system/health-check 使用） */
export async function manualTrigger(): Promise<SelfHealResult> {
  return runSelfHeal({ isolated: false });
}

/** 从 root 收集当前全部文件列表的便捷导出（供 E2E 断言使用） */
export function listSourceFiles(root: string): string[] {
  return sourceFiles(root);
}

export { checkSyntax, createSnapshot, rollbackFromSnapshot, locateLine };
