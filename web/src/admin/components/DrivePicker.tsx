import { useEffect, useRef, useState } from 'react';
import { api, type BrowserItem } from '../api';
import { errorMessage, ErrorAlert } from './common';

/**
 * Browses the connected OneDrive. In 'folder' mode the current folder can be
 * chosen; in 'workbook' mode an .xlsx file is chosen. The selection carries the
 * stable Graph item ID, not just the path.
 */
export function DrivePicker({
  mode,
  onSelect,
  onClose,
}: {
  mode: 'folder' | 'workbook';
  onSelect: (item: BrowserItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [itemId, setItemId] = useState('root');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.children>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .children(itemId)
      .then(setData, (e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [itemId]);

  const items = (data?.items ?? []).filter((i) => i.isFolder || (mode === 'workbook' && i.isWorkbook));

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="picker-title">
      <div className="dialog-body">
        <h2 id="picker-title">{mode === 'folder' ? 'Choose destination folder' : 'Choose Excel workbook'}</h2>
        <p className="breadcrumb" aria-live="polite">
          OneDrive{data?.current.path && data.current.path !== '/' ? data.current.path : ''}
        </p>
        <ErrorAlert error={error} />
        {data?.current.parentId && data.current.path !== '/' && (
          <p>
            <button type="button" className="btn small" onClick={() => setItemId(data.current.parentId!)}>
              ↑ Up one level
            </button>
          </p>
        )}
        {loading ? (
          <p role="status">Loading…</p>
        ) : (
          <ul className="picker-list" aria-label="Folder contents">
            {items.length === 0 && <li className="muted"><span className="small">&nbsp;Nothing here.</span></li>}
            {items.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => (i.isFolder ? setItemId(i.id) : onSelect(i))}>
                  <span aria-hidden="true">{i.isFolder ? '📁' : '📊'}</span>
                  <span>{i.name}</span>
                  {i.isFolder && <span className="muted small">({i.childCount})</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        {mode === 'folder' && data && (
          <button type="button" className="btn primary" onClick={() => onSelect(data.current)}>
            Use “{data.current.path === '/' ? 'OneDrive root' : data.current.name}”
          </button>
        )}
      </div>
    </dialog>
  );
}
