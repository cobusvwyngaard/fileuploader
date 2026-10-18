import type { Env } from '../env';

export type AuditActor = string; // admin email, 'public' or 'system'

/**
 * Appends an audit record. `details` must never contain tokens, upload URLs or
 * submitted field values; callers pass identifiers and counts only.
 */
export async function audit(
  env: Pick<Env, 'DB'>,
  actor: AuditActor,
  action: string,
  target?: { type: string; id: string },
  details?: Record<string, string | number | boolean | null>,
): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO audit_log (at, actor, action, target_type, target_id, details_json) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(Date.now(), actor, action, target?.type ?? null, target?.id ?? null, details ? JSON.stringify(details) : null)
    .run();
}

export function auditStatement(
  env: Pick<Env, 'DB'>,
  actor: AuditActor,
  action: string,
  target?: { type: string; id: string },
  details?: Record<string, string | number | boolean | null>,
): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO audit_log (at, actor, action, target_type, target_id, details_json) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(Date.now(), actor, action, target?.type ?? null, target?.id ?? null, details ? JSON.stringify(details) : null);
}
