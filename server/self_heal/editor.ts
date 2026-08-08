// 阶段二·自诊疗模块 — TS 轻量源码编辑引擎
// 安全三原则：①只读校验先行（transpileModule 语法检查，无子进程）②定点修改仅替换指定代码段，禁止大规模重构
// ③修改前快照备份，单次修改后语法检查失败即自动回滚。
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { RepairTemplate, RepairExecution, Defect } from './types';

export interface SyntaxResult { ok: boolean; errors: string[] }

/** 语法检查：typescript.transpileModule 编译该单文件源码（不触碰其它文件/依赖） */
export function checkSyntax(src: string, fileName = 'mod.ts'): SyntaxResult {
  const out = ts.transpileModule(src, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    reportDiagnostics: true,
  });
  const diags = (out.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (diags.length === 0) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: diags.map(d => {
      const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start || 0) : null;
      return `${pos ? `行${pos.line + 1}` : ''} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    }),
  };
}

/** 快照目录（root/.self_heal_snapshots） */
export function snapshotDir(root: string): string {
  const dir = path.join(root, '.self_heal_snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 修改前快照：返回快照路径 */
export function createSnapshot(root: string, rel: string): string {
  const dir = snapshotDir(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapPath = path.join(dir, `${stamp}__${rel.split('/').join('_')}.bak`);
  fs.writeFileSync(snapPath, fs.readFileSync(path.join(root, rel), 'utf8'));
  return snapPath;
}

/** 基于快照一键回滚 */
export function rollbackFromSnapshot(root: string, rel: string, snapPath: string): boolean {
  const target = path.join(root, rel);
  if (!fs.existsSync(snapPath) || !fs.existsSync(target)) return false;
  fs.copyFileSync(snapPath, target);
  return true;
}

/** 回滚日志（持久化到 .self_heal_snapshots/rollback.log） */
export function appendRollbackLog(root: string, rel: string, reason: string, defectId: string): void {
  const dir = snapshotDir(root);
  const line = `${new Date().toISOString()} [回滚] ${defectId} ${rel} 原因: ${reason}\n`;
  fs.appendFileSync(path.join(dir, 'rollback.log'), line, 'utf8');
}

/**
 * 单缺陷执行模板修复：
 * 快照 → apply（仅替换匹配代码段）→ 语法检查 → verify（模板语义校验）→ 失败自动回滚。
 * 返回 RepairExecution（含 reloadApplied：文件层已生效；进程内热加载由 tsx 按需重载，属良性提示）。
 */
export function applyTemplateFix(
  root: string,
  defect: Defect,
  tpl: RepairTemplate,
): RepairExecution {
  const rel = defect.file;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    return { defect, applied: false, rollbackReason: '目标文件不存在' };
  }
  const src = fs.readFileSync(abs, 'utf8');
  const snap = createSnapshot(root, rel);
  let fixed: string;
  try {
    fixed = tpl.apply(src);
  } catch (e) {
    return { defect, applied: false, snapshotPath: snap, rollbackReason: `apply 抛出异常: ${(e as Error).message}` };
  }
  if (fixed === src) {
    return { defect, applied: false, snapshotPath: snap, rollbackReason: 'apply 未产生任何改动（模板与现状一致）' };
  }
  // ①语法检查
  const syntax = checkSyntax(fixed, path.basename(rel));
  if (!syntax.ok) {
    rollbackFromSnapshot(root, rel, snap);
    appendRollbackLog(root, rel, `语法检查失败: ${syntax.errors.join('; ')}`, defect.id);
    return { defect, applied: false, snapshotPath: snap, syntaxOk: false, rolledBack: true, rollbackReason: `语法检查失败: ${syntax.errors[0]}` };
  }
  // ②模板语义校验
  let verifyOk = true;
  try { verifyOk = tpl.verify(fixed); } catch { verifyOk = false; }
  if (!verifyOk) {
    rollbackFromSnapshot(root, rel, snap);
    appendRollbackLog(root, rel, `模板 verify 校验失败（修复未达到标准）`, defect.id);
    return { defect, applied: false, snapshotPath: snap, syntaxOk: true, verifyOk: false, rolledBack: true, rollbackReason: 'verify 校验失败' };
  }
  // ③写回（安全修改成功）
  fs.writeFileSync(abs, fixed, 'utf8');
  defect.resolved = true;
  defect.repairedBy = tpl.id;
  defect.repairedAt = new Date().toISOString();
  return {
    defect, applied: true, appliedFile: rel, snapshotPath: snap,
    syntaxOk: true, verifyOk: true, reloadApplied: true,
  };
}

/** 只读校验模式：仅检查模板能否命中 + 修复后语法是否可过，不写盘（E2E 模拟修复用） */
export function dryRunTemplateFix(root: string, rel: string, tpl: RepairTemplate): { detected: string | null; syntaxOk: boolean; verifyOk: boolean; changed: boolean } {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { detected: tpl.detect(root, { [rel]: '' }) ?? null, syntaxOk: false, verifyOk: false, changed: false };
  const src = fs.readFileSync(abs, 'utf8');
  const detected = tpl.detect(root, { [rel]: src });
  if (!detected) return { detected: null, syntaxOk: true, verifyOk: true, changed: false };
  const fixed = tpl.apply(src);
  const syntax = checkSyntax(fixed, path.basename(rel));
  let verifyOk = false;
  try { verifyOk = tpl.verify(fixed); } catch { verifyOk = false; }
  return { detected, syntaxOk: syntax.ok, verifyOk, changed: fixed !== src };
}
