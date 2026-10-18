import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_REPORT_COLUMNS } from '../shared/constants';
import { folderPaths } from '../src/google/drive';
import { buildAuthorizeUrl } from '../src/google/oauth';
import { adminCall, call, FakeGoogle, mintAccessJwt, resetDb, seedConnection, SPREADSHEET_ID, withAccess } from './helpers';

let ms: FakeGoogle;
beforeEach(async () => {
  await resetDb();
  ms = new FakeGoogle();
  vi.spyOn(globalThis, 'fetch').mockImplementation(withAccess(ms.handler) as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

describe('Google connect flow', () => {
  it('requests only drive.file + openid email, offline, with PKCE', () => {
    const u = new URL(buildAuthorizeUrl(env, 'state-1', 'challenge-1'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file openid email');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('https://uploads.test/api/admin/google/callback');
  });

  it('redirects admins to Google and rejects callbacks with an unknown state', async () => {
    const jwt = await mintAccessJwt();
    const start = await call('GET', '/api/admin/google/connect', { jwt });
    expect(start.status).toBe(302);
    expect(start.headers.get('Location')).toMatch(/^https:\/\/accounts\.google\.com\//);
    const bad = await call('GET', '/api/admin/google/callback?state=forged&code=x', { jwt });
    expect(bad.headers.get('Location')).toBe('/admin/settings?google=invalid_state');
    expect(ms.tokenCalls).toBe(0);
  });

  it('completes the flow and stores the connection encrypted', async () => {
    const jwt = await mintAccessJwt();
    const start = await call('GET', '/api/admin/google/connect', { jwt });
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      withAccess(async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.hostname === 'openidconnect.googleapis.com') return new Response(JSON.stringify({ sub: 'sub-9', email: 'owner@gmail.com' }));
        return ms.handler(input, init);
      }) as typeof fetch,
    );
    const done = await call('GET', `/api/admin/google/callback?state=${state}&code=abc`, { jwt });
    expect(done.headers.get('Location')).toBe('/admin/settings?google=connected');
    const row = await env.DB.prepare("SELECT * FROM google_connection WHERE id = 'primary'").first<Record<string, string>>();
    expect(row).toMatchObject({ status: 'connected', email: 'owner@gmail.com', connected_by: 'admin@contoso.com' });
    expect(JSON.stringify(row)).not.toContain('refresh-1');
    // State is single-use.
    const replay = await call('GET', `/api/admin/google/callback?state=${state}&code=abc`, { jwt });
    expect(replay.headers.get('Location')).toBe('/admin/settings?google=invalid_state');
    fetchMock.mockRestore();
  });
});

describe('folders and report sheet', () => {
  beforeEach(() => seedConnection());

  it('creates nested folders and lists them with paths', async () => {
    const a = (await (await adminCall('POST', '/drive/folders', { name: 'Events' })).json()) as { folder: { id: string; path: string } };
    expect(a.folder.path).toBe('/Events');
    const b = (await (await adminCall('POST', '/drive/folders', { name: 'Gala 2026', parentId: a.folder.id })).json()) as { folder: { path: string } };
    expect(b.folder.path).toBe('/Events/Gala 2026');
    const list = (await (await adminCall('GET', '/drive/folders')).json()) as { folders: { path: string }[] };
    expect(list.folders.map((f) => f.path)).toEqual(expect.arrayContaining(['/Events', '/Events/Gala 2026']));
    expect((await adminCall('POST', '/drive/folders', { name: '' })).status).toBe(400);
  });

  it('builds paths only from ancestors the app can see', () => {
    const p = folderPaths([
      { id: 'a', name: 'A', parents: ['root'] },
      { id: 'b', name: 'B', parents: ['a'] },
      { id: 'c', name: 'C', parents: ['hidden'] },
    ]);
    expect([p.get('a'), p.get('b'), p.get('c')]).toEqual(['/A', '/A/B', '/C']);
  });

  it('creates a report spreadsheet with the standard and field headers, then selects it', async () => {
    const res = await adminCall('POST', '/sheets/create', { name: 'Report', extraColumns: ['table_number', 'description', 'bad;col'] });
    expect(res.status).toBe(201);
    expect(ms.header).toEqual([...STANDARD_REPORT_COLUMNS, 'table_number', 'description']);
    const tabs = (await (await adminCall('GET', `/sheets/tabs?spreadsheetId=${SPREADSHEET_ID}`)).json()) as { tabs: { sheetId: number; missing: string[] }[] };
    expect(tabs.tabs[0]!.missing).toEqual([]);
    expect((await adminCall('PUT', '/sheets/target', { spreadsheetId: SPREADSHEET_ID, sheetId: tabs.tabs[0]!.sheetId })).status).toBe(200);
  });

  it('refuses a tab whose header row lacks standard columns', async () => {
    ms.header = ['submission_id'];
    const res = await adminCall('PUT', '/sheets/target', { spreadsheetId: SPREADSHEET_ID, sheetId: 0 });
    expect(res.status).toBe(422);
  });
});
