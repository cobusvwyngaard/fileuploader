// Types shared by the Worker and both browser apps.

export const FIELD_TYPES = ['text', 'textarea', 'email', 'number', 'select'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDefinition {
  /** Human readable label shown on the public form. */
  label: string;
  /** Stable internal key (snake_case). Also the default report column name. */
  key: string;
  type: FieldType;
  required: boolean;
  /** Options for `select` fields. */
  options?: string[];
  /** Optional report-sheet column override. Defaults to `key`. */
  column?: string;
  /** Optional helper text shown beneath the input. */
  helpText?: string;
}

export interface FileRules {
  /** Lower-case extensions without the leading dot, e.g. ["pdf", "jpg"]. */
  allowedExtensions: string[];
  maxFileSizeBytes: number;
  maxFilesPerSubmission: number;
}

export const SESSION_STATUSES = ['draft', 'published', 'unpublished', 'closed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Status as seen by a visitor, combining stored status with expiry and capacity. */
export type EffectiveSessionState =
  | 'open'
  | 'draft'
  | 'unpublished'
  | 'closed'
  | 'expired'
  | 'exhausted';

export const SUBMISSION_STATUSES = [
  'created',
  'uploading',
  'uploaded',
  'excel_pending',
  'complete',
  'failed',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export type FileStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

/** A Google Drive folder, identified by its stable file ID. */
export interface DestinationFolder {
  id: string;
  path: string;
  webUrl?: string;
}

/** Editable configuration of an upload session (admin input). */
export interface SessionConfigInput {
  title: string;
  instructions: string;
  folder: DestinationFolder | null;
  /** ISO-8601 UTC timestamp. */
  expiresAt: string | null;
  maxSubmissions: number | null;
  fileRules: FileRules;
  fields: FieldDefinition[];
  showDriveLinks: boolean;
}

export interface AdminSession extends SessionConfigInput {
  id: string;
  status: SessionStatus;
  effectiveState: EffectiveSessionState;
  shareUrl: string;
  submissionCount: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  createdBy: string;
}

/** What the public upload page receives. Never contains folder or report details. */
export interface PublicSessionView {
  title: string;
  instructions: string;
  fields: Omit<FieldDefinition, 'column'>[];
  fileRules: FileRules;
  expiresAt: string;
}

export interface DeclaredFile {
  name: string;
  size: number;
  type: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, string> };
}

export interface CreateSubmissionResponse {
  submissionId: string;
  reference: string;
  submissionSecret: string;
  uploadDeadline: string;
  chunkSize: number;
  files: { fileId: string; index: number; originalName: string; size: number }[];
}

export interface UploadUrlResponse {
  alreadyUploaded: boolean;
  uploadUrl?: string;
  expiresAt?: string;
}

export interface CompleteFileResponse {
  fileStatus: FileStatus;
  submissionStatus: SubmissionStatus;
  webUrl?: string;
}

export interface SubmissionStatusResponse {
  reference: string;
  status: SubmissionStatus;
  uploadDeadline: string;
  files: {
    fileId: string;
    index: number;
    originalName: string;
    size: number;
    status: FileStatus;
    webUrl?: string;
  }[];
}
