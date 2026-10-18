import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { formatBytes, validateDeclaredFiles, validateFieldValues } from '../../../shared/validation';
import type {
  CompleteFileResponse,
  CreateSubmissionResponse,
  PublicSessionView,
  SubmissionStatusResponse,
  UploadUrlResponse,
} from '../../../shared/types';
import { HttpError, requestJson } from '../common/http';
import { UploadAbortedError, UploadSessionGoneError, uploadToSession } from './uploader';

type Phase =
  | { kind: 'loading' }
  | { kind: 'link_error'; title: string; message: string }
  | { kind: 'form' }
  | { kind: 'resume'; saved: SavedSubmission; status: SubmissionStatusResponse }
  | { kind: 'uploading' }
  | { kind: 'done'; reference: string; links: { name: string; url: string }[] };

interface SavedSubmission {
  submissionId: string;
  secret: string;
  reference: string;
  chunkSize: number;
}

interface FileProgress {
  fileId: string;
  name: string;
  size: number;
  uploaded: number;
  state: 'waiting' | 'uploading' | 'verifying' | 'done' | 'error';
  error?: string;
}

const LINK_ERRORS: Record<string, string> = {
  invalid_link: 'Link not recognised',
  not_published: 'Not accepting uploads',
  closed: 'Upload link closed',
  expired: 'Upload link expired',
  exhausted: 'Submission limit reached',
};

function readToken(): string {
  return decodeURIComponent(window.location.hash.replace(/^#/, '')).trim();
}

// The submission secret is kept only in this tab's sessionStorage so an
// interrupted upload can be resumed after a reload.
const storageKey = (token: string) => `upload-submission:${token.slice(0, 16)}`;
function loadSaved(token: string): SavedSubmission | null {
  try {
    const raw = sessionStorage.getItem(storageKey(token));
    return raw ? (JSON.parse(raw) as SavedSubmission) : null;
  } catch {
    return null;
  }
}
function save(token: string, s: SavedSubmission | null) {
  try {
    if (s) sessionStorage.setItem(storageKey(token), JSON.stringify(s));
    else sessionStorage.removeItem(storageKey(token));
  } catch {
    /* storage unavailable: resume after reload will not be offered */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function App() {
  const token = useMemo(readToken, []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [session, setSession] = useState<PublicSessionView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<FileProgress[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileMapRef = useRef(new Map<string, File>());
  const savedRef = useRef<SavedSubmission | null>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!token) {
      setPhase({ kind: 'link_error', title: LINK_ERRORS.invalid_link!, message: 'This page needs a complete upload link. Open the link or scan the QR code you were given.' });
      return;
    }
    (async () => {
      try {
        const s = await requestJson<PublicSessionView>('POST', '/api/public/session', { token });
        setSession(s);
        document.title = `${s.title} – Upload files`;
        const saved = loadSaved(token);
        if (saved) {
          try {
            const status = await requestJson<SubmissionStatusResponse>('POST', `/api/public/submissions/${saved.submissionId}/status`, { secret: saved.secret });
            if (['uploaded', 'excel_pending', 'complete'].includes(status.status)) {
              setPhase({ kind: 'done', reference: status.reference, links: [] });
              return;
            }
            if ((status.status === 'uploading' || status.status === 'created') && Date.parse(status.uploadDeadline) > Date.now()) {
              setPhase({ kind: 'resume', saved, status });
              return;
            }
          } catch {
            /* fall through to a fresh form */
          }
          save(token, null);
        }
        setPhase({ kind: 'form' });
      } catch (e) {
        const err = e instanceof HttpError ? e : new HttpError(0, 'network_error', 'Could not load this upload page.');
        setPhase({ kind: 'link_error', title: LINK_ERRORS[err.code] ?? 'Unable to load', message: err.message });
      }
    })();
  }, [token]);

  useEffect(() => {
    if (phase.kind === 'done' || phase.kind === 'link_error' || phase.kind === 'resume') headingRef.current?.focus();
  }, [phase.kind]);

  const rules = session?.fileRules;
  const multiple = (rules?.maxFilesPerSubmission ?? 1) > 1;
  const accept = rules ? rules.allowedExtensions.map((e) => `.${e}`).join(',') : undefined;

  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      const incoming = Array.from(list);
      setFiles((prev) => (multiple ? [...prev, ...incoming] : incoming.slice(0, 1)));
      setFormErrors([]);
    },
    [multiple],
  );

  const showErrors = (errs: string[], fieldErrs: Record<string, string> = {}) => {
    setFormErrors(errs);
    setFieldErrors(fieldErrs);
    requestAnimationFrame(() => errorSummaryRef.current?.focus());
  };

  /** Uploads each file, restarting a file's upload session if it expires. */
  async function runUploads(saved: SavedSubmission, targets: { fileId: string; file: File }[]) {
    const controller = new AbortController();
    savedRef.current = saved;
    for (const t of targets) fileMapRef.current.set(t.fileId, t.file);
    setBusy(true);
    const links: { name: string; url: string }[] = [];
    let submissionStatus = '';
    let failed = false;
    for (const { fileId, file } of targets) {
      const update = (patch: Partial<FileProgress>) => setProgress((p) => p.map((x) => (x.fileId === fileId ? { ...x, ...patch } : x)));
      update({ state: 'uploading', uploaded: 0, error: undefined });
      try {
        for (let restart = 0; ; restart++) {
          const u = await requestJson<UploadUrlResponse>('POST', `/api/public/submissions/${saved.submissionId}/files/${fileId}/upload-url`, { secret: saved.secret });
          if (u.alreadyUploaded || !u.uploadUrl) break;
          try {
            await uploadToSession({ uploadUrl: u.uploadUrl, file, chunkSize: saved.chunkSize, signal: controller.signal, onProgress: (n) => update({ uploaded: n }) });
            break;
          } catch (e) {
            if (e instanceof UploadSessionGoneError && restart < 2) continue;
            throw e;
          }
        }
        update({ state: 'verifying', uploaded: file.size });
        let done: CompleteFileResponse | null = null;
        for (let i = 0; i < 5 && !done; i++) {
          try {
            done = await requestJson<CompleteFileResponse>('POST', `/api/public/submissions/${saved.submissionId}/files/${fileId}/complete`, { secret: saved.secret });
          } catch (e) {
            // OneDrive can take a moment to make a just-finished file visible.
            if (e instanceof HttpError && e.code === 'upload_incomplete' && i < 4) await sleep(1500 * (i + 1));
            else throw e;
          }
        }
        submissionStatus = done!.submissionStatus;
        if (done!.webUrl) links.push({ name: file.name, url: done!.webUrl });
        update({ state: 'done' });
      } catch (e) {
        if (e instanceof UploadAbortedError) break;
        failed = true;
        update({ state: 'error', error: e instanceof Error ? e.message : 'Upload failed.' });
      }
    }
    setBusy(false);
    if (!failed && ['uploaded', 'excel_pending', 'complete'].includes(submissionStatus)) {
      save(token, null);
      setPhase({ kind: 'done', reference: saved.reference, links });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!session) return;
    const fv = validateFieldValues(session.fields, values);
    const declared = files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    const df = validateDeclaredFiles(session.fileRules, declared);
    if (Object.keys(fv.errors).length || df.errors.length) {
      showErrors([...Object.values(fv.errors), ...df.errors], fv.errors);
      return;
    }
    setPhase({ kind: 'uploading' });
    setFormErrors([]);
    setFieldErrors({});
    let created: CreateSubmissionResponse;
    try {
      created = await requestJson<CreateSubmissionResponse>('POST', '/api/public/submissions', { token, fields: values, files: declared });
    } catch (err) {
      setPhase({ kind: 'form' });
      if (err instanceof HttpError && LINK_ERRORS[err.code]) {
        setPhase({ kind: 'link_error', title: LINK_ERRORS[err.code]!, message: err.message });
        return;
      }
      const details = err instanceof HttpError ? err.details ?? {} : {};
      const { _files, ...fieldDetails } = details;
      showErrors([err instanceof Error ? err.message : 'Submission failed.', ...(_files ? [_files] : [])], fieldDetails);
      return;
    }
    const saved: SavedSubmission = { submissionId: created.submissionId, secret: created.submissionSecret, reference: created.reference, chunkSize: created.chunkSize };
    save(token, saved);
    setProgress(created.files.map((f) => ({ fileId: f.fileId, name: f.originalName, size: f.size, uploaded: 0, state: 'waiting' })));
    await runUploads(saved, created.files.map((f) => ({ fileId: f.fileId, file: files[f.index]! })));
  }

  async function retryFailed() {
    const saved = savedRef.current;
    if (!saved) return;
    const targets = progress
      .filter((p) => p.state === 'error')
      .map((p) => ({ fileId: p.fileId, file: fileMapRef.current.get(p.fileId) }))
      .filter((t): t is { fileId: string; file: File } => !!t.file);
    await runUploads(saved, targets);
  }

  async function onResume(saved: SavedSubmission, status: SubmissionStatusResponse, picked: FileList | null) {
    if (!picked) return;
    const pending = status.files.filter((f) => f.status !== 'uploaded');
    const chosen = Array.from(picked);
    const targets: { fileId: string; file: File }[] = [];
    for (const p of pending) {
      const match = chosen.find((f) => f.size === p.size && f.name.normalize('NFC').endsWith(p.originalName.slice(-60)));
      if (match) targets.push({ fileId: p.fileId, file: match });
    }
    if (!targets.length) {
      showErrors(['None of the selected files match the unfinished files. Select the same files you chose before.']);
      return;
    }
    setFiles(targets.map((t) => t.file));
    setProgress(status.files.map((f) => ({
      fileId: f.fileId,
      name: f.originalName,
      size: f.size,
      uploaded: f.status === 'uploaded' ? f.size : 0,
      state: f.status === 'uploaded' ? 'done' : targets.some((t) => t.fileId === f.fileId) ? 'waiting' : 'error',
      error: f.status === 'uploaded' || targets.some((t) => t.fileId === f.fileId) ? undefined : 'Select this file to continue.',
    })));
    setPhase({ kind: 'uploading' });
    await runUploads(saved, targets);
  }

  return (
    <main id="main" className="container">
      {phase.kind === 'loading' && (
        <div className="card" role="status" aria-live="polite">
          Loading upload page…
        </div>
      )}

      {phase.kind === 'link_error' && (
        <div className="card">
          <h1 ref={headingRef} tabIndex={-1}>{phase.title}</h1>
          <p>{phase.message}</p>
          <p className="muted small">If you think this is a mistake, contact the person who sent you the link.</p>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="card">
          <h1 ref={headingRef} tabIndex={-1}>Upload complete</h1>
          <p>Thank you. Your files were received.</p>
          <p className="muted">Your submission reference:</p>
          <p className="reference" aria-label={`Reference ${phase.reference.split('').join(' ')}`}>{phase.reference}</p>
          <p className="muted small">Keep this reference in case you need to contact us about this submission.</p>
          {phase.links.length > 0 && (
            <>
              <h2>Your files</h2>
              <ul>
                {phase.links.map((l) => (
                  <li key={l.url}><a href={l.url} rel="noopener noreferrer" target="_blank">{l.name}</a></li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {phase.kind === 'resume' && session && (
        <div className="card">
          <h1 ref={headingRef} tabIndex={-1}>Finish your upload</h1>
          <p>Your earlier upload (reference <strong>{phase.status.reference}</strong>) did not finish. Select the same files again to continue:</p>
          <ul>
            {phase.status.files.filter((f) => f.status !== 'uploaded').map((f) => (
              <li key={f.fileId}>{f.originalName} ({formatBytes(f.size)})</li>
            ))}
          </ul>
          {formErrors.length > 0 && <div className="alert error" role="alert" tabIndex={-1} ref={errorSummaryRef}>{formErrors[0]}</div>}
          <div className="field">
            <label htmlFor="resume-files">Select files</label>
            <input id="resume-files" type="file" multiple accept={accept} onChange={(e) => onResume(phase.saved, phase.status, e.target.files)} />
          </div>
          <button type="button" className="link-btn" onClick={() => { save(token, null); setPhase({ kind: 'form' }); }}>
            Start a new submission instead
          </button>
        </div>
      )}

      {(phase.kind === 'form' || phase.kind === 'uploading') && session && (
        <form className="card" onSubmit={onSubmit} noValidate aria-describedby="rules">
          <h1>{session.title}</h1>
          {session.instructions && <p className="instructions">{session.instructions}</p>}
          <p className="muted small">Fields marked <span className="req" aria-hidden="true">*</span> are required. Upload link expires {new Date(session.expiresAt).toLocaleString()}.</p>

          {formErrors.length > 0 && (
            <div className="alert error" role="alert" tabIndex={-1} ref={errorSummaryRef}>
              <strong>Please fix the following:</strong>
              <ul>{formErrors.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
          )}

          <fieldset disabled={phase.kind === 'uploading'} className="unstyled">
            {session.fields.map((f) => {
              const id = `field-${f.key}`;
              const err = fieldErrors[f.key];
              const describedBy = [f.helpText ? `${id}-hint` : '', err ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
              const common = {
                id,
                name: f.key,
                required: f.required,
                'aria-required': f.required,
                'aria-invalid': err ? true : undefined,
                'aria-describedby': describedBy,
                value: values[f.key] ?? '',
                onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [f.key]: e.target.value })),
              };
              return (
                <div className="field" key={f.key}>
                  <label htmlFor={id}>
                    {f.label}
                    {f.required && <span className="req" aria-hidden="true">*</span>}
                  </label>
                  {f.helpText && <p className="hint" id={`${id}-hint`}>{f.helpText}</p>}
                  {f.type === 'textarea' ? (
                    <textarea {...common} maxLength={2000} />
                  ) : f.type === 'select' ? (
                    <select {...common}>
                      <option value="">Choose…</option>
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      {...common}
                      type={f.type === 'email' ? 'email' : 'text'}
                      inputMode={f.type === 'number' ? 'decimal' : undefined}
                      autoComplete={f.type === 'email' ? 'email' : f.key === 'name' ? 'name' : 'off'}
                      maxLength={200}
                    />
                  )}
                  {err && <p className="error-text" id={`${id}-error`}>{err}</p>}
                </div>
              );
            })}

            <div className="field">
              <span className="label" id="files-label">Files<span className="req" aria-hidden="true">*</span></span>
              <div
                className={`dropzone${dragging ? ' active' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
              >
                <p>{multiple ? 'Drag files here, or choose files.' : 'Drag a file here, or choose a file.'}</p>
                <input type="file" aria-labelledby="files-label" aria-describedby="rules" multiple={multiple} accept={accept} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
              </div>
              <ul className="rules" id="rules">
                <li>Allowed types: {rules!.allowedExtensions.map((e) => `.${e}`).join(', ')}</li>
                <li>Maximum size per file: {formatBytes(rules!.maxFileSizeBytes)}</li>
                <li>{multiple ? `Up to ${rules!.maxFilesPerSubmission} files` : 'One file only'}</li>
              </ul>
              {phase.kind === 'form' && files.length > 0 && (
                <ul className="file-list" aria-label="Selected files">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`}>
                      <span className="name">{f.name}</span>
                      <span className="muted small">{formatBytes(f.size)}</span>
                      <button type="button" className="btn small" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </fieldset>

          {phase.kind === 'uploading' && progress.length > 0 && (
            <section aria-labelledby="progress-heading">
              <h2 id="progress-heading">Uploading</h2>
              <p className="muted small">Keep this page open until the upload finishes.</p>
              <ul className="file-list" aria-live="polite">
                {progress.map((p) => (
                  <li key={p.fileId}>
                    <span className="name">{p.name}</span>
                    <span className="small">
                      {p.state === 'done' ? 'Done' : p.state === 'verifying' ? 'Checking…' : p.state === 'error' ? 'Failed' : p.state === 'waiting' ? 'Waiting' : `${Math.floor((p.uploaded / p.size) * 100)}%`}
                    </span>
                    <span className="progress-row">
                      <progress max={p.size} value={p.uploaded} aria-label={`Upload progress for ${p.name}`} />
                    </span>
                    {p.error && <span className="error-text progress-row" role="alert">{p.error}</span>}
                  </li>
                ))}
              </ul>
              {progress.some((p) => p.state === 'error') && !busy && (
                <div className="row">
                  <button type="button" className="btn primary" onClick={retryFailed}>Retry failed files</button>
                </div>
              )}
            </section>
          )}

          {phase.kind === 'form' && (
            <button type="submit" className="btn primary block">Upload</button>
          )}
        </form>
      )}
    </main>
  );
}
