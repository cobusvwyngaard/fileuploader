-- Initial schema. All timestamps are Unix epoch milliseconds (UTC).

-- Single delegated Microsoft connection used for OneDrive and Excel.
-- Tokens are AES-256-GCM encrypted with TOKEN_ENCRYPTION_KEY (a Worker secret).
CREATE TABLE ms_connection (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  tenant_id TEXT,
  user_object_id TEXT,
  user_principal_name TEXT,
  display_name TEXT,
  drive_id TEXT,
  scopes TEXT,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at INTEGER,
  -- Optimistic-concurrency counter; every token write increments it.
  version INTEGER NOT NULL DEFAULT 0,
  connected_by TEXT,
  connected_at INTEGER,
  last_refreshed_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

-- Short-lived OAuth state + PKCE verifier for the admin "Connect Microsoft" flow.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The reporting workbook and named table (one per installation).
CREATE TABLE excel_target (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  drive_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  workbook_name TEXT NOT NULL,
  workbook_path TEXT NOT NULL,
  workbook_web_url TEXT,
  table_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'unpublished', 'closed')),
  -- SHA-256 of the public share token, used for lookup.
  share_token_hash TEXT NOT NULL UNIQUE,
  -- The share token encrypted at rest, so admins can redisplay the link.
  share_token_enc TEXT NOT NULL,
  folder_drive_id TEXT,
  folder_item_id TEXT,
  folder_path TEXT,
  folder_web_url TEXT,
  expires_at INTEGER,
  max_submissions INTEGER CHECK (max_submissions IS NULL OR max_submissions > 0),
  -- Submissions that hold a slot (everything except abandoned uploads).
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  file_rules_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  show_onedrive_links INTEGER NOT NULL DEFAULT 0,
  excel_validated_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  closed_at INTEGER
);
CREATE INDEX idx_upload_sessions_created ON upload_sessions (created_at DESC);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  upload_session_id TEXT NOT NULL REFERENCES upload_sessions (id),
  status TEXT NOT NULL CHECK (status IN ('created', 'uploading', 'uploaded', 'excel_pending', 'complete', 'failed')),
  -- Which stage failed when status = 'failed': 'upload' or 'excel'.
  failure_stage TEXT CHECK (failure_stage IS NULL OR failure_stage IN ('upload', 'excel')),
  failure_reason TEXT,
  -- SHA-256 of the per-submission secret held only by the uploader's browser.
  secret_hash TEXT NOT NULL,
  field_values_json TEXT NOT NULL,
  -- Lower-cased concatenation of reference, filenames and field values for admin search.
  search_text TEXT NOT NULL DEFAULT '',
  upload_deadline INTEGER NOT NULL,
  excel_attempts INTEGER NOT NULL DEFAULT 0,
  excel_next_attempt_at INTEGER,
  excel_lock_until INTEGER,
  excel_last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  uploaded_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX idx_submissions_session ON submissions (upload_session_id, created_at DESC);
CREATE INDEX idx_submissions_status ON submissions (status, excel_next_attempt_at);
CREATE INDEX idx_submissions_created ON submissions (created_at DESC);

CREATE TABLE submission_files (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions (id),
  file_index INTEGER NOT NULL,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL UNIQUE,
  declared_size INTEGER NOT NULL,
  declared_content_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'uploaded', 'failed')),
  failure_reason TEXT,
  drive_item_id TEXT,
  onedrive_path TEXT,
  web_url TEXT,
  actual_size INTEGER,
  content_type TEXT,
  content_check TEXT,
  upload_session_expires_at INTEGER,
  upload_attempts INTEGER NOT NULL DEFAULT 0,
  excel_status TEXT NOT NULL DEFAULT 'pending' CHECK (excel_status IN ('pending', 'inserted')),
  excel_inserted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (submission_id, file_index)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  -- Never contains tokens, upload URLs or submitted field values.
  details_json TEXT
);
CREATE INDEX idx_audit_at ON audit_log (at DESC);
