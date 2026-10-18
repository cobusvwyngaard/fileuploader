// Reports uploaded files to the Google Sheets report. D1 is the source of
// truth; the sheet is a reporting copy that is brought up to date idempotently.
// (Internal names such as the `excel_pending` status and `excel_*` columns
// predate the move from Excel to Google Sheets and refer to this report step.)
//
//
// 1. A submission is claimed with a short lease (excel_lock_until) so only one
//    worker processes it at a time.
// 2. On any attempt after the first, existing stored_filename values are read
//    back from the table. Files already present (e.g. the previous attempt
//    timed out after Sheets had written the rows) are marked inserted instead of
//    being appended again.
// 3. Remaining rows are appended in one request, then D1 is updated.
// 4. Failures reschedule with capped exponential backoff; after
//    REPORT_MAX_ATTEMPTS the submission is marked failed for an admin retry.
import { REPORT_MAX_ATTEMPTS, reportRetryDelayMs } from '../backoff';
import { getSheetTarget } from '../db/sheetTarget';
import { fieldsOf, getSession } from '../db/sessions';
import type { FileRow, SubmissionRow } from '../db/submissions';
import type { Env } from '../env';
import { log } from '../log';
import { GoogleApiError, GoogleClient } from '../google/client';
import { SheetsService } from '../google/sheets';
import { NotConnectedError } from '../google/tokens';
import { transition } from '../state';
import { buildReportRows, validateReportMapping } from './mapping';

export const EXCEL_LEASE_MS = 2 * 60 * 1000;

export type ReportOutcome = 'complete' | 'retry_scheduled' | 'failed' | 'skipped';

export interface ReportSyncDeps {
  sheets?: Pick<SheetsService, 'resolveTitle' | 'readHeader' | 'readColumn' | 'appendRows'>;
  now?: () => number;
  random?: () => number;
}

class PermanentReportError extends Error {}

async function claim(env: Env, submissionId: string, nowMs: number): Promise<SubmissionRow | null> {
  return env.DB.prepare(
    `UPDATE submissions SET excel_lock_until = ?, excel_attempts = excel_attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'excel_pending' AND (excel_lock_until IS NULL OR excel_lock_until < ?)
      RETURNING *`,
  )
    .bind(nowMs + EXCEL_LEASE_MS, nowMs, submissionId, nowMs)
    .first<SubmissionRow>();
}

function describe(e: unknown): string {
  if (e instanceof GoogleApiError) return `google_${e.status}_${e.code}`;
  if (e instanceof NotConnectedError) return e.reason;
  if (e instanceof Error) return e.message.slice(0, 200);
  return 'unknown_error';
}

export async function processSubmissionReport(env: Env, submissionId: string, deps: ReportSyncDeps = {}): Promise<ReportOutcome> {
  const now = deps.now ?? Date.now;
  const claimed = await claim(env, submissionId, now());
  if (!claimed) return 'skipped';
  const attempt = claimed.excel_attempts;
  try {
    const session = await getSession(env, claimed.upload_session_id);
    if (!session) throw new PermanentReportError('session_missing');
    const files = (
      await env.DB.prepare("SELECT * FROM submission_files WHERE submission_id = ? AND status = 'uploaded' ORDER BY file_index")
        .bind(submissionId)
        .all<FileRow>()
    ).results;
    let pending = files.filter((f) => f.excel_status === 'pending');
    if (pending.length) {
      const target = await getSheetTarget(env);
      if (!target) throw new Error('report_sheet_not_configured');
      const sheets = deps.sheets ?? new SheetsService(new GoogleClient(env));
      const title = await sheets.resolveTitle(target.spreadsheet_id, target.sheet_id);
      if (!title) throw new Error('report_sheet_missing');
      const header = await sheets.readHeader(target.spreadsheet_id, title);
      const mapping = validateReportMapping(header, fieldsOf(session));
      if (!mapping.ok) throw new Error(`report_mapping_invalid: ${mapping.errors[0]}`);

      // excel_attempts only ever resets to 1 (admin retry), never 0, so any
      // attempt after the very first one checks for rows a previous attempt wrote.
      if (attempt > 1) {
        const storedIdx = header.findIndex((c) => c.trim().toLowerCase() === 'stored_filename');
        const existing = new Set(await sheets.readColumn(target.spreadsheet_id, title, storedIdx));
        const already = pending.filter((f) => existing.has(f.stored_filename));
        if (already.length) {
          await markInserted(env, already.map((f) => f.id), now());
          log.info({ event: 'report_duplicate_prevented', submissionId, count: already.length });
        }
        pending = pending.filter((f) => !existing.has(f.stored_filename));
      }

      if (pending.length) {
        const rows = buildReportRows(
          header,
          mapping,
          {
            reference: claimed.reference,
            uploadSessionId: session.id,
            sessionTitle: session.title,
            submittedAt: new Date(claimed.created_at),
            fieldValues: JSON.parse(claimed.field_values_json),
          },
          pending.map((f) => ({
            originalFilename: f.original_filename,
            storedFilename: f.stored_filename,
            sizeBytes: f.actual_size ?? f.declared_size,
            contentType: f.content_type ?? f.declared_content_type,
            folderPath: session.folder_path ?? '',
            webUrl: f.web_url ?? '',
          })),
          'complete',
        );
        await sheets.appendRows(target.spreadsheet_id, title, rows);
        await markInserted(env, pending.map((f) => f.id), now());
      }
    }
    const done = await transition(env.DB, submissionId, ['excel_pending'], 'complete', {
      completed_at: now(),
      excel_lock_until: null,
      excel_next_attempt_at: null,
      excel_last_error: null,
    }, now());
    if (done) log.info({ event: 'report_complete', submissionId, attempt });
    return done ? 'complete' : 'skipped';
  } catch (e) {
    const reason = describe(e);
    const permanent = e instanceof PermanentReportError;
    if (permanent || attempt >= REPORT_MAX_ATTEMPTS) {
      await transition(env.DB, submissionId, ['excel_pending'], 'failed', {
        failure_stage: 'excel',
        failure_reason: reason,
        excel_last_error: reason,
        excel_lock_until: null,
        excel_next_attempt_at: null,
      }, now());
      log.error({ event: 'report_failed', submissionId, attempt, reason });
      return 'failed';
    }
    const delay = reportRetryDelayMs(attempt, deps.random);
    await env.DB.prepare(
      `UPDATE submissions SET excel_last_error = ?, excel_next_attempt_at = ?, excel_lock_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'excel_pending'`,
    )
      .bind(reason, now() + delay, now(), submissionId)
      .run();
    log.warn({ event: 'report_retry_scheduled', submissionId, attempt, retryInMs: delay, reason });
    return 'retry_scheduled';
  }
}

async function markInserted(env: Env, fileIds: string[], nowMs: number): Promise<void> {
  if (!fileIds.length) return;
  await env.DB.batch(
    fileIds.map((id) =>
      env.DB.prepare("UPDATE submission_files SET excel_status = 'inserted', excel_inserted_at = ?, updated_at = ? WHERE id = ? AND excel_status = 'pending'").bind(
        nowMs,
        nowMs,
        id,
      ),
    ),
  );
}

/** Processes due submissions. Called by the cron trigger. */
export async function processDueReports(env: Env, limit = 10, deps: ReportSyncDeps = {}): Promise<Record<ReportOutcome, number>> {
  const nowMs = (deps.now ?? Date.now)();
  const due = await env.DB.prepare(
    `SELECT id FROM submissions WHERE status = 'excel_pending' AND (excel_next_attempt_at IS NULL OR excel_next_attempt_at <= ?)
       AND (excel_lock_until IS NULL OR excel_lock_until < ?) ORDER BY excel_next_attempt_at LIMIT ?`,
  )
    .bind(nowMs, nowMs, limit)
    .all<{ id: string }>();
  const counts: Record<ReportOutcome, number> = { complete: 0, retry_scheduled: 0, failed: 0, skipped: 0 };
  for (const { id } of due.results) {
    counts[await processSubmissionReport(env, id, deps)]++;
  }
  return counts;
}
