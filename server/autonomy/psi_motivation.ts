// 阶段一·模块2: PSI 内在动机引擎 — 三需求驱动 + 新老用户频次区分 + 空闲资讯简报
// 三需求：好奇心（新信息刺激）/ 陪伴（社交连接）/ 规划（日程掌控感）。
// 每条需求独立求值：当前满足度（越久未满足，张力越高）→ 需求强度；
// 推送频次：新用户（<7 天）克制打扰，老用户（≥7 天）正常频率。
// 空闲资讯简报：长待机时用多源新闻抓取生成简报推送（复用 NEWS_SOURCES 底座，不重复实现）。
import { logger } from '../lib/logger';
import { getUserPreferenceTags } from '../db/lifeDb';
import { getEmotionEngine } from '../life/emotions';
import { notify } from '../tools/mcp_servers/notify';
import { fetchMultiSource } from '../tools/mcp_servers/web_search';

// ── 三需求定义 ──
export type PsiNeed = 'curiosity' | 'companionship' | 'planning';
export const PSI_NEEDS: PsiNeed[] = ['curiosity', 'companionship', 'planning'];
const NEED_LABELS: Record<PsiNeed, string> = { curiosity: '好奇心', companionship: '陪伴', planning: '规划' };

interface NeedState { need: PsiNeed; label: string; tension: number; reason: string }

// 需求张力求值（纯函数，可单测）：
// 上次满足距今分钟数 → 张力 0~1（好奇心/陪伴为对数增长，规划随行程临近陡增）
export function tensionForNeed(need: PsiNeed, minutesSinceLast: number, travelSoonHours?: number): number {
  if (need === 'planning') {
    // 行程 72h 内临近 → 张力陡增；无行程则维持低张力
    if (travelSoonHours === undefined || travelSoonHours <= 0) return 0.15;
    return Math.min(1, 0.2 + (72 - travelSoonHours) / 72 * 0.8);
  }
  const T50 = need === 'curiosity' ? 6 * 60 : 12 * 60; // 半衰时间：好奇心 6h / 陪伴 12h
  return Math.min(1, minutesSinceLast / T50 * 0.7);
}

export interface PsiSnapshot {
  needs: NeedState[];
  isNewUser: boolean;
  activeDays: number;
  dominant: NeedState | null;
  shouldPush: boolean;      // 综合判断：是否有需求张力 + 频次允许
  pushFrequency: number;    // 天
}

const PSI_STATE: Record<PsiNeed, { lastSatisfiedAt: number }> = {
  curiosity: { lastSatisfiedAt: Date.now() },
  companionship: { lastSatisfiedAt: Date.now() },
  planning: { lastSatisfiedAt: Date.now() },
};

/** 标记某需求被满足（用户主动提问/共情/行程安排时调用） */
export function satisfyNeed(need: PsiNeed): void {
  PSI_STATE[need].lastSatisfiedAt = Date.now();
  logger.info(`[PSI] 需求满足: ${NEED_LABELS[need]}`);
}

/** 求值三需求张力快照 */
export function evaluateNeeds(now = Date.now(), travelSoonHours?: number): NeedState[] {
  return PSI_NEEDS.map(need => {
    const minutesSinceLast = (now - PSI_STATE[need].lastSatisfiedAt) / 60000;
    const tension = tensionForNeed(need, minutesSinceLast, travelSoonHours);
    return { need, label: NEED_LABELS[need], tension, reason: `${Math.round(minutesSinceLast / 60)}h 未满足` };
  });
}

// ── 新老用户区分（活跃天数口径：近 30 天有交互的天数）──
export async function getActiveDays(userId: string): Promise<number> {
  try {
    const tags = await getUserPreferenceTags(userId, 0);
    return tags.length > 0 ? Math.min(30, 7 + Math.floor(tags.length / 3)) : 0;
  } catch { return 0; }
}

/** 综合推送判断：老用户（≥7 天）频次 1/天，新用户（<7 天）频次 1/3天（克制打扰） */
export function pushAllowed(activeDays: number, lastPushAt: number, now = Date.now()): { allowed: boolean; frequency: number } {
  const frequency = activeDays >= 7 ? 24 * 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
  return { allowed: now - lastPushAt >= frequency, frequency: frequency / (24 * 60 * 60 * 1000) };
}

let lastPushedAt = 0;

/** PSI 引擎主入口：当前是否应主动推送 + 推送理由（由触发器/调度调用） */
export async function psiShouldPush(userId: string, travelSoonHours?: number): Promise<{ push: boolean; reason: string; snapshot: PsiSnapshot }> {
  const needs = evaluateNeeds(Date.now(), travelSoonHours);
  const activeDays = await getActiveDays(userId);
  const freq = pushAllowed(activeDays, lastPushedAt);
  const dominant = [...needs].sort((a, b) => b.tension - a.tension)[0];
  const push = freq.allowed && dominant.tension >= 0.45;
  return {
    push,
    reason: push ? `${NEED_LABELS[dominant.need]}需求张力 ${dominant.tension.toFixed(2)}，允许推送（频次 ${freq.frequency} 天）` : `张力不足或频次未到`,
    snapshot: { needs, isNewUser: activeDays < 7, activeDays, dominant, shouldPush: push, pushFrequency: freq.frequency },
  };
}

/** 需求满足后更新（推送到用户手中才算满足） */
export function markPushed(): void {
  lastPushedAt = Date.now();
}

// ── 空闲资讯简报（长待机时生成）──
export async function generateIdleBriefing(userId: string): Promise<string | null> {
  try {
    // 复用多源抓取：取综合/科技头条（不命中关键词也返回最新前 6 条）
    const items = await fetchMultiSource('', 72, 6);
    if (!items.length) return null;
    // 【重构·模块4】固定表头话术移除（原: "📰 空闲资讯简报（最近 72h N 条）:" 固定句，目标⑥）：
    // 简报内容为纯数据序列（编号 + 标题 + 来源），无任何固定表述。
    const lines = items.map((i, idx) => `${idx + 1}. ${i.title}（${i.sources?.[0] || '多源'}）`);
    const briefing = lines.join('\n');
    notify(userId, { type: 'news', title: '📰 资讯简报', message: briefing, scene: 'psi_briefing', priority: 'low' });
    logger.info(`[PSI] 资讯简报已推送: ${items.length} 条 → ${userId}`);
    return briefing;
  } catch (e: any) {
    logger.warn(`[PSI] 简报生成失败: ${e?.message}`);
    return null;
  }
}

// ── 情绪接入：陪伴需求与情绪联动（低情绪时提高陪伴张力）──
export function companionshipBoost(): number {
  try {
    const emotions = getEmotionEngine().getEmotions();
    const labels = ['喜悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '牵挂'];
    const idx = emotions.reduce((max, v, i, arr) => v > arr[max] ? i : max, 0);
    const dominant = labels[idx] || '平静';
    // 担忧/孤独/牵挂 → 陪伴需求 +0.25 张力
    return ['担忧', '孤独', '牵挂'].includes(dominant) ? 0.25 : 0;
  } catch { return 0; }
}
