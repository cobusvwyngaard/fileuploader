import { describe, expect, it } from 'vitest';
import { STANDARD_REPORT_COLUMNS } from '../shared/constants';
import { columnLetter, sheetRange } from '../src/google/sheets';
import { buildReportRows, validateReportMapping } from '../src/report/mapping';

const fields = [
  { key: 'table_number', label: 'Table number' },
  { key: 'description', label: 'Description' },
  { key: 'area', label: 'Area', column: 'Region' },
];

describe('report column mapping', () => {
  it('passes when all standard and field columns exist (case-insensitive)', () => {
    const cols = [...STANDARD_REPORT_COLUMNS.map((c) => c.toUpperCase()), ' Table_Number ', 'description', 'region', 'Notes'];
    const m = validateReportMapping(cols, fields);
    expect(m.ok).toBe(true);
    expect(m.fieldColumns).toEqual({ table_number: ' Table_Number ', description: 'description', area: 'region' });
  });

  it('lists every missing standard and field column', () => {
    const m = validateReportMapping(['submission_id', 'table_number'], fields);
    expect(m.ok).toBe(false);
    expect(m.errors.filter((e) => e.includes('standard column'))).toHaveLength(STANDARD_REPORT_COLUMNS.length - 1);
    expect(m.missing).toContain('Region');
    expect(m.missing).toContain('description');
    expect(m.missing).not.toContain('submission_id');
  });

  it('builds one row per file in header order, blank for unmapped columns', () => {
    const cols = ['Notes', ...STANDARD_REPORT_COLUMNS, 'table_number', 'description', 'Region'];
    const m = validateReportMapping(cols, fields);
    const rows = buildReportRows(
      cols,
      m,
      { reference: 'ABCD-EFGH', uploadSessionId: 'sess', sessionTitle: 'Photos', submittedAt: new Date('2026-10-18T10:11:12.345Z'), fieldValues: { table_number: 12, description: '=HYPERLINK("x")', area: 'North' } },
      [
        { originalFilename: 'a.pdf', storedFilename: 's_a.pdf', sizeBytes: 10, contentType: 'application/pdf', folderPath: '/Uploads', webUrl: 'https://x/a' },
        { originalFilename: '+b.pdf', storedFilename: 's_b.pdf', sizeBytes: 20, contentType: 'application/pdf', folderPath: '/Uploads', webUrl: 'https://x/b' },
      ],
      'complete',
    );
    expect(rows).toHaveLength(2);
    const r0 = Object.fromEntries(cols.map((c, i) => [c, rows[0]![i]]));
    expect(r0).toEqual({
      Notes: '',
      submission_id: 'ABCD-EFGH',
      upload_session_id: 'sess',
      session_title: 'Photos',
      submitted_at_utc: '2026-10-18T10:11:12Z',
      original_filename: 'a.pdf',
      stored_filename: 's_a.pdf',
      file_size_bytes: 10,
      content_type: 'application/pdf',
      drive_folder_path: '/Uploads',
      drive_web_url: 'https://x/a',
      processing_status: 'complete',
      table_number: 12,
      // Written with valueInputOption=RAW, so this stays literal text, never a formula.
      description: '=HYPERLINK("x")',
      Region: 'North',
    });
    expect(rows[1]![cols.indexOf('original_filename')]).toBe('+b.pdf');
  });

  it('refuses to build rows from an invalid mapping', () => {
    expect(() => buildReportRows(['x'], validateReportMapping(['x'], []), {} as never, [], 'complete')).toThrow();
  });

  it('builds A1 ranges safely', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(701)).toBe('ZZ');
    expect(sheetRange("Bob's sheet", '1:1')).toBe("'Bob''s sheet'!1:1");
  });
});
