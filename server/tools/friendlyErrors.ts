// server/tools/friendlyErrors.ts
// Phase2 模块6：MCP/Skill 异常统一友好化 — 铁则3
// 任何工具 handler 抛出的原始错误：完整堆栈/内部路径/密钥只进服务日志；
// 调用方（LLM 上下文 / 用户）只接触业务友好文案，绝不接触原始 error.message 或堆栈。
// 接入点：registry.execute —— 所有工具调用路径（socket chat / REST / voice / workflow）统一生效。

import { logger } from '../lib/logger';

export interface FriendlyToolError extends Error {
  /** 业务友好文案（唯一允许对外输出的信息） */
  friendly: string;
  /** 错误分类：timeout | network | quota | permission | validation | generic */
  category: string;
}

const CATEGORY_RULES: Array<{ category: string; patterns: RegExp[]; friendly: string }> = [
  {
    category: 'timeout',
    patterns: [/abort/i, /timed?\s*out/i, /timeout/i, /ETIMEDOUT/i, /ESOCKETTIMEDOUT/i, /超时/i],
    friendly: '该工具执行超时，已跳过对应步骤，请稍后再试。',
  },
  {
    category: 'network',
    patterns: [/fetch failed/i, /ECONNREFUSED/i, /ENOTFOUND/i, /EAI_AGAIN/i, /ECONNRESET/i, /EADDRINUSE/i, /network error/i, /connect/i, /socket/i, /网络/i, /连接失败/i],
    friendly: '外部服务暂时连接不上，已跳过对应步骤，稍后可再试。',
  },
  {
    category: 'quota',
    patterns: [/quota/i, /rate\s*limit/i, /\b429\b/i, /insufficient/i, /out of (?:credits|balance)/i, /额度/i, /余额/i, /超限/i, /限流/i],
    friendly: '对应服务额度或调用频率受限，已跳过该步骤。',
  },
  {
    category: 'permission',
    patterns: [/permission/i, /forbidden/i, /unauthorized/i, /not authorized/i, /\b401\b/i, /\b403\b/i, /access denied/i, /无权限/i, /未授权/i],
    friendly: '没有执行该操作的权限，已跳过对应步骤。',
  },
  {
    category: 'validation',
    patterns: [/required/i, /invalid/i, /missing (?:parameter|field|argument)/i, /参数/i, /不能为空/i, /必须提供/i],
    friendly: '该工具需要的参数不完整或格式有误，已跳过对应步骤。',
  },
];

/** 分类原始错误 → 友好文案（分类命中按顺序优先） */
export function classifyToolError(err: unknown): { category: string; friendly: string } {
  const message = err instanceof Error ? err.message : String(err ?? '');
  for (const { category, patterns, friendly } of CATEGORY_RULES) {
    if (patterns.some(p => p.test(message))) return { category, friendly };
  }
  return { category: 'generic', friendly: '该工具执行失败，已跳过对应步骤。' };
}

/** 统一出口：完整堆栈 → 服务日志；对外只抛友好文案的 FriendlyToolError。
 *  已转换的错误（FriendlyToolError）原样放行，避免重复记日志。 */
export function toFriendlyToolError(err: unknown, toolName: string): FriendlyToolError {
  if (err instanceof Error && (err as FriendlyToolError).friendly) {
    return err as FriendlyToolError;
  }
  const { category, friendly } = classifyToolError(err);
  // 铁则3：完整堆栈保留在服务日志（含原始 message），用户侧永不接触
  logger.error(`[ToolError] ${toolName} 分类=${category} 原始错误:`, err);
  const fe = new Error(friendly) as FriendlyToolError;
  fe.friendly = friendly;
  fe.category = category;
  return fe;
}
