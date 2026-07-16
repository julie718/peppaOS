import pino from 'pino';

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

export const logger = {
  info(...args: unknown[]) { base.info(join(...args)); },
  error(...args: unknown[]) { base.error(join(...args)); },
  warn(...args: unknown[]) { base.warn(join(...args)); },
  debug(...args: unknown[]) { base.debug(join(...args)); },
  child(opts: Record<string, string>) { return base.child(opts); },
};

export function createLogger(module: string) {
  return base.child({ module });
}
