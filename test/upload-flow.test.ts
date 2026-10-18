import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall, call, createPublishedSession, FakeMicrosoft, PDF_BYTES, resetDb, seedConnection, withAccess } from './helpers';

let ms: FakeMicrosoft;
let logs: string[];

beforeEach(async () => {
  await resetDb();
  await seedConnection();
  ms = new FakeMicrosoft();
  vi.spyOn(globalThis, 'fetch').mockImplementation(withAccess(ms.handler) as typeof fetch);
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
  }
});
afterEach(() => vi.restoreAllMocks());

async function startSubmission(files = [{ name: 'Menu photo.pdf', size: PDF_BYTES.length, type: 'application/pdf' }], sessionOverrides = {}) {
  const session = await createPublishedSession(sessionOverrides);
  const res = await call('POST', '/api/public/submissions', { body: { token: session.token, fields: { table_number: '12', description: 'Front' }, files } });
  expect(res.status).toBe(201);
  return { session, sub: (await res.json()) as { submissionId: string; submissionSecret: string; reference: string; files: { fileId: string }[] } };
}

const uploadUrl = (sub: { submissionId: string; submissionSecret: string }, fileId: string) =>
  call('POST', `/api/public/submissions/${sub.submissionId}/files/${fileId}/upload-url`, { body: { secret: sub.submissionSecret } });
const complete = (sub: { submissionId: string; submissionSecret: string }, fileId: string) =>
  call('POST', `/api/public/submissions/${sub.submissionId}/files/${fileId}/complete`, { body: { secret: sub.submissionSecret } });
const status = async (id: string) => (await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<Record<string, unknown>>())!;

describe('direct-to-OneDrive upload flow', () => {
  it('runs end to end: upload session, verification, Excel row, complete', async () => {
    const { session, sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    expect((await status(sub.submissionId)).status).toBe('created');

    const u = await uploadUrl(sub, fileId);
    expect(u.status).toBe(200);
    expect(u.headers.get('Cache-Control')).toBe('no-store');
    const { uploadUrl: url } = (await u.json()) as { uploadUrl: string };
    expect(url).toMatch(/^https:\/\/contoso-my\.sharepoint\.com\/upload\//);
    expect((await status(sub.submissionId)).status).toBe('uploading');
    // Upload session is created in the configured folder with the server-generated name.
    const us = ms.uploadSessions.get(url)!;
    expect(us.parentId).toBe('FOLDER1');
    expect(us.name).toMatch(/_Menu_photo\.pdf$/);

    // Not finished yet -> completion refused.
    expect((await complete(sub, fileId)).status).toBe(409);

    ms.completeUpload(url, PDF_BYTES); // the browser PUTs chunks directly to Microsoft
    const done = await complete(sub, fileId);
    expect(done.status).toBe(200);
    const body = (await done.json()) as { fileStatus: string; webUrl?: string };
    expect(body.fileStatus).toBe('uploaded');
    expect(body.webUrl).toBeUndefined(); // links hidden unless configured

    const row = await status(sub.submissionId);
    expect(row.status).toBe('complete');
    expect(ms.tableRows).toHaveLength(1);
    const cols = ms.tableColumns;
    const excelRow = Object.fromEntries(cols.map((c, i) => [c, ms.tableRows[0]![i]]));
    expect(excelRow).toMatchObject({
      submission_id: sub.reference,
      upload_session_id: session.id,
      original_filename: 'Menu photo.pdf',
      file_size_bytes: PDF_BYTES.length,
      onedrive_folder_path: '/Uploads',
      processing_status: 'complete',
      table_number: '12',
      description: 'Front',
    });
    const file = await env.DB.prepare('SELECT * FROM submission_files WHERE id = ?').bind(fileId).first<Record<string, unknown>>();
    expect(file).toMatchObject({ status: 'uploaded', excel_status: 'inserted', content_check: 'match', actual_size: PDF_BYTES.length });
    expect(file!.drive_item_id).toBeTruthy();
    expect(file!.onedrive_path).toMatch(/^\/Uploads\/\d{8}_/);
    expect(file!.web_url).toMatch(/^https:/);

    // Access tokens were only ever sent to Graph, never to the browser.
    expect(JSON.stringify(body)).not.toContain('access-');
    expect(ms.graphCalls.every((c) => c.auth === 'Bearer access-0')).toBe(true);
  });

  it('is idempotent: repeated completion does not duplicate Excel rows', async () => {
    const { sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    const { uploadUrl: url } = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    ms.completeUpload(url, PDF_BYTES);
    const results = await Promise.all([complete(sub, fileId), complete(sub, fileId), complete(sub, fileId)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await complete(sub, fileId)).status).toBe(200);
    expect(ms.tableRows).toHaveLength(1);
    expect((await status(sub.submissionId)).status).toBe('complete');
  });

  it('reports an already-finished upload instead of creating a new session on restart', async () => {
    const { sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    const { uploadUrl: url } = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    ms.completeUpload(url, PDF_BYTES); // finished, but the browser lost the response
    const again = await uploadUrl(sub, fileId);
    expect(await again.json()).toEqual({ alreadyUploaded: true });
    expect(ms.uploadSessions.size).toBe(1);
  });

  it('permits restarting an interrupted upload with a fresh upload session', async () => {
    const { sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    const first = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    const second = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    expect(second.uploadUrl).not.toBe(first.uploadUrl);
    ms.completeUpload(second.uploadUrl, PDF_BYTES);
    expect((await complete(sub, fileId)).status).toBe(200);
  });

  it('refuses new upload sessions after the upload window closes', async () => {
    const { sub } = await startSubmission();
    await env.DB.prepare('UPDATE submissions SET upload_deadline = ? WHERE id = ?').bind(Date.now() - 1, sub.submissionId).run();
    const res = await uploadUrl(sub, sub.files[0]!.fileId);
    expect(res.status).toBe(410);
  });

  it('deletes and rejects a file whose size differs from what was declared', async () => {
    const { sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    const { uploadUrl: url } = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    ms.completeUpload(url, new Uint8Array([...PDF_BYTES, 1, 2, 3]));
    const res = await complete(sub, fileId);
    expect(res.status).toBe(422);
    expect(ms.files.size).toBe(0); // removed from OneDrive (recycle bin)
    const f = await env.DB.prepare('SELECT status, failure_reason FROM submission_files WHERE id = ?').bind(fileId).first();
    expect(f).toEqual({ status: 'failed', failure_reason: 'size_mismatch' });
    // The uploader may retry the file.
    expect((await uploadUrl(sub, fileId)).status).toBe(200);
  });

  it('deletes and rejects content that does not match the extension', async () => {
    const fake = new Uint8Array(PDF_BYTES.length).fill(0x41);
    fake[0] = 0x4d; // "MZ" Windows executable header
    fake[1] = 0x5a;
    const { sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    const { uploadUrl: url } = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    ms.completeUpload(url, fake);
    const res = await complete(sub, fileId);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('file_rejected');
    expect(ms.files.size).toBe(0);
  });

  it('waits for every file before reporting to Excel', async () => {
    const { sub } = await startSubmission([
      { name: 'one.pdf', size: PDF_BYTES.length, type: '' },
      { name: 'two.pdf', size: PDF_BYTES.length, type: '' },
    ]);
    for (const [i, f] of sub.files.entries()) {
      const { uploadUrl: url } = (await (await uploadUrl(sub, f.fileId)).json()) as { uploadUrl: string };
      ms.completeUpload(url, PDF_BYTES);
      await complete(sub, f.fileId);
      expect((await status(sub.submissionId)).status).toBe(i === 0 ? 'uploading' : 'complete');
    }
    expect(ms.tableRows).toHaveLength(2);
  });

  it('reveals OneDrive links only when the session allows it', async () => {
    const { sub } = await startSubmission(undefined, { showOneDriveLinks: true });
    const fileId = sub.files[0]!.fileId;
    const { uploadUrl: url } = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    ms.completeUpload(url, PDF_BYTES);
    const body = (await (await complete(sub, fileId)).json()) as { webUrl?: string };
    expect(body.webUrl).toMatch(/^https:\/\/contoso-my\.sharepoint\.com/);
  });

  it('never logs upload URLs, tokens, share tokens or submitted values', async () => {
    const { session, sub } = await startSubmission();
    const fileId = sub.files[0]!.fileId;
    const { uploadUrl: url } = (await (await uploadUrl(sub, fileId)).json()) as { uploadUrl: string };
    ms.completeUpload(url, PDF_BYTES);
    await complete(sub, fileId);
    const all = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain('sharepoint.com');
    expect(all).not.toContain(session.token);
    expect(all).not.toContain(sub.submissionSecret);
    expect(all).not.toContain('access-0');
    expect(all).not.toContain('Front');
    // And the share token is never part of any request URL: it lives in the fragment.
    expect(session.shareUrl).toMatch(/\/u\/#[A-Za-z0-9_-]{43}$/);
  });

  it('lists submissions for admins with search', async () => {
    const { sub } = await startSubmission();
    const res = await adminCall('GET', `/submissions?q=${sub.reference.toLowerCase()}`);
    const body = (await res.json()) as { total: number; submissions: { reference: string; fields: { key: string }[] }[] };
    expect(body.total).toBe(1);
    expect(body.submissions[0]!.reference).toBe(sub.reference);
    expect((await (await adminCall('GET', '/submissions?q=front')).json() as { total: number }).total).toBe(1);
    expect((await (await adminCall('GET', '/submissions?q=nomatch')).json() as { total: number }).total).toBe(0);
    expect((await (await adminCall('GET', '/submissions?q=%25')).json() as { total: number }).total).toBe(0);
  });
});
