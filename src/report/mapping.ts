// Pure functions that map submissions onto the report sheet's columns.
import { STANDARD_REPORT_COLUMNS, type StandardReportColumn } from '../../shared/constants';
import type { FieldDefinition } from '../../shared/types';
import { reportColumnFor } from '../../shared/validation';
import type { CellValue } from '../google/sheets';

const norm = (s: string) => s.trim().toLowerCase();

export interface MappingResult {
  ok: boolean;
  errors: string[];
  /** Column names (as wanted) that the header row lacks. */
  missing: string[];
  /** field key -> actual header name. */
  fieldColumns: Record<string, string>;
}

/**
 * Confirms the header row has every standard column and a column for every
 * configured field (matched case-insensitively, ignoring surrounding spaces).
 */
export function validateReportMapping(header: string[], fields: Pick<FieldDefinition, 'key' | 'label' | 'column'>[]): MappingResult {
  const byNorm = new Map(header.filter(Boolean).map((c) => [norm(c), c]));
  const errors: string[] = [];
  const missing: string[] = [];
  for (const col of STANDARD_REPORT_COLUMNS) {
    if (!byNorm.has(col)) {
      missing.push(col);
      errors.push(`The report sheet is missing the standard column "${col}".`);
    }
  }
  const fieldColumns: Record<string, string> = {};
  const used = new Set<string>(STANDARD_REPORT_COLUMNS);
  for (const f of fields) {
    const wanted = reportColumnFor(f);
    const actual = byNorm.get(norm(wanted));
    if (!actual) {
      missing.push(wanted);
      errors.push(`The report sheet has no column "${wanted}" for the field "${f.label}".`);
      continue;
    }
    if (used.has(norm(actual))) {
      errors.push(`Field "${f.label}" maps to column "${actual}", which is already used.`);
      continue;
    }
    used.add(norm(actual));
    fieldColumns[f.key] = actual;
  }
  return { ok: errors.length === 0, errors, missing, fieldColumns };
}

export interface RowFile {
  originalFilename: string;
  storedFilename: string;
  sizeBytes: number;
  contentType: string;
  folderPath: string;
  webUrl: string;
}

export interface RowSubmission {
  reference: string;
  uploadSessionId: string;
  sessionTitle: string;
  submittedAt: Date;
  fieldValues: Record<string, string | number>;
}

/** ISO 8601 without milliseconds: unambiguous in every spreadsheet locale. */
export const utcTimestamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Builds one row per file in header order. Columns that are not mapped get an
 * empty string. Rows are written with valueInputOption=RAW, so text that looks
 * like a formula is stored as plain text.
 */
export function buildReportRows(
  header: string[],
  mapping: MappingResult,
  submission: RowSubmission,
  files: RowFile[],
  processingStatus: string,
): CellValue[][] {
  if (!mapping.ok) throw new Error('Cannot build rows from an invalid mapping');
  const fieldByColumn = new Map(Object.entries(mapping.fieldColumns).map(([key, col]) => [norm(col), key]));
  return files.map((file) => {
    const standard: Record<StandardReportColumn, CellValue> = {
      submission_id: submission.reference,
      upload_session_id: submission.uploadSessionId,
      session_title: submission.sessionTitle,
      submitted_at_utc: utcTimestamp(submission.submittedAt),
      original_filename: file.originalFilename,
      stored_filename: file.storedFilename,
      file_size_bytes: file.sizeBytes,
      content_type: file.contentType,
      drive_folder_path: file.folderPath,
      drive_web_url: file.webUrl,
      processing_status: processingStatus,
    };
    return header.map((col) => {
      const n = norm(col);
      if ((STANDARD_REPORT_COLUMNS as readonly string[]).includes(n)) return standard[n as StandardReportColumn];
      const key = fieldByColumn.get(n);
      if (key === undefined) return '';
      return submission.fieldValues[key] ?? '';
    });
  });
}
