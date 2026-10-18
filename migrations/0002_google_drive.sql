-- Switch the storage and reporting backend from Microsoft (OneDrive + Excel)
-- to Google (Drive + Sheets). No Microsoft connection was ever established in
-- production, so the Microsoft-specific tables are dropped rather than migrated.

DROP TABLE ms_connection;
DROP TABLE excel_target;

-- Single delegated Google connection. Tokens are AES-256-GCM encrypted with
-- TOKEN_ENCRYPTION_KEY (a Worker secret).
CREATE TABLE google_connection (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  google_sub TEXT,
  email TEXT,
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

-- The report spreadsheet and tab (one per installation). The tab is stored by
-- its numeric sheetId so renaming the tab does not break reporting.
CREATE TABLE sheet_target (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_name TEXT NOT NULL,
  spreadsheet_url TEXT,
  sheet_id INTEGER NOT NULL,
  sheet_title TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Google Drive folders are identified by a single file ID.
ALTER TABLE upload_sessions RENAME COLUMN folder_item_id TO folder_id;
ALTER TABLE upload_sessions DROP COLUMN folder_drive_id;
ALTER TABLE upload_sessions RENAME COLUMN show_onedrive_links TO show_drive_links;
ALTER TABLE upload_sessions RENAME COLUMN excel_validated_at TO report_validated_at;

ALTER TABLE submission_files RENAME COLUMN onedrive_path TO drive_path;
