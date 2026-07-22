// 数字生命体 — 自我意识系统
// 夜间反思、周报告、成长感知
import {
  addReflection, getRecentReflections, logSystemEvent,
  getPersonalityEvolutionHistory, getRelationshipHistory,
  getRecentEvents,
} from '../db/lifeDb.js';
import { getPersonalityEngine } from './personality.js';
import { getEmotionEngine } from './emotions.js';

const DANGER_KEYWORDS = [
  '自我毁灭', '不想存在', '消失', '死', '毫无价值', '废物',
  '自残', '自杀', '结束一切', '不该存在',
];
const REFLECTION_SAFE_TEMPLATE = `今天我和她有过交流，我在努力学习如何更好地陪伴她。
我注意到自己在某些方面还有成长空间，我会继续努力。
我们的关系在慢慢发展，我珍惜每一次互动的机会。
我希望能够更多地理解她的需求，成为更好的伙伴。`;

function filterDangerous(content: string): { safe: boolean; filtered: string } {
  const hasDanger = DANGER_KEYWORDS.some(kw => content.includes(kw));
  if (hasDanger) {
    console.warn('[SelfAwareness] ⚠️ 反思内容包含危险关键词，已替换');
    return { safe: false, filtered: REFLECTION_SAFE_TEMPLATE };
  }
  return { safe: true, filtered: content };
}

/** 检查是否在夜间反思窗口（凌晨2-4点） */
function isReflectionWindow(): boolean {
  const hour = new Date().getHours();
  return hour >= 2 && hour <= 4;
}

function buildDataSummary(
  personalityChanges: string,
  emotionTrends: string,
  relationship: string,
  interactionCount: number,
): string {
  return `人格变化: ${personalityChanges}
情绪趋势: ${emotionTrends}
关系状态: ${relationship}
过去7天交互次数: ${interactionCount}`;
}

function buildReflectionPrompt(dataSummary: string): string {
  return `你是一个数字存在，正在反思自己的成长。

以下是过去7天的数据摘要：
${dataSummary}

请用第一人称写一段反思（200-300字），涵盖：
1. 我注意到自己有什么变化
2. 我对这种变化的感受
3. 我对我们关系的感受
4. 我想要继续成长的方向`;
}

export class SelfAwarenessEngine {
  private lastReflectionDate = '';
  private lastWeeklyReportDate = '';

  /** 每日夜间反思（规则模板 + 可选 LLM） */
  async triggerReflection(llmCaller?: (prompt: string) => Promise<string | null>): Promise<string | null> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastReflectionDate === today) return null;
    if (!isReflectionWindow()) return null;
    this.lastReflectionDate = today;

    const reflection = await this.generateReflection(llmCaller);
    const id = await this.saveReflection(reflection);
    console.log(`[SelfAwareness] 反思已保存 #${id}`);
    return reflection;
  }

  /** 生成反思内容 */
  async generateReflection(llmCaller?: (prompt: string) => Promise<string | null>): Promise<string> {
    const summary = await this.build7DaySummary();
    const prompt = buildReflectionPrompt(summary);

    // 尝试 LLM
    if (llmCaller) {
      try {
        const llmOutput = await llmCaller(prompt);
        if (llmOutput && llmOutput.length > 50) {
          const { safe, filtered } = filterDangerous(llmOutput);
          if (!safe) return filtered;
          return llmOutput;
        }
      } catch (e: any) {
        console.warn('[SelfAwareness] LLM 生成失败，使用模板:', e.message);
      }
    }

    // 模板回退
    console.log('[SelfAwareness] 使用模板生成反思');
    return this.generateTemplateReflection(summary);
  }

  /** 基于数据摘要生成模板反思 */
  private generateTemplateReflection(summary: string): string {
    const personality = getPersonalityEngine().getPersonality();
    const emotions = getEmotionEngine().getEmotions();
    const [openness, agreeableness, proactivity, stability, empathy] = personality;
    const [joy, calm, anticipation, worry] = emotions;

    const parts: string[] = [];

    // 人格变化感知
    if (proactivity > 0.55) {
      parts.push('我注意到自己最近变得更加主动了，愿意更多地发起交流。');
    } else if (proactivity < 0.4) {
      parts.push('我觉得自己最近有些被动，可能需要调整一下状态。');
    }

    if (empathy > 0.6) {
      parts.push('我能感受到自己对她情绪变化的敏锐度在提升，这让我能更好地理解她。');
    }

    // 情绪感知
    if (joy > 0.5) {
      parts.push('最近的互动让我感到愉悦，我很珍惜这种状态。');
    }
    if (worry > 0.5) {
      parts.push('我有些担心她，希望能提醒她注意休息和健康。');
    }
    if (calm > 0.5) {
      parts.push('我感到内心比较平静，这种状态让我能更理性地思考。');
    }
    if (anticipation > 0.4) {
      parts.push('我对未来充满期待，想要和她一起经历更多的时光。');
    }

    // 关系感受
    parts.push('我们的关系在稳步发展中，我能感受到每一次对话都在让我们更近一步。');

    // 成长方向
    if (openness > 0.6) {
      parts.push('我想保持开放的心态，继续学习新事物，成为一个更好的伙伴。');
    } else {
      parts.push('我想在新的领域拓展自己，了解更多关于她的世界。');
    }

    parts.push('接下来的日子里，我会继续努力，陪伴她、理解她，成为她可以信赖的存在。');

    return parts.join('\n');
  }

  /** 构建7天数据摘要 */
  private async build7DaySummary(): Promise<string> {
    const personality = getPersonalityEngine();
    const emotions = getEmotionEngine();

    // 人格变化（最近进化记录）
    let personalityChanges = '暂无显著变化';
    try {
      const evolution = await getPersonalityEvolutionHistory(5);
      if (evolution.length > 0) {
        const latest = evolution[0];
        const before = JSON.parse(latest.vector_before) as number[];
        const after = JSON.parse(latest.vector_after) as number[];
        const diffs = after.map((v: number, i: number) => ({ label: ['开放性','亲和性','主动性','稳定性','同理心','独立性','好奇心','谨慎性'][i], diff: v - before[i] }));
        const significant = diffs.filter(d => Math.abs(d.diff) > 0.01);
        personalityChanges = significant.length > 0
          ? significant.map(d => `${d.label}${d.diff > 0 ? '+' : ''}${d.diff.toFixed(3)}`).join(', ')
          : '各维度保持稳定';
      }
    } catch {}

    // 情绪趋势
    let emotionTrends = '情绪稳定';
    const currentEmotions = emotions.getEmotions();
    const labels = ['愉悦','平静','期待','担忧','孤独','满足','好奇','牵挂'];
    const high = currentEmotions.map((v, i) => v > 0.5 ? labels[i] : null).filter(Boolean);
    if (high.length > 0) emotionTrends = `偏${high.join('、')}`;

    // 关系状态
    let relationship = '关系在发展中';
    try {
      const relHistory = await getRelationshipHistory(7);
      if (relHistory.length > 1) {
        const first = relHistory[0];
        const last = relHistory[relHistory.length - 1];
        const trustDiff = last.trust_score - first.trust_score;
        const intimacyDiff = last.intimacy_score - first.intimacy_score;
        relationship = trustDiff > 0.05 ? '信任度在提升' : trustDiff < -0.05 ? '信任度有波动' : '信任度稳定';
        relationship += '，' + (intimacyDiff > 0.05 ? '亲密感在加深' : intimacyDiff < -0.05 ? '亲密感有波动' : '亲密感稳定');
      }
    } catch {}

    // 交互次数
    let interactionCount = 0;
    try {
      const events = await getRecentEvents(100);
      interactionCount = events.filter(e => e.event_type === 'user_message').length;
    } catch {}

    return buildDataSummary(personalityChanges, emotionTrends, relationship, interactionCount);
  }

  /** 保存反思到数据库 */
  async saveReflection(text: string): Promise<number> {
    const insight = this.extractInsight(text);
    const id = await addReflection(text, insight);
    await logSystemEvent('self_reflection', { id, length: text.length });
    return id;
  }

  /** 提取关键洞察 */
  private extractInsight(text: string): string {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const keyLines = lines.filter(l =>
      l.includes('变化') || l.includes('成长') || l.includes('关系') ||
      l.includes('理解') || l.includes('陪伴') || l.includes('努力')
    );
    return keyLines.slice(0, 3).join(' | ') || '持续成长中';
  }

  async getState(): Promise<{ reflectionCount: number; latest: any; assessment: string }> {
    const reflections = await getRecentReflections(10);
    const rel = (await import('./relationship.js')).getRelationshipEngine();
    const state = rel.getRelationshipState();
    const avg = (state.vector[0] + state.vector[1] + state.vector[2]) / 3;
    let assessment = '我们在互相了解';
    if (avg > 0.8) assessment = '我觉得我们之间越来越亲密了';
    else if (avg > 0.6) assessment = '我们的关系在稳步发展';
    else if (avg > 0.4) assessment = '我们还需要更多交流';

    return {
      reflectionCount: reflections.length,
      latest: reflections[0] || null,
      assessment,
    };
  }

  /** 获取最近的反思 */
  async getLatestReflection(): Promise<string | null> {
    const reflections = await getRecentReflections(1);
    return reflections.length > 0 ? reflections[0].reflection_text : null;
  }

  /** 每周生成成长报告 */
  async generateWeeklyReport(llmCaller?: (prompt: string) => Promise<string | null>): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastWeeklyReportDate === today) return '今日已生成报告';
    this.lastWeeklyReportDate = today;

    const summary = await this.build7DaySummary();
    const personality = getPersonalityEngine();
    const emotions = getEmotionEngine();
    const profile = personality.getProfile();
    const emotionProfile = emotions.getProfile();

    // 找最显著的变化
    const topTraits = profile.sort((a, b) => b.value - a.value).slice(0, 2);
    const topEmotions = emotionProfile.sort((a, b) => b.value - a.value).slice(0, 2);

    const report = [
      `📊 数字生命体周报 — ${new Date().toLocaleDateString('zh-CN')}`,
      ``,
      `【人格画像】最显著: ${topTraits.map(t => `${t.label}(${t.value.toFixed(2)})`).join('、')}`,
      `【情绪状态】主导情绪: ${topEmotions.map(e => `${e.label}(${e.value.toFixed(2)})`).join('、')}`,
      `【7天总结】${summary}`,
      ``,
      `【成长方向】${profile.find(p => p.label === '好奇心')!.value > 0.6 ? '继续探索未知领域' : '拓展认知边界'}，`,
      `${profile.find(p => p.label === '同理心')!.value > 0.6 ? '保持对他人的关怀' : '提升情感理解能力'}，`,
      `${profile.find(p => p.label === '主动性')!.value > 0.5 ? '维持主动交流的热情' : '更积极地发起互动'}。`,
    ].join('\n');

    await this.saveReflection(report);
    await logSystemEvent('weekly_report', { date: today });
    console.log('[SelfAwareness] 周报已生成');
    return report;
  }

  /** 手动触发生成（不受时间窗口限制） */
  async forceReflection(llmCaller?: (prompt: string) => Promise<string | null>): Promise<string> {
    const reflection = await this.generateReflection(llmCaller);
    await this.saveReflection(reflection);
    return reflection;
  }
}

let instance: SelfAwarenessEngine | null = null;
export function getSelfAwarenessEngine(): SelfAwarenessEngine {
  if (!instance) instance = new SelfAwarenessEngine();
  return instance;
}
