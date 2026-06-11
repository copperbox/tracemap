import { useEffect } from 'react';
import { api } from '../api/client';
import { useStore } from './store';

/** Polls live topology + drives the gentle metric jitter tick. */
export function useLiveData(): void {
  const setTopology = useStore((s) => s.setTopology);
  const setIngesting = useStore((s) => s.setIngesting);
  const bumpTick = useStore((s) => s.bumpTick);

  useEffect(() => {
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

  useEffect(() => {
    const i = setInterval(bumpTick, 2600);
    return () => clearInterval(i);
  }, [bumpTick]);
}
