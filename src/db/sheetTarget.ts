import type { Env } from '../env';

export interface SheetTargetRow {
  id: 'primary';
  spreadsheet_id: string;
  spreadsheet_name: string;
  spreadsheet_url: string | null;
  sheet_id: number;
  sheet_title: string;
  columns_json: string;
  updated_by: string;
  updated_at: number;
}

export function getSheetTarget(env: Env): Promise<SheetTargetRow | null> {
  return env.DB.prepare("SELECT * FROM sheet_target WHERE id = 'primary'").first<SheetTargetRow>();
}
