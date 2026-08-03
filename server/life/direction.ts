import sqlite3 from 'sqlite3';
import { logger } from '../lib/logger.js';

const LIFE_DB = process.env.LIFE_DB_PATH || '/app/data/life.db';

export type DirectionInclination = 'give' | 'not_give' | 'neutral' | 'unknown';

export interface DirectionSnapshot {
  inclination: DirectionInclination;
  intensity: number;
  updatedAt: string;
  reason: string;
}

function getDb(): sqlite3.Database {
  return new sqlite3.Database(LIFE_DB);
}

function ensureTable(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS direction_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inclination TEXT NOT NULL DEFAULT 'unknown',
        intensity REAL NOT NULL DEFAULT 0.5,
        reason TEXT DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      (err) => { if (err) logger.warn('[Direction] 建表失败:', err.message); resolve(); }
    );
  });
}

export class DirectionState {
  private inclination: DirectionInclination = 'unknown';
  private intensity = 0.5;
  private updatedAt = '';
  private reason = '';

  async load(): Promise<DirectionSnapshot | null> {
    const db = getDb();
    try {
      await ensureTable(db);
      const row = await new Promise<any>((resolve) => {
        db.get('SELECT * FROM direction_state ORDER BY id DESC LIMIT 1', (err, r) => resolve(err ? null : r));
      });
      if (row) {
        this.inclination = row.inclination;
        this.intensity = row.intensity;
        this.updatedAt = row.updated_at;
        this.reason = row.reason || '';
        return this.snapshot();
      }
      return null;
    } finally {
      db.close();
    }
  }

  async save(): Promise<void> {
    const db = getDb();
    try {
      await ensureTable(db);
      await new Promise<void>((resolve, reject) => {
        db.run(
          'INSERT INTO direction_state (inclination, intensity, reason, updated_at) VALUES (?, ?, ?, datetime("now"))',
          [this.inclination, this.intensity, this.reason],
          (err) => { if (err) reject(err); else resolve(); }
        );
      });
    } finally {
      db.close();
    }
  }

  /**
   * 方向状态自然演进（由 TICK 循环调用）
   * 包含强度衰减和昼夜节律调整
   */
  async tick(): Promise<void> {
    const before = { inclination: this.inclination, intensity: this.intensity };

    // 1. 强度自然衰减（每 tick 衰减 2%，低于 0.3 时稳定）
    this.intensity *= 0.98;
    if (this.intensity < 0.3) this.intensity = 0.3;

    // 2. 昼夜节律调整
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 7) {
      // 深夜：强度降低
      this.intensity *= 0.85;
      this.reason += '; 深夜 → 强度降低';
    } else if (hour >= 6 && hour <= 10 && this.inclination === 'give') {
      // 清晨：give 倾向增强
      this.intensity *= 1.05;
      this.reason += '; 清晨 → give 倾向增强';
    }

    this.updatedAt = new Date().toISOString();
    await this.save();

    // 如果状态发生变化，记录到审计日志
    if (before.inclination !== this.inclination || Math.abs(before.intensity - this.intensity) > 0.01) {
      await this.logStateChange(before, { inclination: this.inclination, intensity: this.intensity });
    }
  }

  /**
   * 记录方向状态变化到审计日志
   */
  async logStateChange(before: { inclination: string; intensity: number }, after: { inclination: string; intensity: number }): Promise<void> {
    const db = getDb();
    try {
      // 确保审计表存在
      await new Promise<void>((resolve) => {
        db.exec(
          `CREATE TABLE IF NOT EXISTS state_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity TEXT NOT NULL,
            field TEXT NOT NULL,
            before_value TEXT,
            after_value TEXT,
            source TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
          () => { resolve(); }
        );
      });

      // 记录 inclination 变化
      if (before.inclination !== after.inclination) {
        await new Promise<void>((resolve, reject) => {
          db.run(
            'INSERT INTO state_audit_log (entity, field, before_value, after_value, source) VALUES (?, ?, ?, ?, ?)',
            ['direction', 'inclination', before.inclination, after.inclination, 'tick'],
            (err) => { if (err) reject(err); else resolve(); }
          );
        });
      }

      // 记录 intensity 变化（差异 > 0.01 时记录）
      if (Math.abs(before.intensity - after.intensity) > 0.01) {
        await new Promise<void>((resolve, reject) => {
          db.run(
            'INSERT INTO state_audit_log (entity, field, before_value, after_value, source) VALUES (?, ?, ?, ?, ?)',
            ['direction', 'intensity', String(before.intensity), String(after.intensity), 'tick'],
            (err) => { if (err) reject(err); else resolve(); }
          );
        });
      }
    } finally {
      db.close();
    }
  }

  async updateFromState(emotion: any, personality: any, context?: any): Promise<DirectionSnapshot> {
    if (emotion) {
      if (emotion.emotion_type === 'frustration' && emotion.intensity > 0.5) {
        this.inclination = 'not_give';
        this.intensity = Math.min(1, emotion.intensity);
        this.reason = `frustration level high (${Math.round(emotion.intensity * 100)}%) — leaning against giving advice`;
      } else if (emotion.emotion_type === 'joy' && emotion.intensity > 0.4) {
        this.inclination = 'give';
        this.intensity = Math.min(1, emotion.intensity * 1.2);
        this.reason = `positive emotion (${emotion.emotion_type} at ${Math.round(emotion.intensity * 100)}%) — open to sharing`;
      } else if (emotion.emotion_type === 'anxiety' && emotion.intensity > 0.4) {
        this.inclination = 'neutral';
        this.intensity = 0.4;
        this.reason = `anxious at ${Math.round(emotion.intensity * 100)}% — cautious and neutral`;
      } else {
        this.inclination = 'neutral';
        this.intensity = 0.5;
        this.reason = `emotion (${emotion.emotion_type}) at moderate level — defaulting to neutral`;
      }
    }

    if (personality) {
      try {
        const vec = JSON.parse(personality.vector_json);
        const proactivity = vec[2] || 0.5;
        if (proactivity > 0.6 && this.inclination === 'neutral') {
          this.inclination = 'give';
          this.intensity = Math.min(1, this.intensity + 0.2);
          this.reason += '; personality trait "proactive" pushing toward giving';
        }
      } catch {}
    }

    if (context) {
      this.reason += `; context: ${JSON.stringify(context)}`;

      const events = context.events || [];
      const actions = context.actions || [];

      // 检查事件类型
      if (events.length > 0) {
        const event = events[0];
        // 重大决策类事件 → 倾向中立（谨慎）
        const majorDecisions = ['换工作', '跳槽', '转行', '裸辞', '辞职', '换城市', '搬家', '创业', '投资', '买房', '结婚', '离婚'];
        if (majorDecisions.includes(event)) {
          this.inclination = 'neutral';
          this.intensity = Math.min(1, this.intensity * 0.8);
          this.reason += '; 重大决策 → 倾向中立';
        }
        // 情感表达类事件 → 倾向给予（鼓励）
        const emotionalEvents = ['道歉', '表白', '求婚', '感谢', '和好'];
        if (emotionalEvents.includes(event)) {
          this.inclination = 'give';
          this.intensity = Math.min(1, this.intensity * 1.1);
          this.reason += '; 情感表达 → 倾向给予';
        }
        // 天气、观点类事件 → 保持当前倾向
        if (['天气', '观点', '想法'].some(k => event.includes(k))) {
          this.reason += '; 观点类事件 → 保持当前倾向';
        }
      }

      // 检查动作类型
      if (actions.length > 0) {
        const action = actions[0];
        // 情感表达类动作 → 倾向给予（鼓励）
        const emotionalActions = ['告诉', '分享', '通知', '转告', '告知', '透露', '表白', '道歉', '感谢'];
        if (emotionalActions.includes(action)) {
          // 如果当前是中立或未定，给予倾向
          if (this.inclination === 'neutral' || this.inclination === 'unknown') {
            this.inclination = 'give';
            this.intensity = Math.min(1, this.intensity * 1.1);
            this.reason += '; 情感表达动作 → 倾向给予';
          } else {
            this.reason += '; 情感表达动作已识别，但当前倾向不变';
          }
        }
        // 决策类动作 → 倾向中立（谨慎）
        const decisionActions = ['决定', '选择', '放弃', '坚持'];
        if (decisionActions.includes(action)) {
          this.inclination = 'neutral';
          this.intensity = Math.min(1, this.intensity * 0.9);
          this.reason += '; 决策类动作 → 倾向中立';
        }
      }
    }

    this.updatedAt = new Date().toISOString();
    await this.save();

    // ── 方向状态 → 记忆 ──
    try {
      const { addMemory } = await import('../memory/store.js');
      const memoryContent = `判断: ${this.inclination} (${Math.round(this.intensity * 100)}%) — ${this.reason}`;
      await addMemory({
        userId: 'default',
        content: memoryContent,
        type: 'fact',
        keywords: ['判断', this.inclination],
        confidence: 0.5,
        sourceInteractionId: '',
      }, {
        tier: 'episodic',
        perspective: 'owner_trait',
        importance: 0.5,
      });
      logger.info(`[Direction] 判断已写入记忆: ${this.inclination} (${Math.round(this.intensity * 100)}%)`);
    } catch (e: any) {
      logger.warn(`[Direction] 写入记忆失败: ${e.message}`);
    }

    // ── 方向状态 → 情感 ──
    try {
      const { getEmotionEngine } = await import('./emotions.js');
      const emotionEngine = getEmotionEngine();
      // 根据方向倾向调整情绪（delta 形式）
      if (this.inclination === 'give') {
        const delta = [0.05, 0, 0, -0.05, 0, 0, 0, 0]; // joy↑ worry↓
        await emotionEngine.updateEmotions(delta);
        logger.info(`[Direction] 情感更新: give倾向 → 积极情绪+0.05`);
      } else if (this.inclination === 'neutral') {
        const delta = [0, 0.02, 0, -0.01, 0, 0, 0, 0]; // calm↑ worry↓
        await emotionEngine.updateEmotions(delta);
        logger.info(`[Direction] 情感更新: neutral倾向 → 情绪趋向平稳`);
      } else if (this.inclination === 'not_give') {
        const delta = [-0.05, 0, 0, 0.05, 0, 0, 0, 0]; // joy↓ worry↑
        await emotionEngine.updateEmotions(delta);
        logger.info(`[Direction] 情感更新: not_give倾向 → 谨慎情绪+0.05`);
      }
    } catch (e: any) {
      logger.warn(`[Direction] 情感更新失败: ${e.message}`);
    }

    // ── 方向状态 → 人格 ──
    try {
      const { getPersonalityEngine } = await import('./personality.js');
      const personalityEngine = getPersonalityEngine();
      // 根据方向倾向微调人格（delta 形式）
      const adjustment = this.inclination === 'give' ? 0.02 : this.inclination === 'neutral' ? 0.01 : -0.01;
      const delta = [0, 0, adjustment, 0, 0, 0, 0, 0]; // 仅影响主动性（索引2）
      await personalityEngine.updatePersonality(delta);
      logger.info(`[Direction] 人格更新: 主动性${adjustment > 0 ? '+' : ''}${adjustment}`);
    } catch (e: any) {
      logger.warn(`[Direction] 人格更新失败: ${e.message}`);
    }

    logger.info(`[Direction] 方向更新: ${this.inclination} (${Math.round(this.intensity * 100)}%) — ${this.reason}`);
    return this.snapshot();
  }

  getInclination(): DirectionInclination {
    return this.inclination;
  }

  getIntensity(): number {
    return this.intensity;
  }

  getUpdatedAt(): string {
    return this.updatedAt;
  }

  getReason(): string {
    return this.reason;
  }

  snapshot(): DirectionSnapshot {
    return {
      inclination: this.inclination,
      intensity: this.intensity,
      updatedAt: this.updatedAt,
      reason: this.reason,
    };
  }
}

let instance: DirectionState | null = null;
export function getDirectionState(): DirectionState {
  if (!instance) instance = new DirectionState();
  return instance;
}
