// OneDrive for Business operations. Every path used here is built from IDs the
// admin selected and names the server generated; uploaders never influence
// which folder a file lands in.
import { joinDrivePath } from '../../shared/filenames';
import { enc, GraphClient } from './graph';

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  folder?: { childCount: number };
  file?: { mimeType?: string };
  package?: { type: string };
  parentReference?: { driveId?: string; id?: string; path?: string };
  lastModifiedDateTime?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

export interface Drive {
  id: string;
  driveType: 'personal' | 'business' | 'documentLibrary';
  owner?: { user?: { displayName?: string } };
}

const ITEM_SELECT = 'id,name,size,webUrl,folder,file,package,parentReference,lastModifiedDateTime';

/** "/drive/root:/A/B" or "/drives/x/root:/A/B" -> "/A/B" */
export function parentDisplayPath(parentPath: string | undefined): string {
  if (!parentPath) return '';
  const idx = parentPath.indexOf('root:');
  if (idx === -1) return '';
  return decodeURIComponent(parentPath.slice(idx + 5)) || '';
}

export function itemDisplayPath(item: DriveItem): string {
  if (!item.parentReference?.path) return '/'; // the drive root has no parent path
  return `${parentDisplayPath(item.parentReference.path)}/${item.name}`;
}

export class DriveService {
  constructor(private readonly graph: GraphClient) {}

  getMe() {
    return this.graph.request<{ id: string; displayName: string; userPrincipalName: string; mail?: string }>(
      'GET',
      '/me?$select=id,displayName,userPrincipalName,mail',
    );
  }

  getMyDrive() {
    return this.graph.request<Drive>('GET', '/me/drive?$select=id,driveType,owner');
  }

  getItem(driveId: string, itemId: string) {
    const path = itemId === 'root' ? `/drives/${enc(driveId)}/root` : `/drives/${enc(driveId)}/items/${enc(itemId)}`;
    return this.graph.request<DriveItem>('GET', `${path}?$select=${ITEM_SELECT}`, { allow404: true });
  }

  listChildren(driveId: string, itemId: string) {
    const base = itemId === 'root' ? `/drives/${enc(driveId)}/root` : `/drives/${enc(driveId)}/items/${enc(itemId)}`;
    return this.graph.list<DriveItem>(`${base}/children?$select=${ITEM_SELECT}&$top=200&$orderby=name`, 5);
  }

  /** Looks a file up by the server-generated name inside the configured folder. */
  getChildByName(driveId: string, folderId: string, name: string) {
    joinDrivePath('/', name); // throws on traversal attempts
    return this.graph.request<DriveItem>('GET', `/drives/${enc(driveId)}/items/${enc(folderId)}:/${enc(name)}`, { allow404: true });
  }

  /**
   * Creates a resumable upload session. The returned uploadUrl is a short-lived
   * pre-authenticated capability for exactly this file path; it is handed to
   * the uploader's browser and never logged or stored.
   */
  async createUploadSession(driveId: string, folderId: string, name: string) {
    joinDrivePath('/', name);
    return this.graph.request<{ uploadUrl: string; expirationDateTime: string }>(
      'POST',
      `/drives/${enc(driveId)}/items/${enc(folderId)}:/${enc(name)}:/createUploadSession`,
      // A duplicate upload session is harmless (it simply expires unused).
      { body: { item: { '@microsoft.graph.conflictBehavior': 'fail' } }, idempotent: true },
    );
  }

  async deleteItem(driveId: string, itemId: string): Promise<void> {
    // Deleted items go to the OneDrive recycle bin and can be restored.
    await this.graph.request('DELETE', `/drives/${enc(driveId)}/items/${enc(itemId)}`, { allow404: true });
  }

  /** Fetches the download URL then reads only the first `bytes` bytes of the file. */
  async readHeader(driveId: string, itemId: string, bytes = 64): Promise<Uint8Array | null> {
    const item = await this.graph.request<DriveItem>('GET', `/drives/${enc(driveId)}/items/${enc(itemId)}?$select=id,@microsoft.graph.downloadUrl`, { allow404: true });
    const url = item?.['@microsoft.graph.downloadUrl'];
    if (!url) return null;
    const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
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
