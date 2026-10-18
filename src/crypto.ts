// Small WebCrypto helpers. No secrets are ever logged from here.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Decode(input: string): Uint8Array {
  return base64UrlDecode(input.trim());
}

/** Cryptographically random URL-safe token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Human-friendly reference such as "K7Q2-M9XD" (40 bits, Crockford base32). */
export function randomReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i]! & 31];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Constant-time comparison of two equal-length strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface KeyEntry {
  id: string;
  key: CryptoKey;
}

const keyCache = new Map<string, Promise<KeyEntry>>();

async function loadKey(material: string): Promise<KeyEntry> {
  let p = keyCache.get(material);
  if (!p) {
    p = (async () => {
      const raw = base64Decode(material);
      if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
      const id = (await sha256Hex(material)).slice(0, 8);
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { id, key };
    })();
    keyCache.set(material, p);
    p.catch(() => keyCache.delete(material));
  }
  return p;
}

export interface KeyMaterial {
  current: string;
  previous?: string;
}

/**
 * Encrypts with AES-256-GCM. Output format: v1.<keyId>.<iv>.<ciphertext>.
 * `context` is bound as additional authenticated data so a ciphertext cannot be
 * moved to a different column or row.
 */
export async function encryptString(keys: KeyMaterial, plaintext: string, context: string): Promise<string> {
  const { id, key } = await loadKey(keys.current);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${id}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptString(keys: KeyMaterial, payload: string, context: string): Promise<string> {
  const [version, keyId, ivPart, ctPart] = payload.split('.');
  if (version !== 'v1' || !keyId || !ivPart || !ctPart) throw new Error('Unsupported ciphertext format');
  const candidates = [keys.current, keys.previous].filter((k): k is string => !!k);
  for (const material of candidates) {
    const entry = await loadKey(material);
    if (entry.id !== keyId) continue;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(ivPart), additionalData: encoder.encode(context) },
      entry.key,
      base64UrlDecode(ctPart),
    );
    return decoder.decode(pt);
  }
  throw new Error('No encryption key matches the stored ciphertext');
}

export function keyMaterial(env: { TOKEN_ENCRYPTION_KEY: string; TOKEN_ENCRYPTION_KEY_PREVIOUS?: string }): KeyMaterial {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  return { current: env.TOKEN_ENCRYPTION_KEY, previous: env.TOKEN_ENCRYPTION_KEY_PREVIOUS || undefined };
}

/** True when the ciphertext was produced with a key other than the current one. */
export async function needsReencryption(keys: KeyMaterial, payload: string): Promise<boolean> {
  const { id } = await loadKey(keys.current);
  return payload.split('.')[1] !== id;
}
