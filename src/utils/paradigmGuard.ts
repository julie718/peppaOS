// src/utils/paradigmGuard.ts
// PeppaOS Phase0 范式防护工具 — 运行时检测告警（不篡改、不阻断业务执行流向）
// 原则：
//   - 开发环境：console.error 范式违规告警 + console.assert 断言（console.assert 不抛异常，仅打印）
//   - 生产环境：仅输出 error 日志，不中断程序
//   - 同类型告警 60 秒节流，防止 TICK/高频路径刷屏
// 本工具仅做检测与告警，绝不修改任何业务逻辑执行流向。

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
