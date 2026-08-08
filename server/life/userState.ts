// 用户状态评估 — 决定 Peppa 是否应该主动沟通
// 纯规则判断，0 Token
import { readDB, writeDB } from '../../db_layer';

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

  // 深夜检测 — 【重构·模块2】静默窗口由交互作息统计学习派生（deriveQuietWindow），
  // 不再写死 23-7（目标④）；无交互数据时回落先验锚点（保留类别⑥ 底层数学模型常量）。
  // 懒加载避免与 proactive/rhythm 形成静态循环依赖（rhythm 依赖本模块 getLastUserMessageAt）。
  let isLateNight = false;
  try {
    const { deriveRhythmProfile, isQuietNow } = require('../proactive/rhythm');
    isLateNight = isQuietNow(deriveRhythmProfile(), hour);
  } catch {
    isLateNight = hour >= 23 || hour < 7; // 容灾：统计底座不可用回落先验 23-7（与 rhythm PRIOR 同值）
  }

  // 综合判断：适合主动沟通 = 用户非专注 AND 非深夜
  // 活跃时发送是合理的（用户在聊），非专注场景也可以
  const isSuitableForProactive = !isFocusScene && !isLateNight;

  return { isActive, isFocusScene, isLateNight, isSuitableForProactive };
}

/** 更新最后用户消息时间（由 chat handler 调用） */
export function touchUserActivity(): void {
  const now = Date.now();
  (global as any).__lastUserMessageAt = now;
  // P1-8: 落地持久化 — 服务重启后长待机判定可正常读取（global 内存值重启即失）
  // 静态 import 安全：db_layer 模块加载无副作用（不连库），readDB 仅在 initDatabase 后可用，
  // 而生产启动链路（server.ts bootstrap）在监听端口前已完成 initDatabase。
  // （原动态 require 在 tsx ESM 下 require 未定义，异常被吞 → 持久化从未生效，验收测试已复现并修正）
  try {
    const db = readDB();
    if (db && db.settings) {
      const key = 'last_user_message_at';
      const idx = db.settings.findIndex((s: any) => s.key === key);
      if (idx >= 0) db.settings[idx].value = String(now);
      else db.settings.push({ key, value: String(now) });
      writeDB(db);
    }
  } catch {}
}

/**
 * P1-8: 读取持久化的最后用户消息时间（ms）。
 * global 内存值优先（运行时一致性），磁盘兜底（重启后连续性）。
 */
export function getLastUserMessageAt(): number {
  const memory = (global as any).__lastUserMessageAt as number | undefined;
  if (memory) return memory;
  try {
    const db = readDB();
    const setting = db?.settings?.find((s: any) => s.key === 'last_user_message_at');
    if (setting?.value) return Number(setting.value) || 0;
  } catch {}
  return 0;
}

/** 设置当前场景（由场景检测模块调用） */
export function setUserScene(scene: string): void {
  (global as any).__activeScene = scene;
}
