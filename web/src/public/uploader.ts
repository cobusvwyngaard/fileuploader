// Uploads one file straight to a Microsoft Graph resumable upload session.
// File bytes go from the browser to Microsoft only; the Worker never sees them.
//
// - Chunks are a multiple of 320 KiB (required by Graph) except the last.
// - No Authorization header is sent: the upload URL is pre-authenticated.
// - Network errors and 5xx responses are retried with backoff after asking the
//   upload session which byte ranges it still expects (resume, not restart).
// - A 404 means the upload session expired or was lost; the caller then asks
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
  body: string;
}

function put(url: string, blob: Blob, rangeHeader: string, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<PutResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Range', rangeHeader);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, body: '' });
    xhr.ontimeout = () => resolve({ status: 0, body: '' });
    xhr.onabort = () => reject(new UploadAbortedError());
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    xhr.send(blob);
  });
}

/** Parses Graph's nextExpectedRanges ("12345-" or "12345-67890") into a start offset. */
export function nextOffsetFrom(body: string): number | null {
  try {
    const json = JSON.parse(body) as { nextExpectedRanges?: string[] };
    const first = json.nextExpectedRanges?.[0];
    if (!first) return null;
    const start = Number(first.split('-')[0]);
    return Number.isSafeInteger(start) && start >= 0 ? start : null;
  } catch {
    return null;
  }
}

async function queryOffset(url: string, signal: AbortSignal): Promise<number | 'gone' | null> {
  try {
    const res = await fetch(url, { method: 'GET', signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 404) return 'gone';
    if (!res.ok) return null;
    return nextOffsetFrom(await res.text());
  } catch (e) {
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
    if (res.status === 202) {
      failures = 0;
      offset = nextOffsetFrom(res.body) ?? end + 1;
      onProgress(offset);
      continue;
    }
    if (res.status === 404) throw new UploadSessionGoneError();
    // 409: the file was already committed (e.g. a previous attempt finished). The Worker verifies it.
    if (res.status === 409) return;

    // 416 (range mismatch), 5xx, 429 or network failure: resynchronise and retry.
    failures++;
    if (failures > maxRetries) throw new Error('The upload keeps failing. Check your connection and try again.');
    await wait(Math.min(30_000, 1000 * 2 ** (failures - 1)), signal);
    const resumed = await queryOffset(uploadUrl, signal);
    if (resumed === 'gone') throw new UploadSessionGoneError();
    if (resumed !== null) offset = resumed;
    onProgress(offset);
  }
}
