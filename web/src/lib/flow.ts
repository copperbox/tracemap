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
 * Cycle length for the glowing "packet" that travels each edge (one packet
 * per cycle; the keyframes spend the first ~30% traveling and the rest
 * hidden). Busier edges emit more often. Bucketed for the same
 * restart-on-poll reason as flowDuration.
 */
export function packetCycle(rps: number): string {
  const bucketed = Math.pow(10, Math.round(Math.log10(Math.max(1, rps)) * 10) / 10);
  const raw = Math.max(4, Math.min(14, 11 - 2.2 * Math.log10(bucketed)));
  return `${raw.toFixed(2)}s`;
}

/**
 * Deterministic negative animation-delay so packets on different edges are
 * staggered instead of marching in lockstep (same idea as the hashed wait in
 * the depsera packet animation, but resolved entirely in CSS).
 */
export function packetDelay(edgeKey: string): string {
  let h = 0;
  for (let i = 0; i < edgeKey.length; i++) h = ((h << 5) - h + edgeKey.charCodeAt(i)) | 0;
  return `${-(Math.abs(h) % 9000)}ms`;
}
