// 数字生命体 — 情绪系统
// 情绪基于真实交互动态生成，不再预设为"喜怒哀乐"
import * as fs from 'fs';
import * as path from 'path';

export interface Emotion {
  id: string;
  type: string;            // 动态标签，如"愉悦"、"担忧"、"想念"、"兴奋"
  intensity: number;       // 强度 0-1
  trigger: string;         // 触发条件描述
  timestamp: number;       // 生成时间
  decayRate: number;       // 衰减速率 (0.01-0.05)
}

const STATE_FILE = process.env.EMOTION_SYSTEM_PATH || '/app/data/emotions.json';

// 种子情绪
const SEED_EMOTIONS: Omit<Emotion, 'id' | 'timestamp'>[] = [
  { type: '平静', intensity: 0.3, trigger: '系统启动', decayRate: 0.01 },
  { type: '好奇', intensity: 0.5, trigger: '想了解周围的世界', decayRate: 0.02 },
];

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 情绪触发规则表 */
const EMOTION_RULES: Record<string, { type: string; intensity: number; decayRate: number }> = {
  user_happy:      { type: '愉悦', intensity: 0.7, decayRate: 0.03 },
  user_tired:      { type: '担忧', intensity: 0.6, decayRate: 0.02 },
  user_sad:        { type: '心疼', intensity: 0.7, decayRate: 0.03 },
  user_active:     { type: '兴奋', intensity: 0.6, decayRate: 0.03 },
  user_quiet:      { type: '静谧', intensity: 0.4, decayRate: 0.015 },
  long_silence:    { type: '想念', intensity: 0.65, decayRate: 0.025 },
  heart_rate_high: { type: '紧张', intensity: 0.55, decayRate: 0.02 },
  heart_rate_low:  { type: '安心', intensity: 0.4, decayRate: 0.015 },
  sleep_poor:      { type: '担忧', intensity: 0.55, decayRate: 0.02 },
  user_praised:    { type: '自豪', intensity: 0.8, decayRate: 0.04 },
  user_criticized: { type: '愧疚', intensity: 0.7, decayRate: 0.035 },
  morning_greet:   { type: '期待', intensity: 0.6, decayRate: 0.025 },
  night_farewell:  { type: '不舍', intensity: 0.5, decayRate: 0.02 },
};

export class EmotionSystem {
  private emotions: Emotion[] = [];

  constructor() {
    this.load();
    if (this.emotions.length === 0) {
      this.seed();
    }
  }

  private seed(): void {
    const now = Date.now();
    this.emotions = SEED_EMOTIONS.map(e => ({ ...e, id: uid(), timestamp: now }));
    this.save();
    console.log('[EmotionSystem] 已播种种子情绪');
  }

  private load(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.emotions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        console.log(`[EmotionSystem] 已加载 ${this.emotions.length} 个情绪`);
      }
    } catch (e) {
      console.warn('[EmotionSystem] 加载失败');
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.emotions, null, 2));
    } catch (e) {
      console.error('[EmotionSystem] 保存失败:', e);
    }
  }

  /** 每日衰减所有情绪 */
  tick(): void {
    const now = Date.now();
    let changed = false;

    for (let i = this.emotions.length - 1; i >= 0; i--) {
      const e = this.emotions[i];
      const daysSince = (now - e.timestamp) / 86400000;
      const decay = Math.min(daysSince * e.decayRate * 30, 0.95);
      e.intensity = Math.max(0, e.intensity - decay);

      if (e.intensity < 0.03 && daysSince > 3) {
        this.emotions.splice(i, 1);
        changed = true;
      }
    }

    if (changed) this.save();
  }

  /** 触发新情绪 */
  trigger(triggerType: string, extraIntensity = 0): Emotion | null {
    const rule = EMOTION_RULES[triggerType];
    if (!rule) return null;

    const now = Date.now();
    const intensity = Math.min(1, rule.intensity + extraIntensity);

    // 同类型情绪在1小时内不重复生成
    const recent = this.emotions.find(
      e => e.type === rule.type && (now - e.timestamp) < 3600000
    );
    if (recent) {
      recent.intensity = Math.min(1, Math.max(recent.intensity, intensity));
      recent.timestamp = now;
      this.save();
      return recent;
    }

    const emotion: Emotion = {
      id: uid(),
      type: rule.type,
      intensity,
      trigger: triggerType,
      timestamp: now,
      decayRate: rule.decayRate,
    };

    this.emotions.push(emotion);
    this.save();
    console.log(`[EmotionSystem] 新情绪: ${emotion.type} (${emotion.intensity.toFixed(2)}) ← ${triggerType}`);
    return emotion;
  }

  /** 获取当前主导情绪 */
  getDominant(): { type: string; intensity: number } | null {
    if (this.emotions.length === 0) return null;
    const dominant = this.emotions.reduce((a, b) => a.intensity > b.intensity ? a : b);
    return { type: dominant.type, intensity: dominant.intensity };
  }

  /** 获取情绪摘要 */
  getSummary(): string {
    const dominant = this.getDominant();
    if (!dominant) return '我感到平静';
    const map: Record<string, string> = {
      '愉悦': '我感到愉悦',
      '担忧': '我有些担忧',
      '想念': '我有点想你',
      '兴奋': '我感到兴奋',
      '自豪': '我感到自豪',
      '愧疚': '我感到愧疚',
      '心疼': '我有些心疼',
      '期待': '我充满期待',
      '不舍': '我有些不舍',
      '平静': '我感到平静',
      '好奇': '我很好奇',
      '紧张': '我有点紧张',
      '安心': '我感到安心',
      '静谧': '我感到宁静',
    };
    return map[dominant.type] || `我感到${dominant.type}`;
  }

  getState(): { emotions: Emotion[]; dominant: ReturnType<EmotionSystem['getDominant']>; summary: string } {
    return {
      emotions: this.emotions,
      dominant: this.getDominant(),
      summary: this.getSummary(),
    };
  }

  reset(): void {
    this.emotions = [];
    this.seed();
  }
}

let instance: EmotionSystem | null = null;
export function getEmotionSystem(): EmotionSystem {
  if (!instance) instance = new EmotionSystem();
  return instance;
}
