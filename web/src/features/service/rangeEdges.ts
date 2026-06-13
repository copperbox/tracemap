import { isLiveRange, rangeLabel, type TimeRange } from '../../lib/timerange';

/**
 * Edge labels for a chart's x-axis: live ranges render as "-24 hours" -> "now",
 * absolute ranges render their formatted start and end timestamps.
 */
export function rangeEdgeLabels(range: TimeRange): { start: string; end: string } {
  if (isLiveRange(range)) {
    return { start: `-${rangeLabel(range).replace('Last ', '')}`, end: 'now' };
  }
  const [start, end] = rangeLabel(range).split(' \u2192 ');
  return { start, end };
}
