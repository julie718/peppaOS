// 用户状态评估 — 决定 Peppa 是否应该主动沟通
// 纯规则判断，0 Token

export interface UserState {
  isActive: boolean;        // 最近 10 分钟有交互
  isFocusScene: boolean;    // 会议/工作/睡眠等专注场景
  isLateNight: boolean;     // 深夜 23:00-07:00
  isSuitableForProactive: boolean; // 综合：是否适合主动沟通
}

/** 获取用户状态 */
export function assessUserState(): UserState {
  const now = Date.now();
  const hour = new Date().getHours();

  // 活跃度：最近 10 分钟是否有用户消息
  const lastUserMessageAt = (global as any).__lastUserMessageAt || 0;
  const isActive = (now - lastUserMessageAt) < 10 * 60000;

  // 场景检测：通过 __activeScene 全局标记
  const activeScene = (global as any).__activeScene || '';
  const focusScenes = ['meeting', 'work', 'sleep', 'focus', 'coding'];
  const isFocusScene = focusScenes.includes(activeScene.toLowerCase());

  // 深夜检测
  const isLateNight = hour >= 23 || hour < 7;

  // 综合判断：适合主动沟通 = 用户非专注 AND 非深夜
  // 活跃时发送是合理的（用户在聊），非专注场景也可以
  const isSuitableForProactive = !isFocusScene && !isLateNight;

  return { isActive, isFocusScene, isLateNight, isSuitableForProactive };
}

/** 更新最后用户消息时间（由 chat handler 调用） */
export function touchUserActivity(): void {
  (global as any).__lastUserMessageAt = Date.now();
}

/** 设置当前场景（由场景检测模块调用） */
export function setUserScene(scene: string): void {
  (global as any).__activeScene = scene;
}
