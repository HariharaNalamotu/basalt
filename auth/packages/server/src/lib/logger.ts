const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

// Never log these, even if a caller passes them by mistake.
const REDACT = /pass(word)?|secret|token|code|authorization|cookie|key/i;

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

function redact(data: Record<string, unknown>, allow: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (REDACT.test(k) && !allow.has(k)) out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = { name: v.name, message: v.message, stack: v.stack };
    else out[k] = v;
  }
  return out;
}

/** Structured JSON logs to stdout. `allowKeys` lets dev-only callers (console mailer) bypass redaction. */
export function createLogger(level: Level = 'info', opts: { allowKeys?: string[] } = {}): Logger {
  const min = LEVELS[level];
  const allow = new Set(opts.allowKeys ?? []);
  const emit = (lvl: Level, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...(data ? redact(data, allow) : {}) });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
