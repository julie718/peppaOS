// 阶段三·模块6b — 双向联动（与主系统只读/旁挂集成，不修改阶段一/二文件）
//
// 方向一（阶段三 → 主系统）：
//   1. health-board 技能健康面板（独立端点 /api/skills/health-board，供健康页并排展示）
//   2. Idle 月度自省简报：每月 3 点生成「技能拓展月度简报」写入长期记忆，
//      阶段二 IdleBrain 月度自省时自然读到（联动而不侵入）
// 方向二（主系统 → 阶段三）：
//   3. 月度缺口复评：每月自省周期内重新执行缺口识别 + 检索评估
//   4. 故障巡检：scheduler 每 5 分钟对故障工具执行自修复
//   5. 跨轮记忆复用：查询技能相关长期记忆（复盘依据）

import { addMemory, queryMemories } from '../memory/store';
import { logger } from '../lib/logger';
import { appendAudit, listAudit, listSandboxProjects, listMetricSummary } from './database';
import { getAdaptedLedger } from './adapter';
import { getBillingStats } from './auth_gateway';
import { planSkillExtension } from './gap_detector';
import { searchAndDecide } from './search_engine';
import { reapSkillFaults } from './monitoring';
import type { SkillsHealthBoard } from './types';

// ── 技能健康面板（M6：health-check 扩展面板） ──

export async function buildSkillsHealthBoard(): Promise<SkillsHealthBoard> {
  const [projects, ledger, billing, audit, faults] = await Promise.all([
    listSandboxProjects(),
    Promise.resolve(getAdaptedLedger()),
    getBillingStats(),
    listAudit(30),
    listMetricSummary(),
  ]);
  return {
    sandboxPending: projects
      .filter(p => p.status === 'building' || p.status === 'testing' || p.status === 'awaiting_approval')
      .map(p => ({ id: p.id, keyword: p.keyword, serviceName: p.serviceName, status: p.status, createdAt: p.createdAt })),
    toolLedger: ledger.map(l => ({ toolName: l.name, source: l.source, deployedAt: l.deployedAt, version: l.version })),
    apiBilling: billing,
    skillHistory: audit,
    faultStats: faults.map(f => ({ toolName: f.toolName, errors: f.errors, timeouts: f.timeouts, avgLatencyMs: f.avgLatencyMs })),
    gapSummary: [],
  };
}

// ── Idle 月度自省简报（技能拓展月度简报 → 长期记忆） ──

export async function generateSkillsMonthlyBrief(): Promise<string> {
  const [board, gaps] = await Promise.all([buildSkillsHealthBoard(), planSkillExtension()]);
  const brief = [
    `【技能拓展月度自省】`,
    `- 工具池技能 ${board.toolLedger.length} 个（来源：${board.toolLedger.map(t => t.source).join('/')}）`,
    `- 沙箱工坊进行中 ${board.sandboxPending.length} 个（${board.sandboxPending.map(p => `${p.serviceName}(${p.status})`).join('、') || '无'}）`,
    `- 待审批 ${board.sandboxPending.filter(p => p.status === 'awaiting_approval').length} 个`,
    `- 月度 API 调用计费 ${board.apiBilling.map(b => `${b.serviceName}≈¥${b.costEstimate}`).join('、') || '无付费调用'}`,
    `- 故障监控：${board.faultStats.length > 0 ? board.faultStats.map(f => `${f.toolName}(错${f.errors} 超${f.timeouts} 均${f.avgLatencyMs}ms)`).join('、') : '全部健康'}`,
    `- 新识别能力缺口 ${gaps.length} 个：${gaps.map(g => `${g.gap.keyword}×${g.gap.frequency}`).join('、') || '无'}`,
  ].join('\n');

  try {
    // Phase3‑LEGACY‑MEMORY：遗留旧心智写入，待后续彻底迁移
    addMemory({
      userId: 'default',
      content: brief,
      type: 'fact',
      keywords: ['技能拓展', '月度自省'],
      confidence: 0.8,
      sourceInteractionId: '',
    }, { tier: 'internalized', perspective: 'owner_trait', importance: 0.4 });
  } catch (e: any) {
    logger.warn(`[SkillsHooks] 月度简报写入记忆失败: ${e.message}`);
  }
  await appendAudit('optimization', 'monthly_brief', `月度技能简报已生成（工具${board.toolLedger.length} 缺口${gaps.length}）`);
  return brief;
}

// ── 月度缺口复评（Idle 自省联动：重新识别 + 检索评估） ──

export async function runMonthlyGapReview(): Promise<{
  gaps: number;
  decision: 'reuse' | 'self_build';
  searchedKeywords: string[];
}> {
  const planned = await planSkillExtension();
  const active = planned.slice(0, 3); // 每期最多复评 3 个高频缺口
  const keywords = active.map(p => p.gap.keyword);
  let decision: 'reuse' | 'self_build' = 'self_build';
  if (keywords.length > 0) {
    const result = await searchAndDecide(keywords);
    decision = result.decision;
  }
  await appendAudit('gap_detected', 'monthly_review', `复评缺口 ${active.length} 个，路径决策 ${decision}`);
  return { gaps: active.length, decision, searchedKeywords: keywords };
}

// ── 跨轮记忆复用（查询技能相关长期记忆，供规划复盘） ──

export function recallSkillMemories(limit = 10): Array<{ content: string; tier: string }> {
  try {
    return queryMemories({ userId: 'default', limit, noTouch: true })
      .filter(m => (m.content || '').includes('技能拓展') || (m.content || '').includes('能力缺口') || (m.content || '').includes('工具调用复盘'))
      .map(m => ({ content: m.content || '', tier: m.tier }));
  } catch {
    return [];
  }
}

// ── 接线辅助（由 index.ts 调用） ──

export async function startSkillsRoutines(): Promise<void> {
  // 启动时巡检一次（故障工具在服务重启后立即处置）
  reapSkillFaults().catch(() => {});
  logger.info('[SkillsHooks] 技能拓展例行巡检已启动');
}
