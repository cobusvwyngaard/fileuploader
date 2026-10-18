import { useEffect, useState, type FormEvent } from 'react';
import type { AdminSession, SessionConfigInput } from '../../../../shared/types';
import { validateSessionConfig } from '../../../../shared/validation';
import { api } from '../api';
import { Badge, errorMessage } from '../components/common';
import { DrivePicker } from '../components/DrivePicker';
import { FIELD_PRESETS, FieldsEditor } from '../components/FieldsEditor';
import { QrDialog } from '../components/QrDialog';
import { fromLocalInput, toLocalInput } from '../format';
import { navigate } from '../router';

const MB = 1024 * 1024;

function defaults(): SessionConfigInput {
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  expires.setMinutes(0, 0, 0);
  return {
    title: '',
    instructions: '',
    folder: null,
    expiresAt: expires.toISOString(),
    maxSubmissions: null,
    fileRules: { allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'docx', 'xlsx'], maxFileSizeBytes: 100 * MB, maxFilesPerSubmission: 5 },
    fields: [FIELD_PRESETS[0]!, FIELD_PRESETS[1]!].map((f) => ({ ...f })),
    showOneDriveLinks: false,
  };
}

export function SessionEditor({ id }: { id: string | null }) {
  const [cfg, setCfg] = useState<SessionConfigInput | null>(id ? null : defaults());
  const [session, setSession] = useState<AdminSession | null>(null);
  const [extText, setExtText] = useState('');
  const [sizeMb, setSizeMb] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(() => {
    const saved = new URLSearchParams(window.location.search).get('saved');
    return saved === 'published' ? 'Saved and published. Share the link or QR code below.' : saved ? 'Saved.' : null;
  });
  const [picker, setPicker] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const apply = (c: SessionConfigInput) => {
      setCfg(c);
      setExtText(c.fileRules.allowedExtensions.join(', '));
      setSizeMb(String(Math.round((c.fileRules.maxFileSizeBytes / MB) * 100) / 100));
    };
    if (!id) {
      apply(defaults());
      return;
    }
    api.session(id).then(
      (r) => {
        setSession(r.session);
        apply(r.session);
      },
      (e) => setErrors([errorMessage(e)]),
    );
  }, [id]);

  if (!cfg) return <p role="status">{errors[0] ?? 'Loading…'}</p>;
  const set = (patch: Partial<SessionConfigInput>) => setCfg({ ...cfg, ...patch });
  const readOnly = session?.status === 'closed';

  const build = (): SessionConfigInput => ({
    ...cfg,
    fileRules: {
      ...cfg.fileRules,
      allowedExtensions: extText.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean),
      maxFileSizeBytes: Math.round(Number(sizeMb) * MB),
    },
    fields: cfg.fields.map((f) => ({ ...f, options: f.type === 'select' ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : undefined })),
  });

  const save = async (andPublish: boolean) => {
    setErrors([]);
    setNotice(null);
    const input = build();
    const local = validateSessionConfig(input, { forPublish: andPublish, now: new Date() });
    if (local.errors.length) {
      setErrors(local.errors);
      return;
    }
    setBusy(true);
    try {
      let saved = id ? (await api.updateSession(id, input)).session : (await api.createSession(input)).session;
      if (andPublish && saved.status !== 'published') saved = (await api.sessionAction(saved.id, 'publish')).session;
      setSession(saved);
      setNotice(andPublish ? 'Saved and published. Share the link or QR code below.' : 'Saved.');
      if (!id) navigate(`/admin/sessions/${saved.id}?saved=${andPublish ? 'published' : '1'}`);
    } catch (e) {
      setErrors(errorMessage(e).split(/(?<=\.)\s+(?=[A-Z])/));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!id) return;
    setErrors([]);
    setNotice(null);
    try {
      const r = await api.validateSession(id);
      if (r.ok) setNotice('Ready to publish: the destination folder and Excel column mapping are valid.');
      else setErrors(r.errors);
    } catch (e) {
      setErrors([errorMessage(e)]);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  return (
    <>
      <div className="row">
        <h1>{id ? 'Edit upload session' : 'New upload session'}</h1>
        {session && <Badge value={session.effectiveState} />}
      </div>
      {errors.length > 0 && (
        <div className="alert error" role="alert">
          <strong>Please fix the following:</strong>
          <ul>{errors.map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}
      {notice && <div className="alert success" role="status">{notice}</div>}
      {readOnly && <div className="alert warning">This session is closed and cannot be edited. Duplicate it from the sessions list to reuse it.</div>}

      {session && (
        <div className="card">
          <h2>Share</h2>
          <p className="share-link">{session.shareUrl}</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(session.shareUrl).then(() => setNotice('Link copied.'))}>Copy link</button>
            <button type="button" className="btn" onClick={() => setShowQr(true)}>QR code</button>
            {!readOnly && (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  if (!confirm('Create a new link? The current link and QR code will stop working immediately.')) return;
                  const r = await api.sessionAction(session.id, 'rotate-link');
                  setSession(r.session);
                  setNotice('A new link was created. The old link no longer works.');
                }}
              >
                Replace link
              </button>
            )}
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate>
        <fieldset disabled={readOnly || busy} className="unstyled">
          <div className="card">
            <h2>Details</h2>
            <div className="field">
              <label htmlFor="title">Title</label>
              <input id="title" type="text" value={cfg.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="instructions">Instructions (optional)</label>
              <textarea id="instructions" value={cfg.instructions} maxLength={5000} onChange={(e) => set({ instructions: e.target.value })} />
            </div>
            <div className="grid">
              <div className="field">
                <label htmlFor="expires">Expires</label>
                <input id="expires" type="datetime-local" value={toLocalInput(cfg.expiresAt)} onChange={(e) => set({ expiresAt: fromLocalInput(e.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="max-subs">Maximum submissions</label>
                <input
                  id="max-subs"
                  type="number"
                  min={1}
                  placeholder="Unlimited"
                  value={cfg.maxSubmissions ?? ''}
                  onChange={(e) => set({ maxSubmissions: e.target.value ? Number(e.target.value) : null })}
                />
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Destination folder</h2>
            {cfg.folder ? (
              <p>
                <strong>{cfg.folder.path || '/'}</strong>{' '}
                {cfg.folder.webUrl && <a href={cfg.folder.webUrl} target="_blank" rel="noopener noreferrer">Open in OneDrive</a>}
              </p>
            ) : (
              <p className="muted">No folder selected.</p>
            )}
            <button type="button" className="btn" onClick={() => setPicker(true)}>{cfg.folder ? 'Change folder' : 'Choose folder'}</button>
            <p className="muted small">Uploaders can never choose or see this folder.</p>
          </div>

          <div className="card">
            <h2>File rules</h2>
            <div className="grid">
              <div className="field">
                <label htmlFor="exts">Allowed extensions</label>
                <input id="exts" type="text" value={extText} onChange={(e) => setExtText(e.target.value)} aria-describedby="exts-hint" />
                <p className="hint" id="exts-hint">Comma separated, e.g. pdf, jpg, docx</p>
              </div>
              <div className="field">
                <label htmlFor="size">Maximum size per file (MB)</label>
                <input id="size" type="number" min={0.01} step="any" value={sizeMb} onChange={(e) => setSizeMb(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="max-files">Maximum files per submission</label>
                <input
                  id="max-files"
                  type="number"
                  min={1}
                  max={20}
                  value={cfg.fileRules.maxFilesPerSubmission}
                  onChange={(e) => set({ fileRules: { ...cfg.fileRules, maxFilesPerSubmission: Number(e.target.value) } })}
                />
              </div>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={cfg.showOneDriveLinks} onChange={(e) => set({ showOneDriveLinks: e.target.checked })} />
              Show uploaders the OneDrive link to their own files (they will need access to open it)
            </label>
          </div>

          <div className="card">
            <h2>Form fields</h2>
            <p className="muted small">Each field is written to the Excel column with the same name as its internal key, unless you set a different Excel column.</p>
            <FieldsEditor fields={cfg.fields} onChange={(fields) => set({ fields })} />
          </div>

          <div className="row end">
            {id && <button type="button" className="btn" onClick={check}>Check Excel mapping</button>}
            <button type="submit" className="btn">Save</button>
            {session?.status !== 'published' && (
              <button type="button" className="btn primary" onClick={() => save(true)}>Save and publish</button>
            )}
          </div>
        </fieldset>
      </form>

      {picker && (
        <DrivePicker
          mode="folder"
          onClose={() => setPicker(false)}
          onSelect={(item) => {
            set({ folder: { driveId: item.driveId, itemId: item.id, path: item.path, webUrl: item.webUrl } });
            setPicker(false);
          }}
        />
      )}
      {showQr && session && <QrDialog url={session.shareUrl} title={session.title} onClose={() => setShowQr(false)} />}
    </>
  );
}
