// server/llm/routerConfig.ts
// DeepSeek 最高性价比外部强制路由 — 配置层
//
// 路由配置（任务6）：
//   - 主心智模型（核心心智强制走此模型）：默认 deepseek-v4-pro
//   - 备用故障降级模型（仅 API 故障应急）：默认 deepseek-v4-flash
//   - 每日 Pro token 预算上限（0 = 不启用熔断）
//   - 预算告警阈值比例（0~1，默认 0.8）
//   - 空闲 InnerTick 推演最小间隔（毫秒，0 = 不限制，保持旧行为）
//
// 优先级：环境变量 > Web 桌面端配置（db.settings key `llm_router_config`）> 默认值。
// iPhone App 不新增客户端配置，完全复用服务端全局配置（本模块为服务端唯一事实源）。

import { readDB, writeDB } from '../../db_layer';
import { logger } from '../lib/logger';

export interface LLMRouterConfig {
  /** 总开关：false = 完全关闭路由（模型强制/预算/频率全部失效，行为回退到旧逻辑） */
  enabled: boolean;
  /** 核心心智强制模型（InnerTick/life TICK/自我反思/MCP评估/长链规划） */
  proModel: string;
  /** 外围输出强制模型（最终回复渲染/摘要/闲聊格式化） */
  flashModel: string;
  /** 每日 Pro 模型 token 预算上限；0 = 不启用熔断 */
  dailyProTokenBudget: number;
  /** 预算告警阈值（0~1 比例，如 0.8 = 消耗达预算 80% 时告警） */
  budgetWarnRatio: number;
  /** 空闲状态 InnerTick 推演最小间隔（毫秒）；0 = 不限制（保持旧行为） */
  idleInnerTickIntervalMs: number;
}

export const ROUTER_CONFIG_KEY = 'llm_router_config';

export const DEFAULT_ROUTER_CONFIG: LLMRouterConfig = {
  enabled: true,
  proModel: 'deepseek-v4-pro',
  flashModel: 'deepseek-v4-flash',
  dailyProTokenBudget: 0,
  budgetWarnRatio: 0.8,
  idleInnerTickIntervalMs: 60 * 60 * 1000, // 1 小时
};

function toNum(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return fallback;
}

/** 从 db.settings 读取 Web 桌面端配置的 JSON */
function readDbConfig(): Partial<LLMRouterConfig> {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === ROUTER_CONFIG_KEY);
    if (setting?.value) {
      const raw = JSON.parse(setting.value);
      if (raw && typeof raw === 'object') return raw as Partial<LLMRouterConfig>;
    }
  } catch {
    /* 未初始化/损坏 → 默认值 */
  }
  return {};
}

/**
 * 读取生效的路由配置。优先级：环境变量 > Web 桌面端配置 > 默认值。
 * 环境变量（docker-compose 透传，全部以 DEEPSEEK_ROUTER_ 前缀）：
 *   DEEPSEEK_ROUTER_ENABLED                     — true/false
 *   DEEPSEEK_ROUTER_PRO_MODEL                   — 主心智模型
 *   DEEPSEEK_ROUTER_FLASH_MODEL                 — 备用降级模型
 *   DEEPSEEK_ROUTER_DAILY_PRO_TOKEN_BUDGET      — 每日 Pro token 预算（0=关闭）
 *   DEEPSEEK_ROUTER_BUDGET_WARN_RATIO           — 告警阈值比例
 *   DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS  — 空闲 InnerTick 最小间隔（0=关闭）
 */
export function getRouterConfig(): LLMRouterConfig {
  const dbCfg = readDbConfig();
  const env = process.env;

  return {
    enabled: toBool(env.DEEPSEEK_ROUTER_ENABLED, toBool(dbCfg.enabled, DEFAULT_ROUTER_CONFIG.enabled)),
    proModel: env.DEEPSEEK_ROUTER_PRO_MODEL?.trim() || dbCfg.proModel || DEFAULT_ROUTER_CONFIG.proModel,
    flashModel: env.DEEPSEEK_ROUTER_FLASH_MODEL?.trim() || dbCfg.flashModel || DEFAULT_ROUTER_CONFIG.flashModel,
    dailyProTokenBudget: toNum(env.DEEPSEEK_ROUTER_DAILY_PRO_TOKEN_BUDGET, toNum(dbCfg.dailyProTokenBudget, DEFAULT_ROUTER_CONFIG.dailyProTokenBudget)),
    budgetWarnRatio: toNum(env.DEEPSEEK_ROUTER_BUDGET_WARN_RATIO, toNum(dbCfg.budgetWarnRatio, DEFAULT_ROUTER_CONFIG.budgetWarnRatio)),
    idleInnerTickIntervalMs: toNum(env.DEEPSEEK_ROUTER_IDLE_INNERTICK_INTERVAL_MS, toNum(dbCfg.idleInnerTickIntervalMs, DEFAULT_ROUTER_CONFIG.idleInnerTickIntervalMs)),
  };
}

/** 持久化 Web 桌面端配置（环境变量优先，写入仅存非 env 字段仍整体保存，读取时 env 永远覆盖） */
export function saveRouterConfig(input: Partial<LLMRouterConfig>): LLMRouterConfig {
  const db = readDB();
  if (!db.settings) (db as any).settings = [];
  const idx = (db.settings as any[]).findIndex((s: any) => s.key === ROUTER_CONFIG_KEY);
  const payload = { ...getRouterConfig(), ...input, updatedAt: new Date().toISOString() };
  if (idx >= 0) {
    (db.settings as any[])[idx].value = JSON.stringify(payload);
  } else {
    (db.settings as any[]).push({ key: ROUTER_CONFIG_KEY, value: JSON.stringify(payload) });
  }
  writeDB(db);
  const saved = getRouterConfig();
  logger.info(`[LLMRouter] 配置已保存: pro=${saved.proModel} flash=${saved.flashModel} budget=${saved.dailyProTokenBudget} idleIntervalMs=${saved.idleInnerTickIntervalMs} enabled=${saved.enabled}`);
  return saved;
}

/**
 * DeepSeek 是否可用（存在 API key）。核心心智「强制锁定 deepseek-v4-pro」的前提是
 * DeepSeek 服务商已配置；未配置时路由层不强制改道（保持用户原配置），避免破坏
 * qwen/gemini 等其他服务商部署。
 */
export function isDeepSeekConfigured(): boolean {
  try {
    const { getKey } = require('../config/keys');
    return !!(process.env.DEEPSEEK_API_KEY || getKey('DEEPSEEK_API_KEY'));
  } catch {
    return !!process.env.DEEPSEEK_API_KEY;
  }
}
