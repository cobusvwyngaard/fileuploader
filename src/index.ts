import { Hono } from 'hono';
import { requireAdmin, resolveAdmin } from './access';
import type { Env } from './env';
import { notFound } from './errors';
import { applySecurityHeaders, errorResponse, sameOriginApi, securityHeaders, type AppEnv } from './http';
import { log } from './log';
import { adminRoutes } from './routes/admin';
import { publicRoutes } from './routes/public';
import { runScheduled } from './scheduled';

export const app = new Hono<AppEnv>();

app.onError((err, c) => errorResponse(c, err));

app.get('/api/health', securityHeaders('api'), (c) => c.json({ ok: true }));

app.use('/api/public/*', securityHeaders('api'), sameOriginApi());
app.route('/api/public', publicRoutes);

app.use('/api/admin/*', securityHeaders('api'), sameOriginApi(), requireAdmin());
app.route('/api/admin', adminRoutes);

app.all('/api/*', securityHeaders('api'), () => {
  throw notFound('Unknown endpoint.');
});

// Admin UI: the Worker runs before static assets for /admin*, so the HTML is
// only served to requests carrying a valid Access identity.
app.get('/admin', (c) => c.redirect('/admin/', 301));
app.get('/admin/*', securityHeaders('admin'), async (c) => {
  const who = await resolveAdmin(c.req.raw, c.env);
  if ('error' in who) {
    log.warn({ event: 'admin_ui_denied', reason: who.error });
    return c.text('Administrator sign-in through Cloudflare Access is required.', 401);
  }
  const url = new URL(c.req.url);
  // Every admin route is handled by the single-page app at /admin/ (admin/index.html).
  const res = await c.env.ASSETS.fetch(new Request(new URL('/admin/', url), c.req.raw));
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  return out;
});

app.notFound(async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  applySecurityHeaders(out.headers, 'public');
  return out;
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
