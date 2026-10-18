// Verifies the Cloudflare Access JWT on every admin request. Access in front of
// the Worker is the primary control; this check means a misconfigured or
// bypassed Access policy still cannot reach admin routes.
import type { MiddlewareHandler } from 'hono';
import { base64UrlDecode } from './crypto';
import type { Env } from './env';
import type { AppEnv } from './http';
import { log } from './log';

interface Jwk extends JsonWebKey {
  kid: string;
}

interface AccessClaims {
  aud: string | string[];
  iss: string;
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  sub?: string;
  /** Present on service-token JWTs: the service token's Client ID. */
  common_name?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { teamDomain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

export function resetJwksCache(): void {
  jwksCache = null;
}

function normaliseTeamDomain(domain: string): string {
  const d = domain.trim().replace(/\/+$/, '');
  return d.startsWith('https://') ? d : `https://${d}`;
}

async function getSigningKey(teamDomain: string, kid: string): Promise<CryptoKey | undefined> {
  const now = Date.now();
  const fresh = jwksCache && jwksCache.teamDomain === teamDomain && now - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && jwksCache!.keys.has(kid)) return jwksCache!.keys.get(kid);
  // Unknown kid or stale cache: refetch (handles Access key rotation).
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed with ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
    );
  }
  jwksCache = { teamDomain, fetchedAt: now, keys };
  return keys.get(kid);
}

export type AccessResult = { ok: true; email: string; serviceToken?: boolean } | { ok: false; reason: string };

export async function verifyAccessJwt(
  token: string,
  env: Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ADMIN_SERVICE_TOKENS'>,
  nowMs = Date.now(),
): Promise<AccessResult> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, reason: 'access_not_configured' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h)));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'bad_alg' };
  const teamDomain = normaliseTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const key = await getSigningKey(teamDomain, header.kid);
  if (!key) return { ok: false, reason: 'unknown_key' };
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return { ok: false, reason: 'bad_signature' };
  const now = Math.floor(nowMs / 1000);
  const skew = 60;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD.trim())) return { ok: false, reason: 'bad_audience' };
  if (normaliseTeamDomain(claims.iss ?? '') !== teamDomain) return { ok: false, reason: 'bad_issuer' };
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) return { ok: false, reason: 'not_yet_valid' };
  if (!claims.email) {
    // Service tokens carry no email. They are refused unless their Client ID is
    // explicitly allowlisted (used for automated smoke tests).
    const allowed = (env.ADMIN_SERVICE_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    if (claims.common_name && allowed.includes(claims.common_name)) return { ok: true, email: `service:${claims.common_name}`, serviceToken: true };
    return { ok: false, reason: 'no_email' };
  }
  return { ok: true, email: claims.email.toLowerCase() };
}

function isLocalRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Resolves the admin identity for a request, or null when it is not an authorised admin. */
export async function resolveAdmin(request: Request, env: Env): Promise<{ email: string } | { error: string }> {
  if (env.ENVIRONMENT === 'development' && env.DEV_ADMIN_EMAIL && isLocalRequest(request.url)) {
    return { email: env.DEV_ADMIN_EMAIL.toLowerCase() };
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { error: 'missing_access_token' };
  let result: AccessResult;
  try {
    result = await verifyAccessJwt(token, env);
  } catch (e) {
    log.error({ event: 'access_verify_error', reason: e instanceof Error ? e.message : 'unknown' });
    return { error: 'access_verification_failed' };
  }
  if (!result.ok) return { error: result.reason };
  const allow = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length && !result.serviceToken && !allow.includes(result.email)) return { error: 'not_in_admin_allowlist' };
  return { email: result.email };
}

/** Middleware for admin API routes: 401 JSON when not authorised. */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const r = await resolveAdmin(c.req.raw, c.env);
    if ('error' in r) {
      log.warn({ event: 'admin_denied', reason: r.error });
      return c.json({ error: { code: 'unauthorised', message: 'Administrator sign-in through Cloudflare Access is required.' } }, 401);
    }
    c.set('adminEmail', r.email);
    await next();
  };
}
