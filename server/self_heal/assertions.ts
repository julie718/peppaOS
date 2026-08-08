// 阶段二·自诊疗模块 — 内置 73 条原始标准断言（全自动离线运行）
// 映射自阶段一 E2E（e2e_isolated_25fix.test.ts）S1-S6 的 73 项原始标准断言：
// 每条断言仅做只读源码特征检查或纯逻辑检查，不触碰业务数据库、不产生副作用。
// 每条断言携带 file 归因字段（缺陷溯源定位用）。
import fs from 'fs';
import path from 'path';
import type { AssertionDef } from './types';

function read(root: string, rel: string): string {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}
const has = (root: string, rel: string, needle: string | string[]) =>
  Array.isArray(needle) ? needle.every(n => read(root, rel).includes(n)) : read(root, rel).includes(needle);
const hasAny = (root: string, rel: string, needles: string[]) =>
  needles.some(n => read(root, rel).includes(n));

/**
 * 73 条原始标准断言（编号 SH-A001 ~ SH-A073）。
 * check 闭包接收 rootDir 参数，由引擎注入。
 */
export function buildStandardAssertions(root: string): AssertionDef[] {
  const r = (rel: string) => read(root, rel);
  const defs: Array<Omit<AssertionDef, 'id'> & { name: string }> = [
    // ── S1 对话复盘三写（E-2/L-2/L-16/L-6） ──
    { name: 'S1-0 复盘与连接生命周期解耦（E-2）', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'performPostChatReview') },
    { name: 'S1-1 情绪增量落库=引擎当前值（L-2）', file: 'server/personality/state.ts', check: () => has(root, 'server/personality/state.ts', 'updateEmotionalState') && has(root, 'server/life/emotions.ts', 'getEmotions') },
    { name: 'S1-2 复盘写入 interaction_memories（E-2）', file: 'server/db/lifeDb.ts', check: () => has(root, 'server/db/lifeDb.ts', 'addInteractionMemory') },
    { name: 'S1-3 TTL 标记写入链路（L-6）', file: 'server/tools/interceptor.ts', check: () => has(root, 'server/tools/interceptor.ts', 'markToolResultTTL') && has(root, 'server/hooks/review.ts', 'markToolResultTTL') },
    { name: 'S1-4 人格记忆落库 tier=core_identity（N-1）', file: 'server/hooks/review.ts', check: () => has(root, 'server/hooks/review.ts', 'core_identity') },
    { name: 'S1-5 复盘四类归档含 TTL 缓存', file: 'server/hooks/review.ts', check: () => has(root, 'server/hooks/review.ts', 'TTL') },
    { name: 'S1-6 交互质量评估自我打分', file: 'server/hooks/review.ts', check: () => has(root, 'server/hooks/review.ts', 'quality') && has(root, 'server/hooks/review.ts', '0.') },
    { name: 'S1-7 复盘触发不阻塞主流程（setImmediate 脱离调用栈）', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'setImmediate') && has(root, 'server/socket/chat.ts', "import('../hooks/review')") },
    { name: 'S1-8 情绪更新走 updateEmotionalState', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'updateEmotionalState') },
    { name: 'S1-9 复盘无事务残留错误（使用既有存储 API）', file: 'server/hooks/review.ts', check: () => has(root, 'server/hooks/review.ts', 'addMemory') },

    // ── S2 打断后思绪跨轮接续（L-4/L-18） ──
    { name: 'S2-1 未消费思绪跨轮注入（L-4）', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'getUnresolvedThoughts') },
    { name: 'S2-2 用后 resolve 消费思绪', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'resolveThoughts') },
    { name: 'S2-3 打断恢复不丢上下文', file: 'server/memory/crossSession.ts', check: () => has(root, 'server/memory/crossSession.ts', 'storeMemory') && has(root, 'server/memory/crossSession.ts', 'getMemories') },
    { name: 'S2-4 超 72h 思绪自动归档（L-18）', file: 'server/db/lifeDb.ts', check: () => has(root, 'server/db/lifeDb.ts', 'expireStaleThoughts') && has(root, 'server/db/lifeDb.ts', 'maxAgeHours = 72') },
    { name: 'S2-5 归档后不再注入', file: 'server/db/lifeDb.ts', check: () => has(root, 'server/db/lifeDb.ts', 'getUnresolvedThoughts') && has(root, 'server/db/lifeDb.ts', 'resolved === false') && has(root, 'server/db/lifeDb.ts', 'ctx.expired = true') },

    // ── S3 断联重逢关系生疏回暖（L-7/L-8/L-12/L-13） ──
    { name: 'S3-0 全新库 totalInteractions=0 前提', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'totalInteractions') },
    { name: 'S3-1 72h 重逢判定（L-7）', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'beginReunionDiscount') },
    { name: 'S3-2 重逢增量 ×0.5 折扣', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'reunionDiscountUntil') },
    { name: 'S3-3 折扣期结束恢复全量', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', '0.5') && has(root, 'server/life/relationship.ts', 'reunionDiscount') },
    { name: 'S3-4 negative 交互真实降低亲密/信任（L-8）', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'negative') && has(root, 'server/life/relationship.ts', '0.02') },
    { name: 'S3-5 新用户熟络期窗口（L-12）', file: 'server/life/relationship.ts', check: () => hasAny(root, 'server/life/relationship.ts', ['熟络', 'warmup']) },
    { name: 'S3-6 高频依赖上限（L-12）', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'high_frequency_3days') },
    { name: 'S3-7 四维单一衰减机制（L-13）', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'long_silence') },
    { name: 'S3-8 长静默不刷新交互时间戳（P1-15）', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'long_silence') && has(root, 'server/life/relationship.ts', 'touchInteraction') },

    // ── S4 记忆 GC 全量扫描（L-5/L-6） ──
    { name: 'S4-1 全量扫描无 50 条上限（L-5）', file: 'server/memory/gc.ts', check: () => has(root, 'server/memory/gc.ts', '100000') },
    { name: 'S4-2 低频降权 60 条可见', file: 'server/memory/gc.ts', check: () => has(root, 'server/memory/gc.ts', 'downweighted') },
    { name: 'S4-3 重复记忆合并（jaccard）', file: 'server/memory/gc.ts', check: () => has(root, 'server/memory/gc.ts', 'merged') && hasAny(root, 'server/memory/gc.ts', ['jaccard', 'cosine', 'similar']) },
    { name: 'S4-4 TTL 过期清理（L-6）', file: 'server/memory/gc.ts', check: () => has(root, 'server/memory/gc.ts', 'cleaned') && has(root, 'server/memory/gc.ts', 'isTTLExpired') },
    { name: 'S4-5 核心层不衰减豁免', file: 'server/memory/store.ts', check: () => has(root, 'server/memory/store.ts', 'core_identity') && hasAny(root, 'server/memory/store.ts', ['never decays', 'never_decay', '核心层']) },
    { name: 'S4-6 成长层不衰减豁免', file: 'server/memory/store.ts', check: () => has(root, 'server/memory/store.ts', 'growth') && hasAny(root, 'server/memory/store.ts', ['Never decays', 'never decays']) },
    { name: 'S4-7 核心 40 天未检索也不降权', file: 'server/memory/store.ts', check: () => has(root, 'server/memory/store.ts', 'core_identity') && hasAny(root, 'server/memory/store.ts', ['40 天', '40天', 'never']) },
    { name: 'S4-8 未过期 TTL 保留', file: 'server/memory/gc.ts', check: () => has(root, 'server/memory/gc.ts', 'isTTLExpired') && has(root, 'server/memory/gc.ts', 'removeMemory') },

    // ── S5 长待机月度自省 + 低情绪关怀（L-9/L-11） ──
    { name: 'S5-1 月度自省记忆归属真实用户（L-9）', file: 'server/autonomy/idle_brain.ts', check: () => has(root, 'server/autonomy/idle_brain.ts', 'monthlyReflection') && has(root, 'server/autonomy/idle_brain.ts', 'userId') },
    { name: 'S5-2 low_mood_comfort 触发器注册（L-11）', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', 'low_mood_comfort') },
    { name: 'S5-3 low_activity_greeting 触发器注册', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', 'low_activity_greeting') },
    // 重构·模块2：触发器阈值/作息/话术全部由 rhythm.ts 统计学习底座派生，断言改为校验派生接线
    // （原断言检查 triggers.ts 内的写死值 '>= 23'/'12'/'48'/'0.2'/'24'，重构后写死值已不存在）
    { name: 'S5-4 深夜不打扰判定（23-7 点）', file: 'server/proactive/rhythm.ts', check: () => has(root, 'server/proactive/rhythm.ts', 'deriveQuietWindow') && has(root, 'server/proactive/rhythm.ts', 'isQuietNow') && has(root, 'server/proactive/rhythm.ts', 'QUIET_START_HOUR') && has(root, 'server/proactive/triggers.ts', 'inQuietWindow') },
    { name: 'S5-5 低情绪+沉默 13h 触发安抚', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', 'low_mood_comfort') && has(root, 'server/proactive/rhythm.ts', 'COMFORT_AFTER_HOURS') && has(root, 'server/proactive/rhythm.ts', 'deriveThresholds') },
    { name: 'S5-6 沉默未达 48h 不问候', file: 'server/proactive/rhythm.ts', check: () => has(root, 'server/proactive/rhythm.ts', 'GREETING_AFTER_HOURS') && has(root, 'server/proactive/rhythm.ts', 'deriveThresholds') },
    { name: 'S5-7 沉默 49h 触发问候', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', 'low_activity_greeting') && has(root, 'server/proactive/rhythm.ts', 'GREETING_AFTER_HOURS') },
    { name: 'S5-8 情绪低落判定喜悦 < 0.2', file: 'server/proactive/rhythm.ts', check: () => has(root, 'server/proactive/rhythm.ts', 'EMOTION_JOY_FLOOR') && has(root, 'server/proactive/triggers.ts', 'emotionJoyFloor') },
    { name: 'S5-9 问候冷却 24h 防重复', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', 'cooldownOk') && has(root, 'server/proactive/rhythm.ts', 'COOLDOWN_HOURS') },

    // ── S6 静态接线复核（E-3/O-1/L-10/L-15/L-17/L-3/O-2/E-1） ──
    { name: 'S6-1 retriever 缺失表静默降级（E-3）', file: 'server/memory/retriever.ts', check: () => has(root, 'server/memory/retriever.ts', 'sqlite_master') },
    { name: 'S6-2 timeline 缺失表静默降级（E-3）', file: 'server/memory/timeline.ts', check: () => has(root, 'server/memory/timeline.ts', 'sqlite_master') },
    { name: 'S6-3 数据路径统一 getPeppaDbPath', file: 'server/config/data_path.ts', check: () => has(root, 'server/config/data_path.ts', 'mkdirSync') },
    { name: 'S6-4 chat 无 v4-pro 硬编码（O-1）', file: 'server/socket/chat.ts', check: () => !r('server/socket/chat.ts').split('\n').filter(l => !l.trim().startsWith('//')).join('\n').includes("'deepseek-v4-pro'") },
    { name: 'S6-5 voice 无 v4-pro 硬编码（O-1）', file: 'server/socket/voice.ts', check: () => !r('server/socket/voice.ts').split('\n').filter(l => !l.trim().startsWith('//')).join('\n').includes("'deepseek-v4-pro'") },
    { name: 'S6-6 task 无 v4-pro 硬编码（O-1）', file: 'server/socket/task.ts', check: () => !r('server/socket/task.ts').split('\n').filter(l => !l.trim().startsWith('//')).join('\n').includes("'deepseek-v4-pro'") },
    { name: 'S6-7 chat 用 COMPLEX_MODELS/DEFAULT_MODELS', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', ['COMPLEX_MODELS', 'DEFAULT_MODELS']) },
    { name: 'S6-8 voice 用 COMPLEX_MODELS', file: 'server/socket/voice.ts', check: () => has(root, 'server/socket/voice.ts', 'COMPLEX_MODELS') },
    { name: 'S6-9 task 用模型档位', file: 'server/socket/task.ts', check: () => has(root, 'server/socket/task.ts', 'DEFAULT_MODELS') && has(root, 'server/socket/task.ts', 'COMPLEX_MODELS') },
    { name: 'S6-10 预算块 relevantHistory 裁剪（L-10）', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'relevantHistory') },
    { name: 'S6-11 预算块 timelineHistory 裁剪', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'timelineHistory') },
    { name: 'S6-12 预算块 prefTags 裁剪', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'prefTags') },
    { name: 'S6-13 预算块 knowledge 裁剪', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'knowledgeBlock') },
    { name: 'S6-14 自主任务轻量模型（L-15）', file: 'server/autonomy/task_generator.ts', check: () => has(root, 'server/autonomy/task_generator.ts', 'maxTokens: 500') },
    { name: 'S6-15 autonomous_work_cycle 降频 2h', file: 'server/scheduler.ts', check: () => has(root, 'server/scheduler.ts', 'autonomous_work_cycle') && hasAny(root, 'server/scheduler.ts', ['every_2h', '7200']) },
    { name: 'S6-16 task source 四类区分（L-17）', file: 'server/autonomy/task_generator.ts', check: () => ['autonomous_emotion', 'autonomous_memory', 'autonomous_context', 'autonomous_idle'].every(s => has(root, 'server/autonomy/task_generator.ts', s)) },
    { name: 'S6-17 人格演进 7 天冷却（L-3）', file: 'server/personality/evolution.ts', check: () => has(root, 'server/personality/evolution.ts', '7 * 24 * 60 * 60 * 1000') && has(root, 'server/personality/registry.ts', '604800000') },
    { name: 'S6-18 宪法守卫 action.constitution（O-2）', file: 'server/personality/constitution.ts', check: () => has(root, 'server/personality/constitution.ts', 'action.constitution') },
    { name: 'S6-19 宪法守卫 work.product.supervision', file: 'server/personality/constitution.ts', check: () => has(root, 'server/personality/constitution.ts', 'work.product.supervision') },
    { name: 'S6-20 宪法守卫 self.extension', file: 'server/personality/constitution.ts', check: () => has(root, 'server/personality/constitution.ts', 'self.extension') },
    { name: 'S6-21 宪法守卫 collaboration.lap', file: 'server/personality/constitution.ts', check: () => has(root, 'server/personality/constitution.ts', 'collaboration.lap') },
    { name: 'S6-22 addMemory 默认 confidence 0.5（E-1）', file: 'server/memory/store.ts', check: () => has(root, 'server/memory/store.ts', '?? 0.5') },
    { name: 'S6-23 情绪单一收敛 BASELINE_CONVERGE_RATE=0.03（L-1）', file: 'server/life/emotions.ts', check: () => has(root, 'server/life/emotions.ts', 'BASELINE_CONVERGE_RATE = 0.03') },
    { name: 'S6-24 chat 重逢分支 beginReunionDiscount（L-7）', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'beginReunionDiscount') },
    { name: 'S6-25 chat 交互 outcome 分支接线（L-8）', file: 'server/socket/chat.ts', check: () => has(root, 'server/socket/chat.ts', 'negative') && has(root, 'server/socket/chat.ts', 'receiveInteraction') },
    { name: 'S6-26 adapter 思考链 reasoningContent（L-16）', file: 'server/llm/adapter.ts', check: () => has(root, 'server/llm/adapter.ts', 'reasoningContent') },
    { name: 'S6-27 relationship 四维衰减承担（L-13）', file: 'server/life/relationship.ts', check: () => has(root, 'server/life/relationship.ts', 'long_silence') },

    // ── S6 扩展映射（阶段二修复保持断言：D-1/D-2 点位 + 关键接线） ──
    { name: 'S6-28 行程 SQL 72h 窗口（D-2 修复保持）', file: 'server/db/lifeDb.ts', check: () => has(root, 'server/db/lifeDb.ts', 'MAX(remind_hours / 24.0, ?)') },
    { name: 'S6-29 深夜判定测试注入钩子（D-1 修复保持）', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', '__forcedHour') },
    { name: 'S6-30 数字孪生五维', file: 'server/autonomy/digital_twin.ts', check: () => ['出行', '阅读', '理财', '情绪', '作息'].every(d => has(root, 'server/autonomy/digital_twin.ts', d)) },
    { name: 'S6-31 行程触发器 72h 推送', file: 'server/proactive/triggers.ts', check: () => has(root, 'server/proactive/triggers.ts', 'pushUpcomingTravelInfo') && has(root, 'server/proactive/triggers.ts', 'travelWindowHours') && has(root, 'server/proactive/rhythm.ts', 'TRAVEL_WINDOW_HOURS') },
    { name: 'S6-32 记忆 GC 三指标返回', file: 'server/memory/gc.ts', check: () => has(root, 'server/memory/gc.ts', 'downweighted') && has(root, 'server/memory/gc.ts', 'merged') && has(root, 'server/memory/gc.ts', 'cleaned') },
  ];
  return defs.map((d, i) => ({ id: `SH-A${String(i + 1).padStart(3, '0')}`, ...d }));
}
