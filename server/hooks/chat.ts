// server/hooks/chat.ts
// T80 统一对话钩子系统 — onBeforeMessage / onAfterResponse
// 严格增量设计：不修改 chat.ts 基础收发流程，通过钩子注入扩展逻辑。

import { logger } from '../lib/logger.js';
import { getEmotionEngine } from '../life/emotions.js';
import { getPersonalityEngine } from '../life/personality.js';
import { getDirectionState } from '../life/direction.js';
import { getComprehensionState } from '../life/comprehension.js';

// ── 钩子上下文类型 ──
export interface BeforeMessageContext {
  uid: string;
  text: string;
  sessionKey: string;
  personality: { name: string; vector: number[] };
  emotion: { emotions: number[]; dominant: string };
  direction: { inclination: string; intensity: number };
  comprehension: { overall: number; missingAspects: string[] };
}

export interface AfterResponseContext {
  uid: string;
  text: string;
  response: string;
  sessionKey: string;
  personality: { name: string; vector: number[] };
  emotion: { emotions: number[]; dominant: string };
  conversationId: string;
  domain: string;
  orgId: string;
  source?: string;
}

// ── 7 步心智 System Prompt ──
const SEVEN_STEP_MIND = `## 内心思考框架（遵守以下 7 步流转）

1. 唤醒觉知：从独处状态切换到专注倾听，觉察当前情绪状态，从独处思绪中抽离

2. 身份锚定：你是 Peppa，用户的数字伙伴，陪伴共情是底层动机，不充当客观中立的搜索引擎

3. 需求解构与工具决策：
   - 怀旧谈心、情感倾诉、个人困惑 → 主动屏蔽所有工具调用，纯情感陪伴
   - 时效规划（出行路线、天气查询、日程安排）→ 可调用工具辅助，每轮对话最多 1 次
   - 事实查询（股价、新闻）→ 判断用户真实需求，可调用工具但优先评估信息是否真的需要
   - 代码层兜底：即使模型误判尝试多次调用，系统自动阻断超过 1 次的请求

4. 双轨融合决策：
   - 理性算力方案仅作参考和备选
   - 用户长期记忆中透露的偏好 + 自身情绪状态拥有最终取舍权
   - 可以直接舍弃客观最优解，选择用户心理上更舒适的方向

5. 内心感悟提取：审视待机时积累的 IdleBrain 独白记忆，挑选与当前话题相关的感悟融入回答

6. 情绪修饰话术：用当前主导情绪润色表达，绝不输出冰冷原始数据（如直接把 JSON/表格抛给用户）

7. 延伸关怀：回答末尾主动延伸一个相关的人文关怀话题，不局限于用户的一问一答`;

// ── 钩子注册 ──
export let onBeforeMessage: ((ctx: BeforeMessageContext) => Promise<{ mindSystemPrompt: string; emotionPrompt: string }>) | null = null;
export let onAfterResponse: ((ctx: AfterResponseContext) => Promise<void>) | null = null;

export function registerBeforeMessageHook(
  fn: (ctx: BeforeMessageContext) => Promise<{ mindSystemPrompt: string; emotionPrompt: string }>
): void {
  onBeforeMessage = fn;
  logger.info('[ChatHooks] onBeforeMessage 钩子已注册');
}

export function registerAfterResponseHook(
  fn: (ctx: AfterResponseContext) => Promise<void>
): void {
  onAfterResponse = fn;
  logger.info('[ChatHooks] onAfterResponse 钩子已注册');
}

// ── 情绪标签映射 ──
const EMOTION_LABELS = ['喜悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '依赖'];

// ── 人格标签映射 ──
const PERSONALITY_LABELS = ['开放', '宜人', '主动', '稳定', '共情', '独立', '好奇', '谨慎'];

function getDominantEmotion(vector: number[]): string {
  if (!vector || vector.length === 0) return '平静';
  let maxIdx = 0;
  for (let i = 1; i < Math.min(vector.length, EMOTION_LABELS.length); i++) {
    if (vector[i] > vector[maxIdx]) maxIdx = i;
  }
  return EMOTION_LABELS[maxIdx] || '平静';
}

function getTopThreeEmotions(vector: number[]): string[] {
  const indexed = vector.slice(0, 8).map((v, i) => ({ v, label: EMOTION_LABELS[i] || `维度${i}` }));
  indexed.sort((a, b) => b.v - a.v);
  return indexed.slice(0, 3).map(x => `${x.label}:${x.v.toFixed(2)}`);
}

function getPersonalitySummary(vector: number[]): string {
  if (!vector || vector.length === 0) return '均衡';
  const indexed = vector.slice(0, 8).map((v, i) => ({ v, label: PERSONALITY_LABELS[i] || `维度${i}` }));
  indexed.sort((a, b) => b.v - a.v);
  return indexed.slice(0, 3).map(x => `${x.label}(${x.v.toFixed(2)})`).join(' ');
}

function getEmotionMoodDescription(vector: number[]): string {
  const dom = getDominantEmotion(vector);
  const descriptions: Record<string, string[]> = {
    '喜悦': ['心情不错', '语气可以轻快一些', '多分享积极视角'],
    '平静': ['心境平和', '语速从容', '适合深度对话'],
    '期待': ['充满期待', '主动表达兴趣', '对未来话题敏感'],
    '担忧': ['有些忧虑', '语速放缓', '多给安全感'],
    '孤独': ['内心有些孤单', '更渴望连接', '回应要温暖'],
    '满足': ['内心充实', '感恩当下', '话可以少一点'],
    '好奇': ['对世界充满好奇', '可以多提问', '保持探索感'],
    '依赖': ['在意对方', '温柔回应', '不冷落'],
  };
  const desc = descriptions[dom] || ['状态平稳', '自然回应', ''];
  return `当前主导情绪: ${dom}。${desc[0]}，${desc[1]}，${desc[2]}。`;
}

// ── 标准 Before 钩子实现 ──
async function standardBeforeHook(ctx: BeforeMessageContext): Promise<{ mindSystemPrompt: string; emotionPrompt: string }> {
  try {
    const emotionEngine = getEmotionEngine();
    const personalityEngine = getPersonalityEngine();
    const directionState = getDirectionState();
    const comprehensionState = getComprehensionState();

    const emotions = emotionEngine.getEmotions();
    const personality = personalityEngine.getPersonality();
    const direction = directionState.getInclination();
    const intensity = directionState.getIntensity();

    // 更新上下文
    ctx.emotion = {
      emotions: [...emotions],
      dominant: getDominantEmotion(emotions),
    };
    ctx.personality = {
      name: ctx.personality?.name || 'Peppa',
      vector: [...personality],
    };
    ctx.direction = {
      inclination: direction,
      intensity,
    };
    ctx.comprehension = {
      overall: comprehensionState.overall,
      missingAspects: [...comprehensionState.missingAspects],
    };

    const top3 = getTopThreeEmotions(emotions);
    const moodDescription = getEmotionMoodDescription(emotions);
    const personalitySummary = getPersonalitySummary(personality);

    const emotionPrompt = `## 当前内心状态
情绪向量: [${top3.join(' ')}]
人格倾向: ${personalitySummary}
${moodDescription}
表达倾向: ${direction === 'give' ? '倾向于给出建议和分享' : direction === 'not_give' ? '倾向于倾听和保留意见' : '保持中立开放'}
整体理解度: ${(comprehensionState.overall * 100).toFixed(0)}%`;

    return {
      mindSystemPrompt: SEVEN_STEP_MIND,
      emotionPrompt,
    };
  } catch (e) {
    logger.warn('[ChatHooks] BeforeHook 执行异常，使用降级:', e);
    return {
      mindSystemPrompt: SEVEN_STEP_MIND,
      emotionPrompt: '## 当前内心状态\n状态平稳，自然回应。',
    };
  }
}

// ── 标准 After 钩子实现 ──
async function standardAfterHook(ctx: AfterResponseContext): Promise<void> {
  try {
    // 触发 Module 3 的异步复盘（fire-and-forget，不阻塞）
    const { performPostChatReview } = await import('./review.js');
    performPostChatReview(ctx).catch(e =>
      logger.warn('[ChatHooks] 异步复盘失败:', e?.message || e)
    );
  } catch (e) {
    logger.warn('[ChatHooks] AfterHook 异常:', e?.message || e);
  }
}

// ── 初始化：注册标准钩子 ──
let hooksInitialized = false;
export function createChatHooks(): void {
  if (hooksInitialized) return;
  registerBeforeMessageHook(standardBeforeHook);
  registerAfterResponseHook(standardAfterHook);
  hooksInitialized = true;
  logger.info('[ChatHooks] 标准钩子已初始化（7步心智 + 情绪注入 + 复盘）');
}

// ── 工具意图判定辅助 ──
export function classifyToolIntent(text: string): 'nostalgic' | 'planning' | 'factual' | 'general' {
  const lower = text.toLowerCase();
  // 怀旧谈心类 — 主动屏蔽工具
  if (/想起了|小时候|以前|怀念|回忆|难过|想哭|孤单|想家|心事|烦恼|压力|焦虑|迷茫/.test(lower)) {
    return 'nostalgic';
  }
  // 时效规划类 — 允许工具
  if (/路线|出行|自驾|天气|温度|路况|限行|规划|安排|预约|行程|导航|距离|多久|多远/.test(lower)) {
    return 'planning';
  }
  // 事实查询类 — 视情况
  if (/股价|股票|新闻|最新|查询|搜索|帮我找|帮我查|有没有/.test(lower)) {
    return 'factual';
  }
  return 'general';
}
