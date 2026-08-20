// server/memory/consolidationState.ts
// Phase2 模块3/模块4：记忆合并（固化）异常状态 — 合并失败记状态、下次成功自动清除，
// 供 ambient warnings 输出"记忆合并异常"告警。
// 铁则1：只告警，绝不物理删除/影响任何业务记忆数据；铁则3：原始错误不暴露给用户
// （完整堆栈由调用方 logger 保留，本模块只存截断后的运维信息）。

import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import { logger } from '../lib/logger';

const TAG = '[ConsolidationState]';

export interface ConsolidationFailureState {
  failed: true;
  at: string;
  error: string; // 已截断的运维信息（不进入用户可见 warnings 文本）
}

function markerPath(): string {
  return path.join(getDataPath(''), 'consolidation_failed.json');
}

/** 记录一次记忆合并失败（幂等覆盖） */
export function recordConsolidationFailure(error: string): void {
  const state: ConsolidationFailureState = {
    failed: true,
    at: new Date().toISOString(),
    error: String(error || '').slice(0, 300),
  };
  try {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify(state, null, 2));
  } catch (e: any) {
    logger.error(`${TAG} 失败标记写入异常（不影响主流程）: ${e?.message || String(e)}`);
  }
  logger.error(`${TAG} 记忆合并失败已记录: ${state.error}`);
}

/** 记忆合并成功 → 清除失败标记（失败态只在合并持续失败时存在） */
export function clearConsolidationFailure(): void {
  try {
    if (fs.existsSync(markerPath())) fs.unlinkSync(markerPath());
  } catch (e: any) {
    logger.warn(`${TAG} 清除失败标记异常: ${e?.message || String(e)}`);
  }
}

/** 最近一次合并失败时间（无失败标记返回 null） */
export function getLastConsolidationFailureAt(): string | null {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.failed === true ? parsed.at : null;
  } catch {
    return null; // 无标记文件 / 解析失败均视为无失败
  }
}
