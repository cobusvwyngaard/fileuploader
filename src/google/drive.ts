// Google Drive operations. Every location used here is a folder ID the admin
// chose plus a name the server generated; uploaders never influence where a
// file is stored. With the drive.file scope the app can only see folders and
// files it created itself.
import { GoogleApiError, GoogleClient } from './client';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FILE_FIELDS = 'id,name,mimeType,size,webViewLink,parents,trashed';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes, as a decimal string (Drive returns int64 as string). Absent for Google-native files. */
  size?: string;
  webViewLink?: string;
  parents?: string[];
  trashed?: boolean;
}

/** Escapes a value for a single-quoted Drive query string literal. */
export const driveQueryLiteral = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class DriveService {
  constructor(private readonly google: GoogleClient) {}

  getFile(id: string) {
    return this.google.request<DriveFile>('GET', `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`, { allow404: true });
  }

  /** Lists folders (or spreadsheets) this app can see. */
  listByMime(mimeType: string): Promise<DriveFile[]> {
    const u = new URL(`${DRIVE_API}/files`);
    u.searchParams.set('q', `mimeType = ${driveQueryLiteral(mimeType)} and trashed = false`);
    u.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
    u.searchParams.set('pageSize', '200');
    u.searchParams.set('orderBy', 'name');
    u.searchParams.set('spaces', 'drive');
    return this.google.list<DriveFile>(u.toString(), 'files', 5);
  }

  createFolder(name: string, parentId?: string) {
    return this.google.request<DriveFile>('POST', `${DRIVE_API}/files?fields=${FILE_FIELDS}`, {
      body: { name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) },
    });
  }

  /** Finds the server-named file inside the configured folder. */
  async findInFolder(folderId: string, name: string): Promise<DriveFile[]> {
    const u = new URL(`${DRIVE_API}/files`);
    u.searchParams.set('q', `name = ${driveQueryLiteral(name)} and ${driveQueryLiteral(folderId)} in parents and trashed = false`);
    u.searchParams.set('fields', `files(${FILE_FIELDS})`);
    u.searchParams.set('pageSize', '10');
    const res = await this.google.request<{ files: DriveFile[] }>('GET', u.toString());
    return res.files ?? [];
  }

  /**
   * Starts a resumable upload and returns the session URI. The URI is a
   * short-lived capability for exactly this file; it is handed to the
   * uploader's browser and never logged or stored. Passing the browser's
   * Origin lets the browser PUT chunks to it directly (CORS). Drive enforces
   * the declared size: the upload fails if more bytes are sent.
   */
  async startResumableUpload(p: { folderId: string; name: string; size: number; mimeType: string; origin: string }): Promise<string> {
    const res = await this.google.request<Response>('POST', `${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`, {
      body: { name: p.name, parents: [p.folderId] },
      headers: {
        'X-Upload-Content-Length': String(p.size),
        'X-Upload-Content-Type': p.mimeType || 'application/octet-stream',
        Origin: p.origin,
      },
      raw: true,
      // A duplicate session is harmless (it expires unused).
      idempotent: true,
    });
    const location = res.headers.get('Location');
    if (!res.ok || !location) {
      throw new GoogleApiError(res.status, 'resumable_start_failed', `Drive did not start an upload session (${res.status})`);
    }
    return location;
  }

  /** Moves a file to the Drive trash (restorable for 30 days). */
  async trash(id: string): Promise<void> {
    await this.google.request('PATCH', `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id`, { body: { trashed: true }, allow404: true });
  }

  /** Reads only the first `bytes` bytes of a file to check its signature. */
  async readHeader(id: string, bytes = 64): Promise<Uint8Array | null> {
    const res = await this.google.request<Response>('GET', `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`, {
      headers: { Range: `bytes=0-${bytes - 1}` },
      raw: true,
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const out = new Uint8Array(bytes);
    let filled = 0;
    try {
      while (filled < bytes) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        const take = Math.min(value.length, bytes - filled);
        out.set(value.subarray(0, take), filled);
        filled += take;
      }
    } finally {
      // Stop the transfer; the rest of the file is never read.
      await reader.cancel().catch(() => undefined);
    }
    return out.slice(0, filled);
  }
}

/** Builds "/Parent/Child" display paths for folders whose ancestors the app can see. */
export function folderPaths(folders: Pick<DriveFile, 'id' | 'name' | 'parents'>[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map<string, string>();
  const pathOf = (id: string, depth = 0): string => {
    const hit = cache.get(id);
    if (hit) return hit;
    const f = byId.get(id)!;
    const parent = f.parents?.[0];
    const path = parent && byId.has(parent) && depth < 20 ? `${pathOf(parent, depth + 1)}/${f.name}` : `/${f.name}`;
    cache.set(id, path);
    return path;
  };
  for (const f of folders) pathOf(f.id);
  return cache;
}
