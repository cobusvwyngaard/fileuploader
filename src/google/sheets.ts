// Google Sheets operations on the report spreadsheet. Values are written with
// valueInputOption=RAW, so submitted text is never interpreted as a formula.
import { GoogleClient } from './client';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export type CellValue = string | number | boolean;

export interface SpreadsheetInfo {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties: { title: string };
  sheets: { properties: { sheetId: number; title: string } }[];
}

/** A1 range for a whole sheet tab, quoting the title. */
export const sheetRange = (title: string, a1 = '') => `'${title.replace(/'/g, "''")}'${a1 ? `!${a1}` : ''}`;

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export class SheetsService {
  constructor(private readonly google: GoogleClient) {}

  getSpreadsheet(id: string) {
    return this.google.request<SpreadsheetInfo>(
      'GET',
      `${SHEETS_API}/${encodeURIComponent(id)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)`,
      { allow404: true },
    );
  }

  /** Creates a spreadsheet with one tab whose first row holds `headers`. */
  createSpreadsheet(title: string, tabTitle: string, headers: string[]) {
    return this.google.request<SpreadsheetInfo>('POST', `${SHEETS_API}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)`, {
      body: {
        properties: { title },
        sheets: [
          {
            properties: { title: tabTitle, gridProperties: { frozenRowCount: 1 } },
            data: [{ startRow: 0, startColumn: 0, rowData: [{ values: headers.map((h) => ({ userEnteredValue: { stringValue: h }, userEnteredFormat: { textFormat: { bold: true } } })) }] }],
          },
        ],
      },
    });
  }

  /** Returns the tab's title for a stable sheetId (tabs can be renamed). */
  async resolveTitle(spreadsheetId: string, sheetId: number): Promise<string | null> {
    const info = await this.getSpreadsheet(spreadsheetId);
    return info?.sheets.find((s) => s.properties.sheetId === sheetId)?.properties.title ?? null;
  }

  async readHeader(spreadsheetId: string, title: string): Promise<string[]> {
    const res = await this.google.request<{ values?: string[][] }>(
      'GET',
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetRange(title, '1:1'))}?majorDimension=ROWS`,
    );
    return (res.values?.[0] ?? []).map((v) => String(v));
  }

  /** Reads one column below the header (used for duplicate detection). */
  async readColumn(spreadsheetId: string, title: string, index: number): Promise<string[]> {
    const col = columnLetter(index);
    const res = await this.google.request<{ values?: (string | number)[][] }>(
      'GET',
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetRange(title, `${col}2:${col}`))}?majorDimension=ROWS`,
    );
    return (res.values ?? []).map((r) => (r[0] === undefined ? '' : String(r[0])));
  }

  /** Writes header cells starting at a column (used to add missing columns). */
  async writeHeaderCells(spreadsheetId: string, title: string, startIndex: number, headers: string[]): Promise<void> {
    const a1 = `${columnLetter(startIndex)}1:${columnLetter(startIndex + headers.length - 1)}1`;
    await this.google.request('PUT', `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetRange(title, a1))}?valueInputOption=RAW`, {
      body: { majorDimension: 'ROWS', values: [headers] },
    });
  }

  /** Appends rows after the last row of data, in one request. */
  async appendRows(spreadsheetId: string, title: string, rows: CellValue[][]): Promise<void> {
    await this.google.request(
      'POST',
      `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetRange(title, 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { body: { majorDimension: 'ROWS', values: rows } },
    );
  }
}
