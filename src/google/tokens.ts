// Encrypted token storage with safe refresh-token rotation.
//
// Every write bumps `version`, and writes are conditional on the version that
// was read (optimistic concurrency). If two requests refresh at once, the loser
// discards its result and uses the winner's tokens, so a rotated refresh token
// is never overwritten by an older one.
import { decryptString, encryptString, keyMaterial, needsReencryption } from '../crypto';
import type { Env } from '../env';
import { log } from '../log';
import { OAuthError, refreshAccessToken, revokeToken, type TokenResponse } from './oauth';

export interface ConnectionRow {
  id: 'primary';
  status: 'connected' | 'needs_reauth' | 'disconnected';
  google_sub: string | null;
  email: string | null;
  scopes: string | null;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires_at: number | null;
  version: number;
  connected_by: string | null;
  connected_at: number | null;
  last_refreshed_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export class NotConnectedError extends Error {
  constructor(public readonly reason: 'not_connected' | 'needs_reauth') {
    super(reason === 'needs_reauth' ? 'Google connection must be re-authorised' : 'Google account is not connected');
  }
}

const REFRESH_CONTEXT = 'google_refresh_token:primary';
const ACCESS_CONTEXT = 'google_access_token:primary';
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export async function getConnection(env: Env): Promise<ConnectionRow | null> {
  return env.DB.prepare("SELECT * FROM google_connection WHERE id = 'primary'").first<ConnectionRow>();
}

export async function storeNewConnection(
  env: Env,
  tokens: TokenResponse,
  identity: { sub: string; email: string },
  adminEmail: string,
  nowMs = Date.now(),
): Promise<void> {
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
  const keys = keyMaterial(env);
  const refreshEnc = await encryptString(keys, tokens.refresh_token, REFRESH_CONTEXT);
  const accessEnc = await encryptString(keys, tokens.access_token, ACCESS_CONTEXT);
  await env.DB.prepare(
    `INSERT INTO google_connection (id, status, google_sub, email, scopes, refresh_token_enc, access_token_enc, access_token_expires_at,
        version, connected_by, connected_at, last_refreshed_at, last_error, updated_at)
     VALUES ('primary', 'connected', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
     ON CONFLICT (id) DO UPDATE SET status = 'connected', google_sub = excluded.google_sub, email = excluded.email,
        scopes = excluded.scopes, refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
        access_token_expires_at = excluded.access_token_expires_at, version = google_connection.version + 1,
        connected_by = excluded.connected_by, connected_at = excluded.connected_at, last_refreshed_at = excluded.last_refreshed_at,
        last_error = NULL, updated_at = excluded.updated_at`,
  )
    .bind(identity.sub, identity.email, tokens.scope ?? null, refreshEnc, accessEnc, nowMs + tokens.expires_in * 1000, adminEmail, nowMs, nowMs, nowMs)
    .run();
}

/** Revokes the grant at Google (best effort) and removes the stored tokens. */
export async function disconnect(env: Env, nowMs = Date.now()): Promise<{ revoked: boolean }> {
  const row = await getConnection(env);
  let revoked = false;
  if (row?.refresh_token_enc) {
    try {
      revoked = await revokeToken(await decryptString(keyMaterial(env), row.refresh_token_enc, REFRESH_CONTEXT));
    } catch {
      revoked = false;
    }
  }
  await env.DB.prepare(
    `UPDATE google_connection SET status = 'disconnected', refresh_token_enc = NULL, access_token_enc = NULL,
       access_token_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = 'primary'`,
  )
    .bind(nowMs)
    .run();
  return { revoked };
}

async function refresh(env: Env, row: ConnectionRow, nowMs: number): Promise<string> {
  const keys = keyMaterial(env);
  const refreshToken = await decryptString(keys, row.refresh_token_enc!, REFRESH_CONTEXT);
  let tokens: TokenResponse;
  try {
    tokens = await refreshAccessToken(env, refreshToken);
  } catch (e) {
    if (e instanceof OAuthError && (e.code === 'invalid_grant' || e.code === 'invalid_client' || e.code === 'unauthorized_client')) {
      // The grant was revoked, expired or the client secret is wrong: a person must reconnect.
      await env.DB.prepare(
        `UPDATE google_connection SET status = 'needs_reauth', last_error = ?, updated_at = ?, version = version + 1
          WHERE id = 'primary' AND version = ?`,
      )
        .bind(e.code, nowMs, row.version)
        .run();
      log.error({ event: 'google_refresh_failed', code: e.code });
      throw new NotConnectedError('needs_reauth');
    }
    throw e;
  }
  // Google normally keeps the same refresh token; store a new one if issued.
  const newRefreshEnc = tokens.refresh_token
    ? await encryptString(keys, tokens.refresh_token, REFRESH_CONTEXT)
    : (await needsReencryption(keys, row.refresh_token_enc!))
      ? await encryptString(keys, refreshToken, REFRESH_CONTEXT)
      : row.refresh_token_enc!;
  const accessEnc = await encryptString(keys, tokens.access_token, ACCESS_CONTEXT);
  const r = await env.DB.prepare(
    `UPDATE google_connection SET refresh_token_enc = ?, access_token_enc = ?, access_token_expires_at = ?,
       last_refreshed_at = ?, last_error = NULL, updated_at = ?, version = version + 1
     WHERE id = 'primary' AND version = ? AND status = 'connected'`,
  )
    .bind(newRefreshEnc, accessEnc, nowMs + tokens.expires_in * 1000, nowMs, nowMs, row.version)
    .run();
  if (r.meta.changes !== 1) {
    // Another request refreshed first. Its tokens are at least as new as ours.
    const latest = await getConnection(env);
    if (latest?.status === 'connected' && latest.access_token_enc && (latest.access_token_expires_at ?? 0) > nowMs + 60_000) {
      return decryptString(keys, latest.access_token_enc, ACCESS_CONTEXT);
    }
  }
  log.info({ event: 'google_token_refreshed' });
  return tokens.access_token;
}

/** Returns a valid Google access token, refreshing it when it is near expiry. */
export async function getAccessToken(env: Env, opts: { forceRefresh?: boolean; nowMs?: number } = {}): Promise<string> {
  const nowMs = opts.nowMs ?? Date.now();
  const row = await getConnection(env);
  if (!row || row.status === 'disconnected' || !row.refresh_token_enc) throw new NotConnectedError('not_connected');
  if (row.status === 'needs_reauth') throw new NotConnectedError('needs_reauth');
  if (!opts.forceRefresh && row.access_token_enc && (row.access_token_expires_at ?? 0) > nowMs + EXPIRY_MARGIN_MS) {
    return decryptString(keyMaterial(env), row.access_token_enc, ACCESS_CONTEXT);
  }
  return refresh(env, row, nowMs);
}

/**
 * Called from the scheduled job. Refreshing daily detects a revoked grant
 * early and keeps the refresh token in use (Google expires refresh tokens that
 * go unused for six months).
 */
export async function keepConnectionAlive(env: Env, nowMs = Date.now()): Promise<void> {
  const row = await getConnection(env);
  if (!row || row.status !== 'connected') return;
  if (nowMs - (row.last_refreshed_at ?? 0) < 24 * 60 * 60 * 1000) return;
  await getAccessToken(env, { forceRefresh: true, nowMs });
}
