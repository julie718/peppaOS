// 阶段三·熔断保护（成本/数量风险熔断，防"疯狂无限生成工具"）
// ① 单会话熔断：窗口内新增工具数量上限（默认 10 个/60 分钟，可环境变量调整），
//    命中后拒绝继续创建/暂存，输出 breach 结构化事件日志；
// ② 全局限额：mcp_skill_store 累计安装上限（默认 30，DB 持久计数，跨重启有效）。
// 内存态会话窗口仅防单进程内单会话的疯狂生成；全局额度为持久兜底。

import { logger } from '../lib/logger';
import { phase3Config, logSkillEvent } from './switch';
import { countInstalledSkills } from './database';

interface SessionWindow {
  count: number;
  windowStart: number;
}

const sessionWindows = new Map<string, SessionWindow>();

/** 单会话窗口计数（内存，进程重启即清空——仅防单次运行内的疯狂生成） */
export function checkSessionSlot(sessionId: string): { ok: boolean; used: number; max: number; reason?: string } {
  const cfg = phase3Config();
  const now = Date.now();
  const win = sessionWindows.get(sessionId);
  if (!win || now - win.windowStart > cfg.breakerWindowMinutes * 60_000) {
    sessionWindows.set(sessionId, { count: 0, windowStart: now });
    return { ok: true, used: 0, max: cfg.maxToolsPerSession };
  }
  if (win.count >= cfg.maxToolsPerSession) {
    return {
      ok: false, used: win.count, max: cfg.maxToolsPerSession,
      reason: `会话 ${sessionId} 在 ${cfg.breakerWindowMinutes} 分钟窗口内已新增 ${win.count} 个工具，达到熔断上限（${cfg.maxToolsPerSession}），拒绝继续创建`,
    };
  }
  return { ok: true, used: win.count, max: cfg.maxToolsPerSession };
}

/** 消费一个工具名额（暂存适配 / 沙箱生成 调用）；达到上限 → 熔断拒绝 */
export function consumeSessionSlot(sessionId: string): { ok: boolean; used: number; max: number; reason?: string } {
  const r = checkSessionSlot(sessionId);
  if (!r.ok) {
    logSkillEvent({ event: 'breach', subject: `session:${sessionId}`, ok: false, detail: r.reason });
    logger.warn(`[SkillsBreaker] ${r.reason}`);
    return r;
  }
  const win = sessionWindows.get(sessionId)!;
  win.count += 1;
  return { ok: true, used: win.count, max: r.max };
}

/** 重置单会话熔断（运维/测试用） */
export function resetSessionBreaker(sessionId: string): void {
  sessionWindows.delete(sessionId);
}

/** 全局限额（DB 持久计数：mcp_skill_store 中未卸载的安装记录） */
export async function assertGlobalCap(): Promise<{ ok: boolean; current: number; max: number; reason?: string }> {
  const cfg = phase3Config();
  const current = await countInstalledSkills();
  if (current >= cfg.globalMaxTools) {
    return {
      ok: false, current, max: cfg.globalMaxTools,
      reason: `累计安装 ${current} 个工具，达到全局限额（${cfg.globalMaxTools}），拒绝继续安装（如需扩容调整 PEPPA_PHASE3_GLOBAL_MAX_TOOLS）`,
    };
  }
  return { ok: true, current, max: cfg.globalMaxTools };
}

/** 供路由/健康面板查询当前熔断状态 */
export function getBreakerStatus(): {
  sessionWindows: Array<{ sessionId: string; count: number; max: number }>;
} {
  const cfg = phase3Config();
  return {
    sessionWindows: Array.from(sessionWindows.entries()).map(([sessionId, w]) => ({
      sessionId, count: w.count, max: cfg.maxToolsPerSession,
    })),
  };
}
