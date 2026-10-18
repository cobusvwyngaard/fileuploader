import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAdmin, verifyAccessJwt } from '../src/access';
import { BASE, call, mintAccessJwt, resetDb, withAccess } from './helpers';

const unexpected = async () => {
  throw new Error('unexpected fetch');
};

describe('admin access control', () => {
  beforeEach(async () => {
    await resetDb();
    vi.spyOn(globalThis, 'fetch').mockImplementation(withAccess(unexpected) as typeof fetch);
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects admin API calls without an Access JWT', async () => {
    const res = await call('GET', '/api/admin/sessions');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorised');
  });

  it('accepts a valid Access JWT and normalises the email', async () => {
    const res = await call('GET', '/api/admin/me', { jwt: await mintAccessJwt() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'admin@contoso.com' });
  });

  it.each([
    ['wrong audience', { aud: ['other-app'] }, 'bad_audience'],
    ['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }, 'bad_issuer'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }, 'expired'],
    ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 3600 }, 'not_yet_valid'],
    ['service token without email', { email: undefined }, 'no_email'],
  ])('rejects a JWT with %s', async (_name, claims, reason) => {
    const jwt = await mintAccessJwt(claims);
    expect(await verifyAccessJwt(jwt, env)).toEqual({ ok: false, reason });
    expect((await call('GET', '/api/admin/sessions', { jwt })).status).toBe(401);
  });

  it('rejects tampered and foreign-signed tokens', async () => {
    const jwt = await mintAccessJwt();
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${btoa(JSON.stringify({ aud: ['test-aud'], iss: 'https://team.cloudflareaccess.com', email: 'x@y.z', exp: 9e9 })).replace(/=+$/, '')}.${s}`;
    expect(await verifyAccessJwt(forged, env)).toMatchObject({ ok: false });
    const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    expect(await verifyAccessJwt(await mintAccessJwt({}, { key: other.privateKey }), env)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyAccessJwt(await mintAccessJwt({}, { kid: 'unknown' }), env)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(await verifyAccessJwt('not.a.jwt', env)).toMatchObject({ ok: false });
  });

  it('accepts only allowlisted service tokens', async () => {
    const jwt = await mintAccessJwt({ email: undefined, common_name: 'abc.access' });
    expect(await verifyAccessJwt(jwt, env)).toEqual({ ok: false, reason: 'no_email' });
    expect(await verifyAccessJwt(jwt, { ...env, ADMIN_SERVICE_TOKENS: 'other.access' })).toEqual({ ok: false, reason: 'no_email' });
    expect(await verifyAccessJwt(jwt, { ...env, ADMIN_SERVICE_TOKENS: 'other.access, abc.access' })).toEqual({ ok: true, email: 'service:abc.access', serviceToken: true });
  });

  it('enforces the optional ADMIN_EMAILS allowlist', async () => {
    const jwt = await mintAccessJwt();
    const req = new Request(`${BASE}/api/admin/me`, { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
    expect(await resolveAdmin(req, { ...env, ADMIN_EMAILS: 'someone@contoso.com' })).toEqual({ error: 'not_in_admin_allowlist' });
    expect(await resolveAdmin(req, { ...env, ADMIN_EMAILS: 'someone@contoso.com, ADMIN@contoso.com' })).toEqual({ email: 'admin@contoso.com' });
  });

  it('only honours the development bypass on localhost in development', async () => {
    const devEnv = { ...env, ENVIRONMENT: 'development', DEV_ADMIN_EMAIL: 'dev@local' };
    expect(await resolveAdmin(new Request('http://localhost:8787/api/admin/me'), devEnv)).toEqual({ email: 'dev@local' });
    expect(await resolveAdmin(new Request(`${BASE}/api/admin/me`), devEnv)).toEqual({ error: 'missing_access_token' });
    expect(await resolveAdmin(new Request('http://localhost:8787/api/admin/me'), { ...devEnv, ENVIRONMENT: 'production' })).toEqual({ error: 'missing_access_token' });
  });

  it('gates the admin UI HTML behind Access as well', async () => {
    const res = await call('GET', '/admin/');
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin and non-JSON state-changing requests', async () => {
    const jwt = await mintAccessJwt();
    const cross = await call('POST', '/api/admin/sessions', { body: {}, jwt, headers: { Origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    const form = await call('POST', '/api/admin/sessions', { body: {}, jwt, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    const preflight = await call('OPTIONS', '/api/public/session', { headers: { Origin: 'https://evil.example' } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('sets security headers on API responses', async () => {
    const res = await call('GET', '/api/health');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
