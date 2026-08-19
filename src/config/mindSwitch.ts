// src/config/mindSwitch.ts
// Phase3：全局功能开关 — 控制旧自主逻辑是否执行 + 会话级 InnerTick 灰度心智开关
// 全部默认 true / 空列表，保持原有行为（旧逻辑继续跑）；后续可手动关闭开关观察行为，便于回滚对比。
// 约束：关闭开关只跳过业务执行，不删除任何旧代码；setInterval 定时器等基础设施完整保留。

export interface MindSwitchConfig {
  enableOldLifeTick: boolean;          // 旧life 10min TICK总开关
  enableOldIdleBrain: boolean;         // idle_brain旧空闲大脑逻辑
  enableOldSchedulerAutonomy: boolean; // scheduler自主任务（周报月报等）
  enableInnerTickIdleTrigger: boolean; // 空闲时触发InnerTick（灰度，默认关闭）
  // ── Phase3：会话级 InnerTick 灰度心智（B模式）──
  sessionInnerTickOverride: boolean;   // 总开关：是否允许会话使用InnerTick快照驱动会话心智；关闭则全部会话强制走旧life
  overrideSessionWhitelist: string[];  // 白名单 session_id 列表，仅白名单会话启用 B 模式（InnerTick 心智源）
  // ── P2迁移：LLM推演心智总闸（默认 false，灰度可控，可回滚）──
  // [P2-MIGRATE] 开启后：旧 life TICK 循环对 emotions/desires/personality/relationship_state 的
  // 直接写入被 paradigmGuard 拦截（只读/计算/日志，不再落库），心智状态变更统一走
  // runInnerTick → MentalEventItem → paradigmGuard 守卫校验之后落库。
  // 关闭：完全维持原有 TICK 写库行为（现有守卫仅告警不阻断）。
  p2MigrateEnable: boolean;
  // ── InnerTick LLM 调用超时阈值（毫秒）──
  // runInnerTick 内 LLM 推演调用的超时上限：超过该时长即通过 AbortController signal
  // 中止在途请求，本轮放弃心智推演落库（心智业务表零写入），等待下一轮对话重新触发；
  // <= 0 表示不启用超时控制（保持旧行为）。
  innerTickLLMTimeoutMs: number;
}

export const MIND_SWITCH: MindSwitchConfig = {
  enableOldLifeTick: true,          // 旧life 10min TICK总开关
  enableOldIdleBrain: true,         // idle_brain旧空闲大脑逻辑
  enableOldSchedulerAutonomy: true, // scheduler自主任务（周报月报等）
  enableInnerTickIdleTrigger: false, // 空闲时触发InnerTick（灰度，默认关闭）

  // ── Phase3 灰度：S_A 会话开启 B 模式（InnerTick 心智源）；其余会话强制走旧life，生产行为不变 ──
  sessionInnerTickOverride: true,   // 总闸开启：允许白名单会话使用 InnerTick 快照驱动会话心智
  overrideSessionWhitelist: ['conv_45e5748b-6ed2-4c35-b789-bb2156362f2e'], // S_A 灰度会话（真实用户活跃会话）

  // ── P2迁移：地基版本总闸关闭 — 维持原有 TICK 写库行为，守卫全部放行、不产生拦截日志；
  //     后续灰度开启只需改回 true（旧 TICK 写核心心智表被拦截，仅 InnerTick 可变更心智状态，可一键回滚）──
  p2MigrateEnable: false,  // [P2-MIGRATE] 关闭：全部放行，旧 TICK 照常写库，无 P2-MIGRATE 拦截输出

  // ── InnerTick LLM 调用超时阈值：默认 45s（45000ms），可后期调参；<= 0 关闭超时 ──
  innerTickLLMTimeoutMs: 45000,
};
