const REDACT = /pass(word)?|secret|token|authorization|cookie|grant|key$/i;
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Log {
  debug(msg: string, d?: Record<string, unknown>): void;
  info(msg: string, d?: Record<string, unknown>): void;
  warn(msg: string, d?: Record<string, unknown>): void;
  error(msg: string, d?: Record<string, unknown>): void;
}

export function createLog(service: string, level: Level = (process.env.LOG_LEVEL as Level) || 'info'): Log {
  const emit = (lvl: Level, msg: string, d?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d ?? {})) {
      data[k] = REDACT.test(k) ? '[redacted]' : v instanceof Error ? { message: v.message, stack: v.stack } : v;
    }
    (lvl === 'warn' || lvl === 'error' ? process.stderr : process.stdout).write(
      JSON.stringify({ level: lvl, time: new Date().toISOString(), service, msg, ...data }) + '\n',
    );
  };
  return { debug: (m, d) => emit('debug', m, d), info: (m, d) => emit('info', m, d), warn: (m, d) => emit('warn', m, d), error: (m, d) => emit('error', m, d) };
}

export const silentLog: Log = { debug() {}, info() {}, warn() {}, error() {} };
