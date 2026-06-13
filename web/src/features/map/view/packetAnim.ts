/**
 * Per-frame packet positions for one edge (pure, so it is unit-testable; the
 * canvas just draws what this returns).
 *
 * Packets are spaced evenly along the edge and all advance together, so a busy
 * edge (many packets) reads as a dense steady stream and an idle one (a single
 * packet) as the occasional traveler. The spacing equals 1/count, so as a
 * packet leaves the far end another enters the near end -- a short fade at each
 * end hides the wrap.
 */

export interface PacketSample {
  /** distance fraction along the edge, 0 (source) .. 1 (dependent) */
  s: number;
  /** 0..1 opacity envelope (fades in/out at the edge ends to hide wrap) */
  opacity: number;
}

/** Fraction of the edge over which a packet fades in at the start / out at the end. */
const FADE = 0.08;

function mod1(x: number): number {
  return ((x % 1) + 1) % 1;
}

/** Opacity envelope for a packet at distance fraction s. */
export function fadeEnvelope(s: number, fade = FADE): number {
  if (fade <= 0) return 1;
  if (s < fade) return Math.max(0, s / fade);
  if (s > 1 - fade) return Math.max(0, (1 - s) / fade);
  return 1;
}

/**
 * Positions of an edge's `count` packets at time `nowMs`. `travelMs` is the
 * time to cross the edge once; `seed` (0..1) is the edge's phase offset so
 * edges don't pulse in lockstep.
 */
export function packetSamples(
  count: number,
  travelMs: number,
  nowMs: number,
  seed: number,
): PacketSample[] {
  if (count <= 0 || travelMs <= 0) return [];
  const progress = nowMs / travelMs + seed;
  const out: PacketSample[] = [];
  for (let i = 0; i < count; i++) {
    const s = mod1(progress + i / count);
    out.push({ s, opacity: fadeEnvelope(s) });
  }
  return out;
}
