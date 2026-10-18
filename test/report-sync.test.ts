import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPORT_MAX_ATTEMPTS } from '../src/backoff';
import { processDueReports, processSubmissionReport } from '../src/report/sync';
import { runScheduled } from '../src/scheduled';
import { adminCall, call, createPublishedSession, FakeGoogle, PDF_BYTES, resetDb, seedConnection, withAccess } from './helpers';

let ms: FakeGoogle;

beforeEach(async () => {
  await resetDb();
  await seedConnection();
  ms = new FakeGoogle();
  vi.spyOn(globalThis, 'fetch').mockImplementation(withAccess(ms.handler) as typeof fetch);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** Uploads two files; returns the submission id. The report append may fail per the fake's settings. */
async function uploadedSubmission(afterPublish?: () => void) {
  const { token } = await createPublishedSession();
  afterPublish?.();
  const res = await call('POST', '/api/public/submissions', {
    body: { token, fields: { table_number: '3' }, files: [{ name: 'a.pdf', size: PDF_BYTES.length, type: '' }, { name: 'b.pdf', size: PDF_BYTES.length, type: '' }] },
  });
  const sub = (await res.json()) as { submissionId: string; submissionSecret: string; files: { fileId: string }[] };
  for (const f of sub.files) {
    const u = await call('POST', `/api/public/submissions/${sub.submissionId}/files/${f.fileId}/upload-url`, { body: { secret: sub.submissionSecret } });
    ms.completeUpload(((await u.json()) as { uploadUrl: string }).uploadUrl, PDF_BYTES);
    await call('POST', `/api/public/submissions/${sub.submissionId}/files/${f.fileId}/complete`, { body: { secret: sub.submissionSecret } });
  }
  return sub.submissionId;
}

const row = async (id: string) => (await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<Record<string, any>>())!;
const makeDue = (id: string) => env.DB.prepare('UPDATE submissions SET excel_next_attempt_at = 0 WHERE id = ?').bind(id).run();

describe('report-sheet retries', () => {
  it('marks excel_pending and schedules a backoff retry when Excel is unavailable', async () => {
    ms.appendFailures = 1;
    const id = await uploadedSubmission();
    const r = await row(id);
    expect(r.status).toBe('excel_pending');
    expect(r.excel_attempts).toBe(1);
    expect(r.excel_last_error).toBe('google_503_UNAVAILABLE');
    expect(r.excel_next_attempt_at).toBeGreaterThan(Date.now() + 30_000);
    expect(r.excel_lock_until).toBeNull();
    // Files stay uploaded and are not re-uploaded by retries.
    const uploadsBefore = ms.uploadSessions.size;

    // Not yet due: the scheduled job leaves it alone.
    expect(await processDueReports(env)).toMatchObject({ complete: 0 });
    await makeDue(id);
    expect(await processDueReports(env)).toMatchObject({ complete: 1 });
    expect((await row(id)).status).toBe('complete');
    expect(ms.rows).toHaveLength(2);
    expect(ms.uploadSessions.size).toBe(uploadsBefore);
  });

  it('does not duplicate rows when a previous attempt wrote them but the response was lost', async () => {
    ms.appendFailAfterWrite = 1;
    const id = await uploadedSubmission();
    expect((await row(id)).status).toBe('excel_pending');
    expect(ms.rows).toHaveLength(2); // written despite the error
    await makeDue(id);
    await processDueReports(env);
    expect((await row(id)).status).toBe('complete');
    expect(ms.rows).toHaveLength(2);
    expect(ms.appendCalls).toBe(1);
  });

  it('only inserts the rows that are missing after a partial write', async () => {
    ms.appendFailures = 1;
    const id = await uploadedSubmission();
    const files = (await env.DB.prepare('SELECT stored_filename FROM submission_files WHERE submission_id = ? ORDER BY file_index').bind(id).all<{ stored_filename: string }>()).results;
    // Simulate a row for the first file already being present in the table.
    const storedIdx = ms.header.indexOf('stored_filename');
    const existing: (string | number)[] = ms.header.map(() => '');
    existing[storedIdx] = files[0]!.stored_filename;
    ms.rows.push(existing);
    await makeDue(id);
    await processDueReports(env);
    expect(ms.rows).toHaveLength(2);
    expect(ms.rows[1]![storedIdx]).toBe(files[1]!.stored_filename);
  });

  it('holds a lease so concurrent processors do not both insert', async () => {
    ms.appendFailures = 1;
    const id = await uploadedSubmission();
    await makeDue(id);
    const results = await Promise.all([processSubmissionReport(env, id), processSubmissionReport(env, id), processSubmissionReport(env, id)]);
    expect(results.filter((r) => r === 'complete')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(2);
    expect(ms.rows).toHaveLength(2);
  });

  it('fails after the maximum attempts and can be retried by an admin', async () => {
    ms.appendFailures = 1000;
    const id = await uploadedSubmission();
    for (let i = 1; i < REPORT_MAX_ATTEMPTS; i++) {
      await makeDue(id);
      await processDueReports(env);
    }
    const failed = await row(id);
    expect(failed.status).toBe('failed');
    expect(failed.failure_stage).toBe('excel');
    expect(failed.excel_attempts).toBe(REPORT_MAX_ATTEMPTS);

    ms.appendFailures = 0;
    const res = await adminCall('POST', `/submissions/${id}/retry-report`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'complete' });
    expect((await row(id)).status).toBe('complete');
    expect(ms.rows).toHaveLength(2);

    // Completed submissions are not retryable.
    expect((await adminCall('POST', `/submissions/${id}/retry-report`, {})).status).toBe(409);
  });

  it('keeps retrying (not failing) when the table loses a mapped column, until fixed', async () => {
    const id = await uploadedSubmission(() => {
      ms.header = ms.header.filter((c) => c !== 'table_number');
    });
    const r = await row(id);
    expect(r.status).toBe('excel_pending');
    expect(r.excel_last_error).toMatch(/report_mapping_invalid/);
    ms.header.push('table_number');
    await makeDue(id);
    await processDueReports(env);
    expect((await row(id)).status).toBe('complete');
  });

  it('does not let admins retry upload failures as report failures', async () => {
    const { token } = await createPublishedSession();
    const res = await call('POST', '/api/public/submissions', { body: { token, fields: { table_number: '1' }, files: [{ name: 'a.pdf', size: 5, type: '' }] } });
    const { submissionId } = (await res.json()) as { submissionId: string };
    await env.DB.prepare('UPDATE submissions SET upload_deadline = 0 WHERE id = ?').bind(submissionId).run();
    await runScheduled(env);
    const r = await row(submissionId);
    expect(r.status).toBe('failed');
    expect(r.failure_stage).toBe('upload');
    expect((await adminCall('POST', `/submissions/${submissionId}/retry-report`, {})).status).toBe(409);
  });

  it('releases the slot of abandoned uploads', async () => {
    const { id, token } = await createPublishedSession({ maxSubmissions: 1 });
    const res = await call('POST', '/api/public/submissions', { body: { token, fields: { table_number: '1' }, files: [{ name: 'a.pdf', size: 5, type: '' }] } });
    const { submissionId } = (await res.json()) as { submissionId: string };
    expect((await call('POST', '/api/public/session', { body: { token } })).status).toBe(410);
    await env.DB.prepare('UPDATE submissions SET upload_deadline = 0 WHERE id = ?').bind(submissionId).run();
    await runScheduled(env);
    await runScheduled(env); // idempotent
    const s = await env.DB.prepare('SELECT submission_count FROM upload_sessions WHERE id = ?').bind(id).first<{ submission_count: number }>();
    expect(s?.submission_count).toBe(0);
    expect((await call('POST', '/api/public/session', { body: { token } })).status).toBe(200);
  });
});
