import { useEffect } from 'react';
import { api } from '../api/client';
import { startLiveClient, type LiveStats } from './live/liveClient';
import { isIngesting } from './live/merge';
import { useStore } from './store';

// Dev-only synthetic topology size (`?synthetic=N`). Read at module load,
// before initRouting normalizes the query string away.
const SYNTHETIC_N = import.meta.env.DEV
  ? Number(new URLSearchParams(window.location.search).get('synthetic')) || 0
  : 0;

/** Feeds the store's topology from the live stream (see live/liveClient.ts). */
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
    const client = startLiveClient({
      streamUrl: api.liveStreamUrl,
      openStream: (url) => new EventSource(url),
      fetchStructure: api.liveStructure,
      fetchFrame: api.liveMetrics,
      visibility: document,
      onTopology: (topo) => {
        setTopology(topo);
        setIngesting(isIngesting(topo));
      },
      onFetchError: () => setIngesting(false),
    });
    // Dev hook for the scale checks: frame counts and decode + merge time.
    if (import.meta.env.DEV) (window as unknown as { __live?: LiveStats }).__live = client.stats;
    return client.stop;
  }, [setTopology, setIngesting]);
}
