import { useEffect, useState } from 'react';
import { api } from '../../../api/client';

export interface SparkData {
  p95: number[];
  rps: number[];
  err: number[];
  times: Date[];
}

export function useSparklines(kind: 'service' | 'edge', a: string | null, b?: string): SparkData | null {
  const [data, setData] = useState<SparkData | null>(null);
  useEffect(() => {
    setData(null);
    if (!a) return;
    let alive = true;
    const load = async () => {
      const res =
        kind === 'service' ? await api.serviceSparklines(a) : await api.edgeSeries(a, b as string);
      if (!alive) return;
      const pts = res.points;
      setData({
        p95: pts.map((p) => p.p95 ?? 0),
        rps: pts.map((p) => p.rps ?? 0),
        err: pts.map((p) => p.errPct ?? 0),
        times: pts.map((p) => new Date(p.t)),
      });
    };
    load().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [kind, a, b]);
  return data;
}
