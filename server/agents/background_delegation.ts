import type { TaskComplexity } from './orchestrator';

/**
 * 【重构·模块1】后台分派判定移除全部正则池：
 * - BACKGROUND_REQUEST_PATTERNS（后台/异步/子agent 关键词）→ 由心智实体 entities.background 驱动（LLM 判定显式后台请求）
 * - STOCK_PATTERNS（股票关键词静态放行）→ 模块3：意图层静态市场识别移除，股票路由由心智依据工具自描述自主完成
 * 仅保留：模式策略配置（WORK_CATEGORY_ALLOWLIST 保留类别⑤）+ 结构化复杂度兜底。
 */

export interface BackgroundDelegationDecisionInput {
  text: string;
  /** 心智意图类别（LLM 判定） */
  category?: string;
  /** 结构化复杂度兜底（长度/列表/分句） */
  complexity: TaskComplexity;
  allowToolUse: boolean;
  sanctuary: boolean;
  availableAgentCount: number;
  /** 心智实体 entities.background==='true'：用户显式要求后台/异步处理 */
  explicitBackground?: boolean;
}

export interface BackgroundDelegationDecision {
  shouldDelegate: boolean;
  reason: string;
}

const WORK_CATEGORY_ALLOWLIST = new Set(['command', 'code', 'question', 'analysis']);

export function shouldDelegateWorkInBackground(input: BackgroundDelegationDecisionInput): BackgroundDelegationDecision {
  if (!input.text.trim()) return { shouldDelegate: false, reason: 'empty_text' };
  if (!input.allowToolUse) return { shouldDelegate: false, reason: 'tools_disabled' };
  if (input.sanctuary) return { shouldDelegate: false, reason: 'sanctuary_agent' };
  if (input.availableAgentCount < 1) return { shouldDelegate: false, reason: 'no_available_workers' };
  if (!WORK_CATEGORY_ALLOWLIST.has(input.category || '')) return { shouldDelegate: false, reason: 'non_work_category' };

  // 显式后台请求由心智实体判定（无正则文本猜测）
  if (input.explicitBackground) return { shouldDelegate: true, reason: 'explicit_background_preference' };
  if (input.complexity === 'complex' || input.complexity === 'moderate') {
    return { shouldDelegate: true, reason: `work_complexity_${input.complexity}` };
  }

  return { shouldDelegate: false, reason: 'simple_foreground_chat' };
}

/** 后台任务确认话术 — 数据化呈现（任务号/工作者名单来自真实执行上下文，无固定文案模板） */
export function buildDelegationAck(workerNames: string[], taskId: string): string {
  const names = workerNames.slice(0, 3).filter(Boolean);
  const workerPart = names.length > 0 ? `，由 ${names.join('、')} 处理` : '';
  return `后台任务已启动（任务号：${taskId}${workerPart}）。完成后我会推送阶段结果和最终结果。`;
}
