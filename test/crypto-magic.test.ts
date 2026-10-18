import { describe, expect, it } from 'vitest';
import { decryptString, encryptString, needsReencryption, randomReference, randomToken } from '../src/crypto';
import { checkContent } from '../src/magic';

const KEY_A = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KEY_B = 'HxwdHhsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA';

describe('token encryption', () => {
  it('round-trips and never stores plaintext', async () => {
    const ct = await encryptString({ current: KEY_A }, 'secret-refresh-token', 'ctx');
    expect(ct).not.toContain('secret');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(await decryptString({ current: KEY_A }, ct, 'ctx')).toBe('secret-refresh-token');
  });

  it('binds ciphertext to its context', async () => {
    const ct = await encryptString({ current: KEY_A }, 'x', 'ms_refresh_token:primary');
    await expect(decryptString({ current: KEY_A }, ct, 'share_token:abc')).rejects.toThrow();
  });

  it('decrypts with the previous key during rotation and flags re-encryption', async () => {
    const ct = await encryptString({ current: KEY_A }, 'x', 'c');
    const rotated = { current: KEY_B, previous: KEY_A };
    expect(await decryptString(rotated, ct, 'c')).toBe('x');
    expect(await needsReencryption(rotated, ct)).toBe(true);
    await expect(decryptString({ current: KEY_B }, ct, 'c')).rejects.toThrow(/No encryption key/);
  });

  it('rejects keys of the wrong length', async () => {
    await expect(encryptString({ current: 'c2hvcnQ' }, 'x', 'c')).rejects.toThrow(/32 bytes/);
  });

  it('generates unguessable share tokens and readable references', () => {
    const t = new Set(Array.from({ length: 200 }, () => randomToken(32)));
    expect(t.size).toBe(200);
    for (const tok of t) expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomReference()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
});

describe('content signature checks', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  it('matches known signatures', () => {
    expect(checkContent('pdf', new TextEncoder().encode('%PDF-1.4'))).toBe('match');
    expect(checkContent('png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('match');
    expect(checkContent('jpg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('match');
    expect(checkContent('docx', bytes(0x50, 0x4b, 0x03, 0x04))).toBe('match');
  });
  it('rejects mismatches and executables whatever the extension', () => {
    expect(checkContent('pdf', bytes(0x89, 0x50, 0x4e, 0x47))).toBe('mismatch');
    expect(checkContent('dwg', bytes(0x4d, 0x5a, 0x90, 0x00))).toBe('mismatch');
    expect(checkContent('txt', bytes(0x41, 0x00, 0x42))).toBe('mismatch');
  });
  it('leaves unknown formats unchecked', () => {
    expect(checkContent('dwg', new TextEncoder().encode('AC1032'))).toBe('unchecked');
    expect(checkContent('csv', new TextEncoder().encode('a,b,c'))).toBe('match');
  });
});

describe('key rotation for stored share tokens', async () => {
  const { env } = await import('cloudflare:workers');
  const { reencryptShareTokens } = await import('../src/scheduled');
  const { newShareToken, shareUrlFor, getSession } = await import('../src/db/sessions');
  const { resetDb } = await import('./helpers');

  it('re-encrypts share tokens with the new key once rotated', async () => {
    await resetDb();
    const oldEnv = { ...env, TOKEN_ENCRYPTION_KEY: KEY_A };
    const share = await newShareToken(oldEnv, 'sess-1');
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO upload_sessions (id, title, status, share_token_hash, share_token_enc, file_rules_json, fields_json, created_by, created_at, updated_at)
       VALUES ('sess-1', 'S', 'draft', ?, ?, '{}', '[]', 'a', ?, ?)`,
    ).bind(share.hash, share.enc, now, now).run();
    const rotated = { ...env, TOKEN_ENCRYPTION_KEY: KEY_B, TOKEN_ENCRYPTION_KEY_PREVIOUS: KEY_A };
    expect(await reencryptShareTokens(rotated)).toBe(1);
    expect(await reencryptShareTokens(rotated)).toBe(0);
    const row = (await getSession(rotated, 'sess-1'))!;
    expect(await shareUrlFor({ ...env, TOKEN_ENCRYPTION_KEY: KEY_B }, row)).toContain(share.token);
  });
});
