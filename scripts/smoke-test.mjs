#!/usr/bin/env node
// Post-deployment smoke test.
//
//   SMOKE_BASE_URL=https://uploads.example.com \
//   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
//   node scripts/smoke-test.mjs
//
// The Access service token must be allowlisted in ADMIN_SERVICE_TOKENS. Without
// it, only the unauthenticated checks run. Secrets are read from the
// environment and never printed.
//
// Checks: health; public pages and security headers; admin routes refuse
// anonymous requests; (with a service token) admin dashboard HTML loads,
// an upload session is created, its QR code is generated, its public link is
// opened, and the session is closed again.

const base = (process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Set SMOKE_BASE_URL');
  process.exit(2);
}
const svcHeaders =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }
    : null;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` – ${detail}` : ''}`);
  if (!ok) failures++;
}

async function req(method, path, { body, admin = false, redirect = 'manual' } = {}) {
  const headers = { Accept: 'application/json', ...(admin && svcHeaders ? svcHeaders : {}) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers.Origin = base;
  }
  return fetch(`${base}${path}`, { method, headers, redirect, body: body === undefined ? undefined : JSON.stringify(body) });
}

const health = await req('GET', '/api/health');
check('GET /api/health', health.status === 200, `status ${health.status}`);

const landing = await req('GET', '/');
check('landing page', landing.status === 200);

const upload = await req('GET', '/u/');
const csp = upload.headers.get('content-security-policy') ?? '';
check('public upload page loads', upload.status === 200 && (await upload.text()).includes('id="root"'));
check('public page has CSP and frame protection', csp.includes("frame-ancestors 'none'") && upload.headers.get('x-frame-options') === 'DENY');

const invalid = await req('POST', '/api/public/session', { body: { token: 'A'.repeat(43) } });
check('invalid share link is rejected', invalid.status === 404 && (await invalid.json()).error?.code === 'invalid_link');

const anonAdmin = await req('GET', '/admin/');
check(
  'admin dashboard refuses anonymous visitors',
  [302, 401, 403].includes(anonAdmin.status),
  anonAdmin.status === 302 ? `redirect to ${new URL(anonAdmin.headers.get('location') ?? '', base).host}` : `status ${anonAdmin.status}`,
);
const anonApi = await req('GET', '/api/admin/sessions');
check('admin API refuses anonymous callers', [302, 401, 403].includes(anonApi.status), `status ${anonApi.status}`);

const cross = await fetch(`${base}/api/public/session`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
check('cross-origin preflight is refused', !cross.headers.get('access-control-allow-origin'));

if (!svcHeaders) {
  console.log('SKIP  admin checks (set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET for a service token allowlisted in ADMIN_SERVICE_TOKENS)');
} else {
  const html = await req('GET', '/admin/', { admin: true });
  check('admin dashboard loads through Access', html.status === 200 && (await html.text()).includes('id="root"'), `status ${html.status}`);

  const status = await req('GET', '/api/admin/google/status', { admin: true });
  const st = status.status === 200 ? await status.json() : null;
  check('admin API reachable', !!st, `status ${status.status}`);
  console.log(`INFO  Google connection: ${st?.connection?.status ?? 'unknown'}; report sheet: ${st?.reportSheet ? st.reportSheet.spreadsheetName : 'not configured'}`);

  const expires = new Date(Date.now() + 2 * 3600_000).toISOString();
  const created = await req('POST', '/api/admin/sessions', {
    admin: true,
    body: {
      title: `Smoke test ${new Date().toISOString()}`,
      instructions: 'Automated deployment check. Closed automatically.',
      folder: null,
      expiresAt: expires,
      maxSubmissions: 1,
      fileRules: { allowedExtensions: ['pdf'], maxFileSizeBytes: 1048576, maxFilesPerSubmission: 1 },
      fields: [
        { label: 'Table number', key: 'table_number', type: 'text', required: true },
        { label: 'Description', key: 'description', type: 'textarea', required: false },
      ],
      showDriveLinks: false,
    },
  });
  const session = created.status === 201 ? (await created.json()).session : null;
  check('create upload session', !!session, `status ${created.status}`);

  if (session) {
    const token = session.shareUrl.split('#')[1] ?? '';
    check('share link uses an unguessable fragment token', /^[A-Za-z0-9_-]{43}$/.test(token) && session.shareUrl.startsWith(`${base}/u/#`));

    const qr = await req('GET', `/api/admin/sessions/${session.id}/qr.svg`, { admin: true });
    check('QR code (SVG) generated', qr.status === 200 && (await qr.text()).startsWith('<svg'));

    const page = await req('GET', '/u/');
    check('public link page loads', page.status === 200);
    const draftView = await req('POST', '/api/public/session', { body: { token } });
    check('public link reports draft session as not published', draftView.status === 403 && (await draftView.json()).error?.code === 'not_published');

    if (st?.connection?.status === 'connected' && st.reportSheet) {
      // Publishing needs a destination folder: reuse (or create) a "Smoke tests" folder.
      const list = await req('GET', '/api/admin/drive/folders', { admin: true });
      let folder = list.status === 200 ? (await list.json()).folders.find((f) => f.path === '/Smoke tests') : null;
      if (!folder) {
        const made = await req('POST', '/api/admin/drive/folders', { admin: true, body: { name: 'Smoke tests' } });
        folder = made.status === 201 ? (await made.json()).folder : null;
      }
      check('destination folder available', !!folder);
      if (folder) {
        const upd = await req('PUT', `/api/admin/sessions/${session.id}`, {
          admin: true,
          body: { ...session, folder: { id: folder.id, path: folder.path, webUrl: folder.webUrl } },
        });
        check('set destination folder', upd.status === 200, `status ${upd.status}`);
        const pub = await req('POST', `/api/admin/sessions/${session.id}/publish`, { admin: true, body: {} });
        const pubBody = await pub.json();
        check('publish (validates folder and report columns)', pub.status === 200, pub.status === 200 ? '' : pubBody.error?.message);
        if (pub.status === 200) {
          const open = await req('POST', '/api/public/session', { body: { token } });
          check('published public link opens', open.status === 200 && (await open.json()).title === session.title);
        }
      }
    } else {
      console.log('SKIP  publish checks (connect Google and choose a report spreadsheet first)');
    }

    const close = await req('POST', `/api/admin/sessions/${session.id}/close`, { admin: true, body: {} });
    check('close smoke-test session', close.status === 200);
    const closed = await req('POST', '/api/public/session', { body: { token } });
    check('closed link is rejected', closed.status === 410);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
