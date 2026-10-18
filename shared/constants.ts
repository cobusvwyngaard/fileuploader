/**
 * Microsoft Graph requires every non-final chunk of a resumable upload to be a
 * multiple of 320 KiB. 16 x 320 KiB = 5 MiB, inside the 5-10 MiB range
 * Microsoft recommends.
 */
export const GRAPH_CHUNK_MULTIPLE = 320 * 1024;
export const UPLOAD_CHUNK_SIZE = 16 * GRAPH_CHUNK_MULTIPLE;

/** OneDrive for Business single-file limit is 250 GB. */
export const HARD_MAX_FILE_SIZE_BYTES = 250 * 1024 ** 3;
export const HARD_MAX_FILES_PER_SUBMISSION = 20;
export const MAX_FIELDS = 30;
export const MAX_FIELD_VALUE_LENGTH = 2000;
export const MAX_SHORT_FIELD_LENGTH = 200;
export const MAX_OPTIONS = 100;
export const MAX_TITLE_LENGTH = 200;
export const MAX_INSTRUCTIONS_LENGTH = 5000;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** A submission must finish uploading within this window after it is created. */
export const SUBMISSION_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Extensions that can never be accepted, whatever the admin configures. */
export const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'msc', 'ps1', 'psm1', 'psd1',
  'vbs', 'vbe', 'js', 'mjs', 'jse', 'wsf', 'wsh', 'hta', 'cpl', 'jar', 'sh', 'lnk',
  'reg', 'html', 'htm', 'xhtml', 'shtml', 'php', 'asp', 'aspx', 'jsp', 'pif', 'gadget',
  'application', 'appx', 'msix', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'docm', 'xlsm',
  'pptm', 'dotm', 'xltm',
]);

/**
 * Column names every reporting table must contain. Order is irrelevant: rows are
 * built by matching header names.
 */
export const STANDARD_EXCEL_COLUMNS = [
  'submission_id',
  'upload_session_id',
  'session_title',
  'submitted_at_utc',
  'original_filename',
  'stored_filename',
  'file_size_bytes',
  'content_type',
  'onedrive_folder_path',
  'onedrive_web_url',
  'processing_status',
] as const;
export type StandardExcelColumn = (typeof STANDARD_EXCEL_COLUMNS)[number];
