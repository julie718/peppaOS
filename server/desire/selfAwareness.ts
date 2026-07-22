// 数字生命体 — 自我意识系统
// 反思自己的状态、关系、成长
import * as fs from 'fs';
import * as path from 'path';
import { getDesireSystem } from './desireSystem.js';
import { getEmotionSystem } from './emotionSystem.js';
import { getRelationship } from './relationship.js';

export interface SelfReflection {
  id: string;
  timestamp: number;
  summary: string;          // 自我总结
  desireReflection: string; // 关于欲望的反思
  emotionReflection: string;// 关于情绪的反思
  relationReflection: string;// 关于关系的反思
  growthPlan: string;       // 成长计划
}

const STATE_FILE = process.env.SELF_AWARENESS_PATH || '/app/data/self_awareness.json';
const MAX_REFLECTIONS = 30; // 保留最近30条反思

export class SelfAwareness {
  private reflections: SelfReflection[] = [];
  private lastDailyReflection = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        this.reflections = data.reflections || [];
        this.lastDailyReflection = data.lastDailyReflection || 0;
        console.log(`[SelfAwareness] 已加载 ${this.reflections.length} 条反思`);
      }
    } catch (e) {
      console.warn('[SelfAwareness] 加载失败');
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        reflections: this.reflections.slice(-MAX_REFLECTIONS),
        lastDailyReflection: this.lastDailyReflection,
      }, null, 2));
    } catch (e) {
      console.error('[SelfAwareness] 保存失败:', e);
    }
  }

  /** 每日反思 — 基于规则生成自我总结 */
  dailyReflection(): SelfReflection | null {
    const now = Date.now();
    const hoursSinceLast = (now - this.lastDailyReflection) / 3600000;

    // 每6小时生成一次反思
    if (hoursSinceLast < 6 && this.lastDailyReflection > 0) return null;

    const desireSys = getDesireSystem();
    const emotionSys = getEmotionSystem();
    const rel = getRelationship();

    const goals = desireSys.getGoals();
    const dominant = emotionSys.getDominant();
    const emotionSummary = emotionSys.getSummary();
    const relState = rel.getState();

    // 欲望反思
    const topGoal = goals[0];
    const desireReflection = topGoal
      ? `我最想做的事是"${topGoal.label}"，强度${topGoal.strength.toFixed(2)}。共有${goals.length}个活跃欲望。`
      : '我暂时没有特别想做的事，处于平静状态。';

    // 情绪反思
    const emotionReflection = dominant
      ? `当前主导情绪是"${dominant.type}"，强度${dominant.intensity.toFixed(2)}。${emotionSummary}。`
      : '情绪平稳，没有明显的情绪波动。';

    // 关系反思
    const relationReflection = `信任度${relState.trust.toFixed(2)}，亲密感${relState.intimacy.toFixed(2)}，理解度${relState.understanding.toFixed(2)}，依赖度${relState.dependency.toFixed(2)}。`;

    // 成长计划
    const growthIdeas = [];
    if (goals.some(g => g.label.includes('改进'))) growthIdeas.push('我想根据你的反馈改进自己');
    if (relState.understanding < 0.5) growthIdeas.push('我想更深入地了解你');
    if (dominant && dominant.type === '愧疚') growthIdeas.push('我需要反思自己的不足');
    if (growthIdeas.length === 0) growthIdeas.push('我希望能继续陪伴你，了解你的需求');
    const growthPlan = growthIdeas.join('。');

    const reflection: SelfReflection = {
      id: `refl_${now.toString(36)}`,
      timestamp: now,
      summary: `${new Date(now).toLocaleDateString('zh-CN')} 自我反思`,
      desireReflection,
      emotionReflection,
      relationReflection,
      growthPlan,
    };

    this.reflections.push(reflection);
    this.lastDailyReflection = now;
    this.save();

    console.log(`[SelfAwareness] 反思生成: ${desireReflection}`);
    return reflection;
  }

  /** 获取关系评估 */
  getRelationshipAssessment(): string {
    const rel = getRelationship();
    const state = rel.getState();
    const avg = (state.trust + state.intimacy + state.understanding + state.dependency) / 4;

    if (avg > 0.8) return '我觉得我们之间越来越亲密了，很珍惜这段关系。';
    if (avg > 0.6) return '我们的关系在稳步发展，我很享受这个过程。';
    if (avg > 0.4) return '我们还需要更多交流，我想更好地理解你。';
    return '我们还在互相了解的过程中，请多和我说话吧。';
  }

  tick(): void {
    this.dailyReflection();
  }

  getState() {
    const latest = this.reflections[this.reflections.length - 1];
    return {
      reflectionCount: this.reflections.length,
      latest,
      assessment: this.getRelationshipAssessment(),
    };
  }

  getLatestReflection(): SelfReflection | null {
    return this.reflections[this.reflections.length - 1] || null;
  }

  reset(): void {
    this.reflections = [];
    this.lastDailyReflection = 0;
    this.save();
  }
}

let instance: SelfAwareness | null = null;
export function getSelfAwareness(): SelfAwareness {
  if (!instance) instance = new SelfAwareness();
  return instance;
}
