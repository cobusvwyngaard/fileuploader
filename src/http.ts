import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from './errors';
import type { Env } from './env';
import { log } from './log';
import { GoogleApiError } from './google/client';
import { NotConnectedError } from './google/tokens';

export type AppEnv = { Bindings: Env; Variables: { adminEmail: string } };

const PUBLIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // The browser PUTs file chunks straight to the Google Drive resumable upload URL.
  "connect-src 'self' https://www.googleapis.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const ADMIN_CSP = PUBLIC_CSP.replace(/connect-src [^;]+/, "connect-src 'self'").replace(
  "form-action 'self'",
  "form-action 'self' https://accounts.google.com",
);

export function applySecurityHeaders(headers: Headers, kind: 'public' | 'admin' | 'api'): void {
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (kind === 'api') {
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    headers.set('Cache-Control', 'no-store');
  } else {
    headers.set('Content-Security-Policy', kind === 'admin' ? ADMIN_CSP : PUBLIC_CSP);
  }
}

export function securityHeaders(kind: 'public' | 'admin' | 'api'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    // Responses from fetch() / ASSETS can be immutable, so copy before changing headers.
    const res = new Response(c.res.body, c.res);
    applySecurityHeaders(res.headers, kind);
    c.res = res;
  };
}

/**
 * Strict same-origin policy for the JSON API. No CORS headers are ever sent,
 * preflights are refused, and state-changing requests must come from our own
 * origin with a JSON body (blocks cross-site form posts).
 */
export function sameOriginApi(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'OPTIONS') return c.json({ error: { code: 'cors_forbidden', message: 'Cross-origin requests are not allowed.' } }, 403);
    if (method !== 'GET' && method !== 'HEAD') {
      const expected = new URL(c.env.PUBLIC_BASE_URL || c.req.url).origin;
      const origin = c.req.header('Origin');
      const fetchSite = c.req.header('Sec-Fetch-Site');
      if ((origin && origin !== expected && origin !== new URL(c.req.url).origin) || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
        return c.json({ error: { code: 'cors_forbidden', message: 'Cross-origin requests are not allowed.' } }, 403);
      }
      const ct = c.req.header('Content-Type') ?? '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        return c.json({ error: { code: 'unsupported_media_type', message: 'Requests must be JSON.' } }, 415);
      }
    }
    await next();
  };
}

export async function readJson<T = unknown>(c: Context<AppEnv>, maxBytes = 64 * 1024): Promise<T> {
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
  const text = await c.req.text();
  if (text.length > maxBytes) throw new ApiError(413, 'payload_too_large', 'Request body is too large.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

export function errorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status as 400);
  }
  if (err instanceof NotConnectedError) {
    log.error({ event: 'google_not_connected', route: c.req.routePath, reason: err.reason });
    return c.json({ error: { code: 'storage_not_connected', message: 'File storage is temporarily unavailable. Please try again later.' } }, 503);
  }
  if (err instanceof GoogleApiError) {
    log.error({ event: 'google_api_error', route: c.req.routePath, apiStatus: err.status, apiCode: err.code });
    return c.json({ error: { code: 'storage_error', message: 'Google Drive did not accept the request. Please try again shortly.' } }, err.transient ? 503 : 502);
  }
  log.error({ event: 'unhandled_error', route: c.req.routePath, reason: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown' });
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } }, 500);
}
