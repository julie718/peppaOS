// 阶段三·模块2 — 心智技能决策维度（对接 innerTick 输出）
// innerTick 心智输出增加技能决策三维度：
//   ① 当前任务是否需要工具（needsTool）
//   ② 社区/注册表是否存在成熟可用 MCP（hasMatureMcp）
//   ③ 结论：复用现有技能（reuse）/ 修改已有技能（modify）/ 从零自研新工具（self_build）
// 决策结果封装为 MentalEventItem（eventType=skill_decision）经 runInnerTick 注入心智推演，
// 与 gap_detector.persistGapReasoning 同一落库通道（受 MIND_SWITCH 开关控制）。
// 优先级锁定：reuse > modify > self_build —— 只有网上无成熟可用方案时才允许自研。

import { logger } from '../lib/logger';
import { runInnerTick } from '../../src/core/innerTick';
import type { MentalEventItem } from '../../src/types/innerTickSchema';
import { MIND_SWITCH } from '../../src/config/mindSwitch';
import { searchAndDecide } from './search_engine';
import { appendAudit } from './database';
import { logSkillEvent } from './switch';

export type SkillConclusion = 'reuse' | 'modify' | 'self_build';

export interface SkillDecision {
  /** ① 当前任务是否需要工具 */
  needsTool: boolean;
  /** ② 是否存在社区成熟可用 MCP（七维达标候选） */
  hasMatureMcp: boolean;
  /** ③ 结论：复用 / 修改 / 自研（优先级锁定：reuse > modify > self_build） */
  conclusion: SkillConclusion;
  reasons: string[];
  eligibleCount: number;
  totalCandidates: number;
  assessedAt: string;
}

/** 任务是否需要工具（需求句式统计先验，非意图正则；无匹配时保守返回 false） */
function inferNeedsTool(task: string): boolean {
  if (!task) return false;
  const signals = /(查|查一下|看看|获取|最新|行情|价格|汇率|新闻|翻译|搜索|有什么|帮我找|能不能|有没有.*工具|报告|论文|天气|股票|基金|油价|电影|比分)/;
  return signals.test(task);
}

/**
 * 技能决策主入口：检索评估（复用七维引擎）→ 三维度决策 → 心智事件落库。
 * 判定规则（优先级不可颠倒）：
 *   - 存在七维全面达标（全部 ≥0.7）候选 → reuse（复用现有技能）
 *   - 存在达标但薄弱维度（0.6 ≤ 维度 < 0.7）候选 → modify（修改/适配已有技能）
 *   - 无合格候选 → self_build（自研兜底，且触发自研前置条件检查）
 */
export async function decideSkillForTask(
  task: string,
  keywords: string[],
  ctx: { userId?: string; sessionId?: string } = {},
): Promise<SkillDecision> {
  const result = await searchAndDecide(keywords);
  const eligible = result.eligible;
  const needsTool = inferNeedsTool(task);

  let conclusion: SkillConclusion;
  const reasons: string[] = [];
  if (eligible.length > 0) {
    const weak = eligible.filter(c => Object.values(c.scores).some(v => v < 0.7));
    if (weak.length > 0) {
      conclusion = 'modify';
      reasons.push(`存在 ${weak.length} 个达标但薄弱（维度<0.7）候选，走修改已有技能（适配改造）`);
      reasons.push(`薄弱候选: ${weak.map(w => `${w.name}(${Object.entries(w.scores).filter(([, v]) => v < 0.7).map(([k]) => k).join(',')})`).join('; ')}`);
    } else {
      conclusion = 'reuse';
      reasons.push(`存在 ${eligible.length} 个七维全面达标的成熟工具，按顶层规则优先复用`);
    }
  } else {
    conclusion = 'self_build';
    reasons.push('全网检索无七维达标的成熟工具，仅此时才允许走自研兜底（复用 > 自研优先级未颠倒）');
  }
  reasons.push(`需要工具=${needsTool}，成熟MCP=${eligible.length > 0}，候选${result.all.length}（淘汰${result.disqualified.length}）`);

  const decision: SkillDecision = {
    needsTool,
    hasMatureMcp: eligible.length > 0,
    conclusion,
    reasons,
    eligibleCount: eligible.length,
    totalCandidates: result.all.length,
    assessedAt: new Date().toISOString(),
  };

  await emitSkillDecisionToMind(decision, {
    task, keywords, userId: ctx.userId || 'default', sessionId: ctx.sessionId,
  });
  return decision;
}

/** 决策封装为心智事件 → runInnerTick 统一落库（与 gap_reasoning 同一通道；失败仅告警不阻断） */
export async function emitSkillDecisionToMind(
  decision: SkillDecision,
  context: { task: string; keywords: string[]; userId: string; sessionId?: string },
): Promise<void> {
  const auditDetail = `技能决策 ${decision.conclusion}（候选${decision.totalCandidates} 达标${decision.eligibleCount} needsTool=${decision.needsTool}）`;
  if (!MIND_SWITCH.enableOldIdleBrain) {
    await appendAudit('assess', context.keywords.join(','), auditDetail);
    logSkillEvent({ event: 'assess', subject: context.keywords.join(','), ok: true, source: 'mind', detail: `${auditDetail}（心智事件写入受开关控制，跳过）` });
    return;
  }
  try {
    const evt: MentalEventItem = {
      source: 'skills_extension',
      eventType: 'skill_decision',
      brief: `技能决策：${context.keywords.join('/')} → ${decision.conclusion}`,
      payload: {
        content: `技能决策复盘：任务「${context.task.slice(0, 120)}」需要工具=${decision.needsTool}，社区成熟MCP=${decision.hasMatureMcp}，结论=${decision.conclusion}。判断依据：${JSON.stringify(decision.reasons)}`,
        keywords: ['技能决策', '技能拓展', ...context.keywords],
        type: 'fact',
        tier: 'growth',
        perspective: 'owner_trait',
        importance: 0.45,
      },
    };
    // 与 gap_detector 同模式：fire-and-forget + 捕获告警，绝不影响调用方主流程
    void runInnerTick({ userId: context.userId, derivedMentalEvents: [evt] }).catch((e: any) =>
      logger.warn(`[SkillsDecision] 技能决策心智事件派发失败: ${e?.message || e}`),
    );
    await appendAudit('assess', context.keywords.join(','), auditDetail);
    logSkillEvent({
      event: 'assess', subject: context.keywords.join(','), ok: true, source: 'mind',
      detail: `${auditDetail}，已注入 innerTick 心智推演`,
    });
  } catch (e: any) {
    logger.warn(`[SkillsDecision] 技能决策落库失败: ${e.message}`);
  }
}
