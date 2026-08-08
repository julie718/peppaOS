// 阶段三·初始化与例行巡检
// 职责：① 迁移阶段三 5 张表（幂等） ② 接线 auth_gateway → adapter（密钥明文不出网关）
//      ③ 例行巡检（内部 setInterval，零侵入主 scheduler）：
//         - 每 5 分钟：工具故障巡检（延迟/失败率/负面情绪 → 自修复）
//         - 每 6 小时：7 天过期清理（沙箱项目 + 待审批）
//         - 每月 3 点：技能月度简报 + 缺口复评（Idle 自省联动）

import { logger } from '../lib/logger';
import { migrateSkillsTables } from './database';
import { setProxyFetcher } from './adapter';
import { proxyFetch } from './auth_gateway';
import { reapSkillFaults } from './monitoring';
import { expireOldSandboxProjects } from './sandbox';
import { expireStaleApprovals } from './approval';
import { generateSkillsMonthlyBrief, runMonthlyGapReview } from './hooks';

let initialized = false;
let routinesStarted = false;

const FAULT_POLL_MS = 5 * 60 * 1000;      // 故障巡检
const CLEANUP_POLL_MS = 6 * 60 * 60 * 1000; // 过期清理
const MONTHLY_POLL_MS = 6 * 60 * 60 * 1000; // 月度检查窗口

/** 初始化（幂等）：迁移表 + 网关接线 */
export async function initSkillsExtension(): Promise<{ ok: boolean; tables: string[]; errors: string[] }> {
  if (initialized) return { ok: true, tables: [], errors: [] };
  const mig = await migrateSkillsTables();
  // 网关代理接线：适配器经 auth_gateway 解密密钥后代理请求（明文不出网关）
  setProxyFetcher(proxyFetch);
  initialized = true;
  logger.info(`[SkillsExt] 初始化完成（表 ${mig.tables.length} 张${mig.errors.length ? `，错误 ${mig.errors.join(';')}` : ''}）`);
  return { ok: mig.success, tables: mig.tables, errors: mig.errors };
}

/** 启动例行巡检（幂等；测试环境可手动触发替代） */
export function startSkillsRoutines(): void {
  if (routinesStarted) return;
  routinesStarted = true;

  // 1) 每 5 分钟故障巡检
  setInterval(() => {
    reapSkillFaults().catch(() => {});
  }, FAULT_POLL_MS).unref();

  // 2) 每 6 小时过期清理（7 天未审批）
  setInterval(() => {
    expireOldSandboxProjects().catch(() => {});
    expireStaleApprovals().catch(() => {});
  }, CLEANUP_POLL_MS).unref();

  // 3) 每月 3 点：技能月度简报 + 缺口复评（Idle 自省联动）
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 3 && now.getDate() === 1) {
      generateSkillsMonthlyBrief().catch(() => {});
      runMonthlyGapReview().catch(() => {});
    }
  }, MONTHLY_POLL_MS).unref();

  logger.info('[SkillsExt] 例行巡检已启动（故障 5min / 清理 6h / 月度简报）');
}

/** 安全退出（供测试关闭进程级资源） */
export function stopSkillsRoutines(): void {
  routinesStarted = false;
}

/** 路由挂载前确保初始化（幂等惰性初始化） */
export async function ensureSkillsReady(): Promise<void> {
  await initSkillsExtension();
  startSkillsRoutines();
}
