// server/hooks/review.ts
// T80 对话即时复盘学习系统
// 每次对话结束后异步归档记忆、复盘交互、更新经验
// 严格使用现有 memory 库和 life.db 存储

import { logger } from '../lib/logger.js';
import { addMemory } from '../memory/store.js';
import { addInteractionMemory, saveEmotionVector } from '../db/lifeDb.js';
import { getEmotionEngine } from '../life/emotions.js';
import { getRelationshipEngine } from '../life/relationship.js';
// 本地类型定义（不依赖全局钩子）
interface AfterResponseContext {
  uid: string; text: string; response: string; sessionKey: string;
  personality: { name: string; vector: number[] };
  emotion: { emotions: number[]; dominant: string };
  conversationId: string; domain: string; orgId: string; source?: string;
}

// ── 四类归档 ──
interface ReviewResult {
  personalityMemories: number;   // 人格记忆数
  userTraitMemories: number;     // 用户特征记忆数
  sceneExperiences: number;      // 场景经验数
  ttlCachedItems: number;        // 时效缓存数
  qualityScore: number;          // 交互质量评分 0-1
  emotionUpdated: boolean;
  relationshipUpdated: boolean;
}

function assessInteractionQuality(ctx: AfterResponseContext): number {
  let score = 0.5;

  // 回复长度合适 (50-500字符)
  const respLen = ctx.response?.length || 0;
  if (respLen > 50 && respLen < 500) score += 0.15;
  else if (respLen >= 20) score += 0.05;

  // 避免模板回复的关键词检测
  if (/我觉得|你可以|建议|理解|明白|感受到|听起来/.test(ctx.response || '')) score += 0.1;

  // 用户消息包含情感表达
  if (/难过|开心|焦虑|迷茫|压力|高兴|感动|愤怒|担心/.test(ctx.text || '')) score += 0.1;

  // 回复不含冰冷数据
  if (!/JSON|```json|```|表格/.test(ctx.response || '')) score += 0.05;

  return Math.min(1, score);
}

function extractPersonalityInsights(text: string, response: string): string[] {
  const insights: string[] = [];
  const combined = `${text} ${response}`;

  // 价值观类
  const valuePatterns: [RegExp, string][] = [
    [/觉得.*重要/, '用户表达了价值观倾向'],
    [/认为.*应该/, '用户表达了行为准则'],
    [/相信|信念|坚持/, '用户展现了信念'],
    [/对我来说|在我心里/, '用户分享了个人价值观'],
  ];
  for (const [pattern, label] of valuePatterns) {
    if (pattern.test(combined)) {
      insights.push(label);
      break;
    }
  }

  return insights;
}

function extractUserTraits(text: string, _response: string): Array<{ trait: string; detail: string }> {
  const traits: Array<{ trait: string; detail: string }> = [];

  // 偏好类
  if (/喜欢|爱|最爱|偏好|钟情|偏爱|热衷/.test(text)) {
    const match = text.match(/(?:喜欢|爱|最爱|偏好|钟情|偏爱|热衷)(.{1,20})/);
    if (match) traits.push({ trait: '偏好', detail: text.slice(0, 80) });
  }
  // 习惯类
  if (/经常|总是|习惯|每次|天天|每天|从不/.test(text)) {
    const match = text.match(/(?:经常|总是|习惯|每次|天天|每天|从不)(.{1,30})/);
    if (match) traits.push({ trait: '习惯', detail: text.slice(0, 80) });
  }
  // 能力类
  if (/擅长|会|可以做|专业|精通/.test(text)) {
    traits.push({ trait: '能力', detail: text.slice(0, 80) });
  }

  return traits;
}

function extractSceneExperience(text: string, response: string): string | null {
  // 检测是否包含可复用的场景经验
  const hasSolution = /可以|试试|建议|方案|方法|解决|处理|应对/.test(response);
  const isPractical = /路线|规划|出行|准备|步骤|流程|预约|安排/.test(text + response);

  if (hasSolution && isPractical) {
    return `场景: ${text.slice(0, 60)} → 方案: ${response.slice(0, 120)}`;
  }

  if (hasSolution && /情绪|安慰|开导|陪伴|倾听|理解你/.test(response)) {
    return `安抚场景: ${text.slice(0, 60)} → 回应方式: ${response.slice(0, 80)}`;
  }

  return null;
}

// ── 主复盘函数 ──
export async function performPostChatReview(ctx: AfterResponseContext): Promise<ReviewResult> {
  const result: ReviewResult = {
    personalityMemories: 0,
    userTraitMemories: 0,
    sceneExperiences: 0,
    ttlCachedItems: 0,
    qualityScore: 0,
    emotionUpdated: false,
    relationshipUpdated: false,
  };

  try {
    const userId = ctx.uid;
    const now = new Date().toISOString();

    // 1. 交互质量评估
    result.qualityScore = assessInteractionQuality(ctx);

    // 2a. 永久人格记忆 (core_identity — 用户价值观)
    const personalityInsights = extractPersonalityInsights(ctx.text, ctx.response);
    for (const insight of personalityInsights) {
      try {
        addMemory({
          userId,
          type: 'fact' as any,
          keywords: ['人格洞察', insight],
          content: `[人格洞察] ${insight}: ${ctx.text.slice(0, 100)}`,
          confidence: 0.7,
          sourceInteractionId: ctx.conversationId || 'review',
        }, {
          tier: 'core_identity' as any,
          perspective: 'user_trait' as any,
          importance: 0.7,
          source: 'post_chat_review' as any,
        });
        result.personalityMemories++;
      } catch {}
    }

    // 2b. 用户长期特征记忆 (growth tier)
    const userTraits = extractUserTraits(ctx.text, ctx.response);
    for (const trait of userTraits) {
      try {
        addMemory({
          userId,
          type: 'fact' as any,
          keywords: [trait.trait, '用户特征'],
          content: `[${trait.trait}] ${trait.detail}`,
          confidence: 0.5,
          sourceInteractionId: ctx.conversationId || 'review',
        }, {
          tier: 'growth' as any,
          perspective: 'user_trait' as any,
          importance: 0.5,
          source: 'post_chat_review' as any,
        });
        result.userTraitMemories++;
      } catch {}
    }

    // 2c. 场景经验记忆 (internalized tier)
    const sceneExp = extractSceneExperience(ctx.text, ctx.response);
    if (sceneExp) {
      try {
        addMemory({
          userId,
          type: 'knowledge' as any,
          keywords: ['场景经验', '方案'],
          content: sceneExp,
          confidence: 0.6,
          sourceInteractionId: ctx.conversationId || 'review',
        }, {
          tier: 'internalized' as any,
          perspective: 'owner_trait' as any,
          importance: 0.6,
          source: 'post_chat_review' as any,
        });
        result.sceneExperiences++;
      } catch {}
    }

    // 2d. 交互记忆 (life.db)
    try {
      await addInteractionMemory('chat_review', {
        qualityScore: result.qualityScore,
        userText: ctx.text.slice(0, 200),
        responseText: ctx.response?.slice(0, 200),
        topic: ctx.text.slice(0, 40),
        timestamp: now,
      }, Math.max(0.3, result.qualityScore * 0.8));
    } catch {}

    // 3. 更新情绪状态 (life.db)
    try {
      const emotionEngine = getEmotionEngine();
      const emotions = emotionEngine.getEmotions();

      // 正面交互轻微提升情绪
      if (result.qualityScore > 0.6) {
        await emotionEngine.receiveEvent('user_positive');
      } else if (result.qualityScore < 0.3) {
        await emotionEngine.receiveEvent('user_negative');
      }

      await saveEmotionVector(emotions);
      result.emotionUpdated = true;
    } catch (e) {
      logger.warn('[Review] 情绪更新失败:', e);
    }

    // 4. 更新关系亲密度
    try {
      const relationshipEngine = getRelationshipEngine();
      const outcome = result.qualityScore > 0.6 ? 'positive' : result.qualityScore < 0.3 ? 'negative' : 'neutral';
      await relationshipEngine.receiveInteraction('user_initiated', outcome);
      result.relationshipUpdated = true;
    } catch (e) {
      logger.warn('[Review] 关系更新失败:', e);
    }

    logger.info(`[Review] 对话复盘完成: quality=${result.qualityScore.toFixed(2)}, ` +
      `人格记忆=${result.personalityMemories}, 特征=${result.userTraitMemories}, ` +
      `场景经验=${result.sceneExperiences}`);

    return result;
  } catch (e: any) {
    logger.error('[Review] 复盘失败:', e?.message || e);
    return result;
  }
}

// ── 快速复盘（仅做情绪+关系更新，不写记忆） ──
export async function quickReview(ctx: AfterResponseContext): Promise<void> {
  try {
    const emotionEngine = getEmotionEngine();
    await emotionEngine.receiveEvent('user_message');

    const relEngine = getRelationshipEngine();
    await relEngine.receiveInteraction('user_initiated', 'neutral');

    logger.info('[Review] 快速复盘完成');
  } catch (e) {
    logger.warn('[Review] 快速复盘失败:', e);
  }
}
