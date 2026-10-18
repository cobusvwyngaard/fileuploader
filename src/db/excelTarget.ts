import type { Env } from '../env';

export interface ExcelTargetRow {
  id: 'primary';
  drive_id: string;
  item_id: string;
  workbook_name: string;
  workbook_path: string;
  workbook_web_url: string | null;
  table_id: string;
  table_name: string;
  columns_json: string;
  updated_by: string;
  updated_at: number;
}

export function getExcelTarget(env: Env): Promise<ExcelTargetRow | null> {
  return env.DB.prepare("SELECT * FROM excel_target WHERE id = 'primary'").first<ExcelTargetRow>();
}
