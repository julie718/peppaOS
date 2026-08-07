// server/autonomy/idle_brain.ts
// T80 IdleBrain 待机深度自主思考模块
// 用户长时间离线时：碎片合并、内心独白、人文检索、月度自省
// 接入现有 scheduler 定时任务 + 7层空闲检测体系

import { logger } from '../lib/logger.js';
import { getEmotionEngine } from '../life/emotions.js';
import { getPersonalityEngine } from '../life/personality.js';
import { getLifeSystem } from '../life/index.js';
import { addMemory, queryMemories, promoteMemories } from '../memory/store.js';
import type { Memory, MemoryTier, MemoryPerspective } from '../memory/types.js';
import { consolidateEpisodic, consolidateNarrative, ConsolidationContext } from '../memory/consolidator.js';
import { addInteractionMemory, getSignificantMemories } from '../db/lifeDb.js';
import { getLastUserMessageAt } from '../life/userState.js';
import { getIdleState } from '../context/activity_stream.js';
import { getRecentIdleState } from './safety_gate.js';
import { perceiveRelation } from '../life/relationshipAwareness.js';
import type { BehaviorAdjustment } from '../life/relationshipAwareness.js';

// ── 配置 ──
const CONFIG = {
  SHORT_IDLE_SECONDS: 30,          // 短待机：对话结束后 30 秒
  LONG_IDLE_SECONDS: 4 * 3600,     // 长待机：全局空闲 4 小时
  MONTHLY_REFLECTION_DAY: 1,       // 每月 1 日凌晨
  MONTHLY_REFLECTION_HOUR: 3,      // 凌晨 3 点
  CHECK_INTERVAL_MS: 60_000,       // 每 1 分钟检查一次
  LONG_IDLE_MAX_PER_DAY: 1,        // 长待机每天最多执行 1 次
  MONTHLY_MAX_PER_MONTH: 1,        // 月度自省每月最多 1 次
  ENABLED: process.env.IDLE_BRAIN_DISABLED !== 'true',
  MONTHLY_ENABLED: process.env.IDLE_BRAIN_MONTHLY_ENABLED !== 'false', // 默认开启
};

// ── 状态 ──
interface IdleBrainState {
  lastShortCheck: number;
  lastLongRun: string | null;      // ISO date string of last long idle run
  lastMonthlyRun: string | null;   // ISO date string of last monthly reflection
  isRunning: boolean;
  totalCycles: number;
  innerMonologueCount: number;
}

class IdleBrain {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: IdleBrainState = {
    lastShortCheck: 0,
    lastLongRun: null,
    lastMonthlyRun: null,
    isRunning: false,
    totalCycles: 0,
    innerMonologueCount: 0,
  };

  // ── 空闲判定 ──
  checkShortIdle(): boolean {
    const now = Date.now();
    const elapsed = (now - this.state.lastShortCheck) / 1000;
    return this.state.lastShortCheck > 0 && elapsed >= CONFIG.SHORT_IDLE_SECONDS && elapsed < CONFIG.LONG_IDLE_SECONDS;
  }

  checkLongIdle(): boolean {
    // 使用 7 层空闲检测的数据
    // 1. activity_stream 的 getIdleState
    // 2. safety_gate 的 getRecentIdleState
    // P1-8: 全局时间戳已持久化 — global 内存值优先，磁盘兜底（重启后连续）
    const lastMessage = getLastUserMessageAt();
    if (!lastMessage) return false;

    const idleSeconds = (Date.now() - lastMessage) / 1000;
    if (idleSeconds < CONFIG.LONG_IDLE_SECONDS) return false;

    // 今天是否已经执行过长待机
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.lastLongRun === today) return false;

    return true;
  }

  checkMonthlyReflection(): boolean {
    if (!CONFIG.MONTHLY_ENABLED) return false;
    const now = new Date();
    if (now.getDate() !== CONFIG.MONTHLY_REFLECTION_DAY) return false;
    if (now.getHours() !== CONFIG.MONTHLY_REFLECTION_HOUR) return false;

    const monthKey = now.toISOString().slice(0, 7); // "2026-08"
    return this.state.lastMonthlyRun !== monthKey;
  }

  // ── 短待机逻辑 ──
  async shortIdleReview(): Promise<void> {
    try {
      logger.info('[IdleBrain] 短待机: 碎片合并 + 情绪回味');

      // 读取最近的交互记忆
      const recentMemories = await getSignificantMemories(5);
      if (recentMemories.length === 0) return;

      // 情绪回味
      const emotionEngine = getEmotionEngine();
      await emotionEngine.receiveEvent('new_scene');

      // 记录内部状态
      await addInteractionMemory('idle_short_review', {
        recentMemoryCount: recentMemories.length,
        timestamp: new Date().toISOString(),
      }, 0.3);

      logger.info(`[IdleBrain] 短待机完成: 回味了 ${recentMemories.length} 条记忆`);
    } catch (e: any) {
      logger.warn('[IdleBrain] 短待机异常:', e?.message || e);
    }
  }

  // ── 长待机逻辑 ──
  async longIdleConsolidation(): Promise<void> {
    try {
      logger.info('[IdleBrain] 长待机: 全量记忆归纳 + 经验固化 + 人文检索');

      // P1-9: 使用真实业务用户 ID（最后活跃用户），替代写死的 'system'
      const targetUserId = ((global as any).__lastActiveUid as string) || 'anonymous';

      // 1. 记忆归纳 — 真实用户 + 补全 LLM Getter（避免空回调导致调用报错被静默吞掉）
      const ctx: ConsolidationContext = {
        userId: targetUserId,
        provider: 'auto',
        model: 'auto',
        domain: 'personal',
        orgId: '',
      };

      try {
        // P1-9: 复用运行时 LLM Getter（chat handler 注册时写入 global），
        // 替代全部 () => null 的空 Getter — 空回调会让 makeLLMCall 直接 throw
        // 并被 catch 静默丢弃，固化永远不会真正执行
        const g = ((global as any).__llmGetters || {}) as Record<string, (() => any) | undefined>;
        const getter = (name: string): (() => any) => g[name] || (() => null);
        await consolidateEpisodic(
          ctx, 5,
          getter('getDeepSeek'), getter('getGemini'), getter('getOpenAI'),
          getter('getAnthropic'), getter('getQwen'), getter('getOllama'),
          getter('getLmStudio'), getter('getArk'), getter('getXiaomi'),
          getter('getKimi'), getter('getGlm'), getter('getRelay'),
        );
        logger.info('[IdleBrain] 碎片记忆已尝试固化（真实用户 ' + targetUserId + '）');
      } catch (e: any) {
        // 无 LLM 可用时跳过 LLM 固化，仍做规则化处理
        logger.info(`[IdleBrain] LLM 固化跳过: ${e?.message || '无可用模型'}`);
      }

      // 2. 经验固化 — 高频场景提升记忆权重（P1-9: promoteMemories 直接落库生效）
      try {
        const promoted = promoteMemories(targetUserId);
        if (promoted > 0) {
          logger.info(`[IdleBrain] 经验固化: ${promoted} 条高频记忆已提升权重并落库`);
        }
      } catch {}

      // 3. 人文类只读检索 — 从知识库中搜索非时事内容
      try {
        const knowledgeMemories = queryMemories({
          userId: targetUserId,
          tier: 'growth' as any,
          limit: 10,
        });
        if (knowledgeMemories.length > 0) {
          logger.info(`[IdleBrain] 人文检索: 查看 ${knowledgeMemories.length} 条成长记忆`);
        }
      } catch {}

      // 4. 生成内心独白 — 独处思考结果反向修正情绪基线（P1-10）
      try {
        const emotions = getEmotionEngine().getEmotions();
        const dominant = emotions.reduce((max, v, i, arr) => v > arr[max] ? i : max, 0);
        const labels = ['喜悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '依赖'];

        const monologue = `[${new Date().toISOString().slice(0, 10)} 内心独白] 当前主导情绪: ${labels[dominant]}。` +
          `独处中整理思绪，回顾了最近的对话和记忆。`;

        addMemory({
          userId: targetUserId,
          type: 'fact' as any,
          keywords: ['内心独白', 'idle_brain'],
          content: monologue,
          confidence: 0.8,
          sourceInteractionId: 'idle_brain_monologue',
        }, {
          tier: 'internalized' as any,
          perspective: 'owner_trait' as any,
          importance: 0.4,
          source: 'idle_brain' as any,
        });
        this.state.innerMonologueCount++;
        logger.info('[IdleBrain] 内心独白已生成');

        // P1-10: 独处思考 → 情绪基线修正（平静/满足微升，担忧/孤独微降）
        // 用独处整理思绪的"沉淀感"修正自身情绪，而非让低落情绪持续挂机累积
        await getEmotionEngine().updateEmotions([0, 0.02, 0, -0.01, -0.01, 0.02, 0, 0]);
        logger.info('[IdleBrain] 独处思绪已反向修正情绪基线');
      } catch {}

      // 记录执行日期
      this.state.lastLongRun = new Date().toISOString().slice(0, 10);
      logger.info('[IdleBrain] 长待机完成');
    } catch (e: any) {
      logger.error('[IdleBrain] 长待机异常:', e?.message || e);
    }
  }

  // ── 月度自省 ──
  async monthlyReflection(): Promise<void> {
    if (!CONFIG.MONTHLY_ENABLED) return;

    try {
      logger.info('[IdleBrain] 月度自省: 全周期关系复盘 + 风格微调');

      // 1. 全周期关系复盘
      const relation = await perceiveRelation();

      // 2. 人格风格微调（小步长）
      try {
        const personalityEngine = getPersonalityEngine();
        const currentPersonality = personalityEngine.getPersonality();

        // 基于关系状态计算微调 delta（最大 0.01）
        const delta: number[] = new Array(8).fill(0);

        // 如果亲密度上升 → 略微提升共情(4)和宜人(1)
        const intimacyTrend = relation?.trends?.find(t => t.dimension === '亲密感');
        if (intimacyTrend && intimacyTrend.velocity > 0.01) {
          delta[4] = 0.005;  // 共情微升
          delta[1] = 0.003;  // 宜人微升
        }

        // 如果信任度上升 → 略微提升开放(0)
        const trustTrend = relation?.trends?.find(t => t.dimension === '信任度');
        if (trustTrend && trustTrend.velocity > 0.01) {
          delta[0] = 0.003;  // 开放微升
        }

        // 只应用非零 delta
        if (delta.some(d => d !== 0)) {
          await personalityEngine.updatePersonality(
            currentPersonality.map((v, i) => Math.min(1, Math.max(0, v + (delta[i] || 0))))
          );
          logger.info(`[IdleBrain] 月度人格微调完成: delta=[${delta.map(d => d.toFixed(3)).join(',')}]`);
        } else {
          logger.info('[IdleBrain] 月度自省: 无显著变化，跳过微调');
        }
      } catch (e) {
        logger.warn('[IdleBrain] 人格微调失败:', e);
      }

      // 3. 记录月度自省记忆
      addMemory({
        userId: 'system',
        type: 'fact' as any,
        keywords: ['月度自省', '反思'],
        content: `[月度自省 ${new Date().toISOString().slice(0, 7)}] ${relation?.narrative || '定期自我审视完成。'}`,
        confidence: 0.9,
        sourceInteractionId: 'monthly_reflection',
      }, {
        tier: 'growth' as any,
        perspective: 'owner_trait' as any,
        importance: 0.8,
        source: 'monthly_reflection' as any,
      });

      this.state.lastMonthlyRun = new Date().toISOString().slice(0, 7);

      // P1-10: 月度人格复盘联动情绪状态 — 自省沉淀带来满足/平静回升
      try {
        await getEmotionEngine().updateEmotions([0, 0.02, 0, -0.01, -0.01, 0.03, 0, 0]);
        logger.info('[IdleBrain] 月度自省已联动情绪基线');
      } catch {}

      logger.info('[IdleBrain] 月度自省完成');
    } catch (e: any) {
      logger.error('[IdleBrain] 月度自省异常:', e?.message || e);
    }
  }

  // ── 主检查循环 ──
  async checkAndProcess(): Promise<void> {
    if (!CONFIG.ENABLED || this.state.isRunning) return;

    this.state.isRunning = true;
    this.state.totalCycles++;

    try {
      if (this.checkMonthlyReflection()) {
        await this.monthlyReflection();
      } else if (this.checkLongIdle()) {
        await this.longIdleConsolidation();
      } else if (this.checkShortIdle()) {
        await this.shortIdleReview();
      }
    } catch (e) {
      logger.warn('[IdleBrain] checkAndProcess 异常:', e);
    } finally {
      this.state.isRunning = false;
    }
  }

  // ── 外部触发：对话结束时的短待机标记 ──
  markConversationEnd(): void {
    this.state.lastShortCheck = Date.now();
  }

  // ── 启动 / 停止 ──
  start(): void {
    if (this.timer) return;
    logger.info(`[IdleBrain] 启动 (短待机=${CONFIG.SHORT_IDLE_SECONDS}s, 长待机=${CONFIG.LONG_IDLE_SECONDS / 3600}h, 月度自省=${CONFIG.MONTHLY_ENABLED ? '开启' : '关闭'})`);
    this.timer = setInterval(() => {
      this.checkAndProcess().catch(e => logger.warn('[IdleBrain] 定时检查失败:', e));
    }, CONFIG.CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[IdleBrain] 已停止');
    }
  }

  /** 获取 IdleBrain 运行统计 */
  getStats(): IdleBrainState {
    return { ...this.state };
  }
}

export const idleBrain = new IdleBrain();

// ── 供 Scheduler 调用的检查函数 ──
export async function idleBrainCheck(): Promise<string | null> {
  try {
    await idleBrain.checkAndProcess();
    const stats = idleBrain.getStats();
    if (stats.innerMonologueCount > 0 || stats.totalCycles > 0) {
      return `IdleBrain: cycles=${stats.totalCycles} monologues=${stats.innerMonologueCount}`;
    }
    return null;
  } catch (e: any) {
    logger.warn('[IdleBrain] scheduler check 异常:', e?.message || e);
    return null;
  }
}
