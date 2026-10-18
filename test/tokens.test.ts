import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptString, keyMaterial } from '../src/crypto';
import { getAccessToken, getConnection, keepConnectionAlive, NotConnectedError } from '../src/google/tokens';
import { FakeGoogle, resetDb, seedConnection } from './helpers';

let ms: FakeGoogle;
beforeEach(async () => {
  await resetDb();
  ms = new FakeGoogle();
  ms.install();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('Google token handling', () => {
  it('uses the cached access token while it is valid', async () => {
    await seedConnection();
    expect(await getAccessToken(env)).toBe('access-0');
    expect(ms.tokenCalls).toBe(0);
  });

  it('refreshes near expiry and stores the rotated refresh token encrypted', async () => {
    await seedConnection({ accessExpiresInMs: 60_000 });
    expect(await getAccessToken(env)).toBe('access-1');
    const row = (await getConnection(env))!;
    expect(row.refresh_token_enc).not.toContain('refresh-1');
    expect(await decryptString(keyMaterial(env), row.refresh_token_enc!, 'google_refresh_token:primary')).toBe('refresh-1');
    expect(row.version).toBe(2);
    // Next call reuses the refreshed token.
    expect(await getAccessToken(env)).toBe('access-1');
    expect(ms.tokenCalls).toBe(1);
  });

  it('does not let a slower concurrent refresh overwrite a newer rotated token', async () => {
    await seedConnection({ accessExpiresInMs: 0 });
    const tokens = await Promise.all([getAccessToken(env), getAccessToken(env)]);
    expect(tokens.every((t) => t.startsWith('access-'))).toBe(true);
    const row = (await getConnection(env))!;
    expect(row.version).toBe(2); // exactly one write won
    const stored = await decryptString(keyMaterial(env), row.refresh_token_enc!, 'google_refresh_token:primary');
    expect(['refresh-1', 'refresh-2']).toContain(stored);
  });

  it('marks the connection for re-authorisation when the grant is revoked', async () => {
    await seedConnection({ accessExpiresInMs: 0 });
    ms.tokenError = 'invalid_grant';
    await expect(getAccessToken(env)).rejects.toBeInstanceOf(NotConnectedError);
    expect((await getConnection(env))!.status).toBe('needs_reauth');
    await expect(getAccessToken(env)).rejects.toMatchObject({ reason: 'needs_reauth' });
  });

  it('throws when nothing is connected', async () => {
    await expect(getAccessToken(env)).rejects.toMatchObject({ reason: 'not_connected' });
  });

  it('keeps the refresh token alive daily', async () => {
    await seedConnection();
    await keepConnectionAlive(env);
    expect(ms.tokenCalls).toBe(0);
    await keepConnectionAlive(env, Date.now() + 25 * 3600_000);
    expect(ms.tokenCalls).toBe(1);
  });
});

describe('disconnect', () => {
  it('revokes the grant at Google and deletes the stored tokens', async () => {
    const { disconnect } = await import('../src/google/tokens');
    await seedConnection();
    expect(await disconnect(env)).toEqual({ revoked: true });
    expect(ms.revoked).toEqual(['refresh-0']);
    const row = (await getConnection(env))!;
    expect(row).toMatchObject({ status: 'disconnected', refresh_token_enc: null, access_token_enc: null });
  });
});
