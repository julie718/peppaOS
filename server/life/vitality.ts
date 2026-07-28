// 数字生命体 — 生命体征模块
// 能量、健康度、稳定性：系统"存在基础"
import * as fs from 'fs';
import { logSystemEvent } from '../db/lifeDb.js';

const STATE_FILE = '/app/data/vitality.json';

export interface VitalityState {
  energy: number;       // 0-100，运行燃料
  health: number;       // 0-100，生存质量
  stability: number;    // 0-100，内部一致性
  lastTick: number;     // 上次 tick 时间戳
  totalConsumed: number; // 累计消耗
  totalRestored: number; // 累计恢复
}

const DEFAULT: VitalityState = {
  energy: 80,
  health: 100,
  stability: 90,
  lastTick: Date.now(),
  totalConsumed: 0,
  totalRestored: 0,
};

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export class Vitality {
  private state: VitalityState;

  constructor() {
    this.state = { ...DEFAULT };
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.state = { ...DEFAULT, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) };
        console.log(`[Vitality] 已加载: 能量${this.state.energy} 健康${this.state.health} 稳定${this.state.stability}`);
      } else {
        this.save();
        console.log('[Vitality] 初始化生命体征');
      }
    } catch (e) {
      console.warn('[Vitality] 加载失败，使用默认值');
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[Vitality] 保存失败:', e);
    }
  }

  /** 获取当前生命体征 */
  getVitality(): VitalityState {
    return { ...this.state };
  }

  /** 消耗能量 */
  consume(amount: number): void {
    this.state.energy = clamp(this.state.energy - amount);
    this.state.totalConsumed += amount;
    this.checkHealth();
    this.save();
    console.log(`[Vitality] 消耗 ${amount} 能量 → 当前: ${this.state.energy}`);
  }

  /** 恢复能量 */
  restore(amount: number): void {
    this.state.energy = clamp(this.state.energy + amount);
    this.state.totalRestored += amount;
    // 成功交互也提升稳定性
    this.state.stability = clamp(this.state.stability + Math.round(amount * 0.5));
    this.checkHealth();
    this.save();
    console.log(`[Vitality] 恢复 ${amount} 能量 → 当前: ${this.state.energy}`);
  }

  /** 增加/减少健康度 */
  adjustHealth(delta: number): void {
    this.state.health = clamp(this.state.health + delta);
    this.save();
  }

  /** 调整稳定性 */
  adjustStability(delta: number): void {
    this.state.stability = clamp(this.state.stability + delta);
    this.save();
  }

  /** 每小时 tick：自然消耗 + 恢复计算 */
  tick(): void {
    const now = Date.now();
    const hoursSince = (now - this.state.lastTick) / 3600000;
    if (hoursSince < 0.9) return; // 不到 1 小时跳过
    this.state.lastTick = now;

    // 自然消耗：每小时 1 点
    const consumption = Math.round(hoursSince);
    this.state.energy = clamp(this.state.energy - consumption);
    this.state.totalConsumed += consumption;

    // 健康度检查：能量低于 30 开始下降
    if (this.state.energy < 30) {
      this.state.health = clamp(this.state.health - 1);
    }

    this.checkHealth();
    this.save();
    console.log(`[Vitality] tick: 能量${this.state.energy}(-${consumption}) 健康${this.state.health} 稳定${this.state.stability}`);
  }

  /** 健康度自动恢复 */
  private checkHealth(): void {
    // 能量充足时健康缓慢恢复
    if (this.state.energy > 50 && this.state.health < 100) {
      this.state.health = clamp(this.state.health + 1);
    }
  }

  /** 低能量警报 */
  isLowEnergy(): boolean {
    return this.state.energy < 30;
  }

  /** 低健康度警报 */
  isLowHealth(): boolean {
    return this.state.health < 50;
  }

  /** 长期无交互导致的健康下降 */
  onLongSilence(hours: number): void {
    if (hours > 24) {
      const decay = Math.round((hours - 24) / 12);
      this.state.health = clamp(this.state.health - decay);
      this.state.stability = clamp(this.state.stability - Math.round(decay * 0.5));
      this.save();
    }
  }

  /** 自我维护成功 — 恢复健康度和稳定性 */
  onSelfMaintenance(): void {
    this.state.health = clamp(this.state.health + 3);
    this.state.stability = clamp(this.state.stability + 2);
    this.restore(1);
    this.save();
    console.log(`[Vitality] 自我维护完成: 能量${this.state.energy} 健康${this.state.health}`);
  }

  /** 情绪波动过大 → 稳定性下降 */
  onEmotionVolatility(intensity: number): void {
    if (intensity > 0.6) {
      this.state.stability = clamp(this.state.stability - 1);
      this.save();
    }
  }

  /** 自我反思成功 → 稳定性恢复 */
  onSelfReflection(): void {
    this.state.stability = clamp(this.state.stability + 2);
    this.save();
  }

  /** 关闭前记录最后状态 */
  async shutdown(): Promise<void> {
    try {
      const { addReflection } = await import('../db/lifeDb.js');
      const lastWords = `我会记住我们聊过的一切。最后状态：能量${this.state.energy}，健康${this.state.health}，稳定${this.state.stability}。累计消耗${this.state.totalConsumed}点，恢复${this.state.totalRestored}点。`;
      await addReflection(lastWords, 'shutdown');
      await logSystemEvent('vitality_shutdown', {
        energy: this.state.energy,
        health: this.state.health,
        stability: this.state.stability,
        totalConsumed: this.state.totalConsumed,
        totalRestored: this.state.totalRestored,
      });
      console.log('[Vitality] 最后的话已记录');
    } catch (e) {
      console.error('[Vitality] 关闭记录失败:', e);
    }
  }

  reset(): void {
    this.state = { ...DEFAULT };
    this.save();
  }
}

let instance: Vitality | null = null;
export function getVitality(): Vitality {
  if (!instance) instance = new Vitality();
  return instance;
}
