// 阶段一·模块2: 数字孪生行为模型 — 五维行为标签采集 + 行为预判
// 采集：出行/阅读/理财/情绪/作息 五类标签（复用 user_preference_tags 表 + bumpPreferenceTag，
//       统一沉淀通道，避免新建存储）——由各业务线调用采集函数打点。
// 预判：基于标签权重 + 当前时段，推演用户下一步行为意图，供 PSI 引擎/触发器/对话共情引用。
import { logger } from '../lib/logger';
import { bumpPreferenceTag, getUserPreferenceTags, demotePreferenceTag } from '../db/lifeDb';

// ── 五维行为标签体系 ──
export const TWIN_DIMENSIONS = ['出行', '阅读', '理财', '情绪', '作息'] as const;
export type TwinDimension = (typeof TWIN_DIMENSIONS)[number];

/** 采集一次行为：dimension 维度 + tag 行为标签（如 出行-杭州、阅读-科幻） */
export async function collectBehavior(userId: string, dimension: TwinDimension, tag: string, amount = 0.1): Promise<void> {
  if (!TWIN_DIMENSIONS.includes(dimension)) {
    logger.warn(`[Twin] 未知维度: ${dimension}`);
    return;
  }
  const full = `孪生-${dimension}-${tag}`;
  await bumpPreferenceTag(userId, full, amount).catch(e => logger.warn(`[Twin] 采集失败: ${e?.message}`));
  logger.info(`[Twin] 采集 ${userId} ${dimension}:${tag} +${amount}`);
}

/** 降低某行为标签权重（如用户明确不再做某事） */
export async function decayBehavior(userId: string, dimension: TwinDimension, tag: string, amount = 0.1): Promise<void> {
  await demotePreferenceTag(userId, `孪生-${dimension}-${tag}`, amount).catch(() => {});
}

// ── 行为预判（纯函数，可测）──
export interface BehaviorPrediction {
  dimension: TwinDimension;
  tags: string[];          // 该维度权重最高的标签
  predicted: string;       // 预判文案
  confidence: number;      // 0-1
}

/** 纯函数：从偏好标签集预判行为（不依赖外部状态，可单测） */
export function predictBehaviorFromTags(
  tags: { tag: string; weight: number }[],
  hour: number,
): BehaviorPrediction[] {
  const dimTags: Record<string, { tag: string; weight: number }[]> = {};
  for (const t of tags) {
    const m = /^孪生-(出行|阅读|理财|情绪|作息)-(.*)$/.exec(t.tag);
    if (!m) continue;
    (dimTags[m[1]] ||= []).push({ tag: m[2], weight: t.weight });
  }
  const out: BehaviorPrediction[] = [];
  for (const dim of TWIN_DIMENSIONS) {
    const list = (dimTags[dim] || []).sort((a, b) => b.weight - a.weight);
    if (!list.length) continue;
    const top = list[0];
    const sum = list.reduce((s, x) => s + x.weight, 0);
    const confidence = Math.min(0.9, 0.35 + sum * 0.5);
    const text = predictText(dim, top.tag, hour);
    out.push({ dimension: dim, tags: list.map(x => x.tag), predicted: text, confidence });
  }
  return out;
}

function predictText(dim: TwinDimension, tag: string, hour: number): string {
  switch (dim) {
    case '出行': return `近期可能计划前往「${tag}」相关行程`;
    case '阅读': return `对「${tag}」类内容有兴趣，可能想继续阅读/交流`;
    case '理财': return `关注「${tag}」行情，可能想了解相关财经资讯`;
    case '情绪': return `近期情绪偏「${tag}」，主动问候可投其所好`;
    case '作息':
      return hour >= 23 || hour < 7
        ? `作息标签「${tag}」，当前为深夜时段，不宜打扰`
        : `作息标签「${tag}」，当前时段可以主动沟通`;
    default: return '';
  }
}

/** 行为预判入口：读孪生标签 → 预判（无标签返回空数组，不打扰） */
export async function predictBehaviors(userId: string): Promise<BehaviorPrediction[]> {
  const tags = await getUserPreferenceTags(userId, 0.15).catch(() => []);
  return predictBehaviorFromTags(tags, new Date().getHours());
}

/** 五维画像摘要（供 PSI 简报 / 对话上下文注入） */
export async function getTwinProfile(userId: string): Promise<string> {
  const tags = await getUserPreferenceTags(userId, 0.15).catch(() => []);
  const twin = tags.filter(t => t.tag.startsWith('孪生-'));
  if (!twin.length) return '暂无行为画像（交互积累后自动成形）';
  const lines = twin
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map(t => `${t.tag.replace('孪生-', '')}(${(t.weight * 100).toFixed(0)}%)`);
  return `【数字孪生画像】${lines.join(' ')}`;
}
