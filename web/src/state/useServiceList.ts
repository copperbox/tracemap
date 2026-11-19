import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { mergeExtras, type ServiceExtra } from './serviceRows';

const REFRESH_MS = 60_000;

/**
 * Sparklines and SLO for the list views (services table, wallboard), from
 * GET /api/services on mount and every 60 s while the tab is visible. Live
 * numbers come from the store topology instead. `null` until the first
 * response; failed fetches keep the previous data.
 */
export function useServiceExtras(): Map<string, ServiceExtra> | null {
  const [extras, setExtras] = useState<Map<string, ServiceExtra> | null>(null);

  useEffect(() => {
    let alive = true;
    let last = 0;
    const load = () => {
      if (document.hidden) return;
      last = Date.now();
      api
        .services()
        .then((list) => alive && setExtras((prev) => mergeExtras(prev, list)))
        .catch(() => undefined);
    };
    load();
    const i = setInterval(load, REFRESH_MS);
    // Catch up after the tab was hidden through one or more refreshes.
    const onVisible = () => !document.hidden && Date.now() - last >= REFRESH_MS && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(i);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return extras;
}
