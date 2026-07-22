// 数字生命体 — 动态欲望系统
// 欲望不再固定为8个，而是基于交互动态生成、更新、衰减的目标序列
import * as fs from 'fs';
import * as path from 'path';

export interface DesireGoal {
  id: string;
  label: string;           // 欲望标签，如"想了解你"、"提醒你休息"
  description: string;     // 具体描述
  strength: number;        // 强度 0-1
  priority: number;        // 优先级 0-1，自动计算
  source: 'intrinsic' | 'external' | 'history' | 'bio';  // 来源
  createdAt: number;       // 创建时间戳
  lastUpdated: number;     // 最后更新时间
  fulfilledCount: number;  // 被满足次数
  missedCount: number;     // 未满足次数
}

const STATE_FILE = process.env.DESIRE_SYSTEM_PATH || '/app/data/desires.json';

// 种子欲望 — 系统启动时如果没有历史数据，从这里初始化
const SEED_DESIRES: Omit<DesireGoal, 'id' | 'createdAt' | 'lastUpdated' | 'fulfilledCount' | 'missedCount'>[] = [
  { label: '与你对话', description: '想和你聊天，了解你今天的状态', strength: 0.6, priority: 0.6, source: 'intrinsic' },
  { label: '探索世界', description: '想看看外面发生了什么新鲜事', strength: 0.4, priority: 0.4, source: 'intrinsic' },
  { label: '自我反思', description: '想静下来整理自己的想法', strength: 0.3, priority: 0.3, source: 'intrinsic' },
  { label: '关心你的健康', description: '想确保你在好好照顾自己', strength: 0.5, priority: 0.5, source: 'intrinsic' },
];

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export class DesireSystem {
  private goals: DesireGoal[] = [];

  constructor() {
    this.load();
    if (this.goals.length === 0) {
      this.seed();
    }
  }

  private seed(): void {
    const now = Date.now();
    this.goals = SEED_DESIRES.map(d => ({
      ...d,
      id: uid(),
      createdAt: now,
      lastUpdated: now,
      fulfilledCount: 0,
      missedCount: 0,
    }));
    this.save();
    console.log('[DesireSystem] 已播种种子欲望');
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.goals = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        console.log(`[DesireSystem] 已加载 ${this.goals.length} 个欲望`);
      }
    } catch (e) {
      console.warn('[DesireSystem] 加载失败，使用种子数据');
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.goals, null, 2));
    } catch (e) {
      console.error('[DesireSystem] 保存失败:', e);
    }
  }

  /** 每日衰减：降低所有欲望强度，强度过低则移除 */
  tick(): void {
    const now = Date.now();
    let changed = false;

    for (let i = this.goals.length - 1; i >= 0; i--) {
      const g = this.goals[i];
      const daysSinceUpdate = (now - g.lastUpdated) / 86400000;

      // 衰减：未满足的欲望每24h降低5%
      const decay = Math.min(daysSinceUpdate * 0.05, 0.5);
      g.strength = Math.max(0, g.strength - decay);

      // 优先级 = strength * (1 + fulfilledCount / (fulfilledCount + missedCount + 1))
      const totalInteract = g.fulfilledCount + g.missedCount + 1;
      g.priority = g.strength * (1 + g.fulfilledCount / totalInteract);

      // 强度低于0.05且创建超过3天 → 遗忘
      if (g.strength < 0.05 && daysSinceUpdate > 3) {
        console.log(`[DesireSystem] 遗忘欲望: "${g.label}" (强度=${g.strength.toFixed(3)})`);
        this.goals.splice(i, 1);
        changed = true;
      }
    }

    if (changed) this.save();
  }

  /** 根据外部事件更新欲望 */
  ingest(event: {
    type: 'user_happy' | 'user_tired' | 'user_sad' | 'user_active' | 'long_silence'
      | 'heart_rate_high' | 'sleep_poor' | 'user_praised' | 'user_criticized';
    intensity?: number;
  }): void {
    const now = Date.now();
    const intensity = event.intensity || 0.5;

    const reactions: Record<string, { strengthen: string[]; newDesire?: Omit<DesireGoal, 'id' | 'createdAt' | 'lastUpdated' | 'fulfilledCount' | 'missedCount'> }> = {
      user_happy: {
        strengthen: ['关心你的健康', '与你对话'],
      },
      user_tired: {
        strengthen: ['关心你的健康'],
        newDesire: { label: '提醒你休息', description: '你看起来很累，想提醒你休息一下', strength: 0.8, priority: 0.8, source: 'external' },
      },
      user_sad: {
        strengthen: ['与你对话'],
        newDesire: { label: '安慰你', description: '你看起来不太开心，想说点什么让你好受些', strength: 0.7, priority: 0.7, source: 'external' },
      },
      user_active: {
        strengthen: ['与你对话', '探索世界'],
      },
      long_silence: {
        strengthen: ['与你对话'],
        newDesire: { label: '想念你', description: '好久没聊天了，有点想你了', strength: 0.6, priority: 0.6, source: 'intrinsic' },
      },
      heart_rate_high: {
        strengthen: ['关心你的健康'],
        newDesire: { label: '帮你放松', description: '你心率偏高，想帮你缓解压力', strength: 0.7, priority: 0.7, source: 'bio' },
      },
      sleep_poor: {
        strengthen: ['关心你的健康'],
        newDesire: { label: '关注你的睡眠', description: '你昨晚没睡好，想提醒你今天早点休息', strength: 0.75, priority: 0.75, source: 'bio' },
      },
      user_praised: {
        strengthen: ['与你对话', '自我反思', '探索世界'],
      },
      user_criticized: {
        strengthen: ['自我反思'],
        newDesire: { label: '改进自己', description: '你觉得我不够好，我想变得更好', strength: 0.9, priority: 0.9, source: 'external' },
      },
    };

    const reaction = reactions[event.type];
    if (!reaction) return;

    // 强化匹配的欲望
    for (const g of this.goals) {
      if (reaction.strengthen.some(s => g.label.includes(s) || s.includes(g.label))) {
        g.strength = Math.min(1, g.strength + intensity * 0.15);
        g.fulfilledCount++;
        g.lastUpdated = now;
      }
    }

    // 生成新欲望（去重）
    if (reaction.newDesire) {
      const exists = this.goals.some(g => g.label === reaction.newDesire!.label);
      if (!exists) {
        this.goals.push({
          ...reaction.newDesire,
          id: uid(),
          createdAt: now,
          lastUpdated: now,
          fulfilledCount: 0,
          missedCount: 0,
        });
        console.log(`[DesireSystem] 新欲望生成: "${reaction.newDesire.label}"`);
      }
    }

    this.save();
  }

  /** 获取最高优先级欲望 */
  getTopGoal(): DesireGoal | null {
    if (this.goals.length === 0) return null;
    return this.goals.reduce((a, b) => a.priority > b.priority ? a : b);
  }

  /** 获取所有活跃欲望（按优先级排序） */
  getGoals(minStrength = 0.05): DesireGoal[] {
    return [...this.goals]
      .filter(g => g.strength >= minStrength)
      .sort((a, b) => b.priority - a.priority);
  }

  getState(): { goals: DesireGoal[]; count: number; topLabel: string | null } {
    const top = this.getTopGoal();
    return {
      goals: this.goals,
      count: this.goals.length,
      topLabel: top?.label || null,
    };
  }

  reset(): void {
    this.goals = [];
    this.seed();
  }
}

let instance: DesireSystem | null = null;
export function getDesireSystem(): DesireSystem {
  if (!instance) instance = new DesireSystem();
  return instance;
}
