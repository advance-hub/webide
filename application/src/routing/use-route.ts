import { useEffect, useState } from 'react';

export type Navigation = (to: string, replace?: boolean) => void;

export function useRoute() {
  const read = () => new URL(window.location.hash.slice(1) || '/dashboard', window.location.origin);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const navigate = (to: string, replace = false) => {
    if (replace) {
      window.history.replaceState(null, '', `#${to}`);
      setRoute(read());
    } else {
      window.location.hash = to;
    }
  };
  const filter = (key: string, value: string) => {
    const next = new URL(route);
    if (value) {
      next.searchParams.set(key, value);
    } else {
      next.searchParams.delete(key);
    }
    navigate(next.pathname + next.search, true);
  };
  return { route, navigate, filter };
}
