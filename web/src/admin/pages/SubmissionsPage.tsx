import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { SUBMISSION_STATUSES, type AdminSession } from '../../../../shared/types';
import { formatBytes } from '../../../../shared/validation';
import { api, type SubmissionListItem } from '../api';
import { Badge, errorMessage, ErrorAlert } from '../components/common';
import { fmtDate, STATE_LABELS } from '../format';
import { navigate, useLocation } from '../router';

export function SubmissionsPage() {
  const url = useLocation();
  const params = {
    q: url.searchParams.get('q') ?? '',
    sessionId: url.searchParams.get('sessionId') ?? '',
    status: url.searchParams.get('status') ?? '',
    page: Number(url.searchParams.get('page') ?? '1') || 1,
  };
  const [q, setQ] = useState(params.q);
  const [data, setData] = useState<Awaited<ReturnType<typeof api.submissions>> | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const key = url.search;
  const load = useCallback(() => {
    setError(null);
    api.submissions(params).then(setData, (e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(load, [load]);
  useEffect(() => {
    api.sessions().then((r) => setSessions(r.sessions), () => undefined);
  }, []);

  const go = (patch: Partial<typeof params>) => {
    const next = { ...params, page: 1, ...patch };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && !(k === 'page' && v === 1)) qs.set(k, String(v));
    navigate(`/admin/submissions${qs.toString() ? `?${qs}` : ''}`);
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    go({ q });
  };

  const retry = async (s: SubmissionListItem) => {
    setNotice(null);
    setError(null);
    try {
      const r = await api.retryReport(s.id);
      setNotice(r.outcome === 'complete' ? `${s.reference}: report sheet updated.` : `${s.reference}: report update still failing; it will be retried automatically.`);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <h1>Submissions</h1>
      <form className="card row" onSubmit={onSearch} role="search">
        <div className="field spacer">
          <label htmlFor="q">Search</label>
          <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference, filename, field value, session…" />
        </div>
        <div className="field">
          <label htmlFor="session">Session</label>
          <select id="session" value={params.sessionId} onChange={(e) => go({ sessionId: e.target.value })}>
            <option value="">All sessions</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" value={params.status} onChange={(e) => go({ status: e.target.value })}>
            <option value="">All statuses</option>
            {SUBMISSION_STATUSES.map((s) => <option key={s} value={s}>{STATE_LABELS[s]}</option>)}
          </select>
        </div>
        <button type="submit" className="btn primary">Search</button>
      </form>
      <ErrorAlert error={error} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      {!data ? (
        <p role="status">Loading…</p>
      ) : data.submissions.length === 0 ? (
        <div className="card"><p>No submissions found.</p></div>
      ) : (
        <div className="card table-wrap">
          <p className="muted small">{data.total} submission{data.total === 1 ? '' : 's'}</p>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Date</th>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col">Fields</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {data.submissions.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.reference}</strong></td>
                  <td className="small">{fmtDate(s.createdAt)}</td>
                  <td className="small">{s.sessionTitle}</td>
                  <td>
                    <Badge value={s.status} />
                    {s.failureReason && <div className="small muted">{s.failureStage}: {s.failureReason}</div>}
                    {s.status === 'excel_pending' && (
                      <div className="small muted">
                        Attempt {s.reportAttempts}
                        {s.reportNextAttemptAt ? `, next ${fmtDate(s.reportNextAttemptAt)}` : ''}
                        {s.reportLastError ? ` – ${s.reportLastError}` : ''}
                      </div>
                    )}
                    {(s.status === 'excel_pending' || (s.status === 'failed' && s.failureStage === 'excel')) && (
                      <button type="button" className="btn small" onClick={() => retry(s)}>Retry report</button>
                    )}
                  </td>
                  <td className="small">
                    <dl className="kv">
                      {s.fields.map((f) => (
                        <div key={f.key} className="contents">
                          <dt>{f.label}</dt>
                          <dd>{String(f.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                  <td className="small">
                    <ul className="unstyled-list">
                      {s.files.map((f) => (
                        <li key={f.id}>
                          {f.webUrl ? <a href={f.webUrl} target="_blank" rel="noopener noreferrer">{f.originalFilename}</a> : f.originalFilename}{' '}
                          <span className="muted">({formatBytes(f.size)}{f.status !== 'uploaded' ? `, ${f.status}` : ''}{f.failureReason ? `: ${f.failureReason}` : ''})</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <nav className="row" aria-label="Pagination">
              <button type="button" className="btn small" disabled={params.page <= 1} onClick={() => go({ ...params, page: params.page - 1 })}>Previous</button>
              <span className="small">Page {params.page} of {pages}</span>
              <button type="button" className="btn small" disabled={params.page >= pages} onClick={() => go({ ...params, page: params.page + 1 })}>Next</button>
            </nav>
          )}
        </div>
      )}
    </>
  );
}
