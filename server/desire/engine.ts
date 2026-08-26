// server/desire/engine.ts
import * as fs from 'fs';
import * as path from 'path';
import { getDataPath } from '../config/data_path';

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
// Bug 修复：状态文件路径统一走 getDataPath 解析（Docker 内 LUMI_DATA_DIR=/app → /app/data/desire_state.json 不变；
// 本地环境回落 ~/Peppa/data/desire_state.json，此前硬编码 /app/data 导致本地写入失败、状态文件静默丢失）
const STATE_FILE = process.env.DESIRE_STATE_PATH || getDataPath('desire_state.json');

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

  private saveState(): boolean {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...this.state, lastTick: this.lastTick }, null, 2));
      return true;
    } catch (err) {
      console.error('[Desire] 保存状态失败', err);
      return false;
    }
  }

  tick(): void {
    const now = Date.now();
    const interval = (now - this.lastTick) / 60000;
    if (interval < 9) return;

    try {
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

      console.log(`[Desire] tick完成:`, this.getTopIntent());
    } finally {
      // Bug 修复：衰减计算无论成功失败，衰减时钟与状态文件都必须推进（lastTick 停滞根因之一）
      this.lastTick = now;
      this.saveState();
    }
  }

  /**
   * Bug 修复：欲望生成/归档逻辑结束后的状态文件对齐 —— 强制把持久化 lastTick 刷新为当前时间，
   * 与 db desires 表的持续更新对齐（此前状态文件 lastTick 长期卡死在首次写入值）。
   * 仅刷新文件观测时间戳，不动内存衰减时钟（避免高频刷新吞掉 tick() 的 9 分钟衰减门，V1 驱力衰减语义不变）。
   */
  refreshLastTick(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...this.state, lastTick: now }, null, 2));
      console.log(`[Desire] 状态文件 lastTick 已对齐为 ${new Date(now).toISOString()}（欲望归档后强制刷新，内存衰减时钟不受影响）`);
    } catch (err) {
      console.error('[Desire] 刷新状态文件 lastTick 失败', err);
    }
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
