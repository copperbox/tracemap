import { useEffect, useState } from 'react';
import { api } from '../../../api/client';

export function useEdgeOps(source: string | null, target?: string) {
  const [ops, setOps] = useState<{ name: string; share: number }[]>([]);
  useEffect(() => {
    setOps([]);
    if (!source || !target) return;
    let alive = true;
    api
      .edgeSeries(source, target)
      .then((res) => alive && setOps(res.operations))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [source, target]);
  return ops;
}
