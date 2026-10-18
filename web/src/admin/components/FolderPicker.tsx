import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type DriveFolder } from '../api';
import { errorMessage, ErrorAlert } from './common';

/**
 * Chooses a Google Drive destination folder. With the drive.file permission
 * the app can only see folders it created, so new folders are created here.
 * The selection carries the folder's stable Drive file ID, not just its path.
 */
export function FolderPicker({ onSelect, onClose }: { onSelect: (f: DriveFolder) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    api.folders().then((r) => setFolders(r.folders), (e) => setError(errorMessage(e)));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { folder } = await api.createFolder(name.trim(), parentId || undefined);
      onSelect(folder);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="picker-title">
      <div className="dialog-body">
        <h2 id="picker-title">Choose destination folder</h2>
        <ErrorAlert error={error} />
        <h3>Folders created by this app</h3>
        {!folders ? (
          <p role="status">Loading…</p>
        ) : (
          <ul className="picker-list" aria-label="Folders">
            {folders.length === 0 && <li className="muted"><span className="small">&nbsp;No folders yet. Create one below.</span></li>}
            {folders.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => onSelect(f)}>
                  <span aria-hidden="true">📁</span>
                  <span>{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={create} className="stack">
          <h3>New folder in Google Drive</h3>
          <div className="grid">
            <div className="field">
              <label htmlFor="folder-name">Folder name</label>
              <input id="folder-name" type="text" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="folder-parent">Inside</label>
              <select id="folder-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">My Drive (top level)</option>
                {(folders ?? []).map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}
              </select>
            </div>
          </div>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>Create and use folder</button>
        </form>
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
      </div>
    </dialog>
  );
}
