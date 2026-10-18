// Administrator API. Mounted behind requireAdmin() (Cloudflare Access JWT).
import { Hono, type Context } from 'hono';
import QRCode from 'qrcode';
import type { AdminSession, SessionConfigInput, SubmissionStatus } from '../../shared/types';
import { SUBMISSION_STATUSES } from '../../shared/types';
import { validateSessionConfig } from '../../shared/validation';
import { base64UrlEncode, randomToken, sha256Hex } from '../crypto';
import { audit, auditStatement } from '../db/audit';
import { getExcelTarget } from '../db/excelTarget';
import {
  configColumns,
  configOf,
  getSession,
  newShareToken,
  shareUrlFor,
  toAdminSession,
  type SessionRow,
} from '../db/sessions';
import { getSubmission, type FileRow, type SubmissionRow } from '../db/submissions';
import { ApiError, badRequest, notFound } from '../errors';
import { validateExcelMapping, type MappingResult } from '../excel/mapping';
import { processSubmissionExcel } from '../excel/sync';
import { readJson, type AppEnv } from '../http';
import { log } from '../log';
import { DriveService, itemDisplayPath, type DriveItem } from '../microsoft/drive';
import { ExcelService } from '../microsoft/excel';
import { GraphClient } from '../microsoft/graph';
import { buildAuthorizeUrl, exchangeCode, OAuthError } from '../microsoft/oauth';
import { disconnect, getConnection, NotConnectedError, storeNewConnection } from '../microsoft/tokens';
import { transition } from '../state';

export const adminRoutes = new Hono<AppEnv>();

const admin = (c: Context<AppEnv>) => c.get('adminEmail');
const graphFor = (c: Context<AppEnv>) => new GraphClient(c.env);
const ID = /^[0-9a-f-]{36}$/;

async function loadSession(c: Context<AppEnv>): Promise<SessionRow> {
  const id = c.req.param('id') ?? '';
  const row = ID.test(id) ? await getSession(c.env, id) : null;
  if (!row) throw notFound('Upload session not found.');
  return row;
}

// ---------------------------------------------------------------- identity

adminRoutes.get('/me', (c) => c.json({ email: admin(c), environment: c.env.ENVIRONMENT }));

// ------------------------------------------------------- Microsoft connection

adminRoutes.get('/microsoft/status', async (c) => {
  const conn = await getConnection(c.env);
  const target = await getExcelTarget(c.env);
  const counts = await c.env.DB.prepare(
    `SELECT SUM(status = 'excel_pending') AS pending, SUM(status = 'failed' AND failure_stage = 'excel') AS failed FROM submissions`,
  ).first<{ pending: number | null; failed: number | null }>();
  const otherDrive = conn?.drive_id
    ? await c.env.DB.prepare("SELECT COUNT(*) AS n FROM upload_sessions WHERE status != 'closed' AND folder_drive_id IS NOT NULL AND folder_drive_id != ?")
        .bind(conn.drive_id)
        .first<{ n: number }>()
    : null;
  return c.json({
    connection: conn
      ? {
          status: conn.status,
          userPrincipalName: conn.user_principal_name,
          displayName: conn.display_name,
          driveId: conn.drive_id,
          connectedBy: conn.connected_by,
          connectedAt: conn.connected_at ? new Date(conn.connected_at).toISOString() : null,
          lastRefreshedAt: conn.last_refreshed_at ? new Date(conn.last_refreshed_at).toISOString() : null,
          lastError: conn.last_error,
        }
      : { status: 'disconnected' },
    excelTarget: target
      ? {
          driveId: target.drive_id,
          itemId: target.item_id,
          workbookName: target.workbook_name,
          workbookPath: target.workbook_path,
          workbookWebUrl: target.workbook_web_url,
          tableId: target.table_id,
          tableName: target.table_name,
          columns: JSON.parse(target.columns_json) as string[],
          updatedAt: new Date(target.updated_at).toISOString(),
        }
      : null,
    excelPending: counts?.pending ?? 0,
    excelFailed: counts?.failed ?? 0,
    sessionsOnOtherDrive: otherDrive?.n ?? 0,
    configured: {
      microsoft: !!(c.env.MS_CLIENT_ID && c.env.MS_TENANT_ID && c.env.MS_CLIENT_SECRET),
      encryptionKey: !!c.env.TOKEN_ENCRYPTION_KEY,
    },
  });
});

adminRoutes.get('/microsoft/connect', async (c) => {
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

adminRoutes.get('/microsoft/callback', async (c) => {
  const done = (result: string) => c.redirect(`/admin/settings?microsoft=${encodeURIComponent(result)}`, 302);
  const url = new URL(c.req.url);
  const error = url.searchParams.get('error');
  if (error) {
    log.warn({ event: 'ms_consent_error', code: error.slice(0, 60) });
    return done(error === 'access_denied' ? 'access_denied' : 'microsoft_error');
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
    const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' };
    const [meRes, driveRes] = await Promise.all([
      fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName', { headers }),
      fetch('https://graph.microsoft.com/v1.0/me/drive?$select=id,driveType', { headers }),
    ]);
    if (!meRes.ok || !driveRes.ok) return done(driveRes.status === 404 ? 'no_onedrive' : 'graph_error');
    const me = (await meRes.json()) as { id: string; displayName: string; userPrincipalName: string };
    const drive = (await driveRes.json()) as { id: string; driveType: string };
    if (drive.driveType !== 'business') return done('not_business_account');
    await storeNewConnection(
      c.env,
      tokens,
      { tenantId: c.env.MS_TENANT_ID, userObjectId: me.id, upn: me.userPrincipalName, displayName: me.displayName, driveId: drive.id },
      admin(c),
    );
    await audit(c.env, admin(c), 'microsoft.connected', { type: 'ms_connection', id: 'primary' }, { upn: me.userPrincipalName });
    return done('connected');
  } catch (e) {
    log.error({ event: 'ms_connect_failed', code: e instanceof OAuthError ? e.code : e instanceof Error ? e.message : 'unknown' });
    return done(e instanceof OAuthError ? e.code : 'connect_failed');
  }
});

adminRoutes.post('/microsoft/disconnect', async (c) => {
  await disconnect(c.env);
  await audit(c.env, admin(c), 'microsoft.disconnected', { type: 'ms_connection', id: 'primary' });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- OneDrive

function toBrowserItem(item: DriveItem, driveId: string) {
  return {
    id: item.id,
    driveId: item.parentReference?.driveId ?? driveId,
    name: item.name,
    path: itemDisplayPath(item),
    webUrl: item.webUrl,
    isFolder: !!item.folder,
    isWorkbook: !!item.file && /\.xlsx$/i.test(item.name),
    childCount: item.folder?.childCount ?? 0,
    size: item.size ?? 0,
  };
}

adminRoutes.get('/drive/children', async (c) => {
  const conn = await getConnection(c.env);
  if (!conn?.drive_id || conn.status !== 'connected') throw new NotConnectedError('not_connected');
  const itemId = c.req.query('itemId') || 'root';
  if (!/^[A-Za-z0-9!_-]{1,200}$/.test(itemId)) throw badRequest('Invalid item.');
  const drive = new DriveService(graphFor(c));
  const driveId = conn.drive_id;
  const [current, children] = await Promise.all([drive.getItem(driveId, itemId), drive.listChildren(driveId, itemId)]);
  if (!current?.folder) throw notFound('Folder not found.');
  return c.json({
    current: { ...toBrowserItem(current, driveId), parentId: current.parentReference?.id ?? null },
    items: children.filter((i) => i.folder || i.file).map((i) => toBrowserItem(i, driveId)),
  });
});

// ---------------------------------------------------------------- Excel

async function workbookFor(c: Context<AppEnv>, itemId: string) {
  const conn = await getConnection(c.env);
  if (!conn?.drive_id || conn.status !== 'connected') throw new NotConnectedError('not_connected');
  const item = await new DriveService(graphFor(c)).getItem(conn.drive_id, itemId);
  if (!item?.file || !/\.xlsx$/i.test(item.name)) throw badRequest('Choose an .xlsx workbook.');
  return { driveId: item.parentReference?.driveId ?? conn.drive_id, item };
}

adminRoutes.get('/excel/tables', async (c) => {
  const { driveId, item } = await workbookFor(c, c.req.query('itemId') ?? '');
  const tables = await new ExcelService(graphFor(c)).listTables(driveId, item.id);
  return c.json({ tables: tables.map((t) => ({ id: t.id, name: t.name })) });
});

adminRoutes.get('/excel/columns', async (c) => {
  const { driveId, item } = await workbookFor(c, c.req.query('itemId') ?? '');
  const cols = await new ExcelService(graphFor(c)).listColumns(driveId, item.id, c.req.query('tableId') ?? '');
  const names = cols.map((x) => x.name);
  return c.json({ columns: names, mapping: validateExcelMapping(names, []) });
});

adminRoutes.put('/excel/target', async (c) => {
  const body = await readJson<{ itemId?: string; tableId?: string }>(c);
  if (typeof body.itemId !== 'string' || typeof body.tableId !== 'string') throw badRequest('Choose a workbook and table.');
  const { driveId, item } = await workbookFor(c, body.itemId);
  const excel = new ExcelService(graphFor(c));
  const table = (await excel.listTables(driveId, item.id)).find((t) => t.id === body.tableId);
  if (!table) throw badRequest('That table does not exist in the workbook.');
  const names = (await excel.listColumns(driveId, item.id, table.id)).map((x) => x.name);
  const mapping = validateExcelMapping(names, []);
  if (!mapping.ok) throw new ApiError(422, 'excel_columns_missing', mapping.errors.join(' '));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO excel_target (id, drive_id, item_id, workbook_name, workbook_path, workbook_web_url, table_id, table_name, columns_json, updated_by, updated_at)
       VALUES ('primary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET drive_id = excluded.drive_id, item_id = excluded.item_id, workbook_name = excluded.workbook_name,
         workbook_path = excluded.workbook_path, workbook_web_url = excluded.workbook_web_url, table_id = excluded.table_id,
         table_name = excluded.table_name, columns_json = excluded.columns_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(driveId, item.id, item.name, itemDisplayPath(item), item.webUrl ?? null, table.id, table.name, JSON.stringify(names), admin(c), now),
    auditStatement(c.env, admin(c), 'excel.target_set', { type: 'excel_target', id: 'primary' }, { table: table.name }),
  ]);
  return c.json({ ok: true, columns: names });
});

/** Checks a session's fields against the live Excel table. */
async function checkExcelMapping(c: Context<AppEnv>, cfg: SessionConfigInput): Promise<MappingResult> {
  const target = await getExcelTarget(c.env);
  if (!target) return { ok: false, errors: ['Connect an Excel workbook and table in Settings first.'], standard: [], fieldColumns: {} };
  const names = (await new ExcelService(graphFor(c)).listColumns(target.drive_id, target.item_id, target.table_id)).map((x) => x.name);
  return validateExcelMapping(names, cfg.fields);
}

/** Full readiness check before a session may accept uploads. */
async function publishErrors(c: Context<AppEnv>, cfg: SessionConfigInput): Promise<string[]> {
  const v = validateSessionConfig(cfg, { forPublish: true, now: new Date() });
  if (v.errors.length) return v.errors;
  const conn = await getConnection(c.env);
  if (conn?.status !== 'connected') return ['Connect a Microsoft account in Settings first.'];
  const folder = await new DriveService(graphFor(c)).getItem(cfg.folder!.driveId, cfg.folder!.itemId);
  if (!folder?.folder) return ['The destination folder no longer exists or is not accessible. Choose it again.'];
  return (await checkExcelMapping(c, cfg)).errors;
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
      `INSERT INTO upload_sessions (id, title, instructions, status, share_token_hash, share_token_enc, folder_drive_id, folder_item_id, folder_path,
         folder_web_url, expires_at, max_submissions, file_rules_json, fields_json, show_onedrive_links, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, cols.title, cols.instructions, share.hash, share.enc, cols.folder_drive_id, cols.folder_item_id, cols.folder_path,
      cols.folder_web_url, cols.expires_at, cols.max_submissions, cols.file_rules_json, cols.fields_json, cols.show_onedrive_links,
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
      `UPDATE upload_sessions SET title = ?, instructions = ?, folder_drive_id = ?, folder_item_id = ?, folder_path = ?, folder_web_url = ?,
         expires_at = ?, max_submissions = ?, file_rules_json = ?, fields_json = ?, show_onedrive_links = ?, updated_at = ?,
         excel_validated_at = CASE WHEN status = 'published' THEN ? ELSE NULL END
       WHERE id = ?`,
    ).bind(
      cols.title, cols.instructions, cols.folder_drive_id, cols.folder_item_id, cols.folder_path, cols.folder_web_url, cols.expires_at,
      cols.max_submissions, cols.file_rules_json, cols.fields_json, cols.show_onedrive_links, now, now, row.id,
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
      "UPDATE upload_sessions SET status = 'published', published_at = ?, excel_validated_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'unpublished', 'published')",
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
      `INSERT INTO upload_sessions (id, title, instructions, status, share_token_hash, share_token_enc, folder_drive_id, folder_item_id, folder_path,
         folder_web_url, expires_at, max_submissions, file_rules_json, fields_json, show_onedrive_links, created_by, created_at, updated_at)
       SELECT ?, ?, instructions, 'draft', ?, ?, folder_drive_id, folder_item_id, folder_path, folder_web_url, expires_at, max_submissions,
         file_rules_json, fields_json, show_onedrive_links, ?, ?, ? FROM upload_sessions WHERE id = ?`,
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
        excelAttempts: s.excel_attempts,
        excelLastError: s.excel_last_error,
        excelNextAttemptAt: iso(s.excel_next_attempt_at),
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
            path: f.onedrive_path,
            contentType: f.content_type,
            excelStatus: f.excel_status,
          })),
      };
    }),
  });
});

adminRoutes.post('/submissions/:id/retry-excel', async (c) => {
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
  if (!moved) throw new ApiError(409, 'not_retryable', 'Only submissions waiting for, or failed at, the Excel step can be retried.');
  await audit(c.env, admin(c), 'submission.excel_retry', { type: 'submission', id });
  const outcome = await processSubmissionExcel(c.env, id).catch((e) => {
    log.error({ event: 'excel_retry_error', submissionId: id, reason: e instanceof Error ? e.message : 'unknown' });
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

