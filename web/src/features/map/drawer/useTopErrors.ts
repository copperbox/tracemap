import { useEffect, useState } from 'react';
import { api } from '../../../api/client';
import type { OperationErrors } from '../../../api/types';

/**
 * Top erroring operations for the selected node ('service', id) or edge
 * ('edge', source, target), with the grouped errors seen on each.
 */
export function useTopErrors(
  kind: 'service' | 'edge',
  a: string | null,
  b?: string,
): OperationErrors[] {
  const [ops, setOps] = useState<OperationErrors[]>([]);
  useEffect(() => {
    setOps([]);
    if (!a) return;
    if (kind === 'edge' && !b) return;
    let alive = true;
    const req =
      kind === 'service' ? api.serviceErrors(a) : api.edgeErrors(a, b as string);
    req.then((res) => alive && setOps(res.operations)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [kind, a, b]);
  return ops;
}
