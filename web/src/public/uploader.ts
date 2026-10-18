// Uploads one file straight to a Google Drive resumable upload session.
// File bytes go from the browser to Google only; the Worker never sees them.
//
// - Chunks are a multiple of 256 KiB (required by Drive) except the last.
// - No Authorization header is sent: the session URI is the capability.
// - Drive answers 308 with a Range header after each non-final chunk. Network
//   errors and 5xx responses are retried with backoff after asking the session
//   how many bytes it has (resume, not restart).
// - 404/410 means the session expired or was cancelled; the caller then asks
//   the Worker for a fresh session and the file restarts.

export class UploadSessionGoneError extends Error {
  constructor() {
    super('The upload session expired.');
  }
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled.');
  }
}

interface PutResult {
  status: number;
  range: string | null;
}

function put(url: string, blob: Blob, rangeHeader: string, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Range', rangeHeader);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, range: xhr.getResponseHeader('Range') });
    xhr.onerror = () => resolve({ status: 0, range: null });
    xhr.ontimeout = () => resolve({ status: 0, range: null });
    xhr.onabort = () => reject(new UploadAbortedError());
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(blob);
  });
}

/**
 * Parses Drive's 308 Range header ("bytes=0-12345") into the next offset.
 * No header means no bytes stored yet (0); null means the header was unreadable.
 */
export function nextOffsetFrom(range: string | null, hasHeader: boolean): number | null {
  if (!range) return hasHeader ? null : 0;
  const m = /bytes=0-(\d+)/.exec(range);
  if (!m) return null;
  const end = Number(m[1]);
  return Number.isSafeInteger(end) ? end + 1 : null;
}

/** Asks the session how many bytes it holds: PUT with an empty body and "bytes *\/total". */
async function queryOffset(url: string, size: number, signal: AbortSignal): Promise<number | 'gone' | 'done' | null> {
  try {
    const res = await fetch(url, { method: 'PUT', signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Range': `bytes */${size}` } });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (res.status === 200 || res.status === 201) return 'done';
    if (res.status !== 308) return null;
    return nextOffsetFrom(res.headers.get('Range'), false);
  } catch {
    if (signal.aborted) throw new UploadAbortedError();
    return null;
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new UploadAbortedError());
    }, { once: true });
  });

export async function uploadToSession(opts: {
  uploadUrl: string;
  file: File;
  chunkSize: number;
  onProgress: (uploadedBytes: number) => void;
  signal: AbortSignal;
  maxRetriesPerChunk?: number;
}): Promise<void> {
  const { uploadUrl, file, chunkSize, onProgress, signal } = opts;
  const maxRetries = opts.maxRetriesPerChunk ?? 6;
  const size = file.size;
  let offset = 0;
  let failures = 0;

  while (offset < size) {
    if (signal.aborted) throw new UploadAbortedError();
    const end = Math.min(offset + chunkSize, size) - 1;
    const res = await put(uploadUrl, file.slice(offset, end + 1), `bytes ${offset}-${end}/${size}`, (loaded) => onProgress(offset + loaded), signal);

    if (res.status === 200 || res.status === 201) {
      onProgress(size);
      return;
    }
    if (res.status === 308) {
      failures = 0;
      // If the Range header is not readable, the accepted chunk is the best estimate.
      offset = res.range ? (nextOffsetFrom(res.range, true) ?? end + 1) : end + 1;
      onProgress(offset);
      continue;
    }
    if (res.status === 404 || res.status === 410) throw new UploadSessionGoneError();

    // 5xx, 429, other 4xx or network failure: resynchronise and retry.
    failures++;
    if (failures > maxRetries) throw new Error('The upload keeps failing. Check your connection and try again.');
    await wait(Math.min(30_000, 1000 * 2 ** (failures - 1)), signal);
    const resumed = await queryOffset(uploadUrl, size, signal);
    if (resumed === 'gone') throw new UploadSessionGoneError();
    if (resumed === 'done') {
      onProgress(size);
      return;
    }
    if (resumed !== null) offset = resumed;
    onProgress(offset);
  }
}
