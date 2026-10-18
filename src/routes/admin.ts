// Administrator API. Mounted behind requireAdmin() (Cloudflare Access JWT).
import { Hono, type Context } from 'hono';
import QRCode from 'qrcode';
import { STANDARD_REPORT_COLUMNS } from '../../shared/constants';
import type { AdminSession, SessionConfigInput, SubmissionStatus } from '../../shared/types';
import { SUBMISSION_STATUSES } from '../../shared/types';
import { validateSessionConfig } from '../../shared/validation';
import { base64UrlEncode, randomToken, sha256Hex } from '../crypto';
import { audit, auditStatement } from '../db/audit';
import {
  configColumns,
  configOf,
  getSession,
  newShareToken,
  shareUrlFor,
  toAdminSession,
  type SessionRow,
} from '../db/sessions';
import { getSheetTarget } from '../db/sheetTarget';
import { getSubmission, type FileRow, type SubmissionRow } from '../db/submissions';
import { ApiError, badRequest, notFound } from '../errors';
import { GoogleClient } from '../google/client';
import { DriveService, FOLDER_MIME, folderPaths, SPREADSHEET_MIME } from '../google/drive';
import { buildAuthorizeUrl, exchangeCode, OAuthError } from '../google/oauth';
import { SheetsService } from '../google/sheets';
import { disconnect, getConnection, NotConnectedError, storeNewConnection } from '../google/tokens';
import { readJson, type AppEnv } from '../http';
import { log } from '../log';
import { validateReportMapping, type MappingResult } from '../report/mapping';
import { processSubmissionReport } from '../report/sync';
import { transition } from '../state';

export const adminRoutes = new Hono<AppEnv>();

const admin = (c: Context<AppEnv>) => c.get('adminEmail');
const googleFor = (c: Context<AppEnv>) => new GoogleClient(c.env);
const ID = /^[0-9a-f-]{36}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;

async function loadSession(c: Context<AppEnv>): Promise<SessionRow> {
  const id = c.req.param('id') ?? '';
  const row = ID.test(id) ? await getSession(c.env, id) : null;
  if (!row) throw notFound('Upload session not found.');
  return row;
}

async function requireConnected(c: Context<AppEnv>) {
  const conn = await getConnection(c.env);
  if (conn?.status !== 'connected') throw new NotConnectedError(conn?.status === 'needs_reauth' ? 'needs_reauth' : 'not_connected');
  return conn;
}

// ---------------------------------------------------------------- identity

adminRoutes.get('/me', (c) => c.json({ email: admin(c), environment: c.env.ENVIRONMENT }));

// ---------------------------------------------------------- Google connection

adminRoutes.get('/google/status', async (c) => {
  const conn = await getConnection(c.env);
  const target = await getSheetTarget(c.env);
  const counts = await c.env.DB.prepare(
    `SELECT SUM(status = 'excel_pending') AS pending, SUM(status = 'failed' AND failure_stage = 'excel') AS failed FROM submissions`,
  ).first<{ pending: number | null; failed: number | null }>();
  return c.json({
    connection: conn
      ? {
          status: conn.status,
          email: conn.email,
          connectedBy: conn.connected_by,
          connectedAt: conn.connected_at ? new Date(conn.connected_at).toISOString() : null,
          lastRefreshedAt: conn.last_refreshed_at ? new Date(conn.last_refreshed_at).toISOString() : null,
          lastError: conn.last_error,
        }
      : { status: 'disconnected' },
    reportSheet: target
      ? {
          spreadsheetId: target.spreadsheet_id,
          spreadsheetName: target.spreadsheet_name,
          spreadsheetUrl: target.spreadsheet_url,
          sheetId: target.sheet_id,
          sheetTitle: target.sheet_title,
          columns: JSON.parse(target.columns_json) as string[],
          updatedAt: new Date(target.updated_at).toISOString(),
        }
      : null,
    reportPending: counts?.pending ?? 0,
    reportFailed: counts?.failed ?? 0,
    configured: {
      google: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
      encryptionKey: !!c.env.TOKEN_ENCRYPTION_KEY,
    },
  });
});

adminRoutes.get('/google/connect', async (c) => {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(now),
    c.env.DB.prepare('INSERT INTO oauth_states (state_hash, code_verifier, admin_email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(
      await sha256Hex(state),
      verifier,
      admin(c),
      now,
      now + 10 * 60 * 1000,
    ),
  ]);
  return c.redirect(buildAuthorizeUrl(c.env, state, challenge), 302);
});

adminRoutes.get('/google/callback', async (c) => {
  const done = (result: string) => c.redirect(`/admin/settings?google=${encodeURIComponent(result)}`, 302);
  const url = new URL(c.req.url);
  const error = url.searchParams.get('error');
  if (error) {
    log.warn({ event: 'google_consent_error', code: error.slice(0, 60) });
    return done(error === 'access_denied' ? 'access_denied' : 'google_error');
  }
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  if (!state || !code) return done('invalid_callback');
  const row = await c.env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING *')
    .bind(await sha256Hex(state))
    .first<{ code_verifier: string; admin_email: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now() || row.admin_email !== admin(c)) return done('invalid_state');

  try {
    const tokens = await exchangeCode(c.env, code, row.code_verifier);
    const granted = (tokens.scope ?? '').split(' ');
    if (!granted.includes('https://www.googleapis.com/auth/drive.file')) return done('drive_scope_missing');
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!res.ok) return done('google_error');
    const me = (await res.json()) as { sub: string; email?: string };
    await storeNewConnection(c.env, tokens, { sub: me.sub, email: me.email ?? '' }, admin(c));
    await audit(c.env, admin(c), 'google.connected', { type: 'google_connection', id: 'primary' }, { email: me.email ?? '' });
    return done('connected');
  } catch (e) {
    log.error({ event: 'google_connect_failed', code: e instanceof OAuthError ? e.code : e instanceof Error ? e.message : 'unknown' });
    return done(e instanceof OAuthError ? e.code : 'connect_failed');
  }
});

adminRoutes.post('/google/disconnect', async (c) => {
  const { revoked } = await disconnect(c.env);
  await audit(c.env, admin(c), 'google.disconnected', { type: 'google_connection', id: 'primary' }, { revoked });
  return c.json({ ok: true, revoked });
});

// ---------------------------------------------------------------- Drive folders

/** Folders the app created (drive.file scope), with display paths. */
adminRoutes.get('/drive/folders', async (c) => {
  await requireConnected(c);
  const folders = await new DriveService(googleFor(c)).listByMime(FOLDER_MIME);
  const paths = folderPaths(folders);
  return c.json({
    folders: folders
      .map((f) => ({ id: f.id, name: f.name, path: paths.get(f.id) ?? `/${f.name}`, webUrl: f.webViewLink }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
});

adminRoutes.post('/drive/folders', async (c) => {
  await requireConnected(c);
  const body = await readJson<{ name?: unknown; parentId?: unknown }>(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name)) throw badRequest('Enter a folder name (max 120 characters).');
  const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : undefined;
  if (parentId && !DRIVE_ID.test(parentId)) throw badRequest('Invalid parent folder.');
  const drive = new DriveService(googleFor(c));
  const folder = await drive.createFolder(name, parentId);
  const all = await drive.listByMime(FOLDER_MIME);
  const path = folderPaths(all.some((f) => f.id === folder.id) ? all : [...all, folder]).get(folder.id) ?? `/${name}`;
  await audit(c.env, admin(c), 'drive.folder_created', { type: 'drive_folder', id: folder.id });
  return c.json({ folder: { id: folder.id, name: folder.name, path, webUrl: folder.webViewLink } }, 201);
});

// ---------------------------------------------------------------- report sheet

adminRoutes.get('/sheets/spreadsheets', async (c) => {
  await requireConnected(c);
  const files = await new DriveService(googleFor(c)).listByMime(SPREADSHEET_MIME);
  return c.json({ spreadsheets: files.map((f) => ({ id: f.id, name: f.name, webUrl: f.webViewLink })) });
});

adminRoutes.get('/sheets/tabs', async (c) => {
  await requireConnected(c);
  const id = c.req.query('spreadsheetId') ?? '';
  if (!DRIVE_ID.test(id)) throw badRequest('Invalid spreadsheet.');
  const sheets = new SheetsService(googleFor(c));
  const info = await sheets.getSpreadsheet(id);
  if (!info) throw notFound('Spreadsheet not found.');
  const tabs = await Promise.all(
    info.sheets.map(async (s) => {
      const header = await sheets.readHeader(id, s.properties.title);
      const m = validateReportMapping(header, []);
      return { sheetId: s.properties.sheetId, title: s.properties.title, header, missing: m.missing };
    }),
  );
  return c.json({ spreadsheet: { id, name: info.properties.title, url: info.spreadsheetUrl }, tabs });
});

/** Creates a new report spreadsheet with all standard columns (and optional extra field columns). */
adminRoutes.post('/sheets/create', async (c) => {
  await requireConnected(c);
  const body = await readJson<{ name?: unknown; extraColumns?: unknown }>(c);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'Upload sessions report';
  const extra = Array.isArray(body.extraColumns) ? body.extraColumns.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_ ]{1,60}$/.test(x)).slice(0, 30) : [];
  const headers = [...STANDARD_REPORT_COLUMNS, ...extra.filter((x) => !(STANDARD_REPORT_COLUMNS as readonly string[]).includes(x))];
  const info = await new SheetsService(googleFor(c)).createSpreadsheet(name, 'Uploads', headers);
  await audit(c.env, admin(c), 'sheets.created', { type: 'spreadsheet', id: info.spreadsheetId });
  return c.json({ spreadsheet: { id: info.spreadsheetId, name: info.properties.title, url: info.spreadsheetUrl } }, 201);
});

adminRoutes.put('/sheets/target', async (c) => {
  await requireConnected(c);
  const body = await readJson<{ spreadsheetId?: unknown; sheetId?: unknown }>(c);
  if (typeof body.spreadsheetId !== 'string' || !DRIVE_ID.test(body.spreadsheetId) || typeof body.sheetId !== 'number') throw badRequest('Choose a spreadsheet and tab.');
  const sheets = new SheetsService(googleFor(c));
  const info = await sheets.getSpreadsheet(body.spreadsheetId);
  const tab = info?.sheets.find((s) => s.properties.sheetId === body.sheetId);
  if (!info || !tab) throw badRequest('That spreadsheet tab does not exist.');
  const header = await sheets.readHeader(info.spreadsheetId, tab.properties.title);
  const mapping = validateReportMapping(header, []);
  if (!mapping.ok) throw new ApiError(422, 'report_columns_missing', mapping.errors.join(' '));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sheet_target (id, spreadsheet_id, spreadsheet_name, spreadsheet_url, sheet_id, sheet_title, columns_json, updated_by, updated_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET spreadsheet_id = excluded.spreadsheet_id, spreadsheet_name = excluded.spreadsheet_name,
         spreadsheet_url = excluded.spreadsheet_url, sheet_id = excluded.sheet_id, sheet_title = excluded.sheet_title,
         columns_json = excluded.columns_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(info.spreadsheetId, info.properties.title, info.spreadsheetUrl, tab.properties.sheetId, tab.properties.title, JSON.stringify(header), admin(c), now),
    auditStatement(c.env, admin(c), 'sheets.target_set', { type: 'spreadsheet', id: info.spreadsheetId }, { tab: tab.properties.title }),
  ]);
  return c.json({ ok: true, columns: header });
});

/** Live header of the configured report tab. */
async function reportHeader(c: Context<AppEnv>): Promise<{ header: string[]; title: string; spreadsheetId: string } | null> {
  const target = await getSheetTarget(c.env);
  if (!target) return null;
  const sheets = new SheetsService(googleFor(c));
  const title = await sheets.resolveTitle(target.spreadsheet_id, target.sheet_id);
  if (!title) return null;
  return { header: await sheets.readHeader(target.spreadsheet_id, title), title, spreadsheetId: target.spreadsheet_id };
}

/** Checks a session's fields against the live report sheet. */
async function checkReportMapping(c: Context<AppEnv>, cfg: SessionConfigInput): Promise<MappingResult> {
  const live = await reportHeader(c);
  if (!live) return { ok: false, errors: ['Choose a report spreadsheet in Settings first.'], missing: [], fieldColumns: {} };
  return validateReportMapping(live.header, cfg.fields);
}

/** Full readiness check before a session may accept uploads. */
async function publishErrors(c: Context<AppEnv>, cfg: SessionConfigInput): Promise<string[]> {
  const v = validateSessionConfig(cfg, { forPublish: true, now: new Date() });
  if (v.errors.length) return v.errors;
  const conn = await getConnection(c.env);
  if (conn?.status !== 'connected') return ['Connect a Google account in Settings first.'];
  const folder = await new DriveService(googleFor(c)).getFile(cfg.folder!.id);
  if (!folder || folder.mimeType !== FOLDER_MIME || folder.trashed) return ['The destination folder no longer exists or is not accessible. Choose it again.'];
  return (await checkReportMapping(c, cfg)).errors;
}

// ---------------------------------------------------------------- sessions

adminRoutes.get('/sessions', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM upload_sessions ORDER BY created_at DESC LIMIT 500').all<SessionRow>()).results;
  const now = Date.now();
  const sessions: AdminSession[] = await Promise.all(rows.map((r) => toAdminSession(c.env, r, now)));
  return c.json({ sessions });
});

adminRoutes.post('/sessions', async (c) => {
  const v = validateSessionConfig(await readJson(c), { forPublish: false, now: new Date() });
  if (!v.value) throw new ApiError(422, 'validation_failed', v.errors.join(' '));
  const id = crypto.randomUUID();
  const share = await newShareToken(c.env, id);
  const cols = configColumns(v.value);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO upload_sessions (id, title, instructions, status, share_token_hash, share_token_enc, folder_id, folder_path,
         folder_web_url, expires_at, max_submissions, file_rules_json, fields_json, show_drive_links, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, cols.title, cols.instructions, share.hash, share.enc, cols.folder_id, cols.folder_path,
      cols.folder_web_url, cols.expires_at, cols.max_submissions, cols.file_rules_json, cols.fields_json, cols.show_drive_links,
      admin(c), now, now,
    ),
    auditStatement(c.env, admin(c), 'session.created', { type: 'upload_session', id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, id))!, now) }, 201);
});

adminRoutes.get('/sessions/:id', async (c) => {
  const row = await loadSession(c);
  return c.json({ session: await toAdminSession(c.env, row, Date.now()) });
});

adminRoutes.put('/sessions/:id', async (c) => {
  const row = await loadSession(c);
  if (row.status === 'closed') throw new ApiError(409, 'session_closed', 'Closed sessions cannot be edited. Duplicate it instead.');
  const v = validateSessionConfig(await readJson(c), { forPublish: false, now: new Date() });
  if (!v.value) throw new ApiError(422, 'validation_failed', v.errors.join(' '));
  if (row.status === 'published') {
    // A live session must stay valid, so edits get the full publish checks.
    const errors = await publishErrors(c, v.value);
    if (errors.length) throw new ApiError(422, 'validation_failed', errors.join(' '));
  }
  const cols = configColumns(v.value);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE upload_sessions SET title = ?, instructions = ?, folder_id = ?, folder_path = ?, folder_web_url = ?,
         expires_at = ?, max_submissions = ?, file_rules_json = ?, fields_json = ?, show_drive_links = ?, updated_at = ?,
         report_validated_at = CASE WHEN status = 'published' THEN ? ELSE NULL END
       WHERE id = ?`,
    ).bind(
      cols.title, cols.instructions, cols.folder_id, cols.folder_path, cols.folder_web_url, cols.expires_at,
      cols.max_submissions, cols.file_rules_json, cols.fields_json, cols.show_drive_links, now, now, row.id,
    ),
    auditStatement(c.env, admin(c), 'session.updated', { type: 'upload_session', id: row.id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, row.id))!, now) });
});

adminRoutes.post('/sessions/:id/validate', async (c) => {
  const row = await loadSession(c);
  const errors = await publishErrors(c, configOf(row));
  return c.json({ ok: errors.length === 0, errors });
});

adminRoutes.post('/sessions/:id/publish', async (c) => {
  const row = await loadSession(c);
  if (row.status === 'closed') throw new ApiError(409, 'session_closed', 'Closed sessions cannot be published. Duplicate it instead.');
  const errors = await publishErrors(c, configOf(row));
  if (errors.length) throw new ApiError(422, 'not_publishable', errors.join(' '));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE upload_sessions SET status = 'published', published_at = ?, report_validated_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'unpublished', 'published')",
    ).bind(now, now, now, row.id),
    auditStatement(c.env, admin(c), 'session.published', { type: 'upload_session', id: row.id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, row.id))!, now) });
});

adminRoutes.post('/sessions/:id/unpublish', async (c) => {
  const row = await loadSession(c);
  if (row.status !== 'published') throw new ApiError(409, 'not_published', 'Only published sessions can be unpublished.');
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE upload_sessions SET status = 'unpublished', updated_at = ? WHERE id = ? AND status = 'published'").bind(now, row.id),
    auditStatement(c.env, admin(c), 'session.unpublished', { type: 'upload_session', id: row.id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, row.id))!, now) });
});

adminRoutes.post('/sessions/:id/close', async (c) => {
  const row = await loadSession(c);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE upload_sessions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status != 'closed'").bind(now, now, row.id),
    auditStatement(c.env, admin(c), 'session.closed', { type: 'upload_session', id: row.id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, row.id))!, now) });
});

adminRoutes.post('/sessions/:id/duplicate', async (c) => {
  const row = await loadSession(c);
  const id = crypto.randomUUID();
  const share = await newShareToken(c.env, id);
  const now = Date.now();
  const title = `Copy of ${row.title}`.slice(0, 200);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO upload_sessions (id, title, instructions, status, share_token_hash, share_token_enc, folder_id, folder_path,
         folder_web_url, expires_at, max_submissions, file_rules_json, fields_json, show_drive_links, created_by, created_at, updated_at)
       SELECT ?, ?, instructions, 'draft', ?, ?, folder_id, folder_path, folder_web_url, expires_at, max_submissions,
         file_rules_json, fields_json, show_drive_links, ?, ?, ? FROM upload_sessions WHERE id = ?`,
    ).bind(id, title, share.hash, share.enc, admin(c), now, now, row.id),
    auditStatement(c.env, admin(c), 'session.duplicated', { type: 'upload_session', id }, { sourceId: row.id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, id))!, now) }, 201);
});

adminRoutes.post('/sessions/:id/rotate-link', async (c) => {
  const row = await loadSession(c);
  const share = await newShareToken(c.env, row.id);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE upload_sessions SET share_token_hash = ?, share_token_enc = ?, updated_at = ? WHERE id = ?').bind(share.hash, share.enc, now, row.id),
    auditStatement(c.env, admin(c), 'session.link_rotated', { type: 'upload_session', id: row.id }),
  ]);
  return c.json({ session: await toAdminSession(c.env, (await getSession(c.env, row.id))!, now) });
});

adminRoutes.get('/sessions/:id/qr.svg', async (c) => {
  const row = await loadSession(c);
  const svg = await QRCode.toString(await shareUrlFor(c.env, row), { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 512 });
  return c.body(svg, 200, {
    'Content-Type': 'image/svg+xml',
    'Content-Disposition': `attachment; filename="upload-qr-${row.id.slice(0, 8)}.svg"`,
  });
});

// ---------------------------------------------------------------- submissions

const PAGE_SIZE = 50;

adminRoutes.get('/submissions', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 100);
  const sessionId = c.req.query('sessionId') || null;
  const statusParam = c.req.query('status') || null;
  const status = statusParam && (SUBMISSION_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as SubmissionStatus) : null;
  const page = Math.max(1, Math.min(10_000, Number(c.req.query('page') ?? '1') || 1));
  const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const where = `WHERE (?1 IS NULL OR s.search_text LIKE ?1 ESCAPE '\\' OR lower(u.title) LIKE ?1 ESCAPE '\\')
      AND (?2 IS NULL OR s.upload_session_id = ?2) AND (?3 IS NULL OR s.status = ?3)`;
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT s.*, u.title AS session_title, u.fields_json AS session_fields_json FROM submissions s
         JOIN upload_sessions u ON u.id = s.upload_session_id ${where}
       ORDER BY s.created_at DESC LIMIT ?4 OFFSET ?5`,
    )
      .bind(like, sessionId, status, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all<SubmissionRow & { session_title: string; session_fields_json: string }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions s JOIN upload_sessions u ON u.id = s.upload_session_id ${where}`)
      .bind(like, sessionId, status)
      .first<{ n: number }>(),
  ]);
  const ids = rows.results.map((r) => r.id);
  const files = ids.length
    ? (
        await c.env.DB.prepare(`SELECT * FROM submission_files WHERE submission_id IN (${ids.map(() => '?').join(',')}) ORDER BY file_index`)
          .bind(...ids)
          .all<FileRow>()
      ).results
    : [];
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return c.json({
    page,
    pageSize: PAGE_SIZE,
    total: total?.n ?? 0,
    submissions: rows.results.map((s) => {
      const values = JSON.parse(s.field_values_json) as Record<string, string | number>;
      const defs = JSON.parse(s.session_fields_json) as { key: string; label: string }[];
      return {
        id: s.id,
        reference: s.reference,
        sessionId: s.upload_session_id,
        sessionTitle: s.session_title,
        status: s.status,
        failureStage: s.failure_stage,
        failureReason: s.failure_reason,
        reportAttempts: s.excel_attempts,
        reportLastError: s.excel_last_error,
        reportNextAttemptAt: iso(s.excel_next_attempt_at),
        createdAt: iso(s.created_at),
        completedAt: iso(s.completed_at),
        fields: defs.filter((d) => values[d.key] !== undefined).map((d) => ({ key: d.key, label: d.label, value: values[d.key] })),
        files: files
          .filter((f) => f.submission_id === s.id)
          .map((f) => ({
            id: f.id,
            originalFilename: f.original_filename,
            storedFilename: f.stored_filename,
            size: f.actual_size ?? f.declared_size,
            status: f.status,
            failureReason: f.failure_reason,
            webUrl: f.web_url,
            path: f.drive_path,
            contentType: f.content_type,
            reportStatus: f.excel_status,
          })),
      };
    }),
  });
});

adminRoutes.post('/submissions/:id/retry-report', async (c) => {
  const id = c.req.param('id');
  const sub = ID.test(id) ? await getSubmission(c.env, id) : null;
  if (!sub) throw notFound('Submission not found.');
  const now = Date.now();
  let moved = false;
  if (sub.status === 'failed' && sub.failure_stage === 'excel') {
    // Attempts restart at 1 (never 0) so the next run checks the table for rows
    // that an earlier attempt may already have written.
    moved = await transition(c.env.DB, id, ['failed'], 'excel_pending', {
      excel_attempts: 1,
      excel_next_attempt_at: now,
      excel_lock_until: null,
      failure_stage: null,
      failure_reason: null,
    }, now);
  } else if (sub.status === 'excel_pending') {
    const r = await c.env.DB.prepare("UPDATE submissions SET excel_next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'excel_pending'")
      .bind(now, now, id)
      .run();
    moved = r.meta.changes === 1;
  }
  if (!moved) throw new ApiError(409, 'not_retryable', 'Only submissions waiting for, or failed at, the report-sheet step can be retried.');
  await audit(c.env, admin(c), 'submission.report_retry', { type: 'submission', id });
  const outcome = await processSubmissionReport(c.env, id).catch((e) => {
    log.error({ event: 'report_retry_error', submissionId: id, reason: e instanceof Error ? e.message : 'unknown' });
    return 'retry_scheduled' as const;
  });
  return c.json({ outcome });
});

// ---------------------------------------------------------------- audit

adminRoutes.get('/audit', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  return c.json({ entries: rows.results });
});

adminRoutes.all('*', () => {
  throw notFound('Unknown admin endpoint.');
});

