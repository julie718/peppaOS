// src/utils/paradigmGuard.ts
// PeppaOS Phase0 范式防护工具 — 运行时检测告警（不篡改、不阻断业务执行流向）
// 原则：
//   - 开发环境：console.error 范式违规告警 + console.assert 断言（console.assert 不抛异常，仅打印）
//   - 生产环境：仅输出 error 日志，不中断程序
//   - 同类型告警 60 秒节流，防止 TICK/高频路径刷屏
// 本工具仅做检测与告警，绝不修改任何业务逻辑执行流向。

// P2迁移：全局心智开关 — 控制旧 life TICK 写库拦截是否生效（无循环依赖，mindSwitch 为纯配置）
import { MIND_SWITCH } from '../config/mindSwitch';

const isProduction = process.env.NODE_ENV === 'production';

/** 同类告警节流表（tag → 上次告警时间戳） */
const lastWarnAt: Record<string, number> = {};
const THROTTLE_MS = 60_000;

function throttled(tag: string): boolean {
  const now = Date.now();
  if (lastWarnAt[tag] && now - lastWarnAt[tag] < THROTTLE_MS) return true; // 已抑制
  lastWarnAt[tag] = now;
  return false;
}

function emitWarning(tag: string, message: string, caller: string): void {
  if (throttled(tag)) return;
  const line = `[ParadigmGuard] ${tag} ${message} ${caller ? `@ ${caller}` : ''}`;
  if (isProduction) {
    // 生产环境：仅 error 日志，不中断
    console.error(line);
  } else {
    console.error(`[ParadigmGuard][DEV] ${line}`);
    // console.assert 不抛出异常，仅打印断言失败信息，不阻断业务
    console.assert(false, line);
  }
}

/** 从调用栈提取调用者信息（堆栈第 2-4 帧） */
function extractCaller(stack?: string): string {
  const lines = (stack || new Error().stack || '').split('\n').slice(2, 5).map((l) => l.trim());
  return lines.join(' ← ') || 'unknown';
}

/** 判断调用栈是否来自白名单路径 */
function stackMatches(stack: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(stack));
}

/**
 * 守卫 1：guardMentalStateWrite
 * 用途：检测业务代码手动构造、生成 mood/desires/goals 等心理状态对象。
 * 心理状态只允许来自 LLM 结构化输出。
 * 用法：在业务代码手动构造心理状态对象的位置调用，传入调用点描述。
 */
export function guardMentalStateWrite(callerInfo: string): void {
  emitWarning(
    'guardMentalStateWrite',
    `检测到业务代码手动构造心理状态对象（mood/desires/goals 等）。心理状态只允许来自 LLM 结构化输出。${callerInfo}`,
    extractCaller(),
  );
}

/**
 * 守卫 2：guardIllegalAddMemory
 * 用途：拦截非法位置调用 addMemory。
 * 合法白名单：
 *   ① chat 对话轮次结束回调（socket/chat.ts 提取/复盘区、socket/task.ts、socket/voice.ts、hooks/review.ts）
 *   ② MCP 工具返回回调（server/mcp/、工具 handler tools/definitions/）
 *   ③ InnerTick 心智回合（src/core/innerTick.ts）
 *   ④ 阶段0扩展：orchestrator workflow 工作流沉淀 / 技能沉淀 adapter / memory 路由
 * 不在白名单的调用触发范式告警（不阻断）。
 */
export function guardIllegalAddMemory(callerInfo?: string): void {
  const stack = new Error().stack || '';
  const isAllowedChatTurn = stackMatches(stack, [
    /socket[/\\]chat\.ts/,
    /socket[/\\]task\.ts/,
    /socket[/\\]voice\.ts/,
    /hooks[/\\]review\.ts/,
  ]);
  const isAllowedToolCallback = stackMatches(stack, [
    /mcp[/\\]/,
    /peppa_server/,
    /tools[/\\]definitions/,
  ]);
  // ③ InnerTick 心智回合（src/core/innerTick.ts 归档写入）
  const isAllowedInnerTick = stackMatches(stack, [/InnerTick|inner_tick/i]);
  // ④ 阶段0扩展：orchestrator workflow 工作流沉淀 / 技能沉淀 adapter / memory 路由
  // V8 调用栈帧为「函数名在前、路径在后」（at executeWorkflow (...orchestrator.ts)），故双向匹配并忽略大小写
  const isAllowedWorkflow = stackMatches(stack, [
    /orchestrator\.ts.*workflow|workflow.*orchestrator\.ts/i,
    /skills_extension[/\\]adapter\.ts/,
    /routes[/\\]memory_routes\.ts/,
  ]);

  if (isAllowedChatTurn || isAllowedToolCallback || isAllowedInnerTick || isAllowedWorkflow) return; // 白名单静默通过

  emitWarning(
    'guardIllegalAddMemory',
    `addMemory 调用点不在白名单（合法：①chat 对话轮次结束回调 ②MCP 工具返回回调 ③InnerTick 心智回合 ④workflow/技能沉淀/记忆路由）。${callerInfo || ''}`,
    extractCaller(stack),
  );
}

/**
 * 守卫 3：assertNoAutoSpawnWorker
 * 用途：禁止业务代码直接 spawn/create worker；worker 只能由 MCP 通路发起。
 * 调用栈包含 MCP 通路（server/mcp/、peppa_server）视为合法，其余路径触发告警。
 */
export function assertNoAutoSpawnWorker(callerInfo: string): void {
  const stack = new Error().stack || '';
  if (stackMatches(stack, [/mcp[/\\]/, /peppa_server/])) return; // MCP 通路允许
  emitWarning(
    'assertNoAutoSpawnWorker',
    `业务代码直接 spawn/create worker。worker 仅允许由 MCP 通路发起。${callerInfo}`,
    extractCaller(stack),
  );
}

// ─────────────────────────────────────────────
// Phase2 守卫：InnerTick 快照写入目标表白名单
// ─────────────────────────────────────────────

/** InnerTick 快照唯一允许写入的表（独立观测表） */
const PHASE2_ALLOWED_SNAPSHOT_TABLE = 'inner_tick_snapshot';

/** 旧 life 业务状态表（Phase2 红线：InnerTick 输出严禁覆盖/修改这些表的数据） */
const PHASE2_FORBIDDEN_LIFE_STATE_TABLES = new Set([
  'personality',
  'emotions',
  'emotion_state',
  'emotion_state_history',
  'desires',
  'self_reflections',
  'interaction_memories',
  'relationship_state',
  'relationship_metrics',
  'personality_evolution',
  'user_preference_tags',
]);

/**
 * 守卫 4：guardInnerTickLifeOverwrite
 * 用途：Phase2 保护校验 — InnerTick 输出只允许写入独立观测表 inner_tick_snapshot。
 * 任何把 InnerTick 输出写往旧 life 状态表（emotions/desires/personality 等）的代码路径都会触发告警；
 * 未知表名同样告警（未来新增表默认不视为快照落点）。
 * 用法：快照写入前调用，传入目标表名。白名单静默通过，违规仅告警不阻断（与守卫体系一致）。
 */
export function guardInnerTickLifeOverwrite(tableName: string, callerInfo?: string): void {
  if (tableName === PHASE2_ALLOWED_SNAPSHOT_TABLE) return; // 白名单：独立观测表静默通过
  if (PHASE2_FORBIDDEN_LIFE_STATE_TABLES.has(tableName)) {
    emitWarning(
      'guardInnerTickLifeOverwrite',
      `检测到 InnerTick 输出覆盖旧life业务状态表「${tableName}」——Phase2 红线：InnerTick 输出严禁覆盖/修改原有life业务数据库。${callerInfo || ''}`,
      extractCaller(),
    );
    return;
  }
  emitWarning(
    'guardInnerTickLifeOverwrite',
    `InnerTick 快照写入目标表不在白名单（仅允许 ${PHASE2_ALLOWED_SNAPSHOT_TABLE}）：${tableName}。${callerInfo || ''}`,
    extractCaller(),
  );
}

// ─────────────────────────────────────────────
// Phase3 守卫：sessionMindProvider 会话心智只读约束
// ─────────────────────────────────────────────

/**
 * 旧 life 业务状态表（Phase3 红线：sessionMindProvider 为只读运行时心智层，
 * 严禁将 InnerTick 快照输出持久化写回这些表；持久层仅允许落 inner_tick_snapshot 观测表）。
 * 与 Phase2 红线清单同一来源，单一事实源。
 */
export const SESSION_MIND_FORBIDDEN_LIFE_TABLES = PHASE2_FORBIDDEN_LIFE_STATE_TABLES;

/**
 * 守卫 5：guardSessionMindPersist
 * 用途：Phase3 保护校验 — sessionMindProvider 会话心智注入层只允许读取 old life 数据表与
 * inner_tick_snapshot 观测表，严禁将 InnerTick 输出持久化写入旧 life 状态表
 * （emotions/desires/personality/self_reflections/relationship_* 等）。
 * 检测到调用栈含 sessionMindProvider 且目标表为旧 life 状态表 → 范式告警（不阻断，与守卫体系一致）。
 * 用法：sessionMindProvider 内部任何未来新增写入点、以及任何把 inner 快照写往旧表的代码路径，写入前调用。
 */
export function guardSessionMindPersist(tableName: string, callerInfo?: string): void {
  const stack = new Error().stack || '';
  const isProviderPath = stackMatches(stack, [/sessionMindProvider/i]);
  if (!isProviderPath) return; // 非 sessionMindProvider 路径不在此守卫范围内（Phase2 守卫已覆盖其他写入路径）
  if (!SESSION_MIND_FORBIDDEN_LIFE_TABLES.has(tableName)) return; // 白名单（inner_tick_snapshot）/ 未知表不拦截 provider 只读路径

  emitWarning(
    'guardSessionMindPersist',
    `检测到 sessionMindProvider 内部将 InnerTick 输出持久化写入旧life状态表「${tableName}」——Phase3 红线：会话心智只读，禁止写回旧life表；InnerTick 输出仅允许内存会话级生效，持久存储仅 inner_tick_snapshot。${callerInfo || ''}`,
    extractCaller(stack),
  );
}

// ─────────────────────────────────────────────
// P2迁移守卫：旧 life TICK 写核心心智状态拦截 + InnerTick 唯一写者放行
// ─────────────────────────────────────────────

/**
 * P2 迁移红线：旧 life TICK 循环直接写入的核心心智状态表（单一事实源）。
 * 开启 p2MigrateEnable 后，这些表只允许 InnerTick 心智闭环（src/core/innerTick.ts）写入，
 * 旧模块（server/life 子系统、direction/review/idle_brain 等）的一切直接写入被拦截并告警。
 * 说明：emotion_state 为情绪系统状态表（8维向量），与 emotions 日志表同属「emotions 情绪系统」，
 * 一并纳入拦截范围（情绪衰减迁移的落库目标）。
 */
export const P2_GUARDED_MENTAL_STATE_TABLES: ReadonlySet<string> = new Set([
  'emotions',
  'emotion_state',
  'desires',
  'personality',
  'relationship_state',
]);

/** P2 迁移总闸状态（读取 mindSwitch 配置，供守卫与日志使用） */
export function isP2MigrateEnabled(): boolean {
  return MIND_SWITCH.p2MigrateEnable === true;
}

/**
 * 守卫 6：guardP2MentalStateWrite（P2 迁移守卫）
 * 用途：拦截旧 life TICK 循环对 emotions/desires/personality/relationship_state 的直接写入，
 * 触发告警日志并返回 false（调用方跳过落库）；仅 InnerTick 心智闭环（src/core/innerTick.ts）
 * 允许写入（返回 true）。
 * 行为：
 *   - p2MigrateEnable=false（默认）：全部放行（返回 true），完全维持原有 TICK 写库行为；
 *   - p2MigrateEnable=true：调用栈含 InnerTick 的写入放行；其余（life TICK/旧模块/事件路径）
 *     一律拦截（返回 false）+ [P2-MIGRATE] 告警日志，不再落库。
 * 用法：lifeDb 写函数在 SQL 执行前调用，返回 false 时跳过写入（仅读取/计算/日志保留）。
 */
export function guardP2MentalStateWrite(tableName: string, callerInfo?: string): boolean {
  if (!isP2MigrateEnabled()) return true; // P2 总闸关闭：维持原有 TICK 行为，全部放行

  const stack = new Error().stack || '';
  // 唯一合法写者：InnerTick 心智闭环（runInnerTick → MentalEventItem → 守卫校验 → 统一落库）
  if (stackMatches(stack, [/innerTick/i])) return true;

  emitWarning(
    'guardP2MentalStateWrite',
    `[P2-MIGRATE] 拦截旧路径直接写入核心心智状态表「${tableName}」——P2迁移：心智状态变更统一走 runInnerTick → MentalEventItem → paradigmGuard 守卫校验后落库；旧 life TICK 仅保留读取/计算/日志（只读快照观测层）。${callerInfo || ''}`,
    extractCaller(stack),
  );
  return false;
}

/**
 * 系统启动/迁移完成时输出 P2 迁移守卫状态（供部署核查：确认总闸开/关）
 */
export function logParadigmP2Status(): void {
  const mode = isP2MigrateEnabled()
    ? '开启 — 旧life TICK 写核心心智状态被拦截，仅 InnerTick 可落库'
    : '关闭 — 维持原有 TICK 写库行为（默认，可灰度开启/一键回滚）';
  console.log(`[P2-MIGRATE] paradigmGuard P2迁移守卫: p2MigrateEnable=${isP2MigrateEnabled()} | ${mode}`);
}

/**
 * 系统启动时输出 Phase0 已禁用反模式清单（旧逻辑代码保留，支持回滚）
 */
export function logParadigmPhase0Status(): void {
  const disabled: string[] = [
    'orchestrator PathA 自动后台委派（chat.ts 触发分支已注释）',
    'MCP interceptor 随机概率拦截（Math.random 概率放行已注释，限流/上限保留）',
    'focusStack 外部内存栈（全部调用点已注释，源文件保留）',
  ];
  for (const d of disabled) {
    console.log(`[Paradigm-Phase0] 已禁用反模式: ${d}, 旧逻辑代码保留，支持回滚`);
  }
}
