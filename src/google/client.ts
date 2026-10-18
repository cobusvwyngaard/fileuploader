// Minimal Google API client (Drive + Sheets). Access tokens never leave the
// Worker and are never logged; neither are resumable upload session URLs.
import type { Env } from '../env';
import { log } from '../log';
import { getAccessToken } from './tokens';


export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface GoogleRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
  /** Return the raw Response instead of parsing JSON (caller handles status). */
  raw?: boolean;
  /**
   * Whether repeating the request is harmless. Defaults to true for everything
   * except POST. Non-idempotent requests are only retried inline on 429, where
   * the request was rejected before processing; other failures are left to the
   * caller (e.g. the report sync, which checks for already-written rows).
   */
  idempotent?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('Retry-After');
  if (!v) return undefined;
  const secs = Number(v);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}

export class GoogleClient {
  constructor(
    private readonly env: Env,
    private readonly maxInlineRetries = 2,
  ) {}

  /** `url` must be an absolute https://*.googleapis.com URL. */
  async request<T>(method: string, url: string, opts: GoogleRequestOptions & { allow404: true }): Promise<T | null>;
  async request<T>(method: string, url: string, opts?: GoogleRequestOptions): Promise<T>;
  async request<T>(method: string, url: string, opts: GoogleRequestOptions = {}): Promise<T | null> {
    if (!/^https:\/\/[a-z]+\.googleapis\.com\//.test(url)) throw new Error('Refusing to send a Google token to a non-Google URL');
    let forcedRefresh = false;
    const idempotent = opts.idempotent ?? method !== 'POST';
    for (let attempt = 0; ; attempt++) {
      const token = await getAccessToken(this.env, { forceRefresh: forcedRefresh && attempt > 0 });
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        if (idempotent && attempt < this.maxInlineRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new GoogleApiError(0, 'network_error', e instanceof Error ? e.message : 'Network error');
      }
      if (res.status === 401 && !forcedRefresh) {
        forcedRefresh = true;
        continue;
      }
      if (opts.raw && res.status !== 401) return res as unknown as T;
      if (res.status === 404 && opts.allow404) return null;
      if (res.status === 204) return null as T;
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string; errors?: { reason?: string }[] } };
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? 'google_error';
      // Google reports rate limiting as 403 with a rateLimitExceeded reason.
      const status = res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason) ? 429 : res.status;
      const err = new GoogleApiError(status, reason, body.error?.message ?? `Google API returned ${res.status}`, retryAfterMs(res));
      if (err.transient && (idempotent || res.status === 429) && attempt < this.maxInlineRetries) {
        const wait = Math.min(err.retryAfterMs ?? 1000 * 2 ** attempt, 5000);
        log.warn({ event: 'google_retry', apiStatus: err.status, apiCode: err.code, retryInMs: wait });
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  /** Follows nextPageToken up to `maxPages`; `key` is the array property (e.g. "files"). */
  async list<T>(url: string, key: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const u = new URL(url);
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const res: Record<string, unknown> & { nextPageToken?: string } = await this.request('GET', u.toString());
      out.push(...((res[key] as T[] | undefined) ?? []));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  }
}

export const enc = encodeURIComponent;
