// Excel Online (workbook) operations on the configured reporting table.
import { enc, GraphClient } from './graph';

export interface ExcelTable {
  id: string;
  name: string;
  showHeaders?: boolean;
}

export interface ExcelColumn {
  id: string;
  name: string;
  index: number;
  values?: (string | number | boolean | null)[][];
}

export type CellValue = string | number | boolean | null;

export class ExcelService {
  constructor(private readonly graph: GraphClient) {}

  private base(driveId: string, itemId: string) {
    return `/drives/${enc(driveId)}/items/${enc(itemId)}/workbook`;
  }

  listTables(driveId: string, itemId: string) {
    return this.graph.list<ExcelTable>(`${this.base(driveId, itemId)}/tables?$select=id,name,showHeaders`, 2);
  }

  async listColumns(driveId: string, itemId: string, tableId: string): Promise<ExcelColumn[]> {
    const cols = await this.graph.list<ExcelColumn>(`${this.base(driveId, itemId)}/tables/${enc(tableId)}/columns?$select=id,name,index`, 2);
    return cols.sort((a, b) => a.index - b.index);
  }

  /** Reads every data value of one column (header excluded), used for duplicate detection. */
  async readColumnValues(driveId: string, itemId: string, tableId: string, columnId: string): Promise<string[]> {
    const range = await this.graph.request<{ values: CellValue[][] }>(
      'GET',
      `${this.base(driveId, itemId)}/tables/${enc(tableId)}/columns/${enc(columnId)}/dataBodyRange?$select=values`,
    );
    return (range.values ?? []).map((row) => (row[0] === null || row[0] === undefined ? '' : String(row[0])));
  }

  /** Appends rows to the end of the table in a single request. */
  async addRows(driveId: string, itemId: string, tableId: string, rows: CellValue[][]): Promise<void> {
    await this.graph.request('POST', `${this.base(driveId, itemId)}/tables/${enc(tableId)}/rows/add`, {
      body: { index: null, values: rows },
    });
  }
}
