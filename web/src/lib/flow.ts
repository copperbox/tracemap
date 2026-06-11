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
