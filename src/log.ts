// Structured logging that never emits secrets. Only whitelisted keys with
// primitive values are written; everything else is dropped.

const ALLOWED_KEYS = new Set([
  'event', 'route', 'status', 'code', 'graphCode', 'graphStatus', 'submissionId', 'sessionId',
  'fileId', 'attempt', 'count', 'durationMs', 'reason', 'stage', 'admin', 'retryInMs', 'ok',
]);

type Primitive = string | number | boolean | null | undefined;

function sanitise(fields: Record<string, Primitive>): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === 'string') {
      // Defence in depth: never let anything that looks like a URL or bearer token through.
      out[k] = /https?:\/\/|bearer\s|eyJ[a-zA-Z0-9_-]{10,}/i.test(v) ? '[redacted]' : v.slice(0, 300);
    } else out[k] = v;
  }
  return out;
}

export const log = {
  info(fields: Record<string, Primitive>): void {
    console.log(JSON.stringify({ level: 'info', ...sanitise(fields) }));
  },
  warn(fields: Record<string, Primitive>): void {
    console.warn(JSON.stringify({ level: 'warn', ...sanitise(fields) }));
  },
  error(fields: Record<string, Primitive>): void {
    console.error(JSON.stringify({ level: 'error', ...sanitise(fields) }));
  },
};
