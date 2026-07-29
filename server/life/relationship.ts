// 数字生命体 — 关系系统
// 4维关系向量：信任度、亲密感、理解度、依赖度
import {
  saveRelationshipVector, loadRelationshipVector,
  addRelationshipSnapshot, logSystemEvent,
} from '../db/lifeDb.js';

const DIM_LABELS = ['信任度', '亲密感', '理解度', '依赖度'] as const;
const BASELINE: number[] = [0.30, 0.20, 0.20, 0.30];
const MIN_FLOOR = 0.05;
const TRUST_DECAY_PER_24H = 0.005;  // 每 24 小时无交互，信任衰减 0.005
const TRUST_DECAY_FLOOR = 0.20;      // 信任最低不低于 0.2
const DECAY_CHECK_MS = 24 * 60 * 60 * 1000; // 24 小时检查一次

function clamp(v: number): number {
  return Math.max(MIN_FLOOR, Math.min(1, v));
}

function clampVector(v: number[]): number[] {
  return v.map(clamp);
}

/** 关系阶段判定 — 结合交互历史和维度平均值 */
function getStage(vector: number[], totalInteractions: number = 0): string {
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

/** 根据关系阶段获取决策建议 */
function getDecisionInfluence(vector: number[]): {
  tone: 'formal' | 'warm' | 'intimate';
  proactivity: 'low' | 'medium' | 'high';
  preemptive: boolean;
  autonomous: boolean;
} {
  const [, intimacy, understanding, dependence] = vector;
  return {
    tone: intimacy > 0.7 ? 'intimate' : intimacy > 0.4 ? 'warm' : 'formal',
    proactivity: vector[0] > 0.8 ? 'high' : vector[0] > 0.4 ? 'medium' : 'low',
    preemptive: understanding > 0.7,
    autonomous: dependence > 0.6,
  };
}

export class RelationshipEngine {
  private vector: number[];
  private lastInteractionAt: number;  // 上次交互时间戳 (ms)
  private lastDecayAt: number;        // 上次衰减检查时间戳 (ms)
  private totalInteractions: number;  // 交互总数（用于阶段判定）

  constructor() {
    this.vector = [...BASELINE];
    this.lastInteractionAt = Date.now();
    this.lastDecayAt = Date.now();
    this.totalInteractions = 0;
    this.load();
  }

  private async load(): Promise<void> {
    const saved = await loadRelationshipVector();
    if (saved) {
      this.vector = clampVector(saved);
      console.log('[Relationship] 已加载:', this.summarize());
    } else {
      await saveRelationshipVector(this.vector);
      await addRelationshipSnapshot(this.vector[0], this.vector[1], this.vector[2]);
      console.log('[Relationship] 初始化:', this.summarize());
    }
  }

  private async persist(): Promise<void> {
    await saveRelationshipVector(this.vector);
  }

  summarize(): string {
    return `${getStage(this.vector, this.totalInteractions)} [${this.vector.map(v => v.toFixed(2)).join(', ')}]`;
  }

  /** 获取当前 4 维关系向量 */
  getRelationship(): number[] {
    return [...this.vector];
  }

  /** 直接更新关系 */
  async updateRelationship(delta: number[]): Promise<void> {
    if (delta.length !== 4) return;

    const before = [...this.vector];
    this.vector = clampVector(this.vector.map((v, i) => v + delta[i]));
    await this.persist();

    // 记录快照（仅显著变化时）
    const maxChange = Math.max(...delta.map(Math.abs));
    if (maxChange > 0.01) {
      await addRelationshipSnapshot(this.vector[0], this.vector[1], this.vector[2]);
    }

    const newStage = getStage(this.vector, this.totalInteractions);
    const oldStage = getStage(before, this.totalInteractions);
    if (newStage !== oldStage) {
      console.log(`[Relationship] 🎉 关系升级: ${oldStage} → ${newStage}`);
      await logSystemEvent('relationship_milestone', { from: oldStage, to: newStage, vector: this.vector });
    }

    console.log(`[Relationship] ${before.map(v=>v.toFixed(2)).join(',')} → ${this.vector.map(v=>v.toFixed(2)).join(',')}`);
  }

  /** 接收交互事件，自动更新关系 */
  async receiveInteraction(type: string, outcome: 'accepted' | 'ignored' | 'positive' | 'negative' | 'neutral' = 'neutral'): Promise<void> {
    const delta = new Array(4).fill(0);

    // 记录交互时间（用于衰减计算）
    this.lastInteractionAt = Date.now();

    switch (type) {
      case 'user_initiated':
        delta[0] += 0.02; // 信任+0.02
        delta[1] += 0.01; // 亲密+0.01
        break;
      case 'user_positive':
        delta[0] += 0.05; // 信任+0.05
        delta[1] += 0.03; // 亲密+0.03
        break;
      case 'user_corrected':
        delta[2] += 0.04; // 理解+0.04（学到了）
        break;
      case 'long_silence':
        delta[3] -= 0.01; // 依赖-0.01
        delta[1] -= 0.005;// 亲密-0.005
        break;
      case 'agent_action':
        if (outcome === 'accepted') {
          delta[0] += 0.02; delta[1] += 0.02;
          delta[2] += 0.02; delta[3] += 0.02;
        } else if (outcome === 'ignored') {
          delta[0] -= 0.02; // 信任-0.02
          delta[2] -= 0.01; // 理解-0.01
        }
        break;
      case 'user_shared_feelings':
        delta[1] += 0.08; // 亲密+0.08
        delta[2] += 0.05; // 理解+0.05
        break;
      case 'high_frequency_3days':
        delta[3] += 0.05; // 依赖+0.05
        break;
      case 'user_asked_help':
        delta[0] += 0.03; // 信任+0.03
        delta[3] += 0.04; // 依赖+0.04
        break;
    }

    await this.updateRelationship(delta);
  }

  /** 定期衰减检查 — 由 LifeSystem TICK 调用（每 10 分钟） */
  async tick(): Promise<void> {
    const now = Date.now();

    // 仅每 24 小时检查一次衰减，避免频繁计算
    if (now - this.lastDecayAt < DECAY_CHECK_MS) return;
    this.lastDecayAt = now;

    // 如果距离上次交互超过 24 小时，每 24 小时信任衰减 0.005
    const hoursSinceInteraction = (now - this.lastInteractionAt) / (60 * 60 * 1000);
    if (hoursSinceInteraction >= 24) {
      const daysPassed = Math.floor(hoursSinceInteraction / 24);
      const decayAmount = daysPassed * TRUST_DECAY_PER_24H;
      const currentTrust = this.vector[0];
      const newTrust = Math.max(TRUST_DECAY_FLOOR, currentTrust - decayAmount);

      if (newTrust < currentTrust) {
        const delta = [newTrust - currentTrust, 0, 0, 0];
        await this.updateRelationship(delta);
        console.log(`[Relationship] 信任衰减: ${currentTrust.toFixed(3)} → ${newTrust.toFixed(3)} (${daysPassed}天无交互, -${decayAmount.toFixed(3)})`);
      }
    }
  }

  /** 获取关系描述 */
  getRelationshipState(): {
    stage: string;
    vector: number[];
    decisionInfluence: ReturnType<typeof getDecisionInfluence>;
    labels: { label: string; value: number }[];
  } {
    return {
      stage: getStage(this.vector, this.totalInteractions),
      vector: this.getRelationship(),
      decisionInfluence: getDecisionInfluence(this.vector),
      labels: DIM_LABELS.map((label, i) => ({ label, value: this.vector[i] })),
    };
  }

  /** 获取决策影响 */
  getDecisionInfluence() {
    return getDecisionInfluence(this.vector);
  }

  getProfile(): { label: string; value: number; floor: number }[] {
    return DIM_LABELS.map((label, i) => ({ label, value: this.vector[i], floor: MIN_FLOOR }));
  }

  /** 设置交互总数（由 LifeSystem 在初始化时调用） */
  setInteractionCount(count: number): void {
    if (count > 0) {
      this.totalInteractions = count;
      console.log(`[Relationship] 交互总数已设置: ${count} → 校准后阶段: ${getStage(this.vector, count)}`);
    }
  }

  getTotalInteractions(): number {
    return this.totalInteractions;
  }

  async reset(): Promise<void> {
    this.vector = [...BASELINE];
    await this.persist();
  }
}

let instance: RelationshipEngine | null = null;
export function getRelationshipEngine(): RelationshipEngine {
  if (!instance) instance = new RelationshipEngine();
  return instance;
}
