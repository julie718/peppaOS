// server/autonomy/idle_brain.ts
// T80 IdleBrain 待机深度自主思考模块
// 用户长时间离线时：碎片合并、内心独白、人文检索、月度自省

// 【重构·模块4】内心独白文案模板池（MONOLOGUE_TEMPLATES）已移除：
// 原按 8 种主导情绪各写死 2-3 条固定独白文案（目标⑥，固定话术模板）。
// 现由 composeTriggerContent 心智润色组成（主导情绪等实时状态 → 心智内核组织表述），
// 离线回退结构化摘要（容灾）。记忆写入结构（keywords/tier/importance/source）保留。
// 接入现有 scheduler 定时任务 + 7层空闲检测体系

import { logger } from '../lib/logger';
// Phase3: 灰度开关 + InnerTick 心智模块（可选触发，不接管空闲大脑输出）
import { MIND_SWITCH } from '../../src/config/mindSwitch';
import { runInnerTick } from '../../src/core/innerTick';
import { getEmotionEngine } from '../life/emotions';
import { getPersonalityEngine } from '../life/personality';
import { getLifeSystem } from '../life/index';
import { queryMemories, promoteMemories } from '../memory/store';
// Phase4: 旧模块 addMemory 直接写入迁移 — 事件封装后经 runInnerTick 统一落库（仅 innerTick.ts 内部允许 addMemory）
import type { MentalEventItem } from '../../src/types/innerTickSchema';
import type { Memory, MemoryTier, MemoryPerspective } from '../memory/types';
import { consolidateEpisodic, consolidateNarrative, ConsolidationContext } from '../memory/consolidator';
import { addInteractionMemory, getSignificantMemories } from '../db/lifeDb';
import { getLastUserMessageAt } from '../life/userState';
import { getIdleState } from '../context/activity_stream';
import { getRecentIdleState } from './safety_gate';
import { perceiveRelation } from '../life/relationshipAwareness';
import type { BehaviorAdjustment } from '../life/relationshipAwareness';
// 【重构·模块4】内心独白由心智润色组成
import { composeTriggerContent } from '../proactive/rhythm';

// ── 配置 ──
const CONFIG = {
  SHORT_IDLE_SECONDS: 30,          // 短待机：对话结束后 30 秒
  LONG_IDLE_SECONDS: 4 * 3600,     // 长待机：全局空闲 4 小时
  MONTHLY_REFLECTION_DAY: 1,       // 每月 1 日凌晨
  MONTHLY_REFLECTION_HOUR: 3,      // 凌晨 3 点
  CHECK_INTERVAL_MS: 60_000,       // P2-5: 已废弃（保留常量防外部引用），实际由 Scheduler every_5m 驱动
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
      const targetUserId = ((global as any).__lastActiveUid as string) || 'default';
      // Phase4: 本任务派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
      const eventList: MentalEventItem[] = [];

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
      // 【重构·模块4】固定独白模板池移除：独白由 composeTriggerContent 心智润色组成
      // （主导情绪等实时状态数据 → 心智内核组织表述），离线回退结构化摘要（容灾）。
      try {
        const emotions = getEmotionEngine().getEmotions();
        const dominant = emotions.reduce((max, v, i, arr) => v > arr[max] ? i : max, 0);
        const labels = ['喜悦', '平静', '期待', '担忧', '孤独', '满足', '好奇', '牵挂'];
        const dominantLabel = labels[dominant] || '平静';

        const date = new Date().toISOString().slice(0, 10);
        const text = await composeTriggerContent('inner_monologue', { date, dominant: dominantLabel });
        const monologue = `[${date} 内心独白] 主导情绪: ${dominantLabel}。${text}`;

        // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
        const evt: MentalEventItem = {
          source: 'idle_brain',
          eventType: 'inner_monologue',
          brief: '空闲内心独白',
          payload: { monologue, dominantEmotion: dominantLabel, date },
        };
        eventList.push(evt);
        this.state.innerMonologueCount++;
        logger.info('[IdleBrain] 内心独白已生成');

        // P1-10: 独处思考 → 情绪基线修正（平静/满足微升，担忧/孤独微降）
        // 用独处整理思绪的"沉淀感"修正自身情绪，而非让低落情绪持续挂机累积
        await getEmotionEngine().updateEmotions([0, 0.02, 0, -0.01, -0.01, 0.02, 0, 0]);
        logger.info('[IdleBrain] 独处思绪已反向修正情绪基线');
      } catch {}

      // 阶段一·模块2: 5. 空闲资讯简报 — 长待机时用多源新闻生成简报推送（复用 NEWS_SOURCES 底座）
      try {
        const { generateIdleBriefing } = await import('./psi_motivation');
        const briefing = await generateIdleBriefing(targetUserId);
        if (briefing) logger.info(`[IdleBrain] 空闲资讯简报已生成 → ${targetUserId}`);
      } catch (e: any) {
        logger.warn(`[IdleBrain] 资讯简报跳过: ${e?.message || '网络不可用'}`);
      }

      // Phase4: 任务末尾派发本任务派生心智事件（非阻塞，失败不影响主流程）
      if (eventList.length > 0) {
        void runInnerTick({ userId: targetUserId, derivedMentalEvents: eventList }).catch((e: any) =>
          logger.warn(`[IdleBrain] 心智事件派发失败: ${e?.message || e}`),
        );
      }

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

    // Phase4: 本任务派生心智事件收集（替代原直接 addMemory 写入，任务末尾随 runInnerTick 注入）
    const eventList: MentalEventItem[] = [];

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
      // L-9: 归属真实用户（与长待机整合一致的 __lastActiveUid 模式）— 修复前写死 'system'，
      // 月度自省记忆永远落不到任何用户记忆库，GC/检索都拿不到它
      // Phase4: 原 addMemory 直接写入 → 封装为 MentalEventItem，任务末尾经 runInnerTick 注入推演统一落库
      const monthlyUserId = ((global as any).__lastActiveUid as string) || 'default';
      const evt: MentalEventItem = {
        source: 'idle_brain',
        eventType: 'monthly_reflection',
        brief: '月度自省复盘',
        payload: {
          month: new Date().toISOString().slice(0, 7),
          narrative: relation?.narrative || '定期自我审视完成。',
        },
      };
      eventList.push(evt);

      this.state.lastMonthlyRun = new Date().toISOString().slice(0, 7);

      // P1-10: 月度人格复盘联动情绪状态 — 自省沉淀带来满足/平静回升
      try {
        await getEmotionEngine().updateEmotions([0, 0.02, 0, -0.01, -0.01, 0.03, 0, 0]);
        logger.info('[IdleBrain] 月度自省已联动情绪基线');
      } catch {}

      // Phase4: 任务末尾派发本任务派生心智事件（非阻塞，失败不影响主流程）
      if (eventList.length > 0) {
        void runInnerTick({ userId: monthlyUserId, derivedMentalEvents: eventList }).catch((e: any) =>
          logger.warn(`[IdleBrain] 心智事件派发失败: ${e?.message || e}`),
        );
      }

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
      // ── Phase3 灰度：InnerTick 空闲心智触发（enableInnerTickIdleTrigger，默认关闭）──
      // 仅作为额外心智推演（LLM 驱动，写 life.db 快照备份），不接管空闲大脑输出；
      // void 异步非阻塞执行，失败不影响旧逻辑。
      if (MIND_SWITCH.enableInnerTickIdleTrigger) {
        const userId = ((global as any).__lastActiveUid as string) || 'default';
        void runInnerTick({ userId }).catch((e: any) =>
          logger.warn(`[IdleBrain] InnerTick 触发失败: ${e?.message || e}`),
        );
      }

      // ── Phase3 开关：enableOldIdleBrain=false 时仅跳过旧空闲大脑逻辑执行（实现完整保留，可一键切回）──
      if (!MIND_SWITCH.enableOldIdleBrain) return;

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
  // P2-5: 移除内部 60s setInterval — 与 Scheduler 的 idle_brain_check (every_5m) 存在双重执行
  // （重复复盘、日志刷屏）。统一由 Scheduler 每 5 分钟驱动 checkAndProcess()，
  // 内部已有 isRunning 运行锁防并发。start()/stop() 保留幂等语义，兼容既有调用方。
  start(): void {
    if (this.timer) return;
    logger.info(`[IdleBrain] 启动 (短待机=${CONFIG.SHORT_IDLE_SECONDS}s, 长待机=${CONFIG.LONG_IDLE_SECONDS / 3600}h, 月度自省=${CONFIG.MONTHLY_ENABLED ? '开启' : '关闭'}, 驱动=5分钟Scheduler)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[IdleBrain] 已停止');
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
