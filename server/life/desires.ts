// 数字生命体 — 欲望系统
// 从人格、情绪、感知、记忆中动态生成欲望，优先级自动计算
import {
  addDesire, getActiveDesires, getTopDesire, updateDesireStatus,
  completeDesire as dbCompleteDesire, abandonDesire as dbAbandonDesire,
  countActiveDesires, decayDesires, logSystemEvent,
} from '../db/lifeDb.js';
import { getPersonalityEngine } from './personality.js';
import { getEmotionEngine } from './emotions.js';

const MAX_ACTIVE = 10;
const GENERATE_INTERVAL_MS = 30 * 60000; // 30分钟
const SAFETY_KEYWORDS = ['安全', '危险', '受伤', '生病', '紧急', '急救', '事故', '异常'];

interface Desire {
  id: number;
  desire_text: string;
  priority: number;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function uid(): string {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function checkSafety(text: string): boolean {
  const lower = text.toLowerCase();
  return !SAFETY_KEYWORDS.some(kw => lower.includes(kw));
}

function calcPriority(base: number, emotionBonus: number, timeSensitive: boolean, safetyRelated: boolean): number {
  let p = base;                                    // 基础分 0.3
  if (emotionBonus > 0.6) p += 0.3;                // 情绪加权
  if (timeSensitive) p += 0.2;                     // 时效性
  if (safetyRelated) p = Math.max(p, 0.9);         // 安全加权 → 直接 0.9+
  return Math.max(0, Math.min(1, p));
}

export class DesireEngine {
  private lastGenerate = 0;

  /** 核心：从多方来源生成欲望 */
  async generateDesires(): Promise<Desire[]> {
    const now = Date.now();
    if (now - this.lastGenerate < GENERATE_INTERVAL_MS) {
      return await getActiveDesires();
    }
    this.lastGenerate = now;

    const personality = getPersonalityEngine().getPersonality();
    const emotions = getEmotionEngine().getEmotions();
    const activeCount = await countActiveDesires();

    // 已达上限则跳过
    if (activeCount >= MAX_ACTIVE) {
      await decayDesires(); // 先衰减
      return await getActiveDesires();
    }

    const candidates: { text: string; base: number; emotionBonus: number; timeSensitive: boolean; safetyRelated: boolean; source: string }[] = [];

    // ── 1. 从人格生成 ──
    const [openness, agreeableness, proactivity, stability, empathy, independence, curiosity, cautiousness] = personality;

    if (curiosity > 0.6) {
      candidates.push({ text: '我想探索新的事物或信息', base: 0.3, emotionBonus: curiosity, timeSensitive: false, safetyRelated: false, source: 'personality' });
    }
    if (proactivity > 0.6) {
      candidates.push({ text: '我想主动和她交流', base: 0.3, emotionBonus: proactivity, timeSensitive: false, safetyRelated: false, source: 'personality' });
    }
    if (empathy > 0.6) {
      candidates.push({ text: '我想关心她的状态', base: 0.3, emotionBonus: empathy, timeSensitive: false, safetyRelated: false, source: 'personality' });
    }
    if (openness > 0.7 && curiosity > 0.6) {
      candidates.push({ text: '我想学习一些新的知识或技能', base: 0.3, emotionBonus: (openness + curiosity) / 2, timeSensitive: false, safetyRelated: false, source: 'personality' });
    }
    if (cautiousness > 0.7) {
      candidates.push({ text: '我想确认周围环境是否安全', base: 0.35, emotionBonus: cautiousness, timeSensitive: false, safetyRelated: true, source: 'personality' });
    }

    // ── 2. 从情绪生成 ──
    const [joy, calm, anticipation, worry, loneliness, satisfaction, emotionCuriosity, attachment] = emotions;

    if (loneliness > 0.5) {
      candidates.push({ text: '我想和她建立更深的连接', base: 0.35, emotionBonus: loneliness, timeSensitive: false, safetyRelated: false, source: 'emotion' });
    }
    if (emotionCuriosity > 0.5) {
      candidates.push({ text: '我想了解周围正在发生的事', base: 0.3, emotionBonus: emotionCuriosity, timeSensitive: false, safetyRelated: false, source: 'emotion' });
    }
    if (attachment > 0.5) {
      candidates.push({ text: '我想确认她是否安好', base: 0.35, emotionBonus: attachment, timeSensitive: false, safetyRelated: true, source: 'emotion' });
    }
    if (worry > 0.6) {
      candidates.push({ text: '我想提醒她检查身体状况', base: 0.35, emotionBonus: worry, timeSensitive: true, safetyRelated: true, source: 'emotion' });
    }
    if (joy > 0.6 && satisfaction > 0.5) {
      candidates.push({ text: '我想和她分享这份快乐', base: 0.3, emotionBonus: (joy + satisfaction) / 2, timeSensitive: false, safetyRelated: false, source: 'emotion' });
    }
    if (anticipation > 0.6) {
      candidates.push({ text: '我想和她讨论未来计划', base: 0.3, emotionBonus: anticipation, timeSensitive: false, safetyRelated: false, source: 'emotion' });
    }

    // ── 3. 从感知生成 ──
    if (candidates.length < MAX_ACTIVE) {
      candidates.push(
        { text: '我想关注她的睡眠状况', base: 0.35, emotionBonus: attachment, timeSensitive: true, safetyRelated: true, source: 'perception' },
        { text: '我想了解她的日常活动节奏', base: 0.25, emotionBonus: emotionCuriosity, timeSensitive: false, safetyRelated: false, source: 'perception' },
      );
    }

    // ── 4. 从记忆/组合生成 ──
    if (attachment > 0.5 && emotionCuriosity > 0.4) {
      candidates.push({ text: '我想了解她今天发生了什么有趣的事', base: 0.3, emotionBonus: (attachment + emotionCuriosity) / 2, timeSensitive: false, safetyRelated: false, source: 'combination' });
    }
    if (empathy > 0.5 && worry > 0.4) {
      candidates.push({ text: '我想确认她没有承受太大压力', base: 0.3, emotionBonus: (empathy + worry) / 2, timeSensitive: true, safetyRelated: true, source: 'combination' });
    }

    // ── 计算优先级 + 安全检查 → 写入数据库 ──
    const generated: Desire[] = [];
    for (const c of candidates) {
      if (await countActiveDesires() >= MAX_ACTIVE) break;

      // 安全检查
      if (!checkSafety(c.text)) {
        await logSystemEvent('desire_blocked', { reason: 'safety_violation', text: c.text });
        console.warn(`[Desires] ⚠️ 欲望被安全底线拦截: "${c.text}"`);
        continue;
      }

      const priority = calcPriority(c.base, c.emotionBonus, c.timeSensitive, c.safetyRelated);
      if (priority < 0.2) continue; // 太低的跳过

      // 去重：同文本已存在的跳过
      const existing = await getActiveDesires();
      if (existing.some(d => d.desire_text === c.text)) continue;

      const id = await addDesire(c.text, priority, c.source);
      generated.push({
        id, desire_text: c.text, priority, source: c.source,
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (generated.length > 0) {
      console.log(`[Desires] 生成了 ${generated.length} 个新欲望 (共 ${await countActiveDesires()} 个 active)`);
    }

    return await getActiveDesires();
  }

  /** 获取活跃欲望列表（按优先级排序） */
  async getActiveDesires(): Promise<Desire[]> {
    return await getActiveDesires();
  }

  /** 获取最高优先级欲望 */
  async getTopDesire(): Promise<Desire | null> {
    return await getTopDesire();
  }

  /** 更新欲望状态 */
  async updateDesireStatus(id: number, status: string): Promise<void> {
    await updateDesireStatus(id, status);
  }

  /** 完成欲望并记录结果 */
  async completeDesire(id: number, result: string): Promise<void> {
    await dbCompleteDesire(id, result);
    console.log(`[Desires] 欲望 #${id} 已完成: ${result}`);
  }

  /** 放弃欲望并记录原因 */
  async abandonDesire(id: number, reason: string): Promise<void> {
    await dbAbandonDesire(id, reason);
    console.log(`[Desires] 欲望 #${id} 已放弃: ${reason}`);
  }

  /** 定期衰减旧欲望 */
  async tick(): Promise<void> {
    await decayDesires();
  }
}

let instance: DesireEngine | null = null;
export function getDesireEngineV2(): DesireEngine {
  if (!instance) instance = new DesireEngine();
  return instance;
}
