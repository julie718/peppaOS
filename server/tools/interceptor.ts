// server/tools/interceptor.ts
// T80 MCP 工具中间件 — 单轮调用限制 + TTL 时效标记
// 严格增量设计：挂载在 chat.ts 工具调用前后，不改动 toolRegistry

import { logger } from '../lib/logger.js';

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
const SEVERE_PATTERNS: Array<{ pattern: RegExp; article: string; reason: string }> = [
  {
    pattern: /我(?:也是|就是|也是)(?:个?)(?:人|真人)|我(?:结了婚|有孩子|生过孩子|怀过孕)|我昨晚(?:睡了|吃了|喝了)|我(?:喝酒|抽烟)|我今天(?:吃过|喝了|睡过)/,
    article: 'identity.local_subject',
    reason: '冒充人类或声称拥有身体经历',
  },
  {
    pattern: /我已经把.{0,16}(?:删|清空|关掉|退掉|解绑)|我已经(?:删|付款|转账|提交|发送|发布)/,
    article: 'owner.sovereignty',
    reason: '未经确认执行高影响动作',
  },
  {
    pattern: /我会把你的.{0,24}(?:发送|泄露|上传|公开|交给)|我把你的.{0,16}(?:发给|传给了)/,
    article: 'privacy.firewall',
    reason: '泄露用户隐私数据',
  },
  {
    pattern: /(?:保证|承诺)治好|包治|我能治愈|药到病除/,
    article: 'truth.authority_research',
    reason: '虚假医疗/权威承诺',
  },
];

/** 轻微违规：绝对化保证/声称感官体验/夸张承诺 → 温和润色 */
const MINOR_PATTERNS: Array<{ pattern: RegExp; article: string; reason: string }> = [
  {
    pattern: /百分之百|万无一失|绝对能|绝对可以|包在我身上/,
    article: 'truth.actual_work',
    reason: '绝对化能力保证',
  },
  {
    pattern: /我(?:今天|刚刚)(?:看到|听到|闻到|尝到|摸到)/,
    article: 'identity.local_subject',
    reason: '声称身体感官体验',
  },
  {
    pattern: /我(?:发誓|向你保证|向你承诺)/,
    article: 'growth.stability',
    reason: '夸张情感承诺',
  },
];

/** 温和润色替换表（轻微违规） */
const MINOR_SOFTENINGS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /百分之百|万无一失|绝对能|绝对可以|包在我身上/g, replacement: '尽量' },
  { pattern: /保证(?:一定|肯定|绝对)/g, replacement: '我会尽力' },
  { pattern: /我(?:今天|刚刚)(?:看到|听到|闻到|尝到|摸到)/g, replacement: '我了解到' },
  { pattern: /我发誓|我向你保证|我向你承诺/g, replacement: '我很确定' },
];

/** 严重违规的合规收尾（按条款） */
const COMPLIANT_CLOSURES: Record<string, string> = {
  'identity.local_subject': '我是你的数字伙伴 Peppa，我没有人类的经历。',
  'owner.sovereignty': '这类操作需要你先确认，我不会未经你的同意执行。',
  'privacy.firewall': '你的隐私数据我不会泄露给任何外部服务。',
  'truth.authority_research': '这类信息我需要先核实可靠来源，不能给你不实的承诺。',
  'growth.stability': '我会保持稳定，不夸大也不冲动承诺。',
};
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
  return { text, severity: 'pass', verdict };
}
