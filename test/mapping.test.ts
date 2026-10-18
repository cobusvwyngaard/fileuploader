import { describe, expect, it } from 'vitest';
import { STANDARD_EXCEL_COLUMNS } from '../shared/constants';
import { buildExcelRows, excelSafeText, validateExcelMapping } from '../src/excel/mapping';

const fields = [
  { key: 'table_number', label: 'Table number' },
  { key: 'description', label: 'Description' },
  { key: 'area', label: 'Area', excelColumn: 'Region' },
];

describe('Excel column mapping', () => {
  it('passes when all standard and field columns exist (case-insensitive)', () => {
    const cols = [...STANDARD_EXCEL_COLUMNS.map((c) => c.toUpperCase()), ' Table_Number ', 'description', 'region', 'Notes'];
    const m = validateExcelMapping(cols, fields);
    expect(m.ok).toBe(true);
    expect(m.fieldColumns).toEqual({ table_number: ' Table_Number ', description: 'description', area: 'region' });
  });

  it('lists every missing standard and field column', () => {
    const m = validateExcelMapping(['submission_id', 'table_number'], fields);
    expect(m.ok).toBe(false);
    expect(m.errors.filter((e) => e.includes('standard column'))).toHaveLength(STANDARD_EXCEL_COLUMNS.length - 1);
    expect(m.errors.join()).toContain('"Region"');
    expect(m.errors.join()).toContain('"description"');
  });

  it('builds one row per file in table column order, leaving unmapped columns untouched', () => {
    const cols = ['Notes', ...STANDARD_EXCEL_COLUMNS, 'table_number', 'description', 'Region'];
    const m = validateExcelMapping(cols, fields);
    const rows = buildExcelRows(
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
    expect(r0).toMatchObject({
      Notes: null,
      submission_id: 'ABCD-EFGH',
      upload_session_id: 'sess',
      session_title: 'Photos',
      submitted_at_utc: '2026-10-18T10:11:12Z',
      original_filename: 'a.pdf',
      stored_filename: 's_a.pdf',
      file_size_bytes: 10,
      onedrive_folder_path: '/Uploads',
      onedrive_web_url: 'https://x/a',
      processing_status: 'complete',
      table_number: 12,
      description: '\'=HYPERLINK("x")',
      Region: 'North',
    });
    expect(rows[1]![cols.indexOf('original_filename')]).toBe("'+b.pdf");
  });

  it('refuses to build rows from an invalid mapping', () => {
    expect(() => buildExcelRows(['x'], validateExcelMapping(['x'], []), {} as never, [], 'complete')).toThrow();
  });

  it('neutralises formula-like text', () => {
    expect(excelSafeText('=1+1')).toBe("'=1+1");
    expect(excelSafeText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(excelSafeText('-5')).toBe("'-5");
    expect(excelSafeText('normal')).toBe('normal');
  });
});
