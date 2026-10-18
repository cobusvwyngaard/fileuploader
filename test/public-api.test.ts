import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall, call, createPublishedSession, FakeMicrosoft, resetDb, seedConnection, withAccess } from './helpers';

let ms: FakeMicrosoft;

beforeEach(async () => {
  await resetDb();
  await seedConnection();
  ms = new FakeMicrosoft();
  vi.spyOn(globalThis, 'fetch').mockImplementation(withAccess(ms.handler) as typeof fetch);
});
afterEach(() => vi.restoreAllMocks());

const openSession = (token: string) => call('POST', '/api/public/session', { body: { token } });
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const submit = (token: string, fields: Record<string, unknown> = { table_number: '7' }, files = [{ name: 'a.pdf', size: 31, type: 'application/pdf' }]) =>
  call('POST', '/api/public/submissions', { body: { token, fields, files } });

describe('public link states', () => {
  it('serves the public view of an open session without internal details', async () => {
    const { token } = await createPublishedSession();
    const res = await openSession(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ title: 'Table photos', fileRules: { allowedExtensions: ['pdf', 'png'] } });
    expect(JSON.stringify(body)).not.toMatch(/FOLDER1|driveId|excel/i);
  });

  it('rejects invalid and malformed tokens', async () => {
    expect(await errCode(await openSession('x'.repeat(43)))).toBe('invalid_link');
    expect(await errCode(await openSession('../../etc'))).toBe('invalid_link');
    expect((await call('POST', '/api/public/session', { body: {} })).status).toBe(404);
  });

  it('rejects expired sessions', async () => {
    const { id, token } = await createPublishedSession();
    await env.DB.prepare('UPDATE upload_sessions SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, id).run();
    const res = await openSession(token);
    expect(res.status).toBe(410);
    expect(await errCode(res)).toBe('expired');
    expect(await errCode(await submit(token))).toBe('expired');
  });

  it('rejects unpublished, draft and closed sessions', async () => {
    const { id, token } = await createPublishedSession();
    await adminCall('POST', `/sessions/${id}/unpublish`, {});
    expect(await errCode(await openSession(token))).toBe('not_published');
    await adminCall('POST', `/sessions/${id}/close`, {});
    expect(await errCode(await openSession(token))).toBe('closed');
    expect((await adminCall('POST', `/sessions/${id}/publish`, {})).status).toBe(409);
  });

  it('stops accepting submissions once the maximum is reached', async () => {
    const { token } = await createPublishedSession({ maxSubmissions: 2 });
    expect((await submit(token)).status).toBe(201);
    expect((await submit(token)).status).toBe(201);
    const third = await submit(token);
    expect(third.status).toBe(410);
    expect(await errCode(third)).toBe('exhausted');
    expect(await errCode(await openSession(token))).toBe('exhausted');
  });

  it('never over-allocates slots under concurrent submissions', async () => {
    const { id, token } = await createPublishedSession({ maxSubmissions: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const row = await env.DB.prepare('SELECT submission_count FROM upload_sessions WHERE id = ?').bind(id).first<{ submission_count: number }>();
    expect(row?.submission_count).toBe(3);
  });

  it('invalidates the old link when it is replaced', async () => {
    const { id, token } = await createPublishedSession();
    const res = await adminCall('POST', `/sessions/${id}/rotate-link`, {});
    const newToken = ((await res.json()) as { session: { shareUrl: string } }).session.shareUrl.split('#')[1]!;
    expect(newToken).not.toBe(token);
    expect(await errCode(await openSession(token))).toBe('invalid_link');
    expect((await openSession(newToken)).status).toBe(200);
  });
});

describe('server-side submission validation', () => {
  it('rejects missing required fields and unknown fields', async () => {
    const { token } = await createPublishedSession();
    const res = await submit(token, { description: 'x', hacker: 'y' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: Record<string, string> } };
    expect(body.error.details.table_number).toMatch(/required/);
    expect(body.error.details.hacker).toBeDefined();
  });

  it('rejects disallowed extensions, oversize files and too many files', async () => {
    const { token } = await createPublishedSession();
    expect((await submit(token, undefined, [{ name: 'run.exe', size: 1, type: '' }])).status).toBe(422);
    expect((await submit(token, undefined, [{ name: 'a.pdf', size: 10_000_001, type: '' }])).status).toBe(422);
    expect((await submit(token, undefined, [1, 2, 3, 4].map((i) => ({ name: `${i}.pdf`, size: 1, type: '' })))).status).toBe(422);
  });

  it('does not let uploaders influence the destination path', async () => {
    const { token } = await createPublishedSession();
    const res = await submit(token, { table_number: '1' }, [{ name: '../../Other/evil.pdf', size: 31, type: '' }]);
    expect(res.status).toBe(201);
    const { submissionId } = (await res.json()) as { submissionId: string };
    const f = await env.DB.prepare('SELECT stored_filename, original_filename FROM submission_files WHERE submission_id = ?').bind(submissionId).first<{ stored_filename: string; original_filename: string }>();
    expect(f!.stored_filename).toMatch(/^\d{8}_[A-Z0-9]{4}-[A-Z0-9]{4}_01_evil\.pdf$/);
    expect(f!.original_filename).toBe('evil.pdf');
  });

  it('requires the submission secret for follow-up calls', async () => {
    const { token } = await createPublishedSession();
    const { submissionId, files } = (await (await submit(token)).json()) as { submissionId: string; files: { fileId: string }[] };
    const res = await call('POST', `/api/public/submissions/${submissionId}/files/${files[0]!.fileId}/upload-url`, { body: { secret: 'wrong' } });
    expect(res.status).toBe(404);
    expect(ms.uploadSessions.size).toBe(0);
  });
});

describe('publishing requires a valid Excel mapping', () => {
  it('refuses to publish when a field has no matching Excel column', async () => {
    const res = await adminCall('POST', '/sessions', (await import('./helpers')).sessionConfig({
      fields: [{ label: 'Colour', key: 'colour', type: 'select', required: true, options: ['Red'] }],
    }));
    const { session } = (await res.json()) as { session: { id: string } };
    const pub = await adminCall('POST', `/sessions/${session.id}/publish`, {});
    expect(pub.status).toBe(422);
    expect(((await pub.json()) as { error: { message: string } }).error.message).toContain('"colour"');
    ms.tableColumns.push('colour');
    expect((await adminCall('POST', `/sessions/${session.id}/publish`, {})).status).toBe(200);
  });

  it('refuses to publish without a connected Excel table', async () => {
    await env.DB.prepare('DELETE FROM excel_target').run();
    const res = await adminCall('POST', '/sessions', (await import('./helpers')).sessionConfig());
    const { session } = (await res.json()) as { session: { id: string } };
    const pub = await adminCall('POST', `/sessions/${session.id}/publish`, {});
    expect(pub.status).toBe(422);
  });
});

describe('Microsoft connection', () => {
  it('refuses new submissions without reserving a slot when OneDrive is not connected', async () => {
    const { id, token } = await createPublishedSession();
    await env.DB.prepare("UPDATE ms_connection SET status = 'needs_reauth'").run();
    const res = await submit(token);
    expect(res.status).toBe(503);
    const row = await env.DB.prepare('SELECT submission_count FROM upload_sessions WHERE id = ?').bind(id).first<{ submission_count: number }>();
    expect(row?.submission_count).toBe(0);
  });
});
