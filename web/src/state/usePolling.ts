import { useEffect } from 'react';
import { api } from '../api/client';
import { useStore } from './store';

// Dev-only synthetic topology size (`?synthetic=N`). Read at module load,
// before initRouting normalizes the query string away.
const SYNTHETIC_N = import.meta.env.DEV
  ? Number(new URLSearchParams(window.location.search).get('synthetic')) || 0
  : 0;

/** Polls live topology. */
export function useLiveData(): void {
  const setTopology = useStore((s) => s.setTopology);
  const setIngesting = useStore((s) => s.setIngesting);

  useEffect(() => {
    if (import.meta.env.DEV && SYNTHETIC_N > 0) {
      let stop: (() => void) | null = null;
      let alive = true;
      void import('../dev/syntheticFeed').then((m) => {
        if (!alive) return;
        stop = m.startSyntheticFeed(SYNTHETIC_N, (topo) => {
          setTopology(topo);
          setIngesting(true);
        });
      });
      return () => {
        alive = false;
        stop?.();
      };
    }
    let alive = true;
    const poll = async () => {
      try {
        const topo = await api.topology();
        if (!alive) return;
        setTopology(topo);
        setIngesting(topo.services.some((s) => !s.metrics.stale && s.metrics.rps > 0));
      } catch {
        if (alive) setIngesting(false);
      }
    };
    void poll();
    const i = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, [setTopology, setIngesting]);
}
