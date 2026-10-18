import { useCallback, useEffect, useState } from 'react';
import { STANDARD_REPORT_COLUMNS } from '../../../../shared/constants';
import { api, type ConnectionStatus, type SheetTab } from '../api';
import { Badge, errorMessage, ErrorAlert } from '../components/common';
import { fmtDate } from '../format';
import { useLocation } from '../router';

const CONNECT_RESULTS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google account connected.' },
  access_denied: { ok: false, text: 'Access was declined on the Google consent screen.' },
  drive_scope_missing: { ok: false, text: 'Google Drive access was not granted. Reconnect and tick the Google Drive permission on the consent screen.' },
  invalid_state: { ok: false, text: 'The sign-in attempt expired or did not match. Please try again.' },
  invalid_client: { ok: false, text: 'Google rejected the client credentials. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' },
  redirect_uri_mismatch: { ok: false, text: 'The redirect URI is not registered on the Google OAuth client.' },
};

export function SettingsPage() {
  const url = useLocation();
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('Upload sessions report');
  const [extraCols, setExtraCols] = useState('table_number, description');
  const [sheetList, setSheetList] = useState<{ id: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState<{ id: string; name: string; tabs: SheetTab[] } | null>(null);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>>['entries']>([]);

  const load = useCallback(() => {
    api.status().then(setStatus, (e) => setError(errorMessage(e)));
    api.audit().then((r) => setAudit(r.entries), () => undefined);
  }, []);
  useEffect(load, [load]);

  const result = url.searchParams.get('google');
  const resultInfo = result ? CONNECT_RESULTS[result] ?? { ok: false, text: `Google sign-in failed (${result}).` } : null;
  const conn = status?.connection;
  const connected = conn?.status === 'connected';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const useTab = (spreadsheetId: string, tab: SheetTab) =>
    run(async () => {
      await api.setSheetTarget(spreadsheetId, tab.sheetId);
      setChosen(null);
      setSheetList(null);
      setNotice(`Reporting to tab “${tab.title}”.`);
      load();
    });

  const createSheet = () =>
    run(async () => {
      const extra = extraCols.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const { spreadsheet } = await api.createSpreadsheet(newName, extra);
      const { tabs } = await api.tabs(spreadsheet.id);
      await api.setSheetTarget(spreadsheet.id, tabs[0]!.sheetId);
      setNotice(`Created “${spreadsheet.name}” in your Google Drive and selected it for reporting.`);
      load();
    });

  const pickSheet = (id: string, name: string) =>
    run(async () => {
      const { tabs } = await api.tabs(id);
      setChosen({ id, name, tabs });
    });

  return (
    <>
      <h1>Settings</h1>
      {resultInfo && <div className={`alert ${resultInfo.ok ? 'success' : 'error'}`} role="status">{resultInfo.text}</div>}
      <ErrorAlert error={error} />
      {notice && <div className="alert success" role="status">{notice}</div>}

      <div className="card">
        <h2>Google account</h2>
        {!status ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            {!status.configured.google && (
              <div className="alert warning">Google OAuth settings (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not configured on the Worker.</div>
            )}
            <dl className="kv">
              <dt>Status</dt>
              <dd><Badge value={conn!.status} /></dd>
              {conn!.email && (<><dt>Account</dt><dd>{conn!.email}</dd></>)}
              {conn!.connectedBy && (<><dt>Connected by</dt><dd>{conn!.connectedBy} on {fmtDate(conn!.connectedAt)}</dd></>)}
              {conn!.lastRefreshedAt && (<><dt>Token refreshed</dt><dd>{fmtDate(conn!.lastRefreshedAt)}</dd></>)}
              {conn!.lastError && (<><dt>Last error</dt><dd>{conn!.lastError}</dd></>)}
            </dl>
            <p className="small muted">The app can only see folders and spreadsheets it creates in this Google Drive (the drive.file permission).</p>
            <div className="row">
              <a className="btn primary" href="/api/admin/google/connect">{conn!.status === 'disconnected' ? 'Connect Google account' : 'Reconnect'}</a>
              {conn!.status !== 'disconnected' && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm('Disconnect? Access is revoked at Google, and uploads and report updates stop until an account is connected again.')) return;
                    await run(async () => {
                      const r = await api.disconnect();
                      setNotice(r.revoked ? 'Disconnected and access revoked at Google.' : 'Disconnected. Google did not confirm revocation; remove access at myaccount.google.com → Security → Third-party connections.');
                      load();
                    });
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
        <h2>Report spreadsheet</h2>
        {status?.reportSheet ? (
          <dl className="kv">
            <dt>Spreadsheet</dt>
            <dd>{status.reportSheet.spreadsheetUrl ? <a href={status.reportSheet.spreadsheetUrl} target="_blank" rel="noopener noreferrer">{status.reportSheet.spreadsheetName}</a> : status.reportSheet.spreadsheetName}</dd>
            <dt>Tab</dt>
            <dd>{status.reportSheet.sheetTitle}</dd>
            <dt>Columns</dt>
            <dd className="small">{status.reportSheet.columns.join(', ')}</dd>
            <dt>Pending / failed rows</dt>
            <dd>{status.reportPending} / {status.reportFailed}</dd>
          </dl>
        ) : (
          <p className="muted">No report spreadsheet yet. Sessions cannot be published until one is selected.</p>
        )}
        <p className="small muted">
          Row 1 of the tab must contain these headers: {STANDARD_REPORT_COLUMNS.join(', ')}, plus one header per form-field key (for example table_number, description).
        </p>

        <fieldset disabled={!connected || busy} className="unstyled stack">
          <h3>Create a new report spreadsheet</h3>
          <div className="grid">
            <div className="field">
              <label htmlFor="sheet-name">Spreadsheet name</label>
              <input id="sheet-name" type="text" maxLength={120} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sheet-extra">Field columns to add</label>
              <input id="sheet-extra" type="text" value={extraCols} onChange={(e) => setExtraCols(e.target.value)} aria-describedby="sheet-extra-hint" />
              <p className="hint" id="sheet-extra-hint">Form-field keys, comma separated. You can add more headers in the sheet later.</p>
            </div>
          </div>
          <button type="button" className="btn primary" onClick={createSheet}>Create spreadsheet</button>

          <h3>Or use a spreadsheet this app created earlier</h3>
          <button type="button" className="btn" onClick={() => run(async () => setSheetList((await api.spreadsheets()).spreadsheets))}>
            List spreadsheets
          </button>
          {sheetList && (
            <ul className="picker-list" aria-label="Spreadsheets">
              {sheetList.length === 0 && <li className="muted"><span className="small">&nbsp;None found.</span></li>}
              {sheetList.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => pickSheet(s.id, s.name)}><span aria-hidden="true">📊</span><span>{s.name}</span></button>
                </li>
              ))}
            </ul>
          )}
          {chosen && (
            <div className="stack">
              <h3>{chosen.name}: choose a tab</h3>
              {chosen.tabs.map((t) => (
                <div key={t.sheetId} className="row">
                  <strong>{t.title}</strong>
                  {t.missing.length ? (
                    <span className="small error-text">Missing headers: {t.missing.join(', ')}</span>
                  ) : (
                    <button type="button" className="btn small primary" onClick={() => useTab(chosen.id, t)}>Use this tab</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </fieldset>
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
    </>
  );
}
