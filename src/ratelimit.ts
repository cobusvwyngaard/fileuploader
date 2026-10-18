import type { Context, MiddlewareHandler } from 'hono';
import { sha256Hex } from './crypto';
import type { AppEnv } from './http';
import { log } from './log';

/**
 * Per-client rate limiting with the Workers Rate Limiting binding. The key is
 * a hash of the client IP so raw addresses are not passed around.
 */
export function rateLimit(binding: 'PUBLIC_RATE_LIMITER' | 'SUBMIT_RATE_LIMITER', bucket: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = c.env[binding];
    if (limiter) {
      const key = `${bucket}:${await clientHash(c)}`;
      const { success } = await limiter.limit({ key });
      if (!success) {
        log.warn({ event: 'rate_limited', route: bucket });
        return c.json({ error: { code: 'rate_limited', message: 'Too many requests. Please wait a minute and try again.' } }, 429, { 'Retry-After': '60' });
      }
    }
    await next();
  };
}

async function clientHash(c: Context<AppEnv>): Promise<string> {
  return (await sha256Hex(c.req.header('CF-Connecting-IP') ?? 'unknown')).slice(0, 32);
}
