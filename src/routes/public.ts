// Public (unauthenticated) API used by the upload page. Every endpoint is a
// JSON POST so share tokens and submission secrets travel in request bodies,
// never in URLs that could be logged.
import { Hono, type Context } from 'hono';
import { SUBMISSION_UPLOAD_WINDOW_MS, UPLOAD_CHUNK_SIZE } from '../../shared/constants';
import { buildStoredFilename, cleanOriginalFilename, getExtension, joinDrivePath } from '../../shared/filenames';
import type {
  CompleteFileResponse,
  CreateSubmissionResponse,
  PublicSessionView,
  SubmissionStatusResponse,
  UploadUrlResponse,
} from '../../shared/types';
import { validateDeclaredFiles, validateFieldValues } from '../../shared/validation';
import { randomReference, randomToken, sha256Hex, timingSafeEqual } from '../crypto';
import { auditStatement } from '../db/audit';
import {
  effectiveState,
  fieldsOf,
  fileRulesOf,
  findSessionByToken,
  getSession,
  releaseSubmissionSlot,
  reserveSubmissionSlot,
  type SessionRow,
} from '../db/sessions';
import { getFile, getFiles, getSubmission, type FileRow, type SubmissionRow } from '../db/submissions';
import { ApiError, badRequest } from '../errors';
import { processSubmissionExcel } from '../excel/sync';
import { readJson, type AppEnv } from '../http';
import { log } from '../log';
import { checkContent, detectMime } from '../magic';
import { DriveService } from '../microsoft/drive';
import { GraphClient } from '../microsoft/graph';
import { getConnection, NotConnectedError } from '../microsoft/tokens';
import { rateLimit } from '../ratelimit';
import { transitionStatement } from '../state';

const MAX_UPLOAD_SESSIONS_PER_FILE = 20;

export const STATE_ERRORS: Record<string, ApiError> = {
  invalid: new ApiError(404, 'invalid_link', 'This upload link is not valid. Check that you have the complete link.'),
  draft: new ApiError(403, 'not_published', 'This upload link is not accepting files yet.'),
  unpublished: new ApiError(403, 'not_published', 'This upload link is not currently accepting files.'),
  closed: new ApiError(410, 'closed', 'This upload link has been closed and no longer accepts files.'),
  expired: new ApiError(410, 'expired', 'This upload link has expired and no longer accepts files.'),
  exhausted: new ApiError(410, 'exhausted', 'This upload link has reached its maximum number of submissions.'),
};

async function loadOpenSession(c: Context<AppEnv>, token: unknown): Promise<SessionRow> {
  const row = typeof token === 'string' ? await findSessionByToken(c.env, token) : null;
  if (!row) throw STATE_ERRORS.invalid!;
  const state = effectiveState(row, Date.now());
  if (state !== 'open') throw STATE_ERRORS[state]!;
  return row;
}

export function publicView(row: SessionRow): PublicSessionView {
  return {
    title: row.title,
    instructions: row.instructions,
    fields: fieldsOf(row).map(({ excelColumn: _omit, ...f }) => f),
    fileRules: fileRulesOf(row),
    expiresAt: new Date(row.expires_at!).toISOString(),
  };
}

async function authorise(c: Context<AppEnv>, body: { secret?: unknown }): Promise<SubmissionRow> {
  const id = c.req.param('id') ?? '';
  const generic = new ApiError(404, 'submission_not_found', 'This submission could not be found.');
  if (!/^[0-9a-f-]{36}$/.test(id) || typeof body.secret !== 'string' || body.secret.length > 100) throw generic;
  const sub = await getSubmission(c.env, id);
  if (!sub || !timingSafeEqual(await sha256Hex(body.secret), sub.secret_hash)) throw generic;
  return sub;
}

async function authoriseFile(c: Context<AppEnv>, body: { secret?: unknown }): Promise<{ sub: SubmissionRow; file: FileRow; session: SessionRow }> {
  const sub = await authorise(c, body);
  const file = await getFile(c.env, sub.id, c.req.param('fileId') ?? '');
  if (!file) throw new ApiError(404, 'file_not_found', 'This file is not part of the submission.');
  const session = await getSession(c.env, sub.upload_session_id);
  if (!session?.folder_drive_id || !session.folder_item_id) throw new ApiError(409, 'session_misconfigured', 'This upload link is not configured correctly.');
  return { sub, file, session };
}

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.post('/session', rateLimit('PUBLIC_RATE_LIMITER', 'public_session'), async (c) => {
  const body = await readJson<{ token?: unknown }>(c, 4096);
  const row = await loadOpenSession(c, body.token);
  return c.json(publicView(row));
});

publicRoutes.post('/submissions', rateLimit('SUBMIT_RATE_LIMITER', 'create_submission'), async (c) => {
  const body = await readJson<{ token?: unknown; fields?: unknown; files?: unknown }>(c);
  const session = await loadOpenSession(c, body.token);
  const fields = fieldsOf(session);
  const rules = fileRulesOf(session);

  const fv = validateFieldValues(fields, body.fields);
  const df = validateDeclaredFiles(rules, body.files);
  if (Object.keys(fv.errors).length || df.errors.length) {
    throw new ApiError(422, 'validation_failed', df.errors[0] ?? 'Please correct the highlighted fields.', {
      ...fv.errors,
      ...(df.errors.length ? { _files: df.errors.join(' ') } : {}),
    });
  }

  // Fail fast rather than reserve a slot that cannot be uploaded to.
  const conn = await getConnection(c.env);
  if (conn?.status !== 'connected') throw new NotConnectedError(conn?.status === 'needs_reauth' ? 'needs_reauth' : 'not_connected');

  const now = Date.now();
  if (!(await reserveSubmissionSlot(c.env, session.id, now))) {
    const fresh = await getSession(c.env, session.id);
    throw STATE_ERRORS[fresh ? effectiveState(fresh, now) : 'invalid'] ?? STATE_ERRORS.exhausted!;
  }

  const id = crypto.randomUUID();
  const secret = randomToken(32);
  const secretHash = await sha256Hex(secret);
  const deadline = now + SUBMISSION_UPLOAD_WINDOW_MS;
  const createdAt = new Date(now);

  for (let attempt = 0; ; attempt++) {
    const reference = randomReference();
    const files = df.files.map((f, index) => ({
      id: crypto.randomUUID(),
      index,
      originalName: cleanOriginalFilename(f.name),
      storedName: buildStoredFilename({ originalName: f.name, reference, index, createdAt }),
      size: f.size,
      type: f.type,
    }));
    const searchText = [reference, ...files.map((f) => f.originalName), ...Object.values(fv.values).map(String)].join(' ').toLowerCase();
    const db = c.env.DB;
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO submissions (id, reference, upload_session_id, status, secret_hash, field_values_json, search_text, upload_deadline, created_at, updated_at)
           VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
        ).bind(id, reference, session.id, secretHash, JSON.stringify(fv.values), searchText, deadline, now, now),
        ...files.map((f) =>
          db.prepare(
            `INSERT INTO submission_files (id, submission_id, file_index, original_filename, stored_filename, declared_size, declared_content_type, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          ).bind(f.id, id, f.index, f.originalName, f.storedName, f.size, f.type, now, now),
        ),
        auditStatement(c.env, 'public', 'submission.created', { type: 'submission', id }, { sessionId: session.id, files: files.length }),
      ]);
      log.info({ event: 'submission_created', submissionId: id, sessionId: session.id, count: files.length });
      const res: CreateSubmissionResponse = {
        submissionId: id,
        reference,
        submissionSecret: secret,
        uploadDeadline: new Date(deadline).toISOString(),
        chunkSize: UPLOAD_CHUNK_SIZE,
        files: files.map((f) => ({ fileId: f.id, index: f.index, originalName: f.originalName, size: f.size })),
      };
      return c.json(res, 201);
    } catch (e) {
      const collision = e instanceof Error && /UNIQUE/i.test(e.message) && attempt < 3;
      if (!collision) {
        await releaseSubmissionSlot(c.env, session.id);
        throw e;
      }
    }
  }
});

publicRoutes.post('/submissions/:id/files/:fileId/upload-url', rateLimit('PUBLIC_RATE_LIMITER', 'upload_url'), async (c) => {
  const body = await readJson<{ secret?: unknown }>(c, 4096);
  const { sub, file, session } = await authoriseFile(c, body);
  if (file.status === 'uploaded') return c.json<UploadUrlResponse>({ alreadyUploaded: true });
  if (sub.status !== 'created' && sub.status !== 'uploading') {
    throw new ApiError(409, 'submission_closed', 'This submission is no longer accepting uploads.');
  }
  const now = Date.now();
  if (now > sub.upload_deadline) throw new ApiError(410, 'upload_window_closed', 'The time allowed to finish this upload has passed. Please start a new submission.');
  if (file.upload_attempts >= MAX_UPLOAD_SESSIONS_PER_FILE) throw new ApiError(429, 'too_many_attempts', 'This file has been restarted too many times. Please start a new submission.');

  const drive = new DriveService(new GraphClient(c.env));
  // A previous attempt may have finished even though the browser never heard back.
  const existing = await drive.getChildByName(session.folder_drive_id!, session.folder_item_id!, file.stored_filename);
  if (existing?.file) return c.json<UploadUrlResponse>({ alreadyUploaded: true });

  const us = await drive.createUploadSession(session.folder_drive_id!, session.folder_item_id!, file.stored_filename);
  const expires = Date.parse(us.expirationDateTime);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE submission_files SET status = 'uploading', failure_reason = NULL, upload_attempts = upload_attempts + 1,
         upload_session_expires_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'uploading', 'failed')`,
    ).bind(Number.isFinite(expires) ? expires : null, now, file.id),
    transitionStatement(c.env.DB, sub.id, ['created'], 'uploading', {}, now),
  ]);
  log.info({ event: 'upload_session_created', submissionId: sub.id, fileId: file.id, attempt: file.upload_attempts + 1 });
  c.header('Cache-Control', 'no-store');
  return c.json<UploadUrlResponse>({ alreadyUploaded: false, uploadUrl: us.uploadUrl, expiresAt: us.expirationDateTime });
});

publicRoutes.post('/submissions/:id/files/:fileId/complete', rateLimit('PUBLIC_RATE_LIMITER', 'complete_file'), async (c) => {
  const body = await readJson<{ secret?: unknown }>(c, 4096);
  const { sub, file, session } = await authoriseFile(c, body);
  const showLinks = session.show_onedrive_links === 1;
  if (file.status === 'uploaded') {
    const latest = (await getSubmission(c.env, sub.id))!;
    return c.json<CompleteFileResponse>({ fileStatus: 'uploaded', submissionStatus: latest.status, ...(showLinks && file.web_url ? { webUrl: file.web_url } : {}) });
  }
  if (sub.status !== 'created' && sub.status !== 'uploading') {
    throw new ApiError(409, 'submission_closed', 'This submission is no longer accepting uploads.');
  }

  const drive = new DriveService(new GraphClient(c.env));
  const driveId = session.folder_drive_id!;
  const folderId = session.folder_item_id!;
  const item = await drive.getChildByName(driveId, folderId, file.stored_filename);
  if (!item?.file) throw new ApiError(409, 'upload_incomplete', 'The upload has not finished yet.');

  const rules = fileRulesOf(session);
  const ext = getExtension(file.stored_filename);
  let rejection: string | null = null;
  if (item.parentReference?.id && item.parentReference.id !== folderId) rejection = 'wrong_folder';
  else if (item.size !== file.declared_size) rejection = 'size_mismatch';
  else if ((item.size ?? 0) > rules.maxFileSizeBytes) rejection = 'too_large';
  let contentCheck = 'unchecked';
  let detected: string | null = null;
  if (!rejection) {
    const header = await drive.readHeader(driveId, item.id);
    if (header) {
      contentCheck = checkContent(ext, header);
      detected = detectMime(header);
      if (contentCheck === 'mismatch') rejection = 'content_mismatch';
    }
  }

  const now = Date.now();
  if (rejection) {
    await drive.deleteItem(driveId, item.id);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE submission_files SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").bind(rejection, now, file.id),
      auditStatement(c.env, 'public', 'file.rejected', { type: 'submission', id: sub.id }, { fileId: file.id, reason: rejection }),
    ]);
    log.warn({ event: 'file_rejected', submissionId: sub.id, fileId: file.id, reason: rejection });
    throw new ApiError(
      422,
      'file_rejected',
      rejection === 'content_mismatch'
        ? `The contents of "${file.original_filename}" do not match a .${ext} file.`
        : `"${file.original_filename}" did not match the file that was declared. Please try again.`,
    );
  }

  const db = c.env.DB;
  const contentType = item.file.mimeType || detected || file.declared_content_type || 'application/octet-stream';
  await db
    .prepare(
      `UPDATE submission_files SET status = 'uploaded', drive_item_id = ?, onedrive_path = ?, web_url = ?, actual_size = ?,
         content_type = ?, content_check = ?, failure_reason = NULL, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'uploading', 'failed')`,
    )
    .bind(item.id, joinDrivePath(session.folder_path ?? '', item.name), item.webUrl ?? null, item.size ?? null, contentType, contentCheck, now, file.id)
    .run();

  const remaining = await db
    .prepare("SELECT COUNT(*) AS n FROM submission_files WHERE submission_id = ? AND status != 'uploaded'")
    .bind(sub.id)
    .first<{ n: number }>();
  if (remaining?.n === 0) {
    // All files verified: uploaded -> excel_pending in one transaction.
    const [, moved] = await db.batch([
      // 'created' only remains if every file was found already uploaded; step through 'uploading'.
      transitionStatement(db, sub.id, ['created'], 'uploading', {}, now),
      transitionStatement(db, sub.id, ['uploading'], 'uploaded', { uploaded_at: now }, now),
      transitionStatement(db, sub.id, ['uploaded'], 'excel_pending', { excel_next_attempt_at: now }, now),
    ]);
    // Concurrent completions of the last file all reach here; only the request
    // that performed the transition records it and starts the Excel update.
    if (moved?.meta.changes === 1) {
      await auditStatement(c.env, 'public', 'submission.uploaded', { type: 'submission', id: sub.id }, { sessionId: session.id }).run();
      c.executionCtx.waitUntil(
        processSubmissionExcel(c.env, sub.id).catch((e) => log.error({ event: 'excel_inline_error', submissionId: sub.id, reason: e instanceof Error ? e.message : 'unknown' })),
      );
    }
  }
  log.info({ event: 'file_uploaded', submissionId: sub.id, fileId: file.id });
  const latest = (await getSubmission(c.env, sub.id))!;
  return c.json<CompleteFileResponse>({
    fileStatus: 'uploaded',
    submissionStatus: latest.status,
    ...(showLinks && item.webUrl ? { webUrl: item.webUrl } : {}),
  });
});

publicRoutes.post('/submissions/:id/status', rateLimit('PUBLIC_RATE_LIMITER', 'submission_status'), async (c) => {
  const body = await readJson<{ secret?: unknown }>(c, 4096);
  const sub = await authorise(c, body);
  const session = await getSession(c.env, sub.upload_session_id);
  const showLinks = session?.show_onedrive_links === 1;
  const files = await getFiles(c.env, sub.id);
  return c.json<SubmissionStatusResponse>({
    reference: sub.reference,
    status: sub.status,
    uploadDeadline: new Date(sub.upload_deadline).toISOString(),
    files: files.map((f) => ({
      fileId: f.id,
      index: f.file_index,
      originalName: f.original_filename,
      size: f.declared_size,
      status: f.status,
      ...(showLinks && f.web_url ? { webUrl: f.web_url } : {}),
    })),
  });
});

publicRoutes.all('*', () => {
  throw badRequest('Unknown endpoint.');
});
