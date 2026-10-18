import { useCallback, useEffect, useState } from 'react';
import type { AdminSession } from '../../../../shared/types';
import { api } from '../api';
import { Badge, errorMessage, ErrorAlert } from '../components/common';
import { QrDialog } from '../components/QrDialog';
import { fmtDate } from '../format';
import { Link, navigate } from '../router';

export function SessionsPage() {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qr, setQr] = useState<AdminSession | null>(null);

  const load = useCallback(() => {
    api.sessions().then((r) => setSessions(r.sessions), (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (s: AdminSession, action: 'publish' | 'unpublish' | 'close' | 'duplicate') => {
    if (action === 'close' && !confirm(`Close “${s.title}”? It will stop accepting uploads permanently.`)) return;
    setError(null);
    setNotice(null);
    try {
      const r = await api.sessionAction(s.id, action);
      if (action === 'duplicate') navigate(`/admin/sessions/${r.session.id}`);
      else {
        setNotice(`“${s.title}” ${action === 'publish' ? 'published' : action === 'unpublish' ? 'unpublished' : 'closed'}.`);
        load();
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const copy = async (s: AdminSession) => {
    try {
      await navigator.clipboard.writeText(s.shareUrl);
      setNotice(`Link for “${s.title}” copied.`);
    } catch {
      setError('Copy failed. Select the link and copy it manually.');
    }
  };

  return (
    <>
      <div className="row">
        <h1>Upload sessions</h1>
        <span className="spacer" />
        <Link className="btn primary" href="/admin/sessions/new">New session</Link>
      </div>
      <ErrorAlert error={error} />
      {notice && <div className="alert success" role="status">{notice}</div>}
      {!sessions ? (
        <p role="status">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="card"><p>No upload sessions yet. Create one to get a shareable link and QR code.</p></div>
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">Destination</th>
                <th scope="col">Submissions</th>
                <th scope="col">Share</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/admin/sessions/${s.id}`}>{s.title}</Link></td>
                  <td><Badge value={s.effectiveState} /></td>
                  <td>{fmtDate(s.expiresAt)}</td>
                  <td className="small">{s.folder ? (s.folder.webUrl ? <a href={s.folder.webUrl} target="_blank" rel="noopener noreferrer">{s.folder.path}</a> : s.folder.path) : <span className="muted">Not set</span>}</td>
                  <td>
                    <Link href={`/admin/submissions?sessionId=${s.id}`}>{s.submissionCount}{s.maxSubmissions ? ` / ${s.maxSubmissions}` : ''}</Link>
                  </td>
                  <td>
                    <div className="actions">
                      <button type="button" className="btn small" onClick={() => copy(s)} aria-label={`Copy link for ${s.title}`}>Copy link</button>
                      <button type="button" className="btn small" onClick={() => setQr(s)} aria-label={`QR code for ${s.title}`}>QR</button>
                    </div>
                  </td>
                  <td>
                    <div className="actions">
                      {s.status !== 'closed' && <Link className="btn small" href={`/admin/sessions/${s.id}`}>Edit</Link>}
                      {(s.status === 'draft' || s.status === 'unpublished') && (
                        <button type="button" className="btn small" onClick={() => act(s, 'publish')}>Publish</button>
                      )}
                      {s.status === 'published' && <button type="button" className="btn small" onClick={() => act(s, 'unpublish')}>Unpublish</button>}
                      <button type="button" className="btn small" onClick={() => act(s, 'duplicate')}>Duplicate</button>
                      {s.status !== 'closed' && <button type="button" className="btn small danger" onClick={() => act(s, 'close')}>Close</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {qr && <QrDialog url={qr.shareUrl} title={qr.title} onClose={() => setQr(null)} />}
    </>
  );
}
