// 数字生命体 — 情绪系统
// 8维固定顺序情绪向量：愉悦、平静、期待、担忧、孤独、满足、好奇、牵挂
import { saveEmotionVector, loadEmotionVector, logSystemEvent, addEmotion } from '../db/lifeDb.js';
import { getPersonalityEngine } from './personality.js';

const DIM_LABELS = ['愉悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '牵挂'] as const;
const BASELINE: number[] = [0.30, 0.60, 0.20, 0.10, 0.15, 0.30, 0.40, 0.25];
const DECAY_RATE = 0.05; // 每tick衰减5%
const HIGH_EMOTION_THRESHOLD = 0.8;
const HIGH_EMOTION_DURATION_MS = 86400000; // 24小时

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampVector(v: number[]): number[] {
  return v.map(clamp);
}

export class EmotionEngine {
  private vector: number[];
  private highEmotionSince: Map<number, number> = new Map(); // dimIndex → 首次超过阈值的时间

  constructor() {
    this.vector = [...BASELINE];
    this.load();
  }

  private async load(): Promise<void> {
    const saved = await loadEmotionVector();
    if (saved) {
      this.vector = clampVector(saved);
      console.log('[Emotions] 已加载:', this.summarize());
    } else {
      await saveEmotionVector(this.vector);
      console.log('[Emotions] 初始化基线:', this.summarize());
    }
  }

  private async persist(): Promise<void> {
    await saveEmotionVector(this.vector);
  }

  /** 获取当前 8 维情绪向量 */
  getEmotions(): number[] {
    return [...this.vector];
  }

  summarize(): string {
    const top = this.vector
      .map((v, i) => ({ v, label: DIM_LABELS[i] }))
      .sort((a, b) => b.v - a.v);
    return `主导: ${top[0].label}(${top[0].v.toFixed(2)}) ${top[1].label}(${top[1].v.toFixed(2)})`;
  }

  /** 直接更新情绪向量 */
  async updateEmotions(delta: number[]): Promise<void> {
    if (delta.length !== 8) return;

    // 获取人格放大/缩小系数
    let amplification = 1.0;
    try {
      const personality = getPersonalityEngine().getPersonality();
      const empathy = personality[4];      // 同理心
      const stability = personality[3];    // 情绪稳定性
      amplification = 1.0 + (empathy - 0.5) * 0.4   // 同理心高 → 放大1.2倍
                      - (stability - 0.5) * 0.4;    // 稳定性高 → 缩小0.8倍
      amplification = clamp(amplification);
    } catch {}

    const before = [...this.vector];
    this.vector = clampVector(this.vector.map((v, i) => v + delta[i] * amplification));
    await this.persist();

    // 记录显著变化到 emotions 日志表
    const maxChange = Math.max(...delta.map(Math.abs));
    if (maxChange > 0.05) {
      const topIdx = delta.findIndex(d => Math.abs(d) === maxChange);
      await addEmotion(DIM_LABELS[topIdx], this.vector[topIdx],
        `delta=${delta.map(d=>d.toFixed(3)).join(',')} amp=${amplification.toFixed(2)}`);
    }

    // 检查高情绪状态
    await this.checkHighEmotions();

    console.log(`[Emotions] ${before.map(v=>v.toFixed(2)).join(',')} → ${this.vector.map(v=>v.toFixed(2)).join(',')}`);
  }

  /** 每10分钟tick：衰减 + 缓慢影响 */
  async tickEmotions(perceptionVector?: number[]): Promise<void> {
    // 1. 所有情绪向0衰减5%
    const decayDelta = this.vector.map(v => -v * DECAY_RATE);

    // 2. 人格影响：好奇心高 → 好奇衰减更慢
    try {
      const curiosity = getPersonalityEngine().getPersonality()[6];
      if (curiosity > 0.6) {
        decayDelta[6] *= (1 - (curiosity - 0.6)); // 好奇心越高，好奇情绪衰减越慢
      }
    } catch {}

    await this.updateEmotions(decayDelta);

    // 3. 感知特征向量的缓慢影响（如果有）
    if (perceptionVector && perceptionVector.length >= 12) {
      await this.receivePerception(perceptionVector, true);
    }
  }

  /** 接收 12 维感知特征向量，触发情绪更新 */
  async receivePerception(pv: number[], isTick = false): Promise<void> {
    const delta = new Array(8).fill(0);
    const scale = isTick ? 0.3 : 1.0; // tick中感知影响减到30%

    // [0]心率 [1]HRV [2]睡眠质量 [4]步数 [5]场景 [8]时间 [9]日历压力
    const hr = pv[0] || 0;
    const hrv = pv[1] || 0;
    const sleep = pv[2] || 0;
    const steps = pv[4] || 0;
    const scene = pv[5] || 0;
    const timePhase = pv[8] || 0;
    const calendar = pv[9] || 0;

    // 心率高 + HRV 低 → 担忧+0.15
    if (hr > 0.6 && hrv < 0.3) delta[3] += 0.15 * scale;

    // 睡眠质量好 → 平静+0.20, 愉悦+0.10
    if (sleep > 0.7) { delta[1] += 0.20 * scale; delta[0] += 0.10 * scale; }
    // 睡眠质量差 → 孤独+0.10, 担忧+0.10
    if (sleep < 0.3) { delta[4] += 0.10 * scale; delta[3] += 0.10 * scale; }

    // 场景=公司(0.2) + 工作时间 → 孤独+0.10
    if (Math.abs(scene - 0.2) < 0.01 && timePhase > 0.33 && timePhase < 0.75) delta[4] += 0.10 * scale;
    // 场景=家(0.1) + 空闲 → 满足+0.10, 平静+0.10
    if (Math.abs(scene - 0.1) < 0.01) { delta[5] += 0.10 * scale; delta[1] += 0.10 * scale; }

    // 步数活跃度高 → 愉悦+0.08, 好奇+0.05
    if (steps > 0.7) { delta[0] += 0.08 * scale; delta[6] += 0.05 * scale; }

    // 日历压力指数高 → 担忧+0.12, 平静-0.08
    if (calendar > 0.6) { delta[3] += 0.12 * scale; delta[1] -= 0.08 * scale; }

    // 时间=晚上(0.75-1.0) → 牵挂+0.05
    if (timePhase > 0.75) delta[7] += 0.05 * scale;
    // 时间=早晨(0.0-0.33) → 期待+0.08
    if (timePhase < 0.33) delta[2] += 0.08 * scale;

    await this.updateEmotions(delta);
  }

  /** 接收交互事件，触发情绪更新 */
  async receiveEvent(eventType: string, _data?: any): Promise<void> {
    const delta = new Array(8).fill(0);

    switch (eventType) {
      case 'user_message':
        delta[0] += 0.15; // 愉悦+0.15
        delta[7] += 0.10; // 牵挂+0.10
        break;
      case 'user_positive':
        delta[0] += 0.20; // 愉悦+0.20
        delta[5] += 0.10; // 满足+0.10
        break;
      case 'user_negative':
        delta[3] += 0.15; // 担忧+0.15
        delta[0] -= 0.10; // 愉悦-0.10
        break;
      case 'long_silence':
        delta[4] += 0.15; // 孤独+0.15
        delta[7] += 0.10; // 牵挂+0.10
        break;
      case 'new_scene':
        delta[6] += 0.20; // 好奇+0.20
        delta[2] += 0.10; // 期待+0.10
        break;
      case 'health_alert':
        delta[3] += 0.12; // 担忧+0.12
        delta[7] += 0.08; // 牵挂+0.08
        break;
    }

    await this.updateEmotions(delta);
  }

  /** 检查高情绪状态 */
  private async checkHighEmotions(): Promise<void> {
    const now = Date.now();

    for (let i = 0; i < 8; i++) {
      if (this.vector[i] > HIGH_EMOTION_THRESHOLD) {
        if (!this.highEmotionSince.has(i)) {
          this.highEmotionSince.set(i, now);
        } else {
          const duration = now - this.highEmotionSince.get(i)!;
          if (duration >= HIGH_EMOTION_DURATION_MS) {
            const label = DIM_LABELS[i];
            await logSystemEvent('emotion_alert', {
              type: 'high_emotion_persistent',
              emotion: label,
              intensity: this.vector[i],
              durationHours: Math.round(duration / 3600000),
            });
            console.warn(`[Emotions] ⚠️ "${label}" 持续偏高(${this.vector[i].toFixed(2)})超过${Math.round(duration/3600000)}小时，已记录`);
          }
        }
      } else {
        this.highEmotionSince.delete(i);
      }
    }
  }

  getProfile(): { label: string; value: number }[] {
    return DIM_LABELS.map((label, i) => ({ label, value: this.vector[i] }));
  }

  async reset(): Promise<void> {
    this.vector = [...BASELINE];
    this.highEmotionSince.clear();
    await this.persist();
  }
}

let instance: EmotionEngine | null = null;
export function getEmotionEngine(): EmotionEngine {
  if (!instance) instance = new EmotionEngine();
  return instance;
}
