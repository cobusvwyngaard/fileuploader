import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { canTransition, predecessorsOf, transition, transitionStatement } from '../src/state';
import { excelRetryDelayMs, EXCEL_RETRY_CAP_MS } from '../src/backoff';
import { resetDb } from './helpers';

async function insertSubmission(id: string, status: string) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_sessions (id, title, status, share_token_hash, share_token_enc, file_rules_json, fields_json, created_by, created_at, updated_at)
     VALUES ('s1', 'S', 'published', 'h', 'e', '{}', '[]', 'a', ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO submissions (id, reference, upload_session_id, status, secret_hash, field_values_json, upload_deadline, created_at, updated_at)
     VALUES (?, ?, 's1', ?, 'x', '{}', ?, ?, ?)`,
  )
    .bind(id, id.slice(0, 9), status, now + 1000, now, now)
    .run();
}

describe('submission state machine', () => {
  beforeEach(resetDb);

  it('defines the expected lifecycle', () => {
    expect(canTransition('created', 'uploading')).toBe(true);
    expect(canTransition('uploading', 'uploaded')).toBe(true);
    expect(canTransition('uploaded', 'excel_pending')).toBe(true);
    expect(canTransition('excel_pending', 'complete')).toBe(true);
    expect(canTransition('failed', 'excel_pending')).toBe(true);
    expect(canTransition('complete', 'excel_pending')).toBe(false);
    expect(canTransition('created', 'complete')).toBe(false);
    expect(canTransition('uploading', 'excel_pending')).toBe(false);
    expect(predecessorsOf('failed').sort()).toEqual(['created', 'excel_pending', 'uploaded', 'uploading']);
  });

  it('refuses to build illegal transitions', () => {
    expect(() => transitionStatement(env.DB, 'x', ['complete'], 'excel_pending')).toThrow(/Illegal/);
  });

  it('only updates rows that are in an allowed predecessor state', async () => {
    await insertSubmission('sub-a', 'uploading');
    expect(await transition(env.DB, 'sub-a', ['created'], 'uploading')).toBe(false);
    expect(await transition(env.DB, 'sub-a', ['uploading'], 'uploaded', { uploaded_at: 5 })).toBe(true);
    // A second, concurrent request performing the same transition is a no-op.
    expect(await transition(env.DB, 'sub-a', ['uploading'], 'uploaded')).toBe(false);
    const row = await env.DB.prepare('SELECT status, uploaded_at FROM submissions WHERE id = ?').bind('sub-a').first();
    expect(row).toEqual({ status: 'uploaded', uploaded_at: 5 });
  });

  it('enforces valid statuses at the database level', async () => {
    await insertSubmission('sub-b', 'created');
    await expect(env.DB.prepare("UPDATE submissions SET status = 'bogus' WHERE id = 'sub-b'").run()).rejects.toThrow();
  });
});

describe('Excel retry backoff', () => {
  it('grows exponentially and is capped', () => {
    const mid = () => 0.5; // no jitter
    expect(excelRetryDelayMs(1, mid)).toBe(60_000);
    expect(excelRetryDelayMs(2, mid)).toBe(120_000);
    expect(excelRetryDelayMs(5, mid)).toBe(960_000);
    expect(excelRetryDelayMs(30, mid)).toBe(EXCEL_RETRY_CAP_MS);
    expect(excelRetryDelayMs(30, () => 1)).toBeLessThanOrEqual(EXCEL_RETRY_CAP_MS);
    expect(excelRetryDelayMs(1, () => 0)).toBe(48_000);
  });
});
