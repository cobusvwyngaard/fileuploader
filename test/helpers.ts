// Test helpers: an in-memory fake of the Google endpoints the Worker calls
// (OAuth, Drive, Sheets), Access JWT minting, and request utilities.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { STANDARD_REPORT_COLUMNS } from '../shared/constants';
import type { SessionConfigInput } from '../shared/types';
import { base64UrlEncode, encryptString, keyMaterial } from '../src/crypto';
import { resetJwksCache } from '../src/access';
import worker from '../src/index';

export const BASE = 'https://uploads.test';
export const FOLDER_ID = 'FOLDER123456';
export const SPREADSHEET_ID = 'SHEET1234567890';
export const SHEET_ID = 0;
export const SHEET_TITLE = 'Uploads';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  parents: string[];
  trashed: boolean;
}

/** Fake Google OAuth + Drive + Sheets. */
export class FakeGoogle {
  files = new Map<string, FakeFile>();
  uploadSessions = new Map<string, { parentId: string; name: string; size: number; mimeType: string; origin: string | null }>();
  header: string[] = [...STANDARD_REPORT_COLUMNS, 'table_number', 'description'];
  rows: (string | number | boolean)[][] = [];
  appendFailures = 0; // upcoming append calls that fail with 503 before writing
  appendFailAfterWrite = 0; // upcoming append calls that write rows, then fail (lost response)
  appendCalls = 0;
  tokenCalls = 0;
  tokenError: string | null = null;
  revoked: string[] = [];
  apiCalls: { method: string; url: string; auth: string | null }[] = [];
  private seq = 0;

  constructor() {
    this.files.set(FOLDER_ID, { id: FOLDER_ID, name: 'Uploads', mimeType: 'application/vnd.google-apps.folder', bytes: new Uint8Array(), parents: ['root'], trashed: false });
  }

  /** Simulates the browser finishing a resumable upload. */
  completeUpload(uploadUrl: string, bytes: Uint8Array) {
    const s = this.uploadSessions.get(uploadUrl);
    if (!s) throw new Error('unknown upload session');
    const id = `FILE${String(++this.seq).padStart(8, '0')}`;
    this.files.set(id, { id, name: s.name, mimeType: s.mimeType, bytes, parents: [s.parentId], trashed: false });
    return id;
  }

  private fileJson(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      ...(f.mimeType.startsWith('application/vnd.google-apps') ? {} : { size: String(f.bytes.length) }),
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
      parents: f.parents,
      trashed: f.trashed,
    };
  }

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      this.tokenCalls++;
      if (this.tokenError) return json({ error: this.tokenError }, 400);
      const n = this.tokenCalls;
      return json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file openid email' });
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      this.revoked.push(new URLSearchParams(await req.text()).get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    if (!url.hostname.endsWith('googleapis.com')) throw new Error(`Unexpected fetch to ${url.hostname}`);
    this.apiCalls.push({ method: req.method, url: url.pathname + url.search, auth: req.headers.get('Authorization') });

    // ---- Drive uploads
    if (url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable' && req.method === 'POST') {
      const meta = (await req.json()) as { name: string; parents: string[] };
      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=U${++this.seq}`;
      this.uploadSessions.set(uploadUrl, {
        parentId: meta.parents[0]!,
        name: meta.name,
        size: Number(req.headers.get('X-Upload-Content-Length')),
        mimeType: req.headers.get('X-Upload-Content-Type') ?? '',
        origin: req.headers.get('Origin'),
      });
      return new Response(null, { status: 200, headers: { Location: uploadUrl } });
    }
    // ---- Drive files
    if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const mime = /mimeType = '([^']+)'/.exec(q)?.[1];
      const files = [...this.files.values()].filter(
        (f) => !f.trashed && (name === undefined || f.name === name) && (parent === undefined || f.parents.includes(parent)) && (mime === undefined || f.mimeType === mime),
      );
      return json({ files: files.map((f) => this.fileJson(f)) });
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const meta = (await req.json()) as { name: string; mimeType: string; parents?: string[] };
      const id = `FOLDER${String(++this.seq).padStart(8, '0')}`;
      const f = { id, name: meta.name, mimeType: meta.mimeType, bytes: new Uint8Array(), parents: meta.parents ?? ['root'], trashed: false };
      this.files.set(id, f);
      return json(this.fileJson(f));
    }
    let m = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]!));
      if (!f) return json({ error: { errors: [{ reason: 'notFound' }], message: 'File not found' } }, 404);
      if (req.method === 'PATCH') {
        Object.assign(f, (await req.json()) as Partial<FakeFile>);
        return json({ id: f.id });
      }
      if (url.searchParams.get('alt') === 'media') {
        const range = req.headers.get('Range');
        const end = range ? Number(range.split('-')[1]) + 1 : f.bytes.length;
        return new Response(f.bytes.slice(0, end), { status: range ? 206 : 200 });
      }
      return json(this.fileJson(f));
    }
    // ---- Sheets
    if (url.hostname === 'sheets.googleapis.com') {
      if (url.pathname === '/v4/spreadsheets' && req.method === 'POST') {
        const body = (await req.json()) as { properties: { title: string }; sheets: { properties: { title: string }; data: { rowData: { values: { userEnteredValue: { stringValue: string } }[] }[] }[] }[] };
        this.header = body.sheets[0]!.data[0]!.rowData[0]!.values.map((v) => v.userEnteredValue.stringValue);
        this.rows = [];
        return json({ spreadsheetId: SPREADSHEET_ID, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`, properties: body.properties, sheets: [{ properties: { sheetId: SHEET_ID, title: SHEET_TITLE } }] });
      }
      m = url.pathname.match(/^\/v4\/spreadsheets\/([^/]+)$/);
      if (m && req.method === 'GET') {
        if (decodeURIComponent(m[1]!) !== SPREADSHEET_ID) return json({ error: { status: 'NOT_FOUND' } }, 404);
        return json({ spreadsheetId: SPREADSHEET_ID, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`, properties: { title: 'Report' }, sheets: [{ properties: { sheetId: SHEET_ID, title: SHEET_TITLE } }] });
      }
      m = url.pathname.match(/^\/v4\/spreadsheets\/[^/]+\/values\/(.+)$/);
      if (m) {
        const range = decodeURIComponent(m[1]!);
        if (range.endsWith(':append') && req.method === 'POST') {
          this.appendCalls++;
          if (this.appendFailures > 0) {
            this.appendFailures--;
            return json({ error: { status: 'UNAVAILABLE', message: 'busy' } }, 503);
          }
          const body = (await req.json()) as { values: (string | number | boolean)[][] };
          for (const row of body.values) {
            if (row.length !== this.header.length) return json({ error: { status: 'INVALID_ARGUMENT', message: 'width' } }, 400);
            this.rows.push(row);
          }
          if (this.appendFailAfterWrite > 0) {
            this.appendFailAfterWrite--;
            return json({ error: { status: 'DEADLINE_EXCEEDED', message: 'timeout' } }, 504);
          }
          return json({ updates: { updatedRows: body.values.length } });
        }
        const a1 = range.split('!')[1] ?? '';
        if (a1 === '1:1') return json({ values: [this.header] });
        const col = /^([A-Z]+)2:/.exec(a1)?.[1];
        if (col && req.method === 'GET') {
          const idx = col.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
          return json({ values: this.rows.map((r) => [r[idx] ?? '']) });
        }
        if (req.method === 'PUT') {
          const body = (await req.json()) as { values: string[][] };
          const start = /^([A-Z]+)1/.exec(a1)![1]!.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
          body.values[0]!.forEach((v, i) => (this.header[start + i] = v));
          return json({});
        }
      }
    }
    throw new Error(`Unhandled Google call ${req.method} ${url.hostname}${url.pathname}`);
  };

  install() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(this.handler as typeof fetch);
  }
}

/** Seeds a connected Google account and report sheet. */
export async function seedConnection(opts: { accessExpiresInMs?: number } = {}) {
  const keys = keyMaterial(env);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO google_connection (id, status, google_sub, email, scopes, refresh_token_enc, access_token_enc, access_token_expires_at,
       version, connected_by, connected_at, last_refreshed_at, updated_at)
     VALUES ('primary', 'connected', 'sub-1', 'owner@gmail.com', 'drive.file', ?, ?, ?, 1, 'admin@contoso.com', ?, ?, ?)`,
  )
    .bind(
      await encryptString(keys, 'refresh-0', 'google_refresh_token:primary'),
      await encryptString(keys, 'access-0', 'google_access_token:primary'),
      now + (opts.accessExpiresInMs ?? 3600_000),
      now,
      now,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO sheet_target (id, spreadsheet_id, spreadsheet_name, spreadsheet_url, sheet_id, sheet_title, columns_json, updated_by, updated_at)
     VALUES ('primary', ?, 'Report', NULL, ?, ?, '[]', 'admin@contoso.com', ?)`,
  )
    .bind(SPREADSHEET_ID, SHEET_ID, SHEET_TITLE, now)
    .run();
}

export function sessionConfig(overrides: Partial<SessionConfigInput> = {}): SessionConfigInput {
  return {
    title: 'Table photos',
    instructions: 'Upload one photo per table.',
    folder: { id: FOLDER_ID, path: '/Uploads' },
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    maxSubmissions: null,
    fileRules: { allowedExtensions: ['pdf', 'png'], maxFileSizeBytes: 10_000_000, maxFilesPerSubmission: 3 },
    fields: [
      { label: 'Table number', key: 'table_number', type: 'text', required: true },
      { label: 'Description', key: 'description', type: 'textarea', required: false },
    ],
    showDriveLinks: false,
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
    ['audit_log', 'submission_files', 'submissions', 'upload_sessions', 'sheet_target', 'google_connection', 'oauth_states'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}
