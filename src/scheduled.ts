// Cron-triggered maintenance: Excel retries, abandoned uploads, token upkeep.
import { decryptString, encryptString, keyMaterial, needsReencryption } from './crypto';
import { auditStatement } from './db/audit';
import type { Env } from './env';
import { processDueExcel } from './excel/sync';
import { log } from './log';
import { keepConnectionAlive, NotConnectedError } from './microsoft/tokens';
import { transitionStatement } from './state';

/**
 * Marks submissions whose upload window has passed without every file being
 * verified as failed, and releases their submission slot. Files that did
 * finish stay in OneDrive and remain listed for the administrator.
 */
export async function expireAbandonedUploads(env: Env, nowMs = Date.now()): Promise<number> {
  const stale = await env.DB.prepare(
    "SELECT id, upload_session_id FROM submissions WHERE status IN ('created', 'uploading') AND upload_deadline < ? LIMIT 100",
  )
    .bind(nowMs)
    .all<{ id: string; upload_session_id: string }>();
  let count = 0;
  for (const s of stale.results) {
    const [moved] = await env.DB.batch([
      transitionStatement(env.DB, s.id, ['created', 'uploading'], 'failed', { failure_stage: 'upload', failure_reason: 'upload_not_completed' }, nowMs),
    ]);
    if (moved?.meta.changes === 1) {
      await env.DB.batch([
        env.DB.prepare('UPDATE upload_sessions SET submission_count = MAX(submission_count - 1, 0) WHERE id = ?').bind(s.upload_session_id),
        auditStatement(env, 'system', 'submission.abandoned', { type: 'submission', id: s.id }),
      ]);
      count++;
    }
  }
  return count;
}

/**
 * After TOKEN_ENCRYPTION_KEY is rotated, re-encrypts stored share tokens with
 * the new key so TOKEN_ENCRYPTION_KEY_PREVIOUS can later be removed. (The
 * Microsoft tokens are re-encrypted whenever they are refreshed.)
 */
export async function reencryptShareTokens(env: Env, limit = 200): Promise<number> {
  const keys = keyMaterial(env);
  if (!keys.previous) return 0;
  const rows = await env.DB.prepare('SELECT id, share_token_enc FROM upload_sessions').all<{ id: string; share_token_enc: string }>();
  let count = 0;
  for (const r of rows.results) {
    if (count >= limit) break;
    if (!(await needsReencryption(keys, r.share_token_enc))) continue;
    const ctx = `share_token:${r.id}`;
    const enc = await encryptString(keys, await decryptString(keys, r.share_token_enc, ctx), ctx);
    await env.DB.prepare('UPDATE upload_sessions SET share_token_enc = ? WHERE id = ? AND share_token_enc = ?').bind(enc, r.id, r.share_token_enc).run();
    count++;
  }
  return count;
}

export async function runScheduled(env: Env, nowMs = Date.now()): Promise<void> {
  try {
    await keepConnectionAlive(env, nowMs);
  } catch (e) {
    if (!(e instanceof NotConnectedError)) log.error({ event: 'token_keepalive_failed', reason: e instanceof Error ? e.message : 'unknown' });
  }
  const excel = await processDueExcel(env, 10);
  await reencryptShareTokens(env).catch((e) => log.error({ event: 'reencrypt_failed', reason: e instanceof Error ? e.message : 'unknown' }));
  const abandoned = await expireAbandonedUploads(env, nowMs);
  await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(nowMs).run();
  log.info({ event: 'scheduled_run', count: excel.complete, attempt: excel.retry_scheduled, reason: `failed=${excel.failed} abandoned=${abandoned}` });
}
