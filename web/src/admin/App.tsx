import { useEffect, useState } from 'react';
import { api } from './api';
import { HttpError } from '../common/http';
import { Link, useLocation } from './router';
import { SessionEditor } from './pages/SessionEditor';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SubmissionsPage } from './pages/SubmissionsPage';

const NAV = [
  { href: '/admin/', label: 'Sessions', match: (p: string) => p === '/admin/' || p.startsWith('/admin/sessions') },
  { href: '/admin/submissions', label: 'Submissions', match: (p: string) => p.startsWith('/admin/submissions') },
  { href: '/admin/settings', label: 'Settings', match: (p: string) => p.startsWith('/admin/settings') },
];

export function App() {
  const url = useLocation();
  const path = url.pathname;
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(setMe, (e) => setAuthError(e instanceof HttpError && e.status === 401 ? 'Your administrator session has expired. Reload the page to sign in again.' : String(e.message)));
  }, []);

  let page;
  const sessionMatch = path.match(/^\/admin\/sessions\/([0-9a-f-]{36})$/);
  if (path === '/admin/sessions/new') page = <SessionEditor key="new" id={null} />;
  else if (sessionMatch) page = <SessionEditor key={sessionMatch[1]} id={sessionMatch[1]!} />;
  else if (path.startsWith('/admin/submissions')) page = <SubmissionsPage />;
  else if (path.startsWith('/admin/settings')) page = <SettingsPage />;
  else page = <SessionsPage />;

  return (
    <>
      <header className="topbar">
        <div className="inner">
          <span className="brand">Upload sessions</span>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={n.match(path) ? 'page' : undefined}>{n.label}</Link>
            ))}
          </nav>
          <span className="spacer" />
          {me && <span className="small muted">{me.email}</span>}
        </div>
      </header>
      <main id="main" className="container wide">
        {authError ? <div className="alert error" role="alert">{authError}</div> : page}
      </main>
    </>
  );
}
