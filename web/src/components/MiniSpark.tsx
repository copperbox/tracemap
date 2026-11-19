import { memo } from 'react';
import { sparkPath } from '../lib/spark';

const FLAT = [0, 0];

/**
 * Static 120x26 sparkline for list rows. Memoized on its props: the list views
 * keep the `data` array identity across refreshes that bring the same values,
 * so a live frame that re-renders a row leaves its sparkline alone.
 */
export const MiniSpark = memo(function MiniSpark({
  data,
  color,
  className,
}: {
  data: number[] | undefined;
  color: string;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 120 26" preserveAspectRatio="none" className={className} aria-hidden>
      <path
        d={sparkPath(data && data.length > 1 ? data : FLAT)}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});
