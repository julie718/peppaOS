// 阶段三·模块5b — 人工审批闸门（批准 / 驳回修改 / 暂存 7 天清理）
//
// 闸门红线（指令安全红线）：所有工具上线必经自动化 E2E 测试 + 人工审批，
// 批准前工具不可进入工具池（ToolRegistry）；审批三选项：
//   批准（approved）      → 正式注册热加载上线（经注册版本栈管理，失败自动回滚）
//   驳回修改（rejected）  → 携带修改意见退回沙箱工坊（building），修复后重新测试审批
//   暂存（hold）          → 保持等待状态，7 天未决定自动过期清理（expired）

import { logger } from '../lib/logger';
import { toolRegistry } from '../tools/registry';
import type { SecurityLevel } from '../tools/types';
import { appendAudit, insertApproval, listApprovals, updateApproval, updateSandboxProject, listSandboxProjects } from './database';
import { commitStagedAdaptation, registerDefinition } from './adapter';
// 方案A（P1阻断项修复）：自研工具上线注册代理 handler，真实执行在隔离子进程（不再主进程 import 生成源码）
import { createIsolatedHandler, ensureSandboxBuilt } from './sandbox_isolate/sandbox_host';
import { assertGlobalCap } from './breakers';
import type { ApprovalRecord, ToolTestReport } from './types';

export const APPROVAL_EXPIRE_DAYS = 7;

export type ApprovalDecision = 'approved' | 'rejected' | 'hold';

// ── 提交审批（测试通过后进入） ──

export async function submitForApproval(
  projectId: number | null,
  toolName: string,
  report: ToolTestReport,
): Promise<{ ok: boolean; approvalId?: number; message: string }> {
  if (!report.gatePassed) {
    return { ok: false, message: `测试未达门槛（${report.passed}/${report.total}），不可提交审批` };
  }
  // 来源标识：沙箱项目用数字 id；适配器工具用 adapt:<toolName>（无沙箱项目）
  const ref = projectId !== null && projectId > 0 ? String(projectId) : `adapt:${toolName}`;
  const pending = await listApprovals('pending');
  if (pending.some(a => a.projectId === ref)) {
    return { ok: false, message: `已有待审批记录（${ref}）` };
  }
  const id = await insertApproval({
    toolName,
    projectId: ref,
    status: 'pending',
  });
  if (projectId !== null && projectId > 0) {
    await updateSandboxProject(projectId, { status: 'awaiting_approval' });
  }
  await appendAudit('approval', toolName, `来源 ${ref} 进入人工审批（测试 ${report.passed}/${report.total}）`);
  logger.info(`[SkillsApproval] ${toolName} 进入人工审批（#${id}，来源 ${ref}）`);
  return { ok: true, approvalId: id, message: `已提交审批 #${id}` };
}

// ── 审批决策（三选项） ──

export interface DecideResult {
  ok: boolean;
  status: ApprovalRecord['status'];
  message: string;
}

/**
 * 人工审批决策入口。
 * @param decision approved（批准上线）/ rejected（驳回修改，附意见）/ hold（暂存）
 */
export async function decideApproval(
  approvalId: number,
  decision: ApprovalDecision,
  decidedBy: string,
  rejectReason = '',
): Promise<DecideResult> {
  const rec = await getApproval(approvalId);
  if (!rec) return { ok: false, status: 'pending', message: `审批记录 #${approvalId} 不存在` };
  if (rec.status !== 'pending') return { ok: false, status: rec.status, message: `审批记录 #${approvalId} 已处理（${rec.status}）` };

  const project = (await listSandboxProjects()).find(p => p.id === Number(rec.projectId));

  switch (decision) {
    case 'approved': {
      // 全局限额熔断：累计安装量达上限（mcp_skill_store 持久计数）→ 拒绝部署
      const cap = await assertGlobalCap();
      if (!cap.ok) {
        return { ok: false, status: 'pending', message: `部署被全局限额熔断拦截：${cap.reason}` };
      }
      // 批准 → 正式上线：注册到工具池（版本栈管理）
      // 来源分流：projectId='adapt:<tool>' 为适配器暂存工具；数字为沙箱自研项目
      const deployed = rec.projectId.startsWith('adapt:')
        ? commitStagedAdaptation(rec.projectId.slice('adapt:'.length))
        : await deploySandboxTool(Number(rec.projectId), rec.toolName);
      if (!deployed.ok) {
        return { ok: false, status: 'rejected', message: `批准但部署失败：${deployed.message}（请驳回修改后重试）` };
      }
      await updateApproval(approvalId, { status: 'approved', decidedBy, decidedAt: new Date().toISOString() });
      await appendAudit('approve', rec.toolName, `审批通过（${decidedBy}）→ ${deployed.message}`);
      logger.info(`[SkillsApproval] ✅ ${rec.toolName} 人工审批通过（${decidedBy}）`);
      return { ok: true, status: 'approved', message: `已批准并上线 ${rec.toolName}（${deployed.message}）` };
    }

    case 'rejected': {
      // 驳回修改 → 退回沙箱工坊（building），携带修改意见
      if (!rejectReason) return { ok: false, status: 'pending', message: '驳回必须附修改意见' };
      if (project) await updateSandboxProject(project.id, { status: 'building', pendingReason: `驳回意见：${rejectReason}` });
      await updateApproval(approvalId, { status: 'rejected', decidedBy, rejectReason, decidedAt: new Date().toISOString() });
      await appendAudit('reject', rec.toolName, `审批驳回（${decidedBy}）：${rejectReason}`);
      logger.info(`[SkillsApproval] ❌ ${rec.toolName} 审批驳回（${decidedBy}）：${rejectReason}`);
      return { ok: true, status: 'rejected', message: `已驳回，意见「${rejectReason}」，项目退回工坊修复` };
    }

    case 'hold': {
      // 暂存 → 保持等待；7 天未决定由过期清理兜底
      await appendAudit('approval', rec.toolName, `暂存待决定（${decidedBy}），${APPROVAL_EXPIRE_DAYS} 天内未决定将自动过期清理`);
      logger.info(`[SkillsApproval] ⏸ ${rec.toolName} 暂存（${decidedBy}）`);
      return { ok: true, status: 'pending', message: `已暂存，${APPROVAL_EXPIRE_DAYS} 天内未决定自动过期清理` };
    }
  }
}

// ── 上线部署（沙箱自研工具：编译校验 → 代理 handler 注册版本栈；方案A 隔离执行） ──

async function deploySandboxTool(projectId: number, toolName: string): Promise<{ ok: boolean; message: string }> {
  // 主进程只做 tsc 编译校验（产物落盘沙箱目录 dist/index.mjs），绝不 import 生成源码；
  // 注册进 ToolRegistry 的 handler 是 IPC 代理 —— 运行时代码在隔离子进程内执行。
  const built = await ensureSandboxBuilt(projectId);
  if (!built.ok) return { ok: false, message: `沙箱源码编译失败：${built.message || '未知错误'}` };
  // P2-2：继承创建阶段风险分级（createSandboxProject 持久化的 realRiskLevel），
  // 存入 mcp_skill_store.securityLevel；不再硬编码 'safe'。旧项目无该字段时回退 'safe'。
  const project = (await listSandboxProjects()).find(p => p.id === projectId);
  const realRiskLevel = project?.riskLevel || 'safe';
  const def = {
    name: toolName,
    description: toolName,
    parameters: {},
    handler: createIsolatedHandler(projectId, toolName),
    permission: 'public' as const,
    // P2-8：安全级别直接继承创建阶段 realRiskLevel（safe/medium/high），不再写死 'safe'，
    // 与下方 meta.securityLevel 入库口径一致，避免内存对象与数据库展示失真。
    // Registry 运行语义不变：仅 'confirm'/'forbidden' 触发确认/禁用，其余按原安全级别放行。
    securityLevel: realRiskLevel as SecurityLevel,
  };
  const r = registerDefinition(toolName, def, '1.0.0', {
    name: toolName,
    serviceName: toolName,
    securityLevel: realRiskLevel,
    source: 'sandbox',
    origin: `沙箱自研（项目 #${projectId}）`,
  });
  if (!r.ok) return { ok: false, message: r.message };
  await updateSandboxProject(projectId, { status: 'approved' });
  return { ok: true, message: r.message };
}

// ── 查询 ──

export async function getApproval(id: number): Promise<ApprovalRecord | undefined> {
  return (await listApprovals()).find(a => a.id === id);
}

export async function listPendingApprovals(): Promise<ApprovalRecord[]> {
  return listApprovals('pending');
}

// ── 7 天过期清理（scheduler 巡检调用） ──

export async function expireStaleApprovals(maxAgeDays = APPROVAL_EXPIRE_DAYS): Promise<number> {
  const pending = await listApprovals('pending');
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  let cleaned = 0;
  for (const a of pending) {
    const created = new Date(a.createdAt.replace(' ', 'T') + 'Z').getTime();
    if (!isNaN(created) && created < cutoff) {
      await updateApproval(a.id, { status: 'expired', decidedAt: new Date().toISOString() });
      const project = (await listSandboxProjects()).find(p => p.id === Number(a.projectId));
      if (project) await updateSandboxProject(project.id, { status: 'expired' });
      await appendAudit('expire_cleanup', a.toolName, `审批 #${a.id} 超过 ${maxAgeDays} 天未决定，已过期清理`);
      cleaned++;
    }
  }
  if (cleaned > 0) logger.info(`[SkillsApproval] 过期清理 ${cleaned} 条待审批（>${maxAgeDays} 天）`);
  return cleaned;
}

/** 安全验证辅助：检查工具是否已进入工具池 */
export function isInToolPool(toolName: string): boolean {
  return !!toolRegistry.get(toolName);
}
