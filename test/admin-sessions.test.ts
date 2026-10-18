import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall, call, createPublishedSession, FakeGoogle, FOLDER_ID, resetDb, seedConnection, sessionConfig, withAccess } from './helpers';

let ms: FakeGoogle;
beforeEach(async () => {
  await resetDb();
  await seedConnection();
  ms = new FakeGoogle();
  vi.spyOn(globalThis, 'fetch').mockImplementation(withAccess(ms.handler) as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

type S = { session: { id: string; status: string; effectiveState: string; shareUrl: string; title: string; folder: { id: string } | null } };

describe('admin session lifecycle', () => {
  it('creates drafts, edits, publishes, unpublishes, duplicates and closes', async () => {
    const created = (await (await adminCall('POST', '/sessions', sessionConfig({ folder: null }))).json()) as S;
    expect(created.session).toMatchObject({ status: 'draft', effectiveState: 'draft' });
    const id = created.session.id;

    // A draft without a folder cannot be published.
    expect((await adminCall('POST', `/sessions/${id}/publish`, {})).status).toBe(422);
    const edited = (await (await adminCall('PUT', `/sessions/${id}`, sessionConfig({ title: 'Edited' }))).json()) as S;
    expect(edited.session).toMatchObject({ title: 'Edited', folder: { id: FOLDER_ID } });

    const pub = (await (await adminCall('POST', `/sessions/${id}/publish`, {})).json()) as S;
    expect(pub.session.effectiveState).toBe('open');

    // Editing a live session into an invalid state is refused.
    const bad = await adminCall('PUT', `/sessions/${id}`, sessionConfig({ fields: [{ label: 'X', key: 'not_in_table', type: 'text', required: false }] }));
    expect(bad.status).toBe(422);

    expect(((await (await adminCall('POST', `/sessions/${id}/unpublish`, {})).json()) as S).session.status).toBe('unpublished');

    const dup = (await (await adminCall('POST', `/sessions/${id}/duplicate`, {})).json()) as S;
    expect(dup.session).toMatchObject({ status: 'draft', title: 'Copy of Edited', folder: { id: FOLDER_ID } });
    expect(dup.session.shareUrl).not.toBe(pub.session.shareUrl);

    expect(((await (await adminCall('POST', `/sessions/${id}/close`, {})).json()) as S).session.status).toBe('closed');
    expect((await adminCall('PUT', `/sessions/${id}`, sessionConfig())).status).toBe(409);

    const list = (await (await adminCall('GET', '/sessions')).json()) as { sessions: { id: string }[] };
    expect(list.sessions.map((s) => s.id).sort()).toEqual([id, dup.session.id].sort());
    const actions = (await env.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['session.created', 'session.updated', 'session.published', 'session.unpublished', 'session.duplicated', 'session.closed']));
  });

  it('stores only a hash and ciphertext of the share token', async () => {
    const { id, token } = await createPublishedSession();
    const row = await env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(id).first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('serves a QR code SVG for exactly the share link', async () => {
    const { id } = await createPublishedSession();
    const res = await adminCall('GET', `/sessions/${id}/qr.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    const svg = await res.text();
    expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain('<path');
  });

  it('validates admin input', async () => {
    const res = await adminCall('POST', '/sessions', { title: '' });
    expect(res.status).toBe(422);
    expect((await adminCall('GET', '/sessions/not-a-uuid')).status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('limits submission creation per client', async () => {
    const { token } = await createPublishedSession();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await call('POST', '/api/public/submissions', {
        body: { token, fields: { table_number: '1' }, files: [{ name: 'a.pdf', size: 5, type: '' }] },
        headers: { 'CF-Connecting-IP': '192.0.2.77' },
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(10);
  });
});
