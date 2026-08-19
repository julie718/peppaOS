import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';

const level = process.env.LOG_LEVEL || 'info';

const base = pino({
  level,
  formatters: { level(label) { return { level: label }; } },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});

function join(...args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
}

// ═══════════════════════════════════════════════════════════════════
// P2-3 日志分层输出：心智 / 感知 / 机器人动作三类通道独立落盘。
// 心智 → logs/mind.log（InnerTick 推演回合）
// 感知 → logs/perception.log（视觉/音频/空间感知输入）
// 动作 → logs/action.log（工具执行记录）
// 同时镜像到主控制台（info 级），NAS 上按文件分通道排查，互不干扰。
// 同步 appendFileSync：崩溃/断电也不丢尾部日志（无缓冲队列），频率低开销可忽略。
// ═══════════════════════════════════════════════════════════════════
// 日志目录解析（修复 Docker 内静默 EACCES）：
// 容器以 node 用户运行而 WORKDIR /app 属 root → mkdir /app/logs 抛 EACCES，旧实现 catch{} 静默吞掉，
// 心智/感知/动作三通道日志全部丢失且无任何告警。现改为启动时解析可写目录：
//   1) 首选 env LOG_DIR 或 cwd/logs；
//   2) 不可写时显式告警并降级到数据目录 logs（Docker 内 LUMI_DATA_DIR=/app → /app/data/logs，
//      Dockerfile 已 chown node:node 且随宿主 ./data 卷持久化，可正常落盘）；
//   3) 降级目录仍不可写则显式告警，通道日志退化为仅输出控制台（绝不静默）。
function resolveLogDir(): string {
  const preferred = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? err;
    try {
      const fallback = getDataPath('logs');
      fs.mkdirSync(fallback, { recursive: true });
      fs.accessSync(fallback, fs.constants.W_OK);
      base.warn(`[Logger] 日志目录 ${preferred} 不可写（${code}），已降级到 ${fallback}`);
      return fallback;
    } catch (fallbackErr) {
      const fbCode = (fallbackErr as NodeJS.ErrnoException)?.code ?? fallbackErr;
      base.warn(`[Logger] 日志目录 ${preferred} 与数据目录 logs 均不可写（${code} / ${fbCode}），通道日志仅输出控制台`);
      return preferred;
    }
  }
}
const LOG_DIR = resolveLogDir();

const warnLogged = new Set<string>();
function channelLog(channel: string, line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${channel}.log`), `${new Date().toISOString()} ${line}\n`);
  } catch (err) {
    // 不静默：每个通道首次失败显式告警，后续失败节流避免刷屏
    if (!warnLogged.has(channel)) {
      warnLogged.add(channel);
      base.warn(`[Logger] ${channel}.log 写入失败（${(err as NodeJS.ErrnoException)?.code ?? err}），本通道后续仅输出控制台`);
    }
  }
}

export const logger = {
  info(...args: unknown[]) { base.info(join(...args)); },
  error(...args: unknown[]) { base.error(join(...args)); },
  warn(...args: unknown[]) { base.warn(join(...args)); },
  debug(...args: unknown[]) { base.debug(join(...args)); },
  child(opts: Record<string, string>) { return base.child(opts); },
  /** 心智通道（InnerTick 内部推演回合） */
  mind(...args: unknown[]) { const line = join(...args); base.info(line); channelLog('mind', line); },
  /** 感知通道（视觉/音频/空间等感知输入） */
  perception(...args: unknown[]) { const line = join(...args); base.info(line); channelLog('perception', line); },
  /** 动作通道（机器人/工具动作执行） */
  action(...args: unknown[]) { const line = join(...args); base.info(line); channelLog('action', line); },
};

export function createLogger(module: string) {
  return base.child({ module });
}
