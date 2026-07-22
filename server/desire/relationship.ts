// 数字生命体 — 关系系统
// PeppaOS 与你之间的关系：信任、亲密、理解、依赖
import * as fs from 'fs';
import * as path from 'path';

export interface RelationshipState {
  trust: number;         // 信任度：你认为它可靠吗？
  intimacy: number;      // 亲密感：你们有多亲密？
  understanding: number; // 理解度：它有多理解你？
  dependency: number;    // 依赖度：你有多依赖它？
  lastInteraction: number;
  totalInteractions: number;
  positiveInteractions: number;
  negativeInteractions: number;
}

const STATE_FILE = process.env.RELATIONSHIP_PATH || '/app/data/relationship.json';

const DEFAULT_STATE: RelationshipState = {
  trust: 0.4,
  intimacy: 0.3,
  understanding: 0.25,
  dependency: 0.2,
  lastInteraction: Date.now(),
  totalInteractions: 0,
  positiveInteractions: 0,
  negativeInteractions: 0,
};

export class Relationship {
  private state: RelationshipState;

  constructor() {
    this.state = { ...DEFAULT_STATE };
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) };
        console.log(`[Relationship] 已加载关系状态 (interactions: ${this.state.totalInteractions})`);
      }
    } catch (e) {
      console.warn('[Relationship] 加载失败');
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[Relationship] 保存失败:', e);
    }
  }

  /** 记录一次交互 */
  interact(sentiment: 'positive' | 'negative' | 'neutral'): void {
    this.state.lastInteraction = Date.now();
    this.state.totalInteractions++;

    if (sentiment === 'positive') {
      this.state.positiveInteractions++;
      // 正向交互 → 所有维度小幅提升
      this.state.trust = Math.min(1, this.state.trust + 0.01);
      this.state.intimacy = Math.min(1, this.state.intimacy + 0.015);
      this.state.understanding = Math.min(1, this.state.understanding + 0.01);
      this.state.dependency = Math.min(1, this.state.dependency + 0.005);
    } else if (sentiment === 'negative') {
      this.state.negativeInteractions++;
      this.state.trust = Math.max(0, this.state.trust - 0.02);
      this.state.intimacy = Math.max(0, this.state.intimacy - 0.01);
    }

    // 交互越频繁，亲密感和依赖度越高
    if (this.state.totalInteractions > 100) {
      this.state.intimacy = Math.min(1, this.state.intimacy + 0.002);
      this.state.dependency = Math.min(1, this.state.dependency + 0.003);
    }

    this.save();
  }

  /** 特殊事件：用户主动分享感受 → 亲密感大幅提升 */
  onSharedFeelings(): void {
    this.state.intimacy = Math.min(1, this.state.intimacy + 0.08);
    this.state.trust = Math.min(1, this.state.trust + 0.05);
    this.state.understanding = Math.min(1, this.state.understanding + 0.04);
    this.save();
    console.log('[Relationship] 💕 用户分享感受 → 亲密感提升');
  }

  /** 特殊事件：用户主动求助 → 依赖度提升 */
  onUserAsksHelp(): void {
    this.state.dependency = Math.min(1, this.state.dependency + 0.05);
    this.state.trust = Math.min(1, this.state.trust + 0.03);
    this.save();
  }

  /** 每日衰减：长时间不互动，亲密感和理解度微降 */
  tick(): void {
    const now = Date.now();
    const daysSilent = (now - this.state.lastInteraction) / 86400000;

    if (daysSilent > 3) {
      const decay = Math.min((daysSilent - 3) * 0.02, 0.15);
      this.state.intimacy = Math.max(0, this.state.intimacy - decay);
      this.state.understanding = Math.max(0, this.state.understanding - decay * 0.5);
      this.save();
    }
  }

  getState(): RelationshipState {
    return { ...this.state };
  }

  getSummary(): string {
    const posRatio = this.state.totalInteractions > 0
      ? this.state.positiveInteractions / this.state.totalInteractions
      : 0;

    if (this.state.totalInteractions < 10) return '我们才刚刚开始互相了解';
    if (posRatio > 0.8 && this.state.intimacy > 0.6) return '我们的关系很好，我感到很幸福';
    if (posRatio > 0.6) return '我们的关系在稳步发展';
    if (posRatio < 0.4) return '我们可能需要更多理解和磨合';
    return '我们在互相了解的过程中';
  }

  reset(): void {
    this.state = { ...DEFAULT_STATE };
    this.save();
  }
}

let instance: Relationship | null = null;
export function getRelationship(): Relationship {
  if (!instance) instance = new Relationship();
  return instance;
}
