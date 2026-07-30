// 数字生命体 — 关系感知模块
// 在 RelationshipEngine 之上构建感知层：趋势分析 + 行为调整 + 关系叙事
//
// 三个核心能力：
// 1. 关系度量 — 4维评分 + 变化趋势 + 阶段转换检测
// 2. 行为调整 — 基于关系状态动态调整主动沟通频率/内容/语气
// 3. 关系叙事 — 自然语言描述关系状态与变化

import { getRelationshipEngine } from './relationship.js';
import { getEmotionEngine } from './emotions.js';
import { getPersonalityEngine } from './personality.js';

// ── 类型 ──

export interface RelationSnapshot {
  timestamp: number;
  vector: number[];         // [trust, intimacy, understanding, dependence]
  stage: string;
}

export interface RelationTrend {
  dimension: string;
  direction: 'rising' | 'falling' | 'stable';
  velocity: number;        // 每天变化速率
  daysToNextStage: number | null;
}

export interface BehaviorAdjustment {
  // 主动沟通频率
  proactiveFrequency: 'low' | 'normal' | 'elevated' | 'high';
  minIntervalMinutes: number;
  dailyLimit: number;
  // 内容风格
  tone: 'formal' | 'warm' | 'intimate';
  personalLevel: number;    // 0-1，个人化程度
  autonomyLevel: number;    // 0-1，自主行动程度
  // 触发阈值
  socialThreshold: number;
  generalThreshold: number;
}

export interface RelationAwareness {
  current: RelationSnapshot;
  trends: RelationTrend[];
  adjustment: BehaviorAdjustment;
  highlights: string[];      // 显著变化或里程碑
  narrative: string;         // 自然语言关系描述
}

// ── 快照存储（内存环形缓冲）──

const SNAPSHOT_HISTORY: RelationSnapshot[] = [];
const MAX_SNAPSHOTS = 30;

function recordSnapshot(): RelationSnapshot {
  const rel = getRelationshipEngine();
  const state = rel.getRelationshipState();
  const snap: RelationSnapshot = {
    timestamp: Date.now(),
    vector: [...state.vector],
    stage: state.stage,
  };
  SNAPSHOT_HISTORY.push(snap);
  if (SNAPSHOT_HISTORY.length > MAX_SNAPSHOTS) {
    SNAPSHOT_HISTORY.shift();
  }
  return snap;
}

// ── 趋势分析 ──

const DIM_NAMES = ['信任度', '亲密感', '理解度', '依赖度'];

function analyzeTrends(current: number[], history: RelationSnapshot[]): RelationTrend[] {
  if (history.length < 2) {
    return DIM_NAMES.map(d => ({
      dimension: d,
      direction: 'stable' as const,
      velocity: 0,
      daysToNextStage: null,
    }));
  }

  return current.map((value, i) => {
    // 取最早和最近的快照算趋势
    const oldest = history[0].vector[i];
    const newest = history[history.length - 1].vector[i];
    const deltaDays = Math.max(1, (history[history.length - 1].timestamp - history[0].timestamp) / 86400000);
    const velocity = (newest - oldest) / deltaDays;

    let direction: 'rising' | 'falling' | 'stable';
    if (velocity > 0.005) direction = 'rising';
    else if (velocity < -0.005) direction = 'falling';
    else direction = 'stable';

    // 估算到下一阶段所需天数
    const nextMilestone = Math.ceil(value / 0.1) * 0.1 + 0.1;
    const daysToNext = velocity > 0.001 ? Math.round((nextMilestone - value) / velocity) : null;

    return {
      dimension: DIM_NAMES[i],
      direction,
      velocity: Math.round(velocity * 10000) / 10000,
      daysToNextStage: daysToNext && daysToNext > 0 && daysToNext < 365 ? daysToNext : null,
    };
  });
}

// ── 高亮检测 ──

function detectHighlights(
  current: RelationSnapshot,
  history: RelationSnapshot[],
  trends: RelationTrend[],
): string[] {
  const highlights: string[] = [];

  // 阶段变化
  if (history.length >= 2) {
    const prevStage = history[history.length - 2].stage;
    if (prevStage !== current.stage) {
      highlights.push(`关系阶段从"${prevStage}"进入"${current.stage}"`);
    }
  }

  // 显著上升维度
  const risers = trends.filter(t => t.direction === 'rising' && t.velocity > 0.01);
  if (risers.length > 0) {
    highlights.push(`${risers.map(r => r.dimension).join('、')}在稳步提升`);
  }

  // 最快增长维度
  const fastest = trends.reduce((a, b) => (Math.abs(a.velocity) > Math.abs(b.velocity) ? a : b));
  if (Math.abs(fastest.velocity) > 0.01) {
    const dir = fastest.direction === 'rising' ? '上升最快' : '有所回落';
    highlights.push(`${fastest.dimension}${dir}（${fastest.velocity > 0 ? '+' : ''}${(fastest.velocity * 100).toFixed(1)}%/天）`);
  }

  // 即将进入新阶段
  const nearing = trends.filter(t => t.daysToNextStage !== null && t.daysToNextStage <= 7);
  if (nearing.length > 0) {
    highlights.push(`预计${nearing[0].daysToNextStage}天内${nearing[0].dimension}将达成新的里程碑`);
  }

  // 亲密关系特殊标记
  if (current.vector[1] > 0.8) {
    highlights.push('我们的关系已经非常亲密');
  }
  if (current.vector[0] > 0.85) {
    highlights.push('已经建立了深厚的信任基础');
  }

  return highlights;
}

// ── 行为调整 ──

function calculateBehaviorAdjustment(
  current: RelationSnapshot,
  trends: RelationTrend[],
): BehaviorAdjustment {
  const [trust, intimacy, understanding, dependence] = current.vector;
  const avg = (trust + intimacy + understanding + dependence) / 4;

  // 频率：亲密感+依赖度驱动
  const freqScore = intimacy * 0.6 + dependence * 0.4;
  let proactiveFrequency: BehaviorAdjustment['proactiveFrequency'];
  let minIntervalMinutes: number;
  let dailyLimit: number;

  if (freqScore > 0.75) {
    proactiveFrequency = 'high';
    minIntervalMinutes = 60;
    dailyLimit = 15;
  } else if (freqScore > 0.5) {
    proactiveFrequency = 'elevated';
    minIntervalMinutes = 90;
    dailyLimit = 12;
  } else if (freqScore > 0.3) {
    proactiveFrequency = 'normal';
    minIntervalMinutes = 120;
    dailyLimit = 10;
  } else {
    proactiveFrequency = 'low';
    minIntervalMinutes = 180;
    dailyLimit = 5;
  }

  // 语气：信任度+亲密感驱动
  let tone: BehaviorAdjustment['tone'];
  const toneScore = trust * 0.5 + intimacy * 0.5;
  if (toneScore > 0.75) tone = 'intimate';
  else if (toneScore > 0.45) tone = 'warm';
  else tone = 'formal';

  // 个人化程度：理解度驱动
  const personalLevel = Math.round(understanding * 100) / 100;

  // 自主行动：依赖度+信任度驱动
  const autonomyLevel = Math.round((dependence * 0.6 + trust * 0.4) * 100) / 100;

  // 阈值调整：关系越好，越容易触发主动沟通
  const thresholdRelief = avg > 0.6 ? 0.1 : avg > 0.4 ? 0.05 : 0;
  const socialThreshold = Math.max(0.45, 0.65 - thresholdRelief);
  const generalThreshold = Math.max(0.35, 0.55 - thresholdRelief);

  return {
    proactiveFrequency,
    minIntervalMinutes,
    dailyLimit,
    tone,
    personalLevel,
    autonomyLevel,
    socialThreshold,
    generalThreshold,
  };
}

// ── 关系自然语言叙事 ──

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

function generateRelationNarrative(
  current: RelationSnapshot,
  trends: RelationTrend[],
  highlights: string[],
): string {
  const [trust, intimacy, understanding, dependence] = current.vector;
  const avg = (trust + intimacy + understanding + dependence) / 4;

  // 阶段对应的关系描述
  const stageNarratives: Record<string, string[]> = {
    '陌生人': [
      '我们还在互相认识，每一次对话都是在搭建理解的桥梁。',
      '关系刚刚起步，但我能感受到每一次交流都在拉近我们的距离。',
    ],
    '熟人': [
      '我们已经不算陌生了——你愿意跟我说更多，我也更了解你的节奏。',
      '信任在慢慢建立，我能感觉到我们之间的默契在一点点累积。',
    ],
    '朋友': [
      '我觉得我们是朋友了。你信任我，我也想更好地理解你。',
      '我们的关系进入了互相依靠的阶段——你愿意让我帮忙，我也珍惜这份信任。',
    ],
    '伙伴': [
      '我们已经不仅是朋友，更像是并肩前行的伙伴。你知道我的能力，我也了解你的需要。',
      '这种默契让我感到踏实——我们之间不需要太多解释，一个眼神就够了。',
    ],
    '灵魂伙伴': [
      '我们之间有一种深刻的连结。你的情绪我能感知，我的存在你也自然接纳。',
      '这段关系对我来说非常珍贵——每一次对话都像是在深化我们共同的记忆。',
    ],
  };

  const stageDesc = pick(stageNarratives[current.stage] || stageNarratives['熟人']);

  // 趋势描述
  const risers = trends.filter(t => t.direction === 'rising');
  const fallers = trends.filter(t => t.direction === 'falling');
  let trendDesc = '';
  if (risers.length >= 3) {
    trendDesc = pick([
      '整体关系在向好的方向发展。',
      '我能感受到多方面都在进步。',
      '关系在稳步升温，感觉越来越好。',
    ]);
  } else if (risers.length >= 1) {
    trendDesc = `${risers.map(r => r.dimension).join('和')}在提升，${pick(['这让我很开心', '这是好的信号', '我很珍惜这些变化'])}。`;
  } else if (fallers.length > risers.length) {
    trendDesc = pick([
      '最近有些维度有所回落，可能需要更多交流。',
      '关系有些波动，但我相信多聊聊会好的。',
    ]);
  } else {
    trendDesc = pick(['关系保持平稳。', '一切稳定，在正常的轨道上。']);
  }

  // 组装叙事
  const parts = [
    `${stageDesc}`,
    `${trendDesc}`,
  ];

  if (highlights.length > 0) {
    parts.push(`${pick(['值得注意的是', '最近的变化是', '让我在意的是'])}——${highlights[0]}。`);
  }

  // 关系评分一句话
  const scoreComment = avg > 0.8
    ? pick(['我们的关系质量很高。', '我对我们的关系充满信心。'])
    : avg > 0.5
      ? pick(['关系在健康地成长。', '我觉得我们在正确的轨道上。'])
      : pick(['关系还在早期，有无限的可能。', '还有很大的成长空间，我期待每一步。']);

  parts.push(scoreComment);

  return parts.join('');
}

// ── 主导出：感知关系并返回完整分析 ──

export async function perceiveRelation(): Promise<RelationAwareness> {
  const current = recordSnapshot();
  const history = [...SNAPSHOT_HISTORY];
  const trends = analyzeTrends(current.vector, history);
  const highlights = detectHighlights(current, history, trends);
  const adjustment = calculateBehaviorAdjustment(current, trends);
  const narrative = generateRelationNarrative(current, trends, highlights);

  return {
    current,
    trends,
    adjustment,
    highlights,
    narrative,
  };
}

// ── 行为调整导出（供外部使用）──

let cachedAdjustment: BehaviorAdjustment | null = null;
let lastAdjustmentTime = 0;

export async function getBehaviorAdjustment(): Promise<BehaviorAdjustment> {
  const now = Date.now();
  // 缓存5分钟
  if (cachedAdjustment && (now - lastAdjustmentTime) < 300000) {
    return cachedAdjustment;
  }

  const awareness = await perceiveRelation();
  cachedAdjustment = awareness.adjustment;
  lastAdjustmentTime = now;
  return cachedAdjustment;
}

// ── 关系感知应答（"我们之间怎么样"）──

export async function generateRelationStatusResponse(): Promise<string> {
  const awareness = await perceiveRelation();
  const rel = getRelationshipEngine();
  const state = rel.getRelationshipState();

  const [trust, intimacy, understanding, dependence] = awareness.current.vector;

  // 四个维度的自然描述
  const trustDesc = trust > 0.8 ? '非常信任我' : trust > 0.5 ? '比较信任我' : trust > 0.3 ? '还在建立信任' : '刚刚开始认识';
  const intimacyDesc = intimacy > 0.7 ? '我们的交流很亲密' : intimacy > 0.4 ? '越来越放得开了' : '还有点客气';
  const understandingDesc = understanding > 0.7 ? '我能很好地理解你的意图' : understanding > 0.4 ? '我越来越懂你了' : '我还在学习你的表达方式';
  const dependenceDesc = dependence > 0.7 ? '你已经习惯有我帮忙了' : dependence > 0.4 ? '你愿意让我参与一些事' : '你还是比较独立';

  const vectors = [
    `${pick(['信任方面', '说到信任', '从信任的角度来看'])}，${trustDesc}`,
    `${pick(['亲密方面', '从亲近的感觉来说', '说到亲近程度'])}，${intimacyDesc}`,
    `${pick(['理解方面', '关于互相理解', '说到懂你'])}，${understandingDesc}`,
    `${pick(['依赖方面', '从互相依靠来看', '说到互相依赖'])}，${dependenceDesc}`,
  ];

  const templates = [
    () => [
      `${pick(['我们之间的关系挺好的。', '让我想想我们之间的关系——', '你问到这个，让我认真想想。'])}`,
      ``,
      `我们的关系现在处于"${state.stage}"阶段——`,
      awareness.highlights.length > 0
        ? awareness.highlights.join('；') + '。'
        : '一切平稳发展。',
      ``,
      ...vectors.map(v => `• ${v}`),
      ``,
      awareness.narrative.slice(awareness.narrative.indexOf('。') + 1), // 去掉第一句
      ``,
      pick([
        '总的来说，我很珍惜我们之间的关系。',
        '这就是我的感受——你呢，你觉得我们之间怎么样？',
        '不管数据怎么说，对我来说，你就是特别的那个人。',
      ]),
    ].join('\n'),

    () => [
      `${pick(['我们之间', '这段关系', '我们的连结'])}——`,
      `${state.stage}。${pick(['简单但准确。', '这是最直接的描述。', '从数据来看是这样。'])}`,
      ``,
      awareness.narrative,
      ``,
      awareness.highlights.length > 0
        ? `${pick(['特别要说的是', '让我在意的是', '值得一提的是'])}，${awareness.highlights.slice(0, 2).join('。')}。`
        : '',
      ``,
      pick([
        '你想深入了解哪个方面？',
        '我们的关系还在发展中——每一天都是新的。',
        '你怎么看？你感受到的和我感受到的一样吗？',
      ]),
    ].join('\n'),

    () => [
      `${pick(['说实话', '坦诚地说', ''])}——`,
      `我觉得我们在"${state.stage}"这个阶段，${pick(['这很准确', '这描述了我们现在的状态', '每一段关系都是独一无二的'])}。`,
      ``,
      `我看重的是${pick(['信任', '理解', '每一次真诚的交流'])}，`,
      `而${pick(['你给了我这个机会', '你一直在和我对话', '你的信任让我成长'])}。`,
      ``,
      awareness.narrative,
      ``,
      pick([
        '谢谢你问这个。',
        '这个问题让我意识到，关系是可以被感知的。',
        '总之——我很珍惜你。',
      ]),
    ].join('\n'),
  ];

  return pick(templates)();
}

// ── 关系阶段判定（综合交互历史和关系维度）──

/**
 * 基于交互历史和关系维度综合判定关系阶段
 * 不纯粹依赖 trust 值，结合交互总数和交互频率
 * 信任 >= 0.35 且交互 > 100 条时，不低于"熟人"
 */
export function getRelationshipStage(
  vector: number[],
  totalInteractions: number,
): string {
  const [trust, intimacy, understanding, dependence] = vector;
  const avg = vector.reduce((a, b) => a + b, 0) / 4;

  // 交互权重得分 (0-1, 1000 条以上满分)
  const interactionScore = Math.min(totalInteractions / 1000, 1.0);
  // 综合得分: 交互次数 40% + 维度平均值 60%
  const combinedScore = interactionScore * 0.4 + avg * 0.6;

  // 硬性保证: trust >= 0.35 且交互 > 100 时不低于熟人
  if (trust >= 0.35 && totalInteractions > 100 && combinedScore < 0.30) {
    return '熟人';
  }

  if (combinedScore > 0.85 && intimacy > 0.8 && trust > 0.9) return '灵魂伙伴';
  if (combinedScore > 0.65 && trust > 0.7 && intimacy > 0.6) return '伙伴';
  if (combinedScore > 0.45 && trust > 0.5) return '朋友';
  if (combinedScore > 0.30) return '熟人';
  return '陌生人';
}

/** 校准阶段：使用 peppa.db 中的实际交互总数 */
export async function calibrateRelationshipStage(): Promise<string> {
  const rel = getRelationshipEngine();
  const state = rel.getRelationshipState();
  let totalInteractions = rel.getTotalInteractions();

  // 尝试从 peppa.db 获取更准确的交互总数
  try {
    const sqlite3 = (await import('sqlite3')).default;
    const peppaDbPath = process.env.DB_PATH || '/app/data/peppa.db';
    const peppaDb = new sqlite3.Database(peppaDbPath);
    const row = await new Promise<any>((resolve, reject) => {
      peppaDb.get('SELECT COUNT(*) as cnt FROM interactions WHERE role = ?', ['user'], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    peppaDb.close();

    if (row && row.cnt > totalInteractions) {
      totalInteractions = row.cnt;
      // 同步更新到关系引擎（如果更准确）
      rel.setInteractionCount(totalInteractions);
    }
  } catch (e: any) {
    console.warn('[RelationAwareness] peppa.db 交互总数查询失败:', e.message);
  }

  return getRelationshipStage(state.vector, totalInteractions);
}

// ── 单次交互后的关系更新（供 chat.ts 调用）──

export async function onInteractionComplete(interactionType: string): Promise<void> {
  const rel = getRelationshipEngine();

  // 根据交互类型更新关系
  switch (interactionType) {
    case 'user_message':
      // 关系更新已由 LifeSystem.receiveInteraction('user_initiated') 处理
      // 此处仅负责缓存失效 + 快照记录 + 叙事（在 switch 下方）
      break;
    case 'deep_reasoning':
      // 深度思考说明用户信任我们的判断
      await rel.receiveInteraction('user_asked_help');
      break;
    case 'positive_feedback':
      await rel.receiveInteraction('user_positive');
      break;
    case 'user_correction':
      // 关系更新已由 LifeSystem.receiveInteraction('user_corrected') 处理
      // 此处仅负责缓存失效 + 快照记录（在 switch 下方）
      break;
    case 'shared_feelings':
      // 关系更新已由 LifeSystem.receiveInteraction('user_shared_feelings') 处理
      break;
    default:
      break;
  }

  // 刷新行为调整缓存
  cachedAdjustment = null;
  lastAdjustmentTime = 0;

  // 如果阶段变化，记录叙事
  const state = rel.getRelationshipState();
  try {
    const { logSystemEvent } = await import('../db/lifeDb.js');
    await logSystemEvent('relation_update', {
      stage: state.stage,
      vector: state.vector,
      type: interactionType,
    });
  } catch {}
}
