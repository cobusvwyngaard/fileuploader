import { useCallback, useEffect, useState } from 'react';
import { STANDARD_EXCEL_COLUMNS } from '../../../../shared/constants';
import { api, type BrowserItem, type ConnectionStatus } from '../api';
import { Badge, errorMessage, ErrorAlert } from '../components/common';
import { DrivePicker } from '../components/DrivePicker';
import { fmtDate } from '../format';
import { useLocation } from '../router';

const CONNECT_RESULTS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Microsoft account connected.' },
  access_denied: { ok: false, text: 'Consent was declined. An administrator may need to grant consent for the app in Microsoft Entra.' },
  not_business_account: { ok: false, text: 'That account does not have OneDrive for Business. Sign in with your Microsoft 365 work account.' },
  no_onedrive: { ok: false, text: 'That account has no OneDrive provisioned yet. Open OneDrive once in a browser, then try again.' },
  invalid_state: { ok: false, text: 'The sign-in attempt expired or did not match. Please try again.' },
  invalid_client: { ok: false, text: 'Microsoft rejected the client credentials. Check MS_CLIENT_ID and MS_CLIENT_SECRET.' },
};

export function SettingsPage() {
  const url = useLocation();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [workbook, setWorkbook] = useState<BrowserItem | null>(null);
  const [tables, setTables] = useState<{ id: string; name: string }[] | null>(null);
  const [tableId, setTableId] = useState('');
  const [columns, setColumns] = useState<{ columns: string[]; mapping: { ok: boolean; errors: string[] } } | null>(null);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>>['entries']>([]);

  const load = useCallback(() => {
    api.status().then(setStatus, (e) => setError(errorMessage(e)));
    api.audit().then((r) => setAudit(r.entries), () => undefined);
  }, []);
  useEffect(load, [load]);

  const result = url.searchParams.get('microsoft');
  const resultInfo = result ? CONNECT_RESULTS[result] ?? { ok: false, text: `Microsoft sign-in failed (${result}).` } : null;

  const chooseWorkbook = async (item: BrowserItem) => {
    setPicking(false);
    setWorkbook(item);
    setTables(null);
    setColumns(null);
    setTableId('');
    try {
      const r = await api.tables(item.id);
      setTables(r.tables);
      if (r.tables.length === 1) await chooseTable(item, r.tables[0]!.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const chooseTable = async (wb: BrowserItem, id: string) => {
    setTableId(id);
    setColumns(null);
    if (!id) return;
    try {
      setColumns(await api.columns(wb.id, id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const saveTarget = async () => {
    if (!workbook || !tableId) return;
    setError(null);
    try {
      await api.setExcelTarget(workbook.id, tableId);
      setNotice('Excel workbook and table saved.');
      setWorkbook(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const conn = status?.connection;
  return (
    <>
      <h1>Settings</h1>
      {resultInfo && <div className={`alert ${resultInfo.ok ? 'success' : 'error'}`} role="status">{resultInfo.text}</div>}
      <ErrorAlert error={error} />
      {notice && <div className="alert success" role="status">{notice}</div>}

      <div className="card">
        <h2>Microsoft account</h2>
        {!status ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            {!status.configured.microsoft && (
              <div className="alert warning">Microsoft Entra settings (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET) are not configured on the Worker.</div>
            )}
            <dl className="kv">
              <dt>Status</dt>
              <dd><Badge value={conn!.status} /></dd>
              {conn!.userPrincipalName && (<><dt>Account</dt><dd>{conn!.displayName} ({conn!.userPrincipalName})</dd></>)}
              {conn!.connectedBy && (<><dt>Connected by</dt><dd>{conn!.connectedBy} on {fmtDate(conn!.connectedAt)}</dd></>)}
              {conn!.lastRefreshedAt && (<><dt>Token refreshed</dt><dd>{fmtDate(conn!.lastRefreshedAt)}</dd></>)}
              {conn!.lastError && (<><dt>Last error</dt><dd>{conn!.lastError}</dd></>)}
            </dl>
            {status.sessionsOnOtherDrive > 0 && (
              <div className="alert warning">{status.sessionsOnOtherDrive} open session(s) use a folder in a different OneDrive than the connected account. Choose their folders again.</div>
            )}
            <div className="row">
              <a className="btn primary" href="/api/admin/microsoft/connect">{conn!.status === 'disconnected' ? 'Connect Microsoft account' : 'Reconnect'}</a>
              {conn!.status !== 'disconnected' && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm('Disconnect? Uploads and Excel updates will stop until an account is connected again.')) return;
                    await api.disconnect();
                    load();
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>Excel reporting workbook</h2>
        {status?.excelTarget ? (
          <dl className="kv">
            <dt>Workbook</dt>
            <dd>{status.excelTarget.workbookWebUrl ? <a href={status.excelTarget.workbookWebUrl} target="_blank" rel="noopener noreferrer">{status.excelTarget.workbookPath}</a> : status.excelTarget.workbookPath}</dd>
            <dt>Table</dt>
            <dd>{status.excelTarget.tableName}</dd>
            <dt>Columns</dt>
            <dd className="small">{status.excelTarget.columns.join(', ')}</dd>
            <dt>Pending / failed rows</dt>
            <dd>{status.excelPending} / {status.excelFailed}</dd>
          </dl>
        ) : (
          <p className="muted">No workbook connected. Sessions cannot be published until one is.</p>
        )}
        <p className="small muted">The table must contain these columns: {STANDARD_EXCEL_COLUMNS.join(', ')}, plus one column per form field key.</p>
        <button type="button" className="btn" disabled={conn?.status !== 'connected'} onClick={() => setPicking(true)}>
          {status?.excelTarget ? 'Change workbook' : 'Choose workbook'}
        </button>
        {workbook && (
          <div className="stack">
            <h3>{workbook.path}</h3>
            {tables && tables.length === 0 && <div className="alert warning">This workbook has no named tables. Create one (Insert → Table) with the required headers.</div>}
            {tables && tables.length > 0 && (
              <div className="field">
                <label htmlFor="table">Table</label>
                <select id="table" value={tableId} onChange={(e) => chooseTable(workbook, e.target.value)}>
                  <option value="">Choose…</option>
                  {tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
            {columns && (
              columns.mapping.ok ? (
                <div className="alert success">All standard columns found. Columns: {columns.columns.join(', ')}</div>
              ) : (
                <div className="alert error"><ul>{columns.mapping.errors.map((m) => <li key={m}>{m}</li>)}</ul></div>
              )
            )}
            <button type="button" className="btn primary" disabled={!columns?.mapping.ok} onClick={saveTarget}>Use this table</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Recent activity</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th></tr></thead>
            <tbody>
              {audit.slice(0, 50).map((a) => (
                <tr key={a.id}>
                  <td className="small">{new Date(a.at).toLocaleString()}</td>
                  <td className="small">{a.actor}</td>
                  <td className="small">{a.action}</td>
                  <td className="small">{a.target_id ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {picking && <DrivePicker mode="workbook" onClose={() => setPicking(false)} onSelect={chooseWorkbook} />}
    </>
  );
}
