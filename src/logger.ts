// Redacting logger.
//
// TWO hard rules live here:
//   1. NEVER emit a credential value. Any key whose name looks secret is replaced with "***",
//      recursively, before anything is written.
//   2. On the stdio MCP transport, STDOUT is the JSON-RPC channel. A stray byte on stdout
//      corrupts the protocol. So every log line goes to STDERR, always.

const SECRET_KEY = /pass(word)?|secret|token|credential|cred|api[-_]?key|private[-_]?key|salt|ssn/i;
const REDACTED = '***';

/** Deep-redact any object so no secret value can ever be logged or returned in observability output. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v);
    }
    return out as unknown as T;
  }
  return value;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: unknown): void {
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
  };
  if (meta !== undefined) line.meta = redact(meta);
  // STDERR only — stdout belongs to the MCP protocol.
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => {
    if (process.env.APM_DEBUG) emit('debug', msg, meta);
  },
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
};
