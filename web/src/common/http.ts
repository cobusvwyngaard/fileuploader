import type { ApiErrorBody } from '../../../shared/types';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Same-origin JSON request. Errors surface as HttpError with the API's message. */
export async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HttpError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new HttpError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status}).`, err?.details);
  }
  return json as T;
}
