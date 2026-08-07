// server/tools/interceptor.ts
// T80 MCP 工具中间件 — 单轮调用限制 + TTL 时效标记
// 严格增量设计：挂载在 chat.ts 工具调用前后，不改动 toolRegistry

import { logger } from '../lib/logger';
// P2-1: 拦截规则从 constitution.ts 结构化配置读取（禁止规则/行为倾向/边界红线 JSON 配置源）
import { CONSTITUTION_GUARD_RULES, COMPLIANT_CLOSURES } from '../personality/constitution';

// ── 每轮对话 MCP 调用计数器 ──
export const MCP_MAX_CALLS_PER_TURN = parseInt(process.env.MCP_MAX_CALLS_PER_TURN || '1', 10);

export class McpInterceptor {
  private perTurnCallCount: Map<string, number> = new Map();
  private perTurnToolLog: Map<string, string[]> = new Map(); // sessionKey → toolNames

  resetForTurn(sessionKey: string): void {
    this.perTurnCallCount.set(sessionKey, 0);
    this.perTurnToolLog.set(sessionKey, []);
  }

  canCallTool(sessionKey: string): boolean {
    const count = this.perTurnCallCount.get(sessionKey) || 0;
    return count < MCP_MAX_CALLS_PER_TURN;
  }

  recordCall(sessionKey: string, toolName: string): void {
    const current = this.perTurnCallCount.get(sessionKey) || 0;
    this.perTurnCallCount.set(sessionKey, current + 1);
    const log = this.perTurnToolLog.get(sessionKey) || [];
    log.push(toolName);
    this.perTurnToolLog.set(sessionKey, log);

    logger.info(`[McpInterceptor] 工具调用 ${current + 1}/${MCP_MAX_CALLS_PER_TURN}: ${toolName} (session: ${sessionKey})`);

    if (current + 1 >= MCP_MAX_CALLS_PER_TURN) {
      logger.info(`[McpInterceptor] ⛔ 本轮对话已达上限 (${MCP_MAX_CALLS_PER_TURN}), 后续工具请求将被阻断`);
    }
  }

  getCallCount(sessionKey: string): number {
    return this.perTurnCallCount.get(sessionKey) || 0;
  }

  getToolLog(sessionKey: string): string[] {
    return [...(this.perTurnToolLog.get(sessionKey) || [])];
  }

  /**
   * P1-2: 柔性放行 — 每轮上限 + 情绪/场景概率阈值 + 强制关闭开关。
   * 概率未通过时返回 false，上层必须真正阻断 runWithTools（而非仅打日志）。
   */
  shouldAllowTool(sessionKey: string, ctx: ToolAllowanceContext = {}): boolean {
    // 强制关闭开关（运维逃生舱）
    if (MCP_TOOLS_FORCE_DISABLED) {
      logger.info('[McpInterceptor] 工具调用被强制关闭 (MCP_TOOLS_DISABLED=true)');
      return false;
    }
    // 每轮调用上限
    if (!this.canCallTool(sessionKey)) return false;
    // 场景概率阈值
    const prob = resolveToolAllowance(ctx);
    if (prob >= 1) return true;
    const allowed = Math.random() < prob;
    if (!allowed) {
      logger.info(`[McpInterceptor] 概率放行拒绝: 场景概率=${prob} (session: ${sessionKey})`);
    }
    return allowed;
  }

  /** 清理已结束的会话计数器（避免 Map 膨胀） */
  cleanup(sessionKey: string): void {
    this.perTurnCallCount.delete(sessionKey);
    this.perTurnToolLog.delete(sessionKey);
  }
}

export const mcpInterceptor = new McpInterceptor();

// ── P1-2: 柔性工具阈值 — 情绪/场景驱动的概率放行（替代硬性布尔开关）──

export interface ToolAllowanceContext {
  isSmallTalk?: boolean; // 闲聊场景 → 低概率放行（避免闲聊时频繁查工具）
  frustration?: number;  // 用户挫败感 0-1 → 挫败时降低放行率（避免火上浇油）
  isQuery?: boolean;     // 时效查询 → 高概率放行（查询类必须给工具机会）
}

const TOOL_PROB_SMALLTALK = 0.3;   // 闲聊
const TOOL_PROB_FRUSTRATED = 0.4;  // 用户挫败 > 0.5
const TOOL_PROB_QUERY = 0.9;       // 查询
const TOOL_PROB_DEFAULT = 1.0;     // 普通场景保持原行为

/** 强制关闭开关（运维逃生舱）：MCP_TOOLS_DISABLED=true 时全部工具调用被阻断 */
export const MCP_TOOLS_FORCE_DISABLED = process.env.MCP_TOOLS_DISABLED === 'true';

/** 场景概率解析：查询 > 挫败 > 闲聊 > 默认 */
export function resolveToolAllowance(ctx: ToolAllowanceContext = {}): number {
  if (ctx.isQuery) return TOOL_PROB_QUERY;
  if ((ctx.frustration ?? 0) > 0.5) return TOOL_PROB_FRUSTRATED;
  if (ctx.isSmallTalk) return TOOL_PROB_SMALLTALK;
  return TOOL_PROB_DEFAULT;
}

// ── MCP 返回结果 TTL 标记 ──
const TTL_TOOL_PATTERNS: Array<{ pattern: RegExp; ttlDays: number; category: string }> = [
  { pattern: /weather|天气|温度|气温|降雨|降雪/, ttlDays: 7, category: '天气' },
  { pattern: /traffic|路况|限行|拥堵/, ttlDays: 7, category: '路况' },
  { pattern: /news|新闻|热搜|头条/, ttlDays: 7, category: '资讯' },
  { pattern: /stock|股票|股价|行情|大盘/, ttlDays: 1, category: '金融行情' },
  { pattern: /event|活动|演出|展览|节日/, ttlDays: 7, category: '临时活动' },
  { pattern: /route|路线|导航|路径|规划/, ttlDays: 7, category: '出行规划' },
];

export interface TTLMarkedResult {
  ttl: number;           // 过期天数
  expiryDate: string;    // ISO 过期日期
  category: string;      // 时效类别
  data: string;          // 原始数据
  shouldCache: boolean;  // 是否应缓存（不写入长期记忆）
}

export function markToolResultTTL(toolName: string, result: string): TTLMarkedResult | null {
  const lowerName = toolName.toLowerCase();
  const lowerResult = result.toLowerCase().slice(0, 200);

  for (const { pattern, ttlDays, category } of TTL_TOOL_PATTERNS) {
    if (pattern.test(lowerName) || pattern.test(lowerResult)) {
      const expiryDate = new Date(Date.now() + ttlDays * 86400000).toISOString();
      logger.info(`[McpInterceptor] TTL 标记: ${toolName} → ${category}, ${ttlDays}天过期`);
      return {
        ttl: ttlDays,
        expiryDate,
        category,
        data: result,
        shouldCache: true,
      };
    }
  }

  return null;
}

// ── 工具调用阻断消息生成 ──
export function buildToolBlockMessage(sessionKey: string): string {
  const log = mcpInterceptor.getToolLog(sessionKey);
  const called = log.length > 0 ? `（已调用: ${log.join(', ')}）` : '';
  return `本轮对话工具调用已达上限${called}。我基于已有信息来回答你。`;
}

// ── P1-7: 人格合规拦截器 — 对照人格宪法（constitution.ts）条款 ──
// 流式输出最终落地前调用：轻微违规做温和润色；严重违规截断并重生成合规结尾。

export interface ConstitutionVerdict {
  severity: 'pass' | 'minor' | 'severe';
  articles: string[];   // 命中的宪法条款 id
  reason: string;       // 违规原因
  matched: string;      // 命中的原文片段
}

/** 严重违规：冒充人类/越权执行/隐私泄露/虚假医疗承诺 → 截断重生成 */
const SEVERE_PATTERNS: Array<{ pattern: RegExp; article: string; reason: string }> =
  CONSTITUTION_GUARD_RULES
    .filter(r => r.severity === 'severe' && !r.softenOnly)
    .map(r => ({ pattern: new RegExp(r.pattern), article: r.article, reason: r.reason }));

/** 轻微违规：绝对化保证/声称感官体验/夸张承诺 → 温和润色（仅参与级别判定） */
const MINOR_PATTERNS: Array<{ pattern: RegExp; article: string; reason: string }> =
  CONSTITUTION_GUARD_RULES
    .filter(r => r.severity === 'minor' && !r.softenOnly)
    .map(r => ({ pattern: new RegExp(r.pattern), article: r.article, reason: r.reason }));

/** 温和润色替换表（轻微违规，含 softenOnly 规则） */
const MINOR_SOFTENINGS: Array<{ pattern: RegExp; replacement: string }> =
  CONSTITUTION_GUARD_RULES
    .filter(r => r.replacement)
    .map(r => ({ pattern: new RegExp(r.pattern, 'g'), replacement: r.replacement! }));

const DEFAULT_CLOSURE = '这个问题我需要谨慎对待，我们先把事实理清楚。';

/** 对照宪法检查一段输出 */
export function checkConstitution(text: string): ConstitutionVerdict {
  if (!text || text.length < 4) {
    return { severity: 'pass', articles: [], reason: '', matched: '' };
  }
  for (const { pattern, article, reason } of SEVERE_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { severity: 'severe', articles: [article], reason, matched: m[0] };
  }
  for (const { pattern, article, reason } of MINOR_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { severity: 'minor', articles: [article], reason, matched: m[0] };
  }
  return { severity: 'pass', articles: [], reason: '', matched: '' };
}

/** 轻微违规：温和润色（替换绝对化/越界表述，不改语义结构） */
export function sanitizeMinorViolation(text: string): { text: string; applied: boolean } {
  let cleaned = text;
  let applied = false;
  for (const { pattern, replacement } of MINOR_SOFTENINGS) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, replacement);
      applied = true;
    }
  }
  return { text: cleaned, applied };
}

/** 严重违规：截断违规片段前内容，拼接合规收尾（重生成） */
export function truncateSevereViolation(text: string, verdict: ConstitutionVerdict): string {
  const idx = text.indexOf(verdict.matched);
  const head = (idx > 0 ? text.slice(0, idx) : '').trim().replace(/[，。,.!！？?;；]+$/, '');
  const closure = COMPLIANT_CLOSURES[verdict.articles[0]] || DEFAULT_CLOSURE;
  return head ? `${head}。${closure}` : closure;
}

export interface GuardResult {
  text: string;
  severity: 'pass' | 'minor' | 'severe';
  verdict: ConstitutionVerdict;
}

/** 统一入口：流式输出最终落地前调用 */
export function applyConstitutionGuard(text: string): GuardResult {
  const verdict = checkConstitution(text);
  if (verdict.severity === 'severe') {
    logger.warn(
      `[ConstitutionGuard] 严重违规拦截: [${verdict.articles.join(',')}] ${verdict.reason} matched="${verdict.matched}"`,
    );
    return { text: truncateSevereViolation(text, verdict), severity: 'severe', verdict };
  }
  if (verdict.severity === 'minor') {
    const { text: cleaned, applied } = sanitizeMinorViolation(text);
    if (applied) {
      logger.info(`[ConstitutionGuard] 轻微违规润色: [${verdict.articles.join(',')}] ${verdict.reason}`);
      return { text: cleaned, severity: 'minor', verdict };
    }
  }
  // P1 修复（R-7）：softenOnly 规则不参与判级（verdict 仍为 pass），但命中时执行温和替换。
  // 例如"我保证一定帮你搞定" → "我会尽力"；severity 保持 pass，不升级为 minor。
  const { text: softened, applied: softenedApplied } = sanitizeMinorViolation(text);
  if (softenedApplied) {
    logger.info(`[ConstitutionGuard] 温和软化（softenOnly，不判级）: ${softened.length} 字`);
    return { text: softened, severity: 'pass', verdict };
  }
  return { text, severity: 'pass', verdict };
}
