import { describe, expect, it } from 'vitest';
import { rangeEdgeLabels } from './rangeEdges';

describe('rangeEdgeLabels', () => {
  it('renders live quick ranges as -duration -> now', () => {
    expect(rangeEdgeLabels({ kind: 'quick', label: 'Last 24 hours', ms: 24 * 3_600_000 })).toEqual({
      start: '-24 hours',
      end: 'now',
    });
  });

  it('renders absolute ranges as formatted start and end timestamps', () => {
    const from = new Date(2026, 0, 2, 3, 4).getTime();
    const to = new Date(2026, 0, 3, 5, 6).getTime();
    expect(rangeEdgeLabels({ kind: 'absolute', from, to })).toEqual({
      start: '2026-01-02 03:04',
      end: '2026-01-03 05:06',
    });
  });
});
