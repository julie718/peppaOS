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
}

export const MIND_SWITCH: MindSwitchConfig = {
  enableOldLifeTick: true,          // 旧life 10min TICK总开关
  enableOldIdleBrain: true,         // idle_brain旧空闲大脑逻辑
  enableOldSchedulerAutonomy: true, // scheduler自主任务（周报月报等）
  enableInnerTickIdleTrigger: false, // 空闲时触发InnerTick（灰度，默认关闭）

  // ── Phase3 灰度默认值：全部关闭 → 所有会话强制走旧life，生产行为不变 ──
  sessionInnerTickOverride: false,   // 总闸默认关闭；需灰度时置 true
  overrideSessionWhitelist: [],      // 白名单默认空；需灰度时填入会话 session_id（conversationId）
};
