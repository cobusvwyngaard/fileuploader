import type { FileStatus, SubmissionStatus } from '../../shared/types';
import type { Env } from '../env';

export interface SubmissionRow {
  id: string;
  reference: string;
  upload_session_id: string;
  status: SubmissionStatus;
  failure_stage: 'upload' | 'excel' | null;
  failure_reason: string | null;
  secret_hash: string;
  field_values_json: string;
  search_text: string;
  upload_deadline: number;
  excel_attempts: number;
  excel_next_attempt_at: number | null;
  excel_lock_until: number | null;
  excel_last_error: string | null;
  created_at: number;
  updated_at: number;
  uploaded_at: number | null;
  completed_at: number | null;
}

export interface FileRow {
  id: string;
  submission_id: string;
  file_index: number;
  original_filename: string;
  stored_filename: string;
  declared_size: number;
  declared_content_type: string;
  status: FileStatus;
  failure_reason: string | null;
  drive_item_id: string | null;
  drive_path: string | null;
  web_url: string | null;
  actual_size: number | null;
  content_type: string | null;
  content_check: string | null;
  upload_session_expires_at: number | null;
  upload_attempts: number;
  excel_status: 'pending' | 'inserted';
  excel_inserted_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function getSubmission(env: Env, id: string): Promise<SubmissionRow | null> {
  return env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<SubmissionRow>();
}

export async function getFiles(env: Env, submissionId: string): Promise<FileRow[]> {
  const r = await env.DB.prepare('SELECT * FROM submission_files WHERE submission_id = ? ORDER BY file_index').bind(submissionId).all<FileRow>();
  return r.results;
}

export async function getFile(env: Env, submissionId: string, fileId: string): Promise<FileRow | null> {
  return env.DB.prepare('SELECT * FROM submission_files WHERE id = ? AND submission_id = ?').bind(fileId, submissionId).first<FileRow>();
}
