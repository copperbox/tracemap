/**
 * Edge flow-particle animation duration (speed tracks call rate).
 *
 * The call rate is bucketed logarithmically (~12% steps) before computing the
 * duration: the topology poll refreshes rps every few seconds, and any change
 * to the CSS animation shorthand restarts the dash animation. Without
 * bucketing, every poll visibly "blips" all edges at once; with it, an edge's
 * animation only resets when its rate meaningfully changes.
 */
export function flowDuration(rps: number): string {
  const bucketed = Math.pow(10, Math.round(Math.log10(Math.max(40, rps)) * 10) / 10);
  const raw = Math.max(0.7, Math.min(6, 2600 / bucketed));
  return `${raw.toFixed(2)}s`;
}

/**
 * Cycle length for the glowing "packets" that travel each edge (the keyframes
 * spend the first ~30% of a cycle traveling and the rest hidden). Busier
 * edges emit more often. Bucketed for the same restart-on-poll reason as
 * flowDuration.
 */
export function packetCycle(rps: number): string {
  const bucketed = Math.pow(10, Math.round(Math.log10(Math.max(1, rps)) * 10) / 10);
  const raw = Math.max(4, Math.min(14, 11 - 2.2 * Math.log10(bucketed)));
  return `${raw.toFixed(2)}s`;
}

/**
 * How many packets ride an edge per cycle, so packet traffic reflects the
 * measured call rate instead of a fixed one-per-cycle loop. Zero when the
 * edge has no current traffic (the caller also checks staleness); otherwise
 * one packet per decade of rps, capped so busy edges don't strobe. Decade
 * buckets keep the count stable across poll jitter.
 */
export function packetCount(rps: number): number {
  if (rps <= 0) return 0;
  return Math.min(4, Math.max(1, 1 + Math.floor(Math.log10(rps))));
}

function hashDelayMs(edgeKey: string): number {
  let h = 0;
  for (let i = 0; i < edgeKey.length; i++) h = ((h << 5) - h + edgeKey.charCodeAt(i)) | 0;
  return -(Math.abs(h) % 9000);
}

/**
 * Deterministic negative animation-delay so packets on different edges are
 * staggered instead of marching in lockstep (same idea as the hashed wait in
 * the depsera packet animation, but resolved entirely in CSS).
 */
export function packetDelay(edgeKey: string): string {
  return `${hashDelayMs(edgeKey)}ms`;
}

/**
 * One animation-delay per packet on an edge: the edge's hashed base delay,
 * with the edge's packets spread evenly through the cycle so a busy edge
 * reads as a steady stream rather than a clump.
 */
export function packetDelays(edgeKey: string, rps: number): string[] {
  const count = packetCount(rps);
  if (!count) return [];
  const cycleMs = parseFloat(packetCycle(rps)) * 1000;
  const base = hashDelayMs(edgeKey);
  return Array.from({ length: count }, (_, i) => `${Math.round(base - (i * cycleMs) / count)}ms`);
}
