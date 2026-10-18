// Pure functions that map submissions onto the reporting table's columns.
import { STANDARD_EXCEL_COLUMNS, type StandardExcelColumn } from '../../shared/constants';
import type { FieldDefinition } from '../../shared/types';
import { excelColumnFor } from '../../shared/validation';
import type { CellValue } from '../microsoft/excel';

const norm = (s: string) => s.trim().toLowerCase();

export interface MappingResult {
  ok: boolean;
  errors: string[];
  /** Standard columns that exist in the table. */
  standard: StandardExcelColumn[];
  /** field key -> actual table column name. */
  fieldColumns: Record<string, string>;
}

/**
 * Confirms the table has every standard column and a column for every
 * configured field (matched case-insensitively, ignoring surrounding spaces).
 */
export function validateExcelMapping(tableColumns: string[], fields: Pick<FieldDefinition, 'key' | 'label' | 'excelColumn'>[]): MappingResult {
  const byNorm = new Map(tableColumns.map((c) => [norm(c), c]));
  const errors: string[] = [];
  const standard: StandardExcelColumn[] = [];
  for (const col of STANDARD_EXCEL_COLUMNS) {
    if (byNorm.has(col)) standard.push(col);
    else errors.push(`The Excel table is missing the standard column "${col}".`);
  }
  const fieldColumns: Record<string, string> = {};
  const used = new Set<string>(STANDARD_EXCEL_COLUMNS);
  for (const f of fields) {
    const wanted = excelColumnFor(f);
    const actual = byNorm.get(norm(wanted));
    if (!actual) {
      errors.push(`The Excel table has no column "${wanted}" for the field "${f.label}".`);
      continue;
    }
    if (used.has(norm(actual))) {
      errors.push(`Field "${f.label}" maps to column "${actual}", which is already used.`);
      continue;
    }
    used.add(norm(actual));
    fieldColumns[f.key] = actual;
  }
  return { ok: errors.length === 0, errors, standard, fieldColumns };
}

/**
 * Stops Excel from interpreting submitted text as a formula. A leading
 * apostrophe forces the cell to text and is not displayed.
 */
export function excelSafeText(value: string): string {
  return /^[=+\-@\t\r|]/.test(value) ? `'${value}` : value;
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

/** ISO 8601 without milliseconds: unambiguous across Excel locales. */
export const utcTimestamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Builds one row per file in the table's column order. Columns that are not
 * mapped receive null, which Excel leaves empty (and does not overwrite
 * calculated columns).
 */
export function buildExcelRows(
  tableColumns: string[],
  mapping: MappingResult,
  submission: RowSubmission,
  files: RowFile[],
  processingStatus: string,
): CellValue[][] {
  if (!mapping.ok) throw new Error('Cannot build rows from an invalid mapping');
  const fieldByColumn = new Map(Object.entries(mapping.fieldColumns).map(([key, col]) => [norm(col), key]));
  return files.map((file) => {
    const standard: Record<StandardExcelColumn, CellValue> = {
      submission_id: submission.reference,
      upload_session_id: submission.uploadSessionId,
      session_title: excelSafeText(submission.sessionTitle),
      submitted_at_utc: utcTimestamp(submission.submittedAt),
      original_filename: excelSafeText(file.originalFilename),
      stored_filename: file.storedFilename,
      file_size_bytes: file.sizeBytes,
      content_type: file.contentType,
      onedrive_folder_path: excelSafeText(file.folderPath),
      onedrive_web_url: file.webUrl,
      processing_status: processingStatus,
    };
    return tableColumns.map((col) => {
      const n = norm(col);
      if ((STANDARD_EXCEL_COLUMNS as readonly string[]).includes(n)) return standard[n as StandardExcelColumn];
      const key = fieldByColumn.get(n);
      if (key === undefined) return null;
      const v = submission.fieldValues[key];
      if (v === undefined) return '';
      return typeof v === 'number' ? v : excelSafeText(v);
    });
  });
}
