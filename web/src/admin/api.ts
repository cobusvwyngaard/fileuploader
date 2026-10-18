import type { AdminSession, SessionConfigInput, SubmissionStatus } from '../../../shared/types';
import { requestJson } from '../common/http';

export interface ConnectionStatus {
  connection: {
    status: 'connected' | 'needs_reauth' | 'disconnected';
    userPrincipalName?: string | null;
    displayName?: string | null;
    connectedBy?: string | null;
    connectedAt?: string | null;
    lastRefreshedAt?: string | null;
    lastError?: string | null;
  };
  excelTarget: null | {
    driveId: string;
    itemId: string;
    workbookName: string;
    workbookPath: string;
    workbookWebUrl: string | null;
    tableId: string;
    tableName: string;
    columns: string[];
    updatedAt: string;
  };
  excelPending: number;
  excelFailed: number;
  sessionsOnOtherDrive: number;
  configured: { microsoft: boolean; encryptionKey: boolean };
}

export interface BrowserItem {
  id: string;
  driveId: string;
  name: string;
  path: string;
  webUrl?: string;
  isFolder: boolean;
  isWorkbook: boolean;
  childCount: number;
  size: number;
}

export interface SubmissionListItem {
  id: string;
  reference: string;
  sessionId: string;
  sessionTitle: string;
  status: SubmissionStatus;
  failureStage: 'upload' | 'excel' | null;
  failureReason: string | null;
  excelAttempts: number;
  excelLastError: string | null;
  excelNextAttemptAt: string | null;
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
    excelStatus: string;
  }[];
}

export const api = {
  me: () => requestJson<{ email: string; environment: string }>('GET', '/api/admin/me'),
  status: () => requestJson<ConnectionStatus>('GET', '/api/admin/microsoft/status'),
  disconnect: () => requestJson('POST', '/api/admin/microsoft/disconnect', {}),
  children: (itemId: string) =>
    requestJson<{ current: BrowserItem & { parentId: string | null }; items: BrowserItem[] }>('GET', `/api/admin/drive/children?itemId=${encodeURIComponent(itemId)}`),
  tables: (itemId: string) => requestJson<{ tables: { id: string; name: string }[] }>('GET', `/api/admin/excel/tables?itemId=${encodeURIComponent(itemId)}`),
  columns: (itemId: string, tableId: string) =>
    requestJson<{ columns: string[]; mapping: { ok: boolean; errors: string[] } }>(
      'GET',
      `/api/admin/excel/columns?itemId=${encodeURIComponent(itemId)}&tableId=${encodeURIComponent(tableId)}`,
    ),
  setExcelTarget: (itemId: string, tableId: string) => requestJson('PUT', '/api/admin/excel/target', { itemId, tableId }),
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
  retryExcel: (id: string) => requestJson<{ outcome: string }>('POST', `/api/admin/submissions/${id}/retry-excel`, {}),
  audit: () =>
    requestJson<{ entries: { id: number; at: number; actor: string; action: string; target_type: string | null; target_id: string | null; details_json: string | null }[] }>(
      'GET',
      '/api/admin/audit',
    ),
};
