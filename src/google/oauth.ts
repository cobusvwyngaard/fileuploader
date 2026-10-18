// Google OAuth 2.0 authorisation-code flow with PKCE, as a confidential web
// client. Only non-sensitive scopes are requested, so the app can be published
// ("In production") without Google's verification, and refresh tokens do not
// expire after 7 days as they do for apps left in "Testing".
import type { Env } from '../env';

/**
 * - drive.file: access only to files and folders this app creates (upload
 *   folders, uploaded files, the report spreadsheet). No access to anything
 *   else in the Drive.
 * - openid email: identify the connected account.
 */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
  id_token?: string;
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`Google token endpoint returned ${code}`);
  }
}

export const redirectUri = (env: Pick<Env, 'PUBLIC_BASE_URL'>) => `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/admin/google/callback`;

export function buildAuthorizeUrl(env: Env, state: string, codeChallenge: string): string {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not configured');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri(env));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  // Always show consent so Google issues a refresh token on reconnect.
  u.searchParams.set('prompt', 'consent select_account');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token) throw new OAuthError(json.error ?? 'token_request_failed', res.status);
  return json as TokenResponse;
}

export function exchangeCode(env: Env, code: string, codeVerifier: string): Promise<TokenResponse> {
  return tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(env), code_verifier: codeVerifier });
}

export function refreshAccessToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Revokes a token at Google (best effort). Revoking the refresh token ends the whole grant. */
export async function revokeToken(token: string): Promise<boolean> {
  const res = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  return res.ok;
}
