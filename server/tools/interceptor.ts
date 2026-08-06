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

  /** 清理已结束的会话计数器（避免 Map 膨胀） */
  cleanup(sessionKey: string): void {
    this.perTurnCallCount.delete(sessionKey);
    this.perTurnToolLog.delete(sessionKey);
  }
}

export const mcpInterceptor = new McpInterceptor();

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
