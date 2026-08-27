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
// Phase-2 修复：后台 session=- 浅层推演管控（2h 硬冷却 / 独立每日熔断 / LLM 健康降级保护；chat_turn 不计入）
import { runInnerTick, isBackgroundInnerTickInCooldown, isBackgroundInnerTickBreakerOpen, recordBackgroundInnerTick, hasInnerTickLLMFailures } from '../../src/core/innerTick';
import { getEmotionEngine } from '../life/emotions';
import { getPersonalityEngine } from '../life/personality';
import { getLifeSystem } from '../life/index';
import { queryMemories, promoteMemories } from '../memory/store';
// Phase4: 旧模块 addMemory 直接写入迁移 — 事件封装后经 runInnerTick 统一落库（仅 innerTick.ts 内部允许 addMemory）
import type { MentalEventItem } from '../../src/types/innerTickSchema';
import type { Memory, MemoryTier, MemoryPerspective } from '../memory/types';
import { consolidateEpisodic, consolidateNarrative, ConsolidationContext } from '../memory/consolidator';
// Phase-2 修复：后台推演触发条件数据源（情绪大幅波动 / 高权重欲望变动）
import { addInteractionMemory, getSignificantMemories, getRecentEmotions, getActiveDesires } from '../db/lifeDb';
import { getLastUserMessageAt } from '../life/userState';
// Phase-2 修复：降级保护 — CPU 负载判定（与 mainLoop 阈值一致）
import os from 'os';
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
  // ── Phase-2 修复：后台 session=- 浅层推演管控（替换原 allowIdleInnerTick 1 小时闸门）──
  // 触发条件：近30min有对话 / 情绪大幅波动 / 高权重欲望变动（任一满足即触发）；
  // 2h 最小冷却为 core 层代码硬锁（INNER_TICK_BG_MIN_INTERVAL_MS），本配置仅保留触发/降级阈值。
  BG_TRIGGER_RECENT_DIALOG_MS: 30 * 60 * 1000,    // 近 30 分钟内有对话 → 触发
  BG_EMOTION_SWING_THRESHOLD: 0.25,               // 最近 4 条情绪强度极差 ≥ 0.25 → 视为大幅波动
  BG_DESIRE_PRIORITY_THRESHOLD: 0.6,              // 高权重欲望：priority ≥ 0.6
  BG_DESIRE_CHANGE_WINDOW_MS: 2 * 60 * 60 * 1000, // 高权重欲望近 2h 内创建/更新 → 视为变动
  BG_CPU_LOAD_MAX: 2.0,                           // 1 分钟平均负载 > 2.0 → CPU 高（与 mainLoop 阈值一致）
  BG_SQLITE_SLOW_MS: 500,                         // 单次 SQLite 读取 > 500ms → 慢查询
  BG_LLM_FAIL_WINDOW: 3,                          // 最近 3 次 InnerTick LLM 推演中…
  BG_LLM_FAIL_THRESHOLD: 2,                       // …≥ 2 次超时/失败 → LLM 连续故障
};

// ── 状态 ──
interface IdleBrainState {
  lastShortCheck: number;
  lastLongRun: string | null;      // ISO date string of last long idle run
  lastMonthlyRun: string | null;   // ISO date string of last monthly reflection
  isRunning: boolean;
  totalCycles: number;
  innerMonologueCount: number;
  lastBackgroundInnerTickAt: number; // Phase-2 修复：上次后台浅层推演时间（观测用；2h 硬锁在 core 层强制）
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
    lastBackgroundInnerTickAt: 0,
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
      // Phase-2 修复：depth=shallow — 人格微漂移只允许深层推演执行，长待机事件派发不落库 personalityDrift
      if (eventList.length > 0) {
        void runInnerTick({ userId: targetUserId, depth: 'shallow', derivedMentalEvents: eventList }).catch((e: any) =>
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
      // Phase-2 修复：depth=shallow — 人格微漂移只允许深层推演执行，月度自省事件派发不落库 personalityDrift
      if (eventList.length > 0) {
        void runInnerTick({ userId: monthlyUserId, depth: 'shallow', derivedMentalEvents: eventList }).catch((e: any) =>
          logger.warn(`[IdleBrain] 心智事件派发失败: ${e?.message || e}`),
        );
      }

      logger.info('[IdleBrain] 月度自省完成');
    } catch (e: any) {
      logger.error('[IdleBrain] 月度自省异常:', e?.message || e);
    }
  }

  // ── Phase-2 修复：后台 session=- 浅层推演（触发条件 + 降级保护 + 2h 硬冷却 + 每日熔断）──

  /** SQLite 时间字符串（"YYYY-MM-DD HH:MM:SS" UTC）→ ms 时间戳；非法/空返回 0 */
  private parseSqliteTs(ts: string | null | undefined): number {
    if (!ts) return 0;
    const n = Date.parse(String(ts).replace(' ', 'T') + 'Z');
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 后台推演触发条件评估（任一满足即触发）：
   *  1) 近 30min 内有对话（最后用户消息在 30 分钟内）；
   *  2) 情绪大幅波动（最近 4 条情绪强度极差 ≥ 0.25）；
   *  3) 高权重欲望变动（priority ≥ 0.6 的活跃欲望近 2h 内创建/更新）。
   * 返回触发原因与本次 SQLite 读取耗时（供慢查询降级判定复用，避免重复查询）。
   */
  private async evaluateBackgroundTrigger(): Promise<{ trigger: string | null; sqliteMs: number }> {
    // 1) 近 30min 有对话（零 IO，先判）
    const lastMsg = getLastUserMessageAt();
    if (lastMsg > 0 && Date.now() - lastMsg <= CONFIG.BG_TRIGGER_RECENT_DIALOG_MS) {
      return { trigger: `近30min有对话（${Math.round((Date.now() - lastMsg) / 60000)} 分钟前）`, sqliteMs: 0 };
    }

    // 2) 情绪大幅波动（本次 SQLite 读取顺带计时，供慢查询降级判定）
    const t0 = Date.now();
    const emotions = await getRecentEmotions(4).catch(() => [] as any[]);
    const sqliteMs = Date.now() - t0;
    if (emotions.length >= 2) {
      const intensities = emotions.map((e: any) => Number(e.intensity) || 0);
      const swing = Math.max(...intensities) - Math.min(...intensities);
      if (swing >= CONFIG.BG_EMOTION_SWING_THRESHOLD) {
        return { trigger: `情绪大幅波动（最近情绪强度极差 ${swing.toFixed(2)} ≥ ${CONFIG.BG_EMOTION_SWING_THRESHOLD}）`, sqliteMs };
      }
    }

    // 3) 高权重欲望变动
    const desires = await getActiveDesires().catch(() => [] as any[]);
    const changed = desires.find((d: any) =>
      Number(d.priority) >= CONFIG.BG_DESIRE_PRIORITY_THRESHOLD &&
      Math.max(this.parseSqliteTs(d.updated_at), this.parseSqliteTs(d.created_at)) >
        Date.now() - CONFIG.BG_DESIRE_CHANGE_WINDOW_MS,
    );
    if (changed) {
      return { trigger: `高权重欲望变动（priority=${Number(changed.priority).toFixed(2)}: ${String(changed.desire_text || '').slice(0, 40)}）`, sqliteMs };
    }

    return { trigger: null, sqliteMs };
  }

  /** 降级保护：CPU 高 / SQLite 慢查询 / LLM 连续超时 → 返回跳过原因；系统健康返回 null */
  private backgroundDegradationReason(sqliteMs: number): string | null {
    // 1) CPU 高（1 分钟平均负载 > 2.0，与 mainLoop 阈值一致）
    const load1 = os.loadavg()[0];
    if (load1 > CONFIG.BG_CPU_LOAD_MAX) {
      return `CPU 负载高（load1=${load1.toFixed(1)} > ${CONFIG.BG_CPU_LOAD_MAX}）`;
    }
    // 2) SQLite 慢查询（触发评估中的读取耗时 > 500ms）
    if (sqliteMs > CONFIG.BG_SQLITE_SLOW_MS) {
      return `SQLite 慢查询（读取耗时 ${sqliteMs}ms > ${CONFIG.BG_SQLITE_SLOW_MS}ms）`;
    }
    // 3) LLM 连续超时/失败（最近 3 次 InnerTick 推演 ≥ 2 次失败）
    if (hasInnerTickLLMFailures(CONFIG.BG_LLM_FAIL_WINDOW, CONFIG.BG_LLM_FAIL_THRESHOLD)) {
      return `LLM 连续超时/失败（最近 ${CONFIG.BG_LLM_FAIL_WINDOW} 次 InnerTick 推演 ≥ ${CONFIG.BG_LLM_FAIL_THRESHOLD} 次失败）`;
    }
    return null;
  }

  /**
   * Phase-2 修复：后台 session=- 浅层推演入口。
   * 管控链路：触发条件评估 → 降级保护 → 2h 硬冷却 → 独立每日熔断 → fire-and-forget 浅层推演。
   * 约束：只跑活跃主用户（global.__lastActiveUid），禁止遍历全部 uid；
   *       chat_turn 对话触发不经过本路径，不计入后台熔断统计；
   *       2h 最小冷却由 core 层代码硬锁强制（替换原 allowIdleInnerTick 1 小时闸门）。
   */
  private async triggerBackgroundInnerTick(userId: string): Promise<void> {
    try {
      // 1) 触发条件：近30min有对话 / 情绪大幅波动 / 高权重欲望变动（任一满足才触发）
      const { trigger, sqliteMs } = await this.evaluateBackgroundTrigger();
      if (!trigger) {
        logger.info('[IdleBrain] 后台浅层推演跳过: 无触发条件（近30min无对话、情绪无大幅波动、无高权重欲望变动）');
        return;
      }

      // 2) 降级保护：CPU 高 / SQLite 慢查询 / LLM 连续超时 → 直接跳过后台推演
      const degrade = this.backgroundDegradationReason(sqliteMs);
      if (degrade) {
        logger.warn(`[IdleBrain] 后台浅层推演跳过（降级保护）: ${degrade}`);
        return;
      }

      // 3) 后台推演 2h 硬冷却（core 层强制；先判避免熔断计数失真）
      if (isBackgroundInnerTickInCooldown(userId)) {
        logger.info(`[IdleBrain] 后台浅层推演跳过: 2h 冷却中（user=${userId}，后台 session=- 推演最小间隔 2 小时）`);
        return;
      }

      // 4) 后台推演独立每日调用熔断（chat_turn 对话触发不计入本统计）
      if (isBackgroundInnerTickBreakerOpen()) {
        logger.warn('[IdleBrain] 后台浅层推演跳过: 今日后台推演熔断已达上限（chat_turn 对话触发不受此熔断约束）');
        return;
      }
      recordBackgroundInnerTick();

      // 5) fire-and-forget 异步推演：不阻塞调度器/本检查循环；浅层只传结构化心智快照（depth=shallow）
      this.state.lastBackgroundInnerTickAt = Date.now();
      logger.info(`[IdleBrain] 后台浅层推演触发（user=${userId}，depth=shallow，trigger=${trigger}）`);
      void runInnerTick({ userId, depth: 'shallow', triggerSource: 'manual' })
        .then(() => logger.info(`[IdleBrain] 后台浅层推演完成（user=${userId}）`))
        .catch((e: any) => logger.warn(`[IdleBrain] 后台浅层推演触发失败: ${e?.message || e}`));
    } catch (e: any) {
      logger.warn(`[IdleBrain] 后台浅层推演评估异常（本轮跳过）: ${e?.message || e}`);
    }
  }

  // ── 主检查循环 ──
  async checkAndProcess(): Promise<void> {
    if (!CONFIG.ENABLED || this.state.isRunning) return;

    this.state.isRunning = true;
    this.state.totalCycles++;

    try {
      // ── Phase-2 修复：后台 session=- 浅层推演（enableInnerTickIdleTrigger 灰度开关，默认关闭）──
      // 原 allowIdleInnerTick 1 小时可配置闸门已由 core 层 2 小时硬冷却替换（INNER_TICK_BG_MIN_INTERVAL_MS）；
      // 新增触发条件（近30min有对话 / 情绪大幅波动 / 高权重欲望变动）、独立每日熔断（chat_turn 不计入）
      // 与降级保护（CPU 高 / SQLite 慢查询 / LLM 连续超时）。
      // 只跑活跃主用户（__lastActiveUid），禁止遍历全部 uid；fire-and-forget 异步，不阻塞调度器。
      if (MIND_SWITCH.enableInnerTickIdleTrigger) {
        const userId = ((global as any).__lastActiveUid as string) || 'default';
        await this.triggerBackgroundInnerTick(userId);
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
