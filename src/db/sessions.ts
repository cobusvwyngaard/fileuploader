import type {
  AdminSession,
  EffectiveSessionState,
  FieldDefinition,
  FileRules,
  SessionConfigInput,
  SessionStatus,
} from '../../shared/types';
import { decryptString, encryptString, keyMaterial, randomToken, sha256Hex } from '../crypto';
import type { Env } from '../env';

export interface SessionRow {
  id: string;
  title: string;
  instructions: string;
  status: SessionStatus;
  share_token_hash: string;
  share_token_enc: string;
  folder_drive_id: string | null;
  folder_item_id: string | null;
  folder_path: string | null;
  folder_web_url: string | null;
  expires_at: number | null;
  max_submissions: number | null;
  submission_count: number;
  file_rules_json: string;
  fields_json: string;
  show_onedrive_links: number;
  excel_validated_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  closed_at: number | null;
}

export const fieldsOf = (row: SessionRow): FieldDefinition[] => JSON.parse(row.fields_json) as FieldDefinition[];
export const fileRulesOf = (row: SessionRow): FileRules => JSON.parse(row.file_rules_json) as FileRules;

/** Combines stored status with expiry and capacity into what a visitor experiences. */
export function effectiveState(
  row: Pick<SessionRow, 'status' | 'expires_at' | 'max_submissions' | 'submission_count'>,
  nowMs: number,
): EffectiveSessionState {
  if (row.status === 'closed') return 'closed';
  if (row.status === 'draft') return 'draft';
  if (row.status === 'unpublished') return 'unpublished';
  if (row.expires_at === null || row.expires_at <= nowMs) return 'expired';
  if (row.max_submissions !== null && row.submission_count >= row.max_submissions) return 'exhausted';
  return 'open';
}

const SHARE_TOKEN_CONTEXT = (id: string) => `share_token:${id}`;

export async function newShareToken(env: Env, sessionId: string): Promise<{ token: string; hash: string; enc: string }> {
  const token = randomToken(32);
  return {
    token,
    hash: await sha256Hex(token),
    enc: await encryptString(keyMaterial(env), token, SHARE_TOKEN_CONTEXT(sessionId)),
  };
}

export async function shareUrlFor(env: Env, row: SessionRow): Promise<string> {
  const token = await decryptString(keyMaterial(env), row.share_token_enc, SHARE_TOKEN_CONTEXT(row.id));
  return buildShareUrl(env, token);
}

export function buildShareUrl(env: Pick<Env, 'PUBLIC_BASE_URL'>, token: string): string {
  // The token lives in the URL fragment, which browsers never send to the server,
  // so it cannot appear in request logs, Referer headers or analytics.
  return `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/u/#${token}`;
}

export async function findSessionByToken(env: Env, token: string): Promise<SessionRow | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare('SELECT * FROM upload_sessions WHERE share_token_hash = ?').bind(await sha256Hex(token)).first<SessionRow>();
}

export async function getSession(env: Env, id: string): Promise<SessionRow | null> {
  return env.DB.prepare('SELECT * FROM upload_sessions WHERE id = ?').bind(id).first<SessionRow>();
}

export function configColumns(cfg: SessionConfigInput) {
  return {
    title: cfg.title,
    instructions: cfg.instructions,
    folder_drive_id: cfg.folder?.driveId ?? null,
    folder_item_id: cfg.folder?.itemId ?? null,
    folder_path: cfg.folder?.path ?? null,
    folder_web_url: cfg.folder?.webUrl ?? null,
    expires_at: cfg.expiresAt ? new Date(cfg.expiresAt).getTime() : null,
    max_submissions: cfg.maxSubmissions,
    file_rules_json: JSON.stringify(cfg.fileRules),
    fields_json: JSON.stringify(cfg.fields),
    show_onedrive_links: cfg.showOneDriveLinks ? 1 : 0,
  };
}

export function configOf(row: SessionRow): SessionConfigInput {
  return {
    title: row.title,
    instructions: row.instructions,
    folder:
      row.folder_drive_id && row.folder_item_id
        ? { driveId: row.folder_drive_id, itemId: row.folder_item_id, path: row.folder_path ?? '', webUrl: row.folder_web_url ?? undefined }
        : null,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    maxSubmissions: row.max_submissions,
    fileRules: fileRulesOf(row),
    fields: fieldsOf(row),
    showOneDriveLinks: row.show_onedrive_links === 1,
  };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export async function toAdminSession(env: Env, row: SessionRow, nowMs: number): Promise<AdminSession> {
  return {
    id: row.id,
    ...configOf(row),
    status: row.status,
    effectiveState: effectiveState(row, nowMs),
    shareUrl: await shareUrlFor(env, row),
    submissionCount: row.submission_count,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    publishedAt: iso(row.published_at),
    createdBy: row.created_by,
  };
}

/**
 * Atomically reserves a submission slot. The WHERE clause re-checks status,
 * expiry and capacity in the same statement, so concurrent visitors cannot
 * exceed max_submissions.
 */
export async function reserveSubmissionSlot(env: Env, sessionId: string, nowMs: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE upload_sessions SET submission_count = submission_count + 1
      WHERE id = ? AND status = 'published' AND expires_at > ?
        AND (max_submissions IS NULL OR submission_count < max_submissions)`,
  )
    .bind(sessionId, nowMs)
    .run();
  return r.meta.changes === 1;
}

export async function releaseSubmissionSlot(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare('UPDATE upload_sessions SET submission_count = MAX(submission_count - 1, 0) WHERE id = ?').bind(sessionId).run();
}
