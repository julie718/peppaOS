// server/db/migrationState.ts
// Phase2 模块7：SQLite schema 迁移失败状态 — 标记文件持久化 + 告警输出
//
// 铁则5：SQLite schema 迁移失败 → 不启动新版本容器（fail-fast 拒绝服务），
// 自动回滚至上一个正常运行容器，输出告警。
// 实现：
//   1) 迁移前自动备份（VACUUM INTO data/db_archive/pre-migration-vN.db）；
//   2) 迁移失败 → 写迁移失败标记文件（data 卷持久化，容器重启仍可见）+
//      输出告警日志 + 调用方 fail-fast（进程退出非零，容器永不带残缺 schema 服务）；
//   3) 运维回滚上一个正常容器后，成功迁移会清除失败标记；
//   4) getMigrationFailureState() 供 ambient warnings（每轮对话 warnings 数组）与
//      /api/health 输出回滚告警。

import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import { logger } from '../lib/logger';

const TAG = '[MigrationState]';

export interface MigrationFailureState {
  failed: true;
  failedVersion: number;
  error: string;
  at: string;
  backupPath: string | null;
}

function markerPath(): string {
  return path.join(getDataPath(''), 'migration_failed.json');
}

/** 记录迁移失败（写标记文件 + 告警日志）；幂等，重复调用覆盖更新 */
export function recordMigrationFailure(failedVersion: number, error: string, backupPath: string | null): void {
  const state: MigrationFailureState = {
    failed: true,
    failedVersion,
    error: String(error || '').slice(0, 500),
    at: new Date().toISOString(),
    backupPath,
  };
  try {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify(state, null, 2));
  } catch (e: any) {
    logger.error(`${TAG} 迁移失败标记写入失败（不影响 fail-fast 主行为）: ${e?.message || String(e)}`);
  }
  logger.error(
    `${TAG} ⚠️ SQLite schema 迁移失败（v${failedVersion}）: ${String(error).slice(0, 300)}。` +
    `按铁则5 拒绝启动新版本：请回滚至上一个正常运行容器（迁移前备份: ${backupPath || '无'}）。`,
  );
}

/** 读取迁移失败状态（无失败返回 null） */
export function getMigrationFailureState(): MigrationFailureState | null {
  try {
    const raw = fs.readFileSync(markerPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.failed === true ? (parsed as MigrationFailureState) : null;
  } catch {
    return null; // 无标记文件 / 解析失败均视为无失败
  }
}

/** 迁移全部成功时清除失败标记 */
export function clearMigrationFailure(): void {
  try {
    if (fs.existsSync(markerPath())) fs.unlinkSync(markerPath());
  } catch (e: any) {
    logger.warn(`${TAG} 清除迁移失败标记失败: ${e?.message || String(e)}`);
  }
}
