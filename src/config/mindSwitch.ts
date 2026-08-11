// src/config/mindSwitch.ts
// Phase3：全局功能开关 — 控制旧自主逻辑是否执行
// 全部默认 true，保持原有行为（旧逻辑继续跑）；后续可手动关闭开关观察行为，便于回滚对比。
// 约束：关闭开关只跳过业务执行，不删除任何旧代码；setInterval 定时器等基础设施完整保留。

export const MIND_SWITCH = {
  enableOldLifeTick: true,          // 旧life 10min TICK总开关
  enableOldIdleBrain: true,         // idle_brain旧空闲大脑逻辑
  enableOldSchedulerAutonomy: true, // scheduler自主任务（周报月报等）
  enableInnerTickIdleTrigger: false // 空闲时触发InnerTick（灰度，默认关闭）
};
