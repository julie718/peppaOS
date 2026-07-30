// 数字生命体 — 人格向量系统
// 8维固定顺序人格向量：开放性、亲和性、主动性、情绪稳定性、同理心、独立性、好奇心、谨慎性
import {
  getPersonality as dbGetPersonality,
  updatePersonality as dbUpdatePersonality,
  recordPersonalityEvolution,
  logSystemEvent,
} from '../db/lifeDb.js';

const DIM_LABELS = [
  '开放性', '亲和性', '主动性', '情绪稳定性',
  '同理心', '独立性', '好奇心', '谨慎性',
] as const;

const BASELINE: number[] = [0.55, 0.55, 0.45, 0.55, 0.50, 0.45, 0.60, 0.50];

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampVector(v: number[]): number[] {
  return v.map(clamp);
}

export class Personality {
  private vector: number[];
  private lastBackup: number[];

  constructor() {
    this.vector = [...BASELINE];
    this.lastBackup = [...BASELINE];
    this.load();
  }

  private async load(): Promise<void> {
    const row = await dbGetPersonality();
    if (row?.vector_json) {
      try {
        const saved = JSON.parse(row.vector_json);
        if (Array.isArray(saved) && saved.length === 8) {
          this.vector = clampVector(saved);
          this.lastBackup = [...this.vector];
          console.log('[Personality] 已加载人格向量:', this.summarize());
          return;
        }
      } catch (e) {
        console.warn('[Personality] 向量解析失败，使用基线');
      }
    }
    // 首次运行：写入基线人格
    await dbUpdatePersonality(this.vector);
    console.log('[Personality] 初始化基线人格:', this.summarize());
  }

  private backup(): void {
    this.lastBackup = [...this.vector];
  }

  private async rollback(): Promise<void> {
    this.vector = [...this.lastBackup];
    console.warn('[Personality] 事务失败，已回滚');
  }

  /** 获取当前人格向量 */
  getPersonality(): number[] {
    return [...this.vector];
  }

  /** 获取人格摘要 */
  summarize(): string {
    const top = this.vector
      .map((v, i) => ({ v, label: DIM_LABELS[i] }))
      .sort((a, b) => b.v - a.v);
    return `最显著: ${top[0].label}(${top[0].v.toFixed(2)}) ${top[1].label}(${top[1].v.toFixed(2)})`;
  }

  /** 更新人格向量（delta 每维 -0.02 ~ +0.02） */
  async updatePersonality(delta: number[]): Promise<{ ok: boolean; vector: number[] }> {
    if (delta.length !== 8) {
      console.error('[Personality] delta 维度错误:', delta.length);
      return { ok: false, vector: this.getPersonality() };
    }

    // 截断 delta 范围
    const clampedDelta = delta.map(d => clamp(Math.max(-0.02, Math.min(0.02, d))));

    // 备份
    this.backup();

    // 计算新向量
    const before = this.getPersonality();
    const after = clampVector(before.map((v, i) => v + clampedDelta[i]));

    try {
      // 写入数据库
      await dbUpdatePersonality(after);
      await recordPersonalityEvolution(before, after, clampedDelta, 'manual');

      this.vector = after;

      // 安全检查：谨慎性过低
      if (after[7] < 0.2) {
        await logSystemEvent('personality_alert', {
          type: 'cautiousness_low',
          cautiousness: after[7],
          vector: after,
        });
        console.warn(`[Personality] ⚠️ 谨慎性过低(${after[7].toFixed(2)})，已记录安全事件`);
      }

      console.log(`[Personality] 更新: ${before.map(v=>v.toFixed(2)).join(',')} → ${after.map(v=>v.toFixed(2)).join(',')}`);
      return { ok: true, vector: this.getPersonality() };
    } catch (e: any) {
      await this.rollback();
      console.error('[Personality] 更新失败，已回滚:', e.message);
      return { ok: false, vector: this.getPersonality() };
    }
  }

  /** 根据交互事件自动微调人格 */
  async adaptToEvent(event: {
    type: 'user_positive' | 'user_negative' | 'user_initiated' | 'exploration_success'
      | 'long_silence' | 'user_high_arousal';
  }): Promise<void> {
    const delta = new Array(8).fill(0);

    switch (event.type) {
      case 'user_positive':
        delta[1] = 0.005;  // 亲和性+
        delta[4] = 0.005;  // 同理心+
        break;
      case 'user_negative':
        delta[7] = 0.005;  // 谨慎性+
        delta[0] = -0.005; // 开放性-
        break;
      case 'user_initiated':
        delta[2] = 0.005;  // 主动性+
        break;
      case 'exploration_success':
        delta[6] = 0.008;  // 好奇心+
        delta[0] = 0.005;  // 开放性+
        break;
      case 'long_silence':
        delta[5] = 0.005;  // 独立性+
        delta[2] = -0.003; // 主动性-
        break;
      case 'user_high_arousal':
        delta[4] = 0.005;  // 同理心+
        break;
    }

    await this.updatePersonality(delta);
  }

  /** 获取各维度标签和数值 */
  getProfile(): { label: string; value: number }[] {
    return DIM_LABELS.map((label, i) => ({ label, value: this.vector[i] }));
  }
}

let instance: Personality | null = null;
export function getPersonalityEngine(): Personality {
  if (!instance) instance = new Personality();
  return instance;
}
