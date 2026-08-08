// 阶段二·自诊疗模块 — 修复后回归 + 自动回滚
// 局部回归：单缺陷修复后，仅跑与该缺陷文件关联的断言子集（快速闭环）
// 全量回归：批量修复后跑全部内置断言
// 任一层回归失败 → 基于快照一键回滚并留痕（rollback.log）。
import fs from 'fs';
import path from 'path';
import { rollbackFromSnapshot, appendRollbackLog } from './editor';
import type { AssertionDef, Defect, RepairExecution } from './types';

export interface RegressionResult {
  total: number;
  passed: number;
  failed: string[];
}

/** 关联断言子集：命中缺陷文件的断言 id 列表（基于断言定义自带的 file 归因字段） */
export function relatedAssertionIds(assertions: AssertionDef[], defect: Defect): string[] {
  if (!defect.file) return [];
  return assertions.filter(a => a.file && (a.file === defect.file || defect.file.endsWith(a.file))).map(a => a.id);
}

function runSubset(assertions: AssertionDef[], ids: string[]): RegressionResult {
  let passed = 0;
  const failed: string[] = [];
  for (const a of assertions) {
    if (!ids.includes(a.id)) continue;
    try {
      if (a.check()) passed++;
      else failed.push(a.id);
    } catch {
      failed.push(a.id);
    }
  }
  return { total: ids.length, passed, failed };
}

/** 局部回归：单缺陷关联断言子集 */
export function runLocalRegression(assertions: AssertionDef[], defect: Defect): RegressionResult {
  return runSubset(assertions, relatedAssertionIds(assertions, defect));
}

/** 全量回归：全部内置断言 */
export function runFullRegression(assertions: AssertionDef[]): RegressionResult {
  const ids = assertions.map(a => a.id);
  return runSubset(assertions, ids);
}

/**
 * 修复执行后的统一回归入口：
 * 全部相关断言通过 → 返回 { ok: true }；有失败 → 自动回滚该修复（快照）并返回失败明细。
 */
export async function verifyAfterRepair(
  root: string,
  assertions: AssertionDef[],
  execution: RepairExecution,
  full = false,
): Promise<{ ok: boolean; result: RegressionResult; rolledBack: boolean }> {
  const defect = execution.defect;
  const result = full ? runFullRegression(assertions) : runLocalRegression(assertions, defect);
  if (result.failed.length > 0 && execution.snapshotPath) {
    const okRollback = rollbackFromSnapshot(root, defect.file, execution.snapshotPath);
    if (okRollback) {
      appendRollbackLog(root, defect.file, `回归失败（${result.failed.join(',')}）`, defect.id);
      // 标记缺陷回到未修复状态
      defect.resolved = false;
      defect.repairedBy = undefined;
      defect.repairedAt = undefined;
      return { ok: false, result, rolledBack: true };
    }
    return { ok: false, result, rolledBack: false };
  }
  if (result.failed.length > 0 && !execution.snapshotPath) {
    return { ok: false, result, rolledBack: false };
  }
  return { ok: result.failed.length === 0, result, rolledBack: false };
}

/** 依赖文件重读助手（修复后断言若读缓存需刷新时使用，当前断言直接读盘无需此步） */
export function touchFile(root: string, rel: string): void {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) fs.appendFileSync(abs, '');
}
