export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

/** ISO string -> value for <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  draft: 'Draft',
  unpublished: 'Unpublished',
  closed: 'Closed',
  expired: 'Expired',
  exhausted: 'Limit reached',
  created: 'Created',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  excel_pending: 'Excel pending',
  complete: 'Complete',
  failed: 'Failed',
  connected: 'Connected',
  needs_reauth: 'Reconnect needed',
  disconnected: 'Not connected',
};
