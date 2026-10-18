// Test helpers: an in-memory fake of the Microsoft endpoints the Worker calls,
// Access JWT minting, and request utilities.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { STANDARD_EXCEL_COLUMNS } from '../shared/constants';
import type { SessionConfigInput } from '../shared/types';
import { base64UrlEncode, encryptString, keyMaterial } from '../src/crypto';
import { resetJwksCache } from '../src/access';
import worker from '../src/index';

export const BASE = 'https://uploads.test';
export const DRIVE_ID = 'b!drive';
export const FOLDER_ID = 'FOLDER1';
export const WORKBOOK_ID = 'WORKBOOK1';
export const TABLE_ID = '{TABLE-1}';

interface FakeFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  parentId: string;
}

/** Fake OneDrive + Excel + token endpoint. */
export class FakeMicrosoft {
  files = new Map<string, FakeFile>(); // by id
  uploadSessions = new Map<string, { parentId: string; name: string }>();
  tableColumns: string[] = [...STANDARD_EXCEL_COLUMNS, 'table_number', 'description'];
  tableRows: (string | number | boolean | null)[][] = [];
  addRowsFailures = 0; // number of upcoming rows/add calls that fail with 503
  addRowsFailAfterWrite = 0; // upcoming rows/add calls that write rows, then fail (lost response)
  addRowsCalls = 0;
  tokenCalls = 0;
  tokenError: string | null = null;
  graphCalls: { method: string; url: string; auth: string | null }[] = [];
  private seq = 0;

  /** Simulates the browser finishing a resumable upload. */
  completeUpload(uploadUrl: string, bytes: Uint8Array) {
    const s = this.uploadSessions.get(uploadUrl);
    if (!s) throw new Error('unknown upload session');
    const id = `ITEM${++this.seq}`;
    this.files.set(id, { id, name: s.name, bytes, parentId: s.parentId });
    return id;
  }

  private itemJson(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      size: f.bytes.length,
      webUrl: `https://contoso-my.sharepoint.com/personal/a/Documents/Uploads/${encodeURIComponent(f.name)}`,
      file: { mimeType: 'application/pdf' },
      parentReference: { driveId: DRIVE_ID, id: f.parentId, path: '/drive/root:/Uploads' },
    };
  }

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.hostname === 'login.microsoftonline.com' && url.pathname.endsWith('/token')) {
      this.tokenCalls++;
      if (this.tokenError) return json({ error: this.tokenError }, 400);
      const n = this.tokenCalls;
      return json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, token_type: 'Bearer', scope: 'Files.ReadWrite User.Read' });
    }
    if (url.hostname === 'download.test') {
      const f = this.files.get(url.pathname.slice(1))!;
      const range = req.headers.get('Range');
      const end = range ? Number(range.split('-')[1]) + 1 : f.bytes.length;
      return new Response(f.bytes.slice(0, end), { status: range ? 206 : 200 });
    }
    if (url.hostname !== 'graph.microsoft.com') throw new Error(`Unexpected fetch to ${url.hostname}`);

    const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));
    this.graphCalls.push({ method: req.method, url: path, auth: req.headers.get('Authorization') });

    // Upload session creation: /drives/{d}/items/{folder}:/{name}:/createUploadSession
    let m = path.match(/^\/drives\/[^/]+\/items\/([^/:]+):\/(.+):\/createUploadSession$/);
    if (m && req.method === 'POST') {
      const uploadUrl = `https://contoso-my.sharepoint.com/upload/${++this.seq}`;
      this.uploadSessions.set(uploadUrl, { parentId: m[1]!, name: m[2]! });
      return json({ uploadUrl, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
    }
    // Child by path: /drives/{d}/items/{folder}:/{name}
    m = path.match(/^\/drives\/[^/]+\/items\/([^/:]+):\/([^:]+)$/);
    if (m && req.method === 'GET') {
      const f = [...this.files.values()].find((x) => x.parentId === m![1] && x.name === m![2]);
      return f ? json(this.itemJson(f)) : json({ error: { code: 'itemNotFound', message: 'not found' } }, 404);
    }
    // Excel
    if (path.includes('/workbook/tables')) {
      if (path.endsWith('/columns')) return json({ value: this.tableColumns.map((name, index) => ({ id: String(index + 1), name, index })) });
      m = path.match(/\/columns\/(\d+)\/dataBodyRange$/);
      if (m) {
        const idx = Number(m[1]) - 1;
        return json({ values: this.tableRows.map((r) => [r[idx] ?? '']) });
      }
      if (path.endsWith('/rows/add') && req.method === 'POST') {
        this.addRowsCalls++;
        if (this.addRowsFailures > 0) {
          this.addRowsFailures--;
          return json({ error: { code: 'serviceNotAvailable', message: 'busy' } }, 503);
        }
        const body = (await req.json()) as { values: (string | number | null)[][] };
        for (const row of body.values) {
          if (row.length !== this.tableColumns.length) return json({ error: { code: 'InvalidArgument', message: 'width' } }, 400);
          this.tableRows.push(row);
        }
        if (this.addRowsFailAfterWrite > 0) {
          this.addRowsFailAfterWrite--;
          return json({ error: { code: 'gatewayTimeout', message: 'timeout' } }, 504);
        }
        return json({ index: this.tableRows.length - 1 });
      }
      if (path.match(/\/tables$/)) return json({ value: [{ id: TABLE_ID, name: 'Uploads' }] });
    }
    // Item by id (with optional downloadUrl select) or delete
    m = path.match(/^\/drives\/[^/]+\/items\/([^/:]+)$/);
    if (m) {
      if (req.method === 'DELETE') {
        this.files.delete(m[1]!);
        return new Response(null, { status: 204 });
      }
      if (m[1] === FOLDER_ID) return json({ id: FOLDER_ID, name: 'Uploads', folder: { childCount: 0 }, parentReference: { driveId: DRIVE_ID, id: 'ROOT', path: '/drive/root:' } });
      if (m[1] === WORKBOOK_ID) return json({ id: WORKBOOK_ID, name: 'Uploads.xlsx', file: {}, parentReference: { driveId: DRIVE_ID, id: 'ROOT', path: '/drive/root:' } });
      const f = this.files.get(m[1]!);
      if (!f) return json({ error: { code: 'itemNotFound' } }, 404);
      return json({ ...this.itemJson(f), '@microsoft.graph.downloadUrl': `https://download.test/${f.id}` });
    }
    throw new Error(`Unhandled Graph call ${req.method} ${path}`);
  };

  install() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(this.handler as typeof fetch);
  }
}

/** Seeds a connected Microsoft account and Excel target. */
export async function seedConnection(opts: { accessExpiresInMs?: number } = {}) {
  const keys = keyMaterial(env);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO ms_connection (id, status, tenant_id, user_object_id, user_principal_name, display_name, drive_id, scopes,
       refresh_token_enc, access_token_enc, access_token_expires_at, version, connected_by, connected_at, last_refreshed_at, updated_at)
     VALUES ('primary', 'connected', 't', 'u', 'admin@contoso.com', 'Admin', ?, 'Files.ReadWrite', ?, ?, ?, 1, 'admin@contoso.com', ?, ?, ?)`,
  )
    .bind(
      DRIVE_ID,
      await encryptString(keys, 'refresh-0', 'ms_refresh_token:primary'),
      await encryptString(keys, 'access-0', 'ms_access_token:primary'),
      now + (opts.accessExpiresInMs ?? 3600_000),
      now,
      now,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO excel_target (id, drive_id, item_id, workbook_name, workbook_path, table_id, table_name, columns_json, updated_by, updated_at)
     VALUES ('primary', ?, ?, 'Uploads.xlsx', '/Uploads.xlsx', ?, 'Uploads', '[]', 'admin@contoso.com', ?)`,
  )
    .bind(DRIVE_ID, WORKBOOK_ID, TABLE_ID, now)
    .run();
}

export function sessionConfig(overrides: Partial<SessionConfigInput> = {}): SessionConfigInput {
  return {
    title: 'Table photos',
    instructions: 'Upload one photo per table.',
    folder: { driveId: DRIVE_ID, itemId: FOLDER_ID, path: '/Uploads' },
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    maxSubmissions: null,
    fileRules: { allowedExtensions: ['pdf', 'png'], maxFileSizeBytes: 10_000_000, maxFilesPerSubmission: 3 },
    fields: [
      { label: 'Table number', key: 'table_number', type: 'text', required: true },
      { label: 'Description', key: 'description', type: 'textarea', required: false },
    ],
    showOneDriveLinks: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------- Access JWTs

let signingKey: CryptoKeyPair | null = null;
export const ACCESS_KID = 'test-kid';

async function keyPair() {
  if (!signingKey) {
    signingKey = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
  }
  return signingKey;
}

export async function accessJwks() {
  const jwk = (await crypto.subtle.exportKey('jwk', (await keyPair()).publicKey)) as JsonWebKey;
  return { keys: [{ ...jwk, kid: ACCESS_KID, alg: 'RS256', use: 'sig' }] };
}

export async function mintAccessJwt(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: CryptoKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: opts.kid ?? ACCESS_KID, typ: 'JWT' };
  const payload = { aud: ['test-aud'], iss: 'https://team.cloudflareaccess.com', email: 'Admin@Contoso.com', exp: now + 600, iat: now, nbf: now, ...claims };
  const enc = (o: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(o)));
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? (await keyPair()).privateKey, new TextEncoder().encode(data));
  return `${data}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Wraps a fetch handler so Access JWKS requests are answered. */
export function withAccess(inner: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  resetJwksCache();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.hostname === 'team.cloudflareaccess.com') return new Response(JSON.stringify(await accessJwks()), { headers: { 'Content-Type': 'application/json' } });
    return inner(input, init);
  };
}

// ---------------------------------------------------------------- requests

export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; jwt?: string } = {},
): Promise<Response> {
  // A distinct client IP per request keeps the rate limiters out of the way; rate limiting has its own test.
  const ip = `198.51.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const headers: Record<string, string> = { 'CF-Connecting-IP': ip, ...opts.headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    headers.Origin ??= BASE;
  }
  if (opts.jwt) headers['Cf-Access-Jwt-Assertion'] = opts.jwt;
  const req = new Request(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function adminCall(method: string, path: string, body?: unknown) {
  return call(method, `/api/admin${path}`, { body, jwt: await mintAccessJwt() });
}

/** Creates and publishes a session through the admin API; returns its share token. */
export async function createPublishedSession(overrides: Partial<SessionConfigInput> = {}) {
  const res = await adminCall('POST', '/sessions', sessionConfig(overrides));
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${await res.text()}`);
  const { session } = (await res.json()) as { session: { id: string; shareUrl: string } };
  const pub = await adminCall('POST', `/sessions/${session.id}/publish`, {});
  if (pub.status !== 200) throw new Error(`publish failed ${pub.status} ${await pub.text()}`);
  return { id: session.id, token: session.shareUrl.split('#')[1]!, shareUrl: session.shareUrl };
}

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n% test document body');

export async function resetDb() {
  await env.DB.batch(
    ['audit_log', 'submission_files', 'submissions', 'upload_sessions', 'excel_target', 'ms_connection', 'oauth_states'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
