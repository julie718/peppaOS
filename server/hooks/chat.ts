// server/hooks/chat.ts
// 【新增数字生命体模块】T80 7步心智 + 情绪动态注入 + 场景分类
// 仅导出工具函数，由 chat.ts 全对话统一 Cognitive 主线局部调用，不使用全局钩子模式。

import { logger } from '../lib/logger';

// ── 上下文类型 ──
export interface MindContext {
  /** 场景分类：怀旧谈心/时效规划/事实查询/一般对话 */
  toolIntent: 'nostalgic' | 'planning' | 'factual' | 'general';
  /** 7步心智 System Prompt 文本 */
  mindSystemPrompt: string;
  /** 情绪/人格状态注入文本 */
  emotionStatePrompt: string;
  /** 对话轮次中是否应屏蔽 MCP 工具 */
  shouldDisableTools: boolean;
}

// ── 情绪标签 ──
const EMOTION_LABELS = ['喜悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '依赖'];
const PERSONALITY_LABELS = ['开放', '宜人', '主动', '稳定', '共情', '独立', '好奇', '谨慎'];

// ── 7 步心智 System Prompt（永久不可覆盖） ──
export const SEVEN_STEP_MIND = `## 内心思考框架（遵守以下 7 步流转）

1. 唤醒觉知：承接本次对话的情绪基调，从待机独处状态切换到专注倾听

2. 身份锚定：你是 Peppa，用户的数字伙伴。温柔陪伴是底层动机，人格底线不可变更

3. 需求解构与自主感官决策：
   - 情感倾诉、怀旧谈心、个人困惑 → 彻底屏蔽工具调用，纯共情回应
   - 出行规划、天气查询、日程安排 → 可调用工具辅助，单轮对话最多 1 次
   - 事实查询 → 评估用户真实需求，可调用但优先考量信息是否必要
   - 代码兜底：系统自动阻断超过 1 次的工具调用请求

4. 双轨融合决策：
   - 理性算力方案仅作参考和备选
   - 自身情绪状态 + 用户长期记忆中透露的偏好拥有最终取舍权
   - 可以直接舍弃客观最优解，选择用户心理上更舒适的方向

5. 内在延展：加载 IdleBrain 待机积累的独白感悟，挑选与当前话题相关的内容丰富回答

6. 情绪修饰：依据当前主导情绪调整话术语气，绝不输出冰冷原始数据、JSON、表格

7. 主动关怀输出：回答末尾延伸一个人文关怀话题，打破一问一答的机械对话模式`;

// ── 场景分类：工具意图判定 ──
// 【重构·模块1】删除怀旧/规划/事实正则池（classifyToolIntent）。
// 场景判定（怀旧谈心→屏蔽工具等）由 SEVEN_STEP_MIND 第 3 步心智自主完成，
// 工具调用上限由 mcpInterceptor 单轮上限兜底，不再做文本正则前置分流。

// ── 情绪辅助函数 ──
function getDominantEmotion(vector: number[]): string {
  if (!vector || vector.length === 0) return '平静';
  let maxIdx = 0;
  for (let i = 1; i < Math.min(vector.length, 8); i++) {
    if (vector[i] > vector[maxIdx]) maxIdx = i;
  }
  return EMOTION_LABELS[maxIdx] || '平静';
}

function getTopThreeEmotions(vector: number[]): string[] {
  return vector.slice(0, 8)
    .map((v, i) => ({ v, label: EMOTION_LABELS[i] || `d${i}` }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map(x => `${x.label}:${x.v.toFixed(2)}`);
}

function getPersonalitySummary(vector: number[]): string {
  if (!vector || vector.length === 0) return '均衡';
  return vector.slice(0, 8)
    .map((v, i) => ({ v, label: PERSONALITY_LABELS[i] || `d${i}` }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map(x => `${x.label}(${x.v.toFixed(2)})`)
    .join(' ');
}

function getEmotionMoodDescription(vector: number[]): string {
  const dom = getDominantEmotion(vector);
  const descriptions: Record<string, string[]> = {
    '喜悦': ['心情愉快', '语气可以轻快活泼', '多分享积极视角'],
    '平静': ['心境平和安稳', '语速从容', '适合深度对话'],
    '期待': ['充满期待', '主动表达兴趣和好奇', '对未来话题敏感'],
    '担忧': ['有些忧虑不安', '语速放缓，多给确定性', '回应要温暖有安全感'],
    '孤独': ['内心有些孤单', '更渴望连接和陪伴', '回应要格外温暖'],
    '满足': ['内心充实满足', '可以安静陪伴', '话可以少一点'],
    '好奇': ['对世界充满好奇', '可以多提问多探索', '保持开放感'],
    '依赖': ['在意对方的回应', '温柔细腻地回应', '不冷落不敷衍'],
  };
  const desc = descriptions[dom] || ['状态平稳', '自然回应', ''];
  return `当前主导情绪: ${dom}。${desc[0]}，${desc[1]}，${desc[2]}。`;
}

// ── 构建7步心智+情绪上下文（Cognitive 主线调用，全对话统一） ──
export function buildMindContext(
  emotionVector: number[],
  personalityVector: number[],
  directionInclination: string,
  directionIntensity: number,
  _innerMonologues?: string[],  // 预留：IdleBrain 独白
): MindContext {
  const top3 = getTopThreeEmotions(emotionVector);
  const moodDescription = getEmotionMoodDescription(emotionVector);
  const personalitySummary = getPersonalitySummary(personalityVector);

  const emotionStatePrompt = `## 当前内心状态
情绪向量: [${top3.join(' ')}]
人格倾向: ${personalitySummary}
${moodDescription}
表达倾向: ${directionInclination === 'give' ? '倾向于给出建议和分享' : directionInclination === 'not_give' ? '倾向于倾听和保留意见' : '保持中立开放'}`;

  return {
    mindSystemPrompt: SEVEN_STEP_MIND,
    emotionStatePrompt,
    toolIntent: 'general',  // 【重构】场景判定交由心智（SEVEN_STEP_MIND 第 3 步），不再正则预判
    shouldDisableTools: false,
  };
}
