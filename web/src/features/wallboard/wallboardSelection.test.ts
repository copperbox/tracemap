import { describe, expect, it } from 'vitest';
import type { TopologyEdge } from '../../api/types';
import { relatedServiceId, toggleCardSelection } from './wallboardSelection';

const edge = (source: string, target: string): TopologyEdge => ({
  source,
  target,
  firstSeen: '2026-06-01T00:00:00Z',
  lastSeen: '2026-06-11T00:00:00Z',
  samples: 1000,
  manual: false,
  confidence: 99,
  status: 'ok',
  metrics: { rps: 10, p50: 5, p95: 20, p99: 40, errPct: 0.2, stale: false },
});

describe('toggleCardSelection', () => {
  it('selects the clicked card when nothing is selected', () => {
    expect(toggleCardSelection(null, 'api')).toEqual({ kind: 'node', id: 'api' });
  });

  it('moves the selection when a different card is clicked', () => {
    expect(toggleCardSelection({ kind: 'node', id: 'api' }, 'db')).toEqual({ kind: 'node', id: 'db' });
  });

  it('clears the selection when the selected card is re-clicked', () => {
    expect(toggleCardSelection({ kind: 'node', id: 'api' }, 'api')).toBeNull();
  });

  it('replaces a non-node selection carried over from the map', () => {
    expect(toggleCardSelection({ kind: 'edge', id: 'a=>b' }, 'api')).toEqual({ kind: 'node', id: 'api' });
  });
});

describe('relatedServiceId', () => {
  it('returns the target for a DEPENDS ON edge (self is the source)', () => {
    expect(relatedServiceId(edge('api', 'db'), 'api')).toBe('db');
  });

  it('returns the source for a CALLED BY edge (self is the target)', () => {
    expect(relatedServiceId(edge('web', 'api'), 'api')).toBe('web');
  });
});
