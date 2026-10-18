// Microsoft identity platform (Entra ID) authorisation-code flow with PKCE,
// using a confidential client. Single-tenant authority: only accounts from the
// configured Microsoft 365 tenant can sign in, never personal Microsoft accounts.
import type { Env } from '../env';

/**
 * Least-privilege delegated scopes:
 * - Files.ReadWrite: read/write the signed-in user's own OneDrive for Business,
 *   including creating upload sessions and editing the reporting workbook.
 * - User.Read: identify the connected account.
 * - offline_access: obtain a refresh token so background retries can run.
 */
export const GRAPH_SCOPES = ['https://graph.microsoft.com/Files.ReadWrite', 'https://graph.microsoft.com/User.Read', 'offline_access'];

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`Microsoft token endpoint returned ${code}`);
  }
}

export const redirectUri = (env: Pick<Env, 'PUBLIC_BASE_URL'>) =>
  `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/admin/microsoft/callback`;

const authority = (env: Pick<Env, 'MS_TENANT_ID'>) => {
  if (!/^[0-9a-f-]{36}$/i.test(env.MS_TENANT_ID ?? '')) throw new Error('MS_TENANT_ID must be the directory (tenant) GUID');
  return `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0`;
};

export function buildAuthorizeUrl(env: Env, state: string, codeChallenge: string): string {
  const u = new URL(`${authority(env)}/authorize`);
  u.searchParams.set('client_id', env.MS_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri(env));
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', GRAPH_SCOPES.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    scope: GRAPH_SCOPES.join(' '),
    ...params,
  });
  const res = await fetch(`${authority(env)}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token) throw new OAuthError(json.error ?? 'token_request_failed', res.status);
  return json as TokenResponse;
}

export function exchangeCode(env: Env, code: string, codeVerifier: string): Promise<TokenResponse> {
  return tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env),
    code_verifier: codeVerifier,
  });
}

export function refreshAccessToken(env: Env, refreshToken: string): Promise<TokenResponse> {
  return tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
}
