// 数字生命体 — 主循环协调器
// 整合人格、情绪、欲望、自我意识、关系 五个子系统
// 与现有闸门/注入系统联动
import { getPersonalityEngine, Personality } from './personality.js';
import { getEmotionEngine, EmotionEngine } from './emotions.js';
import { getDesireEngineV2, DesireEngine } from './desires.js';
import { getSelfAwarenessEngine, SelfAwarenessEngine } from './selfAwareness.js';
import { getRelationshipEngine, RelationshipEngine } from './relationship.js';
import { checkGates, recordHeartbeat } from '../heartbeat/gates.js';
import { triggerHeartbeatIfReady } from '../heartbeat/injector.js';
import { logSystemEvent, migrateLifeTables, autoBackup, verifyIntegrity } from '../db/lifeDb.js';

const TICK_INTERVAL_MS = 10 * 60000; // 10 分钟
const DEGRADED_THRESHOLD = 3; // 连续 3 次失败进入降级模式

interface LifeState {
  personality: number[];
  emotions: number[];
  desires: any[];
  topDesire: any | null;
  relationship: {
    stage: string;
    vector: number[];
    decisionInfluence: any;
    labels: any[];
  };
  selfAwareness: {
    reflectionCount: number;
    latest: any;
    assessment: string;
  };
}

export class LifeSystem {
  personality: Personality;
  emotions: EmotionEngine;
  desires: DesireEngine;
  selfAwareness: SelfAwarenessEngine;
  relationship: RelationshipEngine;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private degraded = false;
  private running = false;

  constructor() {
    this.personality = getPersonalityEngine();
    this.emotions = getEmotionEngine();
    this.desires = getDesireEngineV2();
    this.selfAwareness = getSelfAwarenessEngine();
    this.relationship = getRelationshipEngine();
  }

  /** 初始化所有子系统 */
  async initializeLifeSystem(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    console.log('[LifeSystem] ======== 数字生命体初始化 ========');

    try {
      await migrateLifeTables();
      console.log('[LifeSystem] ✅ 数据库迁移完成');
    } catch (e: any) {
      errors.push(`database: ${e.message}`);
      console.error('[LifeSystem] ❌ 数据库迁移失败:', e.message);
    }

    // 每个子系统初始化时自动加载持久化状态（构造函数已执行）
    // 此处做健康检查
    const checks = [
      { name: 'personality', fn: () => this.personality.getPersonality() },
      { name: 'emotions', fn: () => this.emotions.getEmotions() },
      { name: 'desires', fn: async () => { await this.desires.generateDesires(); return true; } },
      { name: 'selfAwareness', fn: () => this.selfAwareness.getLatestReflection() },
      { name: 'relationship', fn: () => this.relationship.getRelationship() },
    ];

    for (const check of checks) {
      try {
        await check.fn();
        console.log(`[LifeSystem] ✅ ${check.name} 正常`);
      } catch (e: any) {
        errors.push(`${check.name}: ${e.message}`);
        console.error(`[LifeSystem] ❌ ${check.name} 异常:`, e.message);
      }
    }

    try {
      await autoBackup();
    } catch (e: any) {
      errors.push(`backup: ${e.message}`);
    }

    await logSystemEvent('life_system_init', { ok: errors.length === 0, errors });

    console.log(`[LifeSystem] ======== 初始化完成 (${errors.length} 个错误) ========`);
    return { ok: errors.length === 0, errors };
  }

  /** 启动主循环 */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[LifeSystem] ▶ 主循环启动 (10分钟间隔)');

    // 立即执行首次 tick
    this.tick().catch(e => console.error('[LifeSystem] 首次tick失败:', e.message));

    // 每 10 分钟执行
    this.tickTimer = setInterval(() => {
      this.tick().catch(e => console.error('[LifeSystem] tick失败:', e.message));
    }, TICK_INTERVAL_MS);
  }

  /** 停止主循环 */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.running = false;
    console.log('[LifeSystem] ⏸ 主循环停止');
  }

  /** 每 10 分钟执行一次完整循环 */
  async tick(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const startTime = Date.now();

    try {
      // 步骤 1: 情绪衰减 (tick)
      await this.safeCall('emotions.tick', async () => {
        await this.emotions.tickEmotions();
      }, errors);

      // 步骤 2: 欲望生成与衰减
      await this.safeCall('desires.generate', async () => {
        await this.desires.generateDesires();
        await this.desires.tick();
      }, errors);

      // 步骤 3: 人格适应（基于交互事件）
      // 如果有长时间无交互事件
      await this.safeCall('personality.long_silence', async () => {
        // 关系系统会检测长时间沉默
        const relVec = this.relationship.getRelationship();
        if (relVec[3] < 0.25) {
          await this.personality.adaptToEvent({ type: 'long_silence' });
        }
      }, errors);

      // 步骤 4: 关系衰减
      await this.safeCall('relationship.tick', async () => {
        const relVec = this.relationship.getRelationship();
        // 如果有长时间无交互，关系微调
        // 关系系统内部有 updateRelationship 处理
      }, errors);

      // 步骤 5: 自我反思（夜间触发）
      await this.safeCall('selfAwareness.reflection', async () => {
        await this.selfAwareness.triggerReflection();
      }, errors);

      // 步骤 6: 闸门检查 + 行动
      if (!this.degraded) {
        await this.safeCall('heartbeat.gates', async () => {
          try {
            triggerHeartbeatIfReady();
          } catch {}
        }, errors);
      }

      // 步骤 7: 数据库维护
      await this.safeCall('backup', async () => {
        await autoBackup();
      }, errors);

      // 成功：重置失败计数
      this.consecutiveFailures = 0;
      if (this.degraded) {
        console.log('[LifeSystem] ✅ 恢复正常模式');
        await logSystemEvent('life_system_recovery', { failuresBefore: this.consecutiveFailures });
        this.degraded = false;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 5000) {
        console.warn(`[LifeSystem] ⚠️ tick 耗时较长: ${elapsed}ms`);
      }

      await logSystemEvent('life_system_tick', { ok: true, elapsed, errors: errors.length });
      return { ok: errors.length === 0, errors };
    } catch (e: any) {
      this.consecutiveFailures++;
      console.error(`[LifeSystem] tick 整体失败 (${this.consecutiveFailures}/${DEGRADED_THRESHOLD}):`, e.message);

      await logSystemEvent('life_system_tick_fail', {
        error: e.message,
        consecutiveFailures: this.consecutiveFailures,
      });

      if (this.consecutiveFailures >= DEGRADED_THRESHOLD) {
        this.degraded = true;
        console.warn('[LifeSystem] ⚠️ 进入降级模式（只记录，不行动）');
        await logSystemEvent('life_system_degraded', { reason: 'consecutive_failures', count: this.consecutiveFailures });
      }

      return { ok: false, errors: [...errors, e.message] };
    }
  }

  /** 安全调用子系统方法 */
  private async safeCall(
    name: string,
    fn: () => Promise<void>,
    errors: string[],
  ): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      errors.push(`${name}: ${e.message}`);
      console.error(`[LifeSystem] ${name} 异常:`, e.message);
    }
  }

  /** 接收外部感知输入 */
  async receivePerception(perceptionVector: number[]): Promise<void> {
    if (perceptionVector.length < 12) {
      console.warn('[LifeSystem] 感知向量维度异常:', perceptionVector.length);
      return;
    }

    try {
      // 感知 → 情绪更新
      await this.emotions.receivePerception(perceptionVector);

      // 感知 → 人格微调（渐进式）
      const [hr, hrv, sleep, , steps, , , screen, timePhase, calendar, arousal, fatigue] = perceptionVector;

      // 高心率 + 低 HRV → 用户可能压力大，通知情绪系统
      if (hr > 0.6 && hrv < 0.3) {
        await this.emotions.receiveEvent('health_alert', { hr, hrv });
        await this.relationship.receiveInteraction('user_shared_feelings');
      }

      // 睡眠质量差 → 触发关心欲望
      if (sleep < 0.3) {
        await this.desires.generateDesires();
      }

      // 场景=家(0.1) + 安静(0.1) → 适合聊天
      const scene = perceptionVector[5] || 0;
      const env = perceptionVector[6] || 0;
      if (Math.abs(scene - 0.1) < 0.01 && env < 0.2) {
        // 不做特殊处理，由欲望系统自然生成"想聊天"
      }

      await logSystemEvent('perception_received', {
        hr: hr.toFixed(2),
        sleep: sleep.toFixed(2),
        steps: steps.toFixed(2),
        arousal: arousal.toFixed(2),
      });
    } catch (e: any) {
      console.error('[LifeSystem] 感知处理失败:', e.message);
    }
  }

  /** 接收交互事件 */
  async receiveInteraction(
    type: string,
    outcome: 'accepted' | 'ignored' | 'positive' | 'negative' | 'neutral' = 'neutral',
  ): Promise<void> {
    try {
      // 关系更新
      await this.relationship.receiveInteraction(type, outcome);

      // 映射到人格事件
      const personalityEventMap: Record<string, any> = {
        'user_initiated': { type: 'user_initiated' as const },
        'user_positive': { type: 'user_positive' as const },
        'user_corrected': { type: 'user_negative' as const },
        'user_shared_feelings': { type: 'user_high_arousal' as const },
      };
      if (personalityEventMap[type]) {
        await this.personality.adaptToEvent(personalityEventMap[type]);
      }

      // 映射到情绪事件
      const emotionEventMap: Record<string, string> = {
        'user_positive': 'user_positive',
        'user_corrected': 'user_negative',
        'long_silence': 'long_silence',
        'user_shared_feelings': 'user_positive',
      };
      if (emotionEventMap[type]) {
        await this.emotions.receiveEvent(emotionEventMap[type]);
      }

      // 交互后更新欲望
      await this.desires.generateDesires();

      await logSystemEvent('interaction_received', { type, outcome });
    } catch (e: any) {
      console.error('[LifeSystem] 交互处理失败:', e.message);
    }
  }

  /** 获取完整状态（用于调试和 UI） */
  async getFullState(): Promise<LifeState> {
    const desires = await this.desires.getActiveDesires();
    const topDesire = await this.desires.getTopDesire();
    const relState = this.relationship.getRelationshipState();
    const saState = await this.selfAwareness.getState();

    return {
      personality: this.personality.getPersonality(),
      emotions: this.emotions.getEmotions(),
      desires,
      topDesire,
      relationship: relState,
      selfAwareness: saState,
    };
  }

  /** 获取简要摘要（用于表达生成） */
  async getLifeSummary(): Promise<string> {
    const personality = this.personality.summarize();
    const emotions = this.emotions.summarize();
    const relState = this.relationship.getRelationshipState();
    const topDesire = await this.desires.getTopDesire();

    const parts = [
      `人格: ${personality}`,
      `情绪: ${emotions}`,
      `关系: ${relState.stage} [${relState.vector.map(v => v.toFixed(2)).join(',')}]`,
    ];
    if (topDesire) {
      parts.push(`最想: ${topDesire.desire_text} (优先级 ${topDesire.priority.toFixed(2)})`);
    }

    return parts.join('\n');
  }

  /** 健康检查 */
  async healthCheck(): Promise<{ healthy: boolean; degraded: boolean; checks: Record<string, boolean> }> {
    const checks: Record<string, boolean> = {};
    try { this.personality.getPersonality(); checks.personality = true; } catch { checks.personality = false; }
    try { this.emotions.getEmotions(); checks.emotions = true; } catch { checks.emotions = false; }
    try { await this.desires.getActiveDesires(); checks.desires = true; } catch { checks.desires = false; }
    try { this.relationship.getRelationship(); checks.relationship = true; } catch { checks.relationship = false; }
    try { await this.selfAwareness.getLatestReflection(); checks.selfAwareness = true; } catch { checks.selfAwareness = false; }

    // 数据库完整性
    try {
      const integrity = await verifyIntegrity();
      checks.database = integrity.ok;
    } catch { checks.database = false; }

    const allOk = Object.values(checks).every(Boolean);
    return { healthy: allOk, degraded: this.degraded, checks };
  }
}

let instance: LifeSystem | null = null;
export function getLifeSystem(): LifeSystem {
  if (!instance) instance = new LifeSystem();
  return instance;
}
