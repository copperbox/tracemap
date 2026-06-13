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

// ---- packet visuals (rendered on a single canvas; see view/PacketCanvas.tsx) ----
//
// These are visual tuning knobs, not domain constants. Because packets are
// drawn as cheap sprite blits on one canvas layer (not one DOM/GPU layer
// each), the packet count is no longer bounded by performance -- it is bounded
// only by legibility, so the cap is set far higher than the old 4.

/** Maximum packets riding a single edge at once. */
export const PACKET_CAP = 18;
/** rps at which an edge reaches PACKET_CAP; busier edges are clamped there. */
const PACKET_SAT_RPS = 2000;
/** Gamma > 1 keeps low-traffic edges sparse and ramps the count up later. */
const PACKET_GAMMA = 1.6;
/** Packet travel speed, in world units per second (uniform visual speed). */
const PACKET_SPEED = 130;
/** Clamp so very short edges aren't instant and very long ones aren't glacial. */
const PACKET_TRAVEL_MIN_MS = 1400;
const PACKET_TRAVEL_MAX_MS = 6000;

/**
 * How many packets ride an edge, so packet density reflects the measured call
 * rate. Zero when the edge has no current traffic (the caller also checks
 * staleness); otherwise a gamma-shaped log ramp from 1 up to PACKET_CAP, kept
 * sparse for low rps and saturating around PACKET_SAT_RPS. The mapping is
 * smooth (not decade-bucketed) so a 50 rps edge and a 500 rps edge read
 * visibly differently.
 */
export function packetCount(rps: number): number {
  if (rps <= 0) return 0;
  const norm = Math.min(1, Math.max(0, Math.log10(rps) / Math.log10(PACKET_SAT_RPS)));
  const count = 1 + (PACKET_CAP - 1) * Math.pow(norm, PACKET_GAMMA);
  return Math.max(1, Math.min(PACKET_CAP, Math.round(count)));
}

/**
 * Time for one packet to traverse an edge of the given world-space length, so
 * every packet moves at the same on-screen speed regardless of edge length
 * (the pan/zoom scale then applies uniformly on top). Clamped to a readable
 * range.
 */
export function packetTravelMs(lengthWorld: number): number {
  const ms = (Math.max(0, lengthWorld) / PACKET_SPEED) * 1000;
  return Math.max(PACKET_TRAVEL_MIN_MS, Math.min(PACKET_TRAVEL_MAX_MS, ms));
}

/**
 * Deterministic per-edge phase offset in [0, 1) so packets on different edges
 * are staggered instead of marching in lockstep. (Same hashing idea as the old
 * CSS animation-delay, now expressed as a unit phase the canvas advances.)
 */
export function packetSeed(edgeKey: string): number {
  let h = 0;
  for (let i = 0; i < edgeKey.length; i++) h = ((h << 5) - h + edgeKey.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}
