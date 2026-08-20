// server/utils/chatWarnings.ts
// Phase2 模块3：API 统一返回结构 { content, warnings } 的 warnings 收集器
//
// 约定（铁则6）：
//   - 所有系统提示（LLM 超时、搜索截断、token 配额告警、机器人失联、记忆合并异常、
//     磁盘水位告警、MCP 报错、迁移失败等）全部放入 warnings 字符串数组；
//   - 业务正常时 warnings 为空数组；
//   - content 只放用户看到的对话正文，绝不混入系统提示。
// 前端（Web / iOS-Capacitor）读取 warnings 做 toast 弹窗展示。

import { logger } from '../lib/logger';

/** 已知系统警告类型（用于去重与观测埋点） */
export type WarningCode =
  | 'llm_timeout'            // LLM 超时
  | 'llm_quota'              // token 配额告警
  | 'search_truncated'       // 外部搜索截断
  | 'robot_offline'          // 机器人/设备失联
  | 'memory_consolidation'   // 记忆合并/固化异常
  | 'disk_water_level'       // 磁盘水位告警
  | 'mcp_error'              // MCP/Skill 工具报错
  | 'migration_failed'       // SQLite 迁移失败
  | 'generic';               // 其他系统提示

const TAG = '[ChatWarnings]';

/**
 * 单轮对话的 warnings 收集器：按 code 去重（同一轮同一类问题只提示一次），
 * 全部为面向用户的友好业务提示文本（禁止携带原始堆栈/报错细节，铁则3）。
 */
export class ChatWarnings {
  private items: { code: WarningCode; message: string }[] = [];

  /** 追加一条警告（同 code 去重）；返回当前警告数量 */
  add(code: WarningCode, message: string): number {
    if (!message || !message.trim()) return this.items.length;
    if (this.items.some((i) => i.code === code)) return this.items.length; // 同轮同类型只提示一次
    this.items.push({ code, message: message.trim() });
    logger.info(`${TAG} +${code}: ${message.trim().slice(0, 120)}`);
    return this.items.length;
  }

  /** 追加多条 */
  addAll(code: WarningCode, messages: string[]): void {
    for (const m of messages || []) this.add(code, m);
  }

  /**
   * 追加环境性告警（磁盘水位/迁移失败，来自 buildAmbientWarnings）。
   * 与 add() 不同：按文本去重而非按 code 去重（磁盘+迁移可能同时存在，不能互相折叠）。
   */
  addAmbient(messages: string[]): void {
    for (const m of messages || []) {
      if (!m || !m.trim()) continue;
      const text = m.trim();
      if (this.items.some((i) => i.message === text)) continue;
      this.items.push({ code: 'generic', message: text });
      logger.info(`${TAG} +ambient: ${text.slice(0, 120)}`);
    }
  }

  /** 全部警告文本数组（业务正常时为空数组） */
  toArray(): string[] {
    return this.items.map((i) => i.message);
  }

  get size(): number {
    return this.items.length;
  }

  /** 是否包含指定类型的警告 */
  has(code: WarningCode): boolean {
    return this.items.some((i) => i.code === code);
  }
}

/**
 * 构建环境性系统警告（磁盘水位/迁移失败），供每轮对话/API 调用收尾时合并进 warnings。
 * 异步检测失败静默跳过（不因检测失败打断对话主流程）。
 */
export async function buildAmbientWarnings(): Promise<string[]> {
  const ambient: string[] = [];
  try {
    // 磁盘水位告警（模块7；纯只读检测，禁止任何自动删除逻辑）
    const { checkDiskStatus } = await import('../monitor/disk');
    const disk = await checkDiskStatus();
    if (disk && disk.warning) ambient.push(disk.warning);
  } catch (e: any) {
    logger.warn(`${TAG} 磁盘水位检测跳过（不影响对话）: ${e?.message || String(e)}`);
  }
  try {
    // SQLite 迁移失败标记（模块7）：存在则输出回滚告警
    const { getMigrationFailureState } = await import('../db/migrationState');
    const mig = getMigrationFailureState();
    if (mig && mig.failed) {
      ambient.push(
        `系统提示：数据库结构升级失败（版本 v${mig.failedVersion}），服务已停止新版本启动，请回滚至上一个正常运行容器并检查日志。`,
      );
    }
  } catch {
    // 迁移状态模块尚未初始化（启动早期），跳过
  }
  try {
    // 记忆合并异常（模块3）：最近一次合并失败且 24h 内 → 输出告警（铁则1：仅告警，原始记录不受影响）
    const { getLastConsolidationFailureAt } = await import('../memory/consolidationState');
    const failAt = getLastConsolidationFailureAt();
    if (failAt) {
      const hours = (Date.now() - new Date(failAt).getTime()) / 3600000;
      if (Number.isFinite(hours) && hours >= 0 && hours < 24) {
        ambient.push('记忆合并异常：最近一次记忆整理未完成，原始记忆数据完整保留，不受影响。');
      }
    }
  } catch {
    // 状态模块尚未初始化，跳过
  }
  return ambient;
}
