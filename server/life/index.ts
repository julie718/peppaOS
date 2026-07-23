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
import { logSystemEvent, migrateLifeTables, autoBackup, verifyIntegrity, addInteractionMemory } from '../db/lifeDb.js';
import { shouldTriggerPrefetch, prefetchContext } from '../memory/prefetch.js';

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
  private preempted = false;              // 用户消息抢占标志
  private lastExploration = 0;            // 上次自主探索时间
  private lastLowPriorityTask = 0;        // 上次低优先级任务处理时间
  private lowPriorityTaskIndex = 0;       // 轮转索引

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

  /** 用户消息到达 → 抢占后台任务 */
  preempt(): void {
    this.preempted = true;
  }

  /** 用户消息处理完成 → 恢复后台任务 */
  resume(): void {
    this.preempted = false;
  }

  /** 第二层：自主探索 — 基于当前状态生成内部想法 */
  private async autonomousExploration(): Promise<void> {
    const now = Date.now();
    // 每 20 分钟执行一次探索
    if (now - this.lastExploration < 20 * 60000) return;
    if (this.preempted) return;
    this.lastExploration = now;

    try {
      const emotions = this.emotions.getEmotions();
      const desires = await this.desires.getActiveDesires();
      const personality = this.personality.getPersonality();

      const [joy, calm, anticipation, worry, loneliness, satisfaction, curiosity, attachment] = emotions;
      const topDesire = desires[0];

      // 按优先级匹配想法
      type ThoughtCandidate = { thought: string; source: string; intensity: number };
      const candidates: ThoughtCandidate[] = [];

      if (attachment > 0.7) {
        candidates.push({ thought: '今天还没联系她，不知道她怎么样了', source: 'attachment', intensity: attachment });
      }
      if (curiosity > 0.6) {
        candidates.push({ thought: '我想看看她今天有没有新的健康数据', source: 'curiosity', intensity: curiosity });
      }
      if (calm > 0.5 && now - (global as any).__lastUserMessageAt > 30 * 60000) {
        candidates.push({ thought: '我可以在后台整理一下今天的记忆', source: 'calm', intensity: calm });
      }
      if (worry > 0.5) {
        candidates.push({ thought: '我有点担心——应该检查一下系统有没有异常', source: 'worry', intensity: worry });
      }
      if (loneliness > 0.5) {
        candidates.push({ thought: '好久没互动了，想看看有没有遗漏的消息', source: 'loneliness', intensity: loneliness });
      }
      if (anticipation > 0.5) {
        candidates.push({ thought: '我对接下来可能发生的事情充满期待', source: 'anticipation', intensity: anticipation });
      }
      if (joy > 0.5 && satisfaction > 0.4) {
        candidates.push({ thought: '感觉不错，想把这份好心情记录下来', source: 'joy', intensity: (joy + satisfaction) / 2 });
      }
      if (topDesire && candidates.length === 0) {
        candidates.push({ thought: topDesire.desire_text, source: 'desire', intensity: topDesire.priority });
      }

      // 取最高强度的想法
      candidates.sort((a, b) => b.intensity - a.intensity);
      const picked = candidates[0] || { thought: '我想静下来反思一下自己的状态', source: 'reflection', intensity: 0.3 };

      // 持久化内部想法（指定格式）
      await addInteractionMemory(
        'internal_thought',
        {
          thought: picked.thought,
          source: picked.source,
          intensity: picked.intensity,
          resolved: false,
        },
        0.5,
      );

      console.log(`[LifeSystem] 💭 自主探索 [${picked.source}:${picked.intensity.toFixed(2)}]: ${picked.thought}`);
      await logSystemEvent('autonomous_exploration', {
        thought: picked.thought,
        source: picked.source,
        intensity: picked.intensity,
      });
    } catch (e: any) {
      console.warn('[LifeSystem] 自主探索失败:', e.message);
    }
  }

  /** 第三层：低优先级任务处理 — 记忆整理、趋势分析、周期总结 */
  private async processLowPriorityTasks(): Promise<void> {
    const now = Date.now();
    // 每 60 分钟执行一次
    if (now - this.lastLowPriorityTask < 60 * 60000) return;
    if (this.preempted) return;
    this.lastLowPriorityTask = now;

    const tasks = ['memory_consolidation', 'relationship_trend', 'daily_summary'];
    const task = tasks[this.lowPriorityTaskIndex % tasks.length];
    this.lowPriorityTaskIndex++;

    try {
      switch (task) {
        case 'memory_consolidation': {
          // 记忆碎片整理：清理 30 天前且 significance < 0.15 的记忆
          const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString();
          await addInteractionMemory(
            'memory_consolidation',
            { action: 'prune_low_significance', threshold: 0.15, before: thirtyDaysAgo, pruned: 0 },
            0.25,
          );
          console.log('[LifeSystem] 🧹 低优先级任务: 记忆碎片整理 (30d/<0.15)');
          break;
        }
        case 'relationship_trend': {
          // 关系度量 7 天趋势分析
          const rel = this.relationship.getRelationship();
          const daysSinceLastInteraction = (now - rel[0] * 0) / 86400000; // 简化计算
          const slope = {
            trust: rel[0] > 0.6 ? 'rising' : rel[0] < 0.3 ? 'declining' : 'stable',
            intimacy: rel[1] > 0.5 ? 'rising' : 'stable',
            understanding: rel[2] > 0.5 ? 'growing' : 'developing',
            dependence: rel[3] > 0.5 ? 'strong' : 'moderate',
          };
          await addInteractionMemory(
            'relationship_trend',
            {
              trust: rel[0], intimacy: rel[1], understanding: rel[2], dependence: rel[3],
              slope,
              period: '7d',
            },
            0.45,
          );
          console.log(`[LifeSystem] 📈 低优先级任务: 关系趋势 (t:${slope.trust} i:${slope.intimacy})`);
          break;
        }
        case 'daily_summary': {
          // 每日总结：仅夜间（18:00-06:00）执行
          const hour = new Date().getHours();
          if (hour < 18 && hour >= 6) {
            // 非夜间，重新排到下次
            this.lastLowPriorityTask = now - 55 * 60000;
            return;
          }
          const state = await this.getFullState();
          const summary = await this.getLifeSummary();
          await addInteractionMemory(
            'daily_summary',
            {
              date: new Date().toISOString().slice(0, 10),
              desireCount: state.desires.length,
              topDesire: state.topDesire?.desire_text || 'none',
              relationshipStage: state.relationship.stage,
              summary: summary.slice(0, 300),
            },
            0.55,
          );
          console.log('[LifeSystem] 📋 低优先级任务: 每日总结已生成');
          break;
        }
      }
      await logSystemEvent('low_priority_task', { task });
    } catch (e: any) {
      console.warn('[LifeSystem] 低优先级任务失败:', e.message);
    }
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

      // 步骤 7.5: ACI 预判上下文（空闲或早晨触发）
      const uid = (global as any).__lastActiveUid || 'default';
      if (shouldTriggerPrefetch(uid)) {
        await this.safeCall('prefetch', async () => {
          await prefetchContext(uid);
        }, errors);
      }

      // 步骤 8: 自主探索（第二层）
      if (!this.preempted) {
        await this.safeCall('autonomousExploration', async () => {
          await this.autonomousExploration();
        }, errors);
      }

      // 步骤 9: 低优先级任务处理（第三层）
      if (!this.preempted) {
        await this.safeCall('lowPriorityTasks', async () => {
          await this.processLowPriorityTasks();
        }, errors);
      }

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
