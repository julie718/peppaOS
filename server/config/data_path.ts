// Centralized data directory resolver.
// All persisted files (DB, keys, config, voice samples, KB) live here.
// Default: ~/Peppa/data/ — survives code/upgrade overwrites.
// Override: set LUMI_DATA_DIR env var.

import fs from 'fs';
import path from 'path';
import os from 'os';

const ENV_KEY = 'LUMI_DATA_DIR';

function defaultDataRoot(): string {
  return path.join(os.homedir(), 'Peppa');
}

export function getDataRoot(): string {
  return process.env[ENV_KEY] || defaultDataRoot();
}

export function getDataPath(relativePath: string): string {
  const full = path.join(getDataRoot(), 'data', relativePath);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return full;
}

/**
 * E-3: peppa.db 路径统一解析 — 修复前 7 处直写 `process.env.DB_PATH || '/app/data/peppa.db'`，
 * 父目录不存在时 sqlite3 抛 SQLITE_CANTOPEN 未捕获异常，全新环境启动直接崩溃。
 * 统一出口：先确保父目录存在再返回路径（Docker 内 LUMI_DATA_DIR=/app → /app/data/peppa.db，行为不变）。
 * 【重构·校验修复】默认路径不再直写 Docker 专属 /app/data：无 DB_PATH 时回落数据根统一解析
 * （~/Peppa/data 或 LUMI_DATA_DIR/data），本地/桌面/隔离库环境不再因无 /app 写权限启动崩溃。
 */
export function getPeppaDbPath(): string {
  const p = process.env.DB_PATH || getDataPath('peppa.db');
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return p;
}
