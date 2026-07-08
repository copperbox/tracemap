import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ServiceList } from '../api/types';

/**
 * Polls the service list every 15s for the list-style views (services table,
 * wallboard). Failed polls keep the previous data on screen; `null` until the
 * first response arrives.
 */
export function useServiceList(): ServiceList | null {
  const [data, setData] = useState<ServiceList | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api.services().then((d) => alive && setData(d)).catch(() => undefined);
    void poll();
    const i = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);

  return data;
}
