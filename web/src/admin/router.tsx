import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

// A tiny history-API router; the admin app has only a handful of routes.
const listeners = new Set<() => void>();

export function navigate(to: string) {
  window.history.pushState({}, '', to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useLocation(): URL {
  const [url, setUrl] = useState(() => new URL(window.location.href));
  useEffect(() => {
    const update = () => setUrl(new URL(window.location.href));
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return url;
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
