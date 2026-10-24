const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

// Never log these, even if a handler passes them by mistake.
const REDACT = /pass(word)?|secret|token|authorization|cookie|grant|api[-_]?key|credit|card|ssn/i;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function clean(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (REDACT.test(k)) out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message, stack: v.stack, code: (v as { code?: unknown }).code };
    else out[k] = v;
  }
  return out;
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const min = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...bindings, ...(data ? clean(data) : {}) });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (b) => createLogger(level, { ...bindings, ...clean(b) }),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger };
