// Minimal Microsoft Graph client. Access tokens never leave the Worker and are
// never logged; neither are upload or download URLs returned by Graph.
import type { Env } from '../env';
import { log } from '../log';
import { getAccessToken } from './tokens';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
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

export interface GraphRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
  /**
   * Whether repeating the request is harmless. Defaults to true for everything
   * except POST. Non-idempotent requests are only retried inline on 429, where
   * Graph guarantees the request was not processed; other failures are left to
   * the caller (e.g. the Excel sync, which checks for already-written rows).
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

export class GraphClient {
  constructor(
    private readonly env: Env,
    private readonly maxInlineRetries = 2,
  ) {}

  async request<T>(method: string, path: string, opts: GraphRequestOptions & { allow404: true }): Promise<T | null>;
  async request<T>(method: string, path: string, opts?: GraphRequestOptions): Promise<T>;
  async request<T>(method: string, path: string, opts: GraphRequestOptions = {}): Promise<T | null> {
    let forcedRefresh = false;
    const idempotent = opts.idempotent ?? method !== 'POST';
    for (let attempt = 0; ; attempt++) {
      const token = await getAccessToken(this.env, { forceRefresh: forcedRefresh && attempt > 0 });
      let res: Response;
      try {
        res = await fetch(`${GRAPH_BASE}${path}`, {
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
        throw new GraphError(0, 'network_error', e instanceof Error ? e.message : 'Network error');
      }
      if (res.status === 401 && !forcedRefresh) {
        forcedRefresh = true;
        continue;
      }
      if (res.status === 404 && opts.allow404) return null;
      if (res.status === 204) return null as T;
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      const err = new GraphError(res.status, body.error?.code ?? 'graph_error', body.error?.message ?? `Graph returned ${res.status}`, retryAfterMs(res));
      if (err.transient && (idempotent || res.status === 429) && attempt < this.maxInlineRetries) {
        const wait = Math.min(err.retryAfterMs ?? 1000 * 2 ** attempt, 5000);
        log.warn({ event: 'graph_retry', graphStatus: res.status, graphCode: err.code, retryInMs: wait });
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  /** Follows @odata.nextLink up to `maxPages`. */
  async list<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      const res: { value: T[]; '@odata.nextLink'?: string } = await this.request('GET', next);
      out.push(...res.value);
      const link = res['@odata.nextLink'];
      next = link?.startsWith(GRAPH_BASE) ? link.slice(GRAPH_BASE.length) : undefined;
    }
    return out;
  }
}

export const enc = encodeURIComponent;
