import type { AdminSession, SessionConfigInput, SubmissionStatus } from '../../../shared/types';
import { requestJson } from '../common/http';

export interface ConnectionStatus {
  connection: {
    status: 'connected' | 'needs_reauth' | 'disconnected';
    email?: string | null;
    connectedBy?: string | null;
    connectedAt?: string | null;
    lastRefreshedAt?: string | null;
    lastError?: string | null;
  };
  reportSheet: null | {
    spreadsheetId: string;
    spreadsheetName: string;
    spreadsheetUrl: string | null;
    sheetId: number;
    sheetTitle: string;
    columns: string[];
    updatedAt: string;
  };
  reportPending: number;
  reportFailed: number;
  configured: { google: boolean; encryptionKey: boolean };
}

export interface DriveFolder {
  id: string;
  name: string;
  path: string;
  webUrl?: string;
}

export interface SheetTab {
  sheetId: number;
  title: string;
  header: string[];
  missing: string[];
}

export interface SubmissionListItem {
  id: string;
  reference: string;
  sessionId: string;
  sessionTitle: string;
  status: SubmissionStatus;
  failureStage: 'upload' | 'excel' | null;
  failureReason: string | null;
  reportAttempts: number;
  reportLastError: string | null;
  reportNextAttemptAt: string | null;
  createdAt: string;
  completedAt: string | null;
  fields: { key: string; label: string; value: string | number }[];
  files: {
    id: string;
    originalFilename: string;
    storedFilename: string;
    size: number;
    status: string;
    failureReason: string | null;
    webUrl: string | null;
    path: string | null;
    contentType: string | null;
    reportStatus: string;
  }[];
}

export const api = {
  me: () => requestJson<{ email: string; environment: string }>('GET', '/api/admin/me'),
  status: () => requestJson<ConnectionStatus>('GET', '/api/admin/google/status'),
  disconnect: () => requestJson<{ ok: boolean; revoked: boolean }>('POST', '/api/admin/google/disconnect', {}),
  folders: () => requestJson<{ folders: DriveFolder[] }>('GET', '/api/admin/drive/folders'),
  createFolder: (name: string, parentId?: string) => requestJson<{ folder: DriveFolder }>('POST', '/api/admin/drive/folders', { name, parentId }),
  spreadsheets: () => requestJson<{ spreadsheets: { id: string; name: string; webUrl?: string }[] }>('GET', '/api/admin/sheets/spreadsheets'),
  tabs: (spreadsheetId: string) =>
    requestJson<{ spreadsheet: { id: string; name: string; url: string }; tabs: SheetTab[] }>('GET', `/api/admin/sheets/tabs?spreadsheetId=${encodeURIComponent(spreadsheetId)}`),
  createSpreadsheet: (name: string, extraColumns: string[]) =>
    requestJson<{ spreadsheet: { id: string; name: string; url: string } }>('POST', '/api/admin/sheets/create', { name, extraColumns }),
  setSheetTarget: (spreadsheetId: string, sheetId: number) => requestJson('PUT', '/api/admin/sheets/target', { spreadsheetId, sheetId }),
  sessions: () => requestJson<{ sessions: AdminSession[] }>('GET', '/api/admin/sessions'),
  session: (id: string) => requestJson<{ session: AdminSession }>('GET', `/api/admin/sessions/${id}`),
  createSession: (cfg: SessionConfigInput) => requestJson<{ session: AdminSession }>('POST', '/api/admin/sessions', cfg),
  updateSession: (id: string, cfg: SessionConfigInput) => requestJson<{ session: AdminSession }>('PUT', `/api/admin/sessions/${id}`, cfg),
  validateSession: (id: string) => requestJson<{ ok: boolean; errors: string[] }>('POST', `/api/admin/sessions/${id}/validate`, {}),
  sessionAction: (id: string, action: 'publish' | 'unpublish' | 'close' | 'duplicate' | 'rotate-link') =>
    requestJson<{ session: AdminSession }>('POST', `/api/admin/sessions/${id}/${action}`, {}),
  submissions: (params: { q?: string; sessionId?: string; status?: string; page?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return requestJson<{ page: number; pageSize: number; total: number; submissions: SubmissionListItem[] }>('GET', `/api/admin/submissions?${qs}`);
  },
  retryReport: (id: string) => requestJson<{ outcome: string }>('POST', `/api/admin/submissions/${id}/retry-report`, {}),
  audit: () =>
    requestJson<{ entries: { id: number; at: number; actor: string; action: string; target_type: string | null; target_id: string | null; details_json: string | null }[] }>(
      'GET',
      '/api/admin/audit',
    ),
};
