/**
 * Cap on packets drawn per frame across the whole map. The canvas blit is
 * cheap, but tens of thousands a frame is not, and past a few thousand the
 * extra dots add no information.
 */
export const MAX_PACKETS_PER_FRAME = 1500;

/**
 * Frame budget at zoom `k`. Zoomed out, packets shrink to a few pixels over a
 * dense edge mesh and read as noise, so the budget shrinks with the zoom down
 * to a quarter of the full cap.
 */
export function packetBudget(k: number, cap = MAX_PACKETS_PER_FRAME): number {
  const f = Math.max(0.25, Math.min(1, k / 0.5));
  return Math.round(cap * f);
}

/**
 * Scale per-edge packet counts down to fit `cap` in total. Every edge that
 * wanted packets keeps at least one while there is room for one each; when
 * there are more edges than the cap, the busiest edges (largest wants) keep a
 * single packet and the rest go quiet, ties broken by input order. Linear
 * time (wants are small integers), since it runs every animation frame. Pure.
 */
export function capPacketCounts(want: readonly number[], cap: number): number[] {
  let total = 0;
  let live = 0;
  let maxWant = 0;
  for (const w of want) {
    if (w > 0) {
      total += w;
      live++;
      if (w > maxWant) maxWant = w;
    }
  }
  if (total <= cap) return [...want];
  const out = new Array<number>(want.length).fill(0);
  if (cap <= 0) return out;
  if (live >= cap) {
    // Threshold by counting: everything above `t` is in, then the first
    // edges (in input order) exactly at `t` fill the remaining slots.
    const hist = new Array<number>(Math.floor(maxWant) + 2).fill(0);
    for (const w of want) if (w > 0) hist[Math.floor(w)]++;
    let above = 0;
    let t = hist.length - 1;
    while (t > 0 && above + hist[t] < cap) above += hist[t--];
    let atT = cap - above;
    for (let i = 0; i < want.length; i++) {
      const w = Math.floor(want[i]);
      if (want[i] <= 0) continue;
      if (w > t) out[i] = 1;
      else if (w === t && atT > 0) {
        out[i] = 1;
        atT--;
      }
    }
    return out;
  }
  // one each, then share the remainder in proportion to what is left wanted
  const spare = cap - live;
  const extraWant = total - live;
  for (let i = 0; i < want.length; i++) {
    if (want[i] <= 0) continue;
    out[i] = 1 + Math.floor(((want[i] - 1) * spare) / extraWant);
  }
  return out;
}

/**
 * Backing-store budget for the packet canvas. Glows are soft, so a 4K
 * viewport does not need 4K of packet pixels, and every pixel is composited
 * again on each animation frame.
 */
export const MAX_PACKET_PIXELS = 4_000_000;

/** Backing-store scale for a `cssW` x `cssH` canvas: the device ratio, lowered to fit `maxPixels`. */
export function packetScale(cssW: number, cssH: number, dpr: number, maxPixels = MAX_PACKET_PIXELS): number {
  const area = cssW * cssH;
  if (!(area > 0)) return dpr;
  return Math.min(dpr, Math.sqrt(maxPixels / area));
}
