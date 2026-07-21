// server/desire/engine.ts
import * as fs from 'fs';
import * as path from 'path';

// 驱力配置
export const DRIVE_CONFIG = {
  attachment: { baseline: 0.3, decay: 0.02, label: '牵挂' },
  curiosity: { baseline: 0.2, decay: 0.015, label: '好奇' },
  reflection: { baseline: 0.1, decay: 0.01, label: '反思' },
  duty: { baseline: 0.0, decay: 0.025, label: '责任' },
  social: { baseline: 0.1, decay: 0.02, label: '社交' },
  libido: { baseline: 0.0, decay: 0.03, label: '亲密' },
  stress: { baseline: 0.1, decay: 0.01, label: '压力' },
  fatigue: { baseline: 0.0, decay: 0.02, label: '疲劳' },
} as const;

export type DriveName = keyof typeof DRIVE_CONFIG;
export type DriveState = Record<DriveName, number>;

const COUPLING = 0.05;
const STATE_FILE = process.env.DESIRE_STATE_PATH || path.resolve(process.cwd(), 'data/desire_state.json');

const INTENT_MESSAGES: Record<DriveName, string> = {
  attachment: '我有点想她',
  curiosity: '我想去看看新的东西',
  reflection: '我想静一静，写点东西',
  duty: '我还有事情要做',
  social: '我想看看外面的人群在聊什么',
  libido: '我有点想要靠近',
  stress: '我感觉有点紧绷',
  fatigue: '我有点累了',
};

export class DesireEngine {
  private state: DriveState;
  private lastTick: number;

  constructor() {
    this.state = { ...this.getDefaultState() };
    this.lastTick = Date.now();
    this.loadState();
  }

  private getDefaultState(): DriveState {
    const defaultState: Partial<DriveState> = {};
    for (const [key, cfg] of Object.entries(DRIVE_CONFIG)) {
      defaultState[key as DriveName] = cfg.baseline;
    }
    return defaultState as DriveState;
  }

  private loadState(): void {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const data = JSON.parse(raw);
        for (const key of Object.keys(this.state)) {
          if (typeof data[key] === 'number') {
            this.state[key as DriveName] = data[key];
          }
        }
        this.lastTick = data.lastTick || Date.now();
        console.log(`[Desire] 已加载状态文件，lastTick=${new Date(this.lastTick).toISOString()}`);
      }
    } catch (err) {
      console.warn('[Desire] 加载状态失败，使用默认值', err);
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...this.state, lastTick: this.lastTick }, null, 2));
    } catch (err) {
      console.error('[Desire] 保存状态失败', err);
    }
  }

  tick(): void {
    const now = Date.now();
    const interval = (now - this.lastTick) / 60000;
    if (interval < 9) return;

    for (const [key, cfg] of Object.entries(DRIVE_CONFIG)) {
      const name = key as DriveName;
      const diff = cfg.baseline - this.state[name];
      this.state[name] += diff * cfg.decay * Math.min(interval / 10, 3);
      this.state[name] = Math.max(0, Math.min(1, this.state[name]));
    }

    const keys = Object.keys(DRIVE_CONFIG) as DriveName[];
    for (const name of keys) {
      let couplingDelta = 0;
      for (const other of keys) {
        if (name !== other) {
          couplingDelta += COUPLING * this.state[other] * 0.1;
        }
      }
      this.state[name] = Math.max(0, Math.min(1, this.state[name] + couplingDelta));
    }

    this.lastTick = now;
    this.saveState();
    console.log(`[Desire] tick完成:`, this.getTopIntent());
  }

  ingest(deltas: Partial<DriveState>): void {
    for (const [key, delta] of Object.entries(deltas)) {
      if (key in this.state && typeof delta === 'number') {
        this.state[key as DriveName] = Math.max(0, Math.min(1, this.state[key as DriveName] + delta));
      }
    }
    this.saveState();
  }

  getTopIntent(): { name: DriveName; score: number; message: string } {
    let top: DriveName = 'attachment';
    let maxScore = -Infinity;
    for (const [key, value] of Object.entries(this.state)) {
      if (value > maxScore) {
        maxScore = value;
        top = key as DriveName;
      }
    }
    return {
      name: top,
      score: maxScore,
      message: INTENT_MESSAGES[top] || '我想做点什么',
    };
  }

  getState(): DriveState {
    return { ...this.state };
  }

  reset(): void {
    this.state = this.getDefaultState();
    this.lastTick = Date.now();
    this.saveState();
  }
}

let instance: DesireEngine | null = null;
export function getDesireEngine(): DesireEngine {
  if (!instance) instance = new DesireEngine();
  return instance;
}
