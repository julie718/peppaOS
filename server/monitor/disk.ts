// server/monitor/disk.ts
// Phase2 模块7：磁盘水位检测 — data 目录磁盘临近满时输出告警（warnings / 日志）
//
// ⚠️ 铁则4：只输出警告，代码禁止写任何自动删除业务数据的逻辑。本模块纯只读检测。

import { statfs } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDataPath } from '../config/data_path';
import { logger } from '../lib/logger';

const execFileAsync = promisify(execFile);
const TAG = '[DiskMonitor]';

// ── 阈值（.env 可配置；默认：剩余空间 <5GB 或 使用率 >90% 触发告警）──
/** 磁盘可用空间告警阈值（字节），默认 5GB */
export const DISK_MIN_FREE_BYTES = Number(process.env.DISK_MIN_FREE_BYTES) || 5 * 1024 * 1024 * 1024;
/** 磁盘使用率告警阈值（0-1），默认 0.90（90%） */
export const DISK_WARN_USAGE_RATIO = Math.min(0.99, Math.max(0.5, Number(process.env.DISK_WARN_USAGE_RATIO) || 0.9));

export interface DiskStatus {
  ok: boolean;              // false = 磁盘水位触发告警
  warning: string | null;   // 面向用户的友好告警文本（放入 warnings 数组）
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usageRatio: number;       // 0-1
  path: string;
  checkedAt: string;
}

/** 实际磁盘状态（statfs 优先；异常时回退 df -k 解析；都失败返回 null 不打断调用方） */
export async function checkDiskStatus(): Promise<DiskStatus | null> {
  const target = getDataPath('');
  const checkedAt = new Date().toISOString();
  try {
    const s = await statfs(target);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize; // 非特权用户可实际使用量（bavail，不含 reserved）
    const usedBytes = totalBytes - freeBytes;
    const usageRatio = totalBytes > 0 ? +(usedBytes / totalBytes).toFixed(4) : 0;

    const warning = buildWarning(usageRatio, freeBytes);
    const ok = !warning;
    if (!ok) {
      logger.warn(
        `${TAG} 磁盘水位告警 path=${target} 使用率=${(usageRatio * 100).toFixed(1)}% ` +
        `剩余=${(freeBytes / 1024 / 1024 / 1024).toFixed(2)}GB / 总量=${(totalBytes / 1024 / 1024 / 1024).toFixed(2)}GB`,
      );
    }
    return { ok, warning, totalBytes, freeBytes, usedBytes, usageRatio, path: target, checkedAt };
  } catch (e: any) {
    // statfs 失败 → 回退 df -k（POSIX 通用）；再失败返回 null，不打断调用方
    try {
      const { stdout } = await execFileAsync('df', ['-k', target], { timeout: 5000 });
      const lines = stdout.trim().split('\n');
      const line = lines[lines.length - 1];
      const parts = line.split(/\s+/);
      const totalKB = Number(parts[1] || 0);
      const usedKB = Number(parts[2] || 0);
      if (totalKB > 0) {
        const usageRatio = +(usedKB / totalKB).toFixed(4);
        const freeBytes = (totalKB - usedKB) * 1024;
        const warning = buildWarning(usageRatio, freeBytes);
        if (!warning) logger.debug(`${TAG} 磁盘状态正常（df 回退）使用率=${(usageRatio * 100).toFixed(1)}%`);
        return {
          ok: !warning, warning, totalBytes: totalKB * 1024, freeBytes, usedBytes: usedKB * 1024,
          usageRatio, path: target, checkedAt,
        };
      }
    } catch { /* 双通道均失败 */ }
    logger.error(`${TAG} 磁盘状态检测失败（statfs/df 均不可用）: ${e?.message || String(e)}`);
    return null;
  }
}

function buildWarning(usageRatio: number, freeBytes: number): string | null {
  if (usageRatio >= DISK_WARN_USAGE_RATIO) {
    return `磁盘空间告警：数据目录使用率已达 ${(usageRatio * 100).toFixed(1)}%（阈值 ${(DISK_WARN_USAGE_RATIO * 100).toFixed(0)}%），剩余 ${(freeBytes / 1024 / 1024 / 1024).toFixed(2)}GB。为避免服务异常，请及时清理磁盘（系统不会自动删除任何数据）。`;
  }
  if (freeBytes < DISK_MIN_FREE_BYTES) {
    return `磁盘空间告警：数据目录剩余可用空间仅 ${(freeBytes / 1024 / 1024 / 1024).toFixed(2)}GB（阈值 ${(DISK_MIN_FREE_BYTES / 1024 / 1024 / 1024).toFixed(0)}GB）。为避免服务异常，请及时清理磁盘（系统不会自动删除任何数据）。`;
  }
  return null;
}
