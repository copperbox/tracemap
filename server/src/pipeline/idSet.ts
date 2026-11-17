/**
 * Compact sets of 64-bit ids (span ids, hashed trace ids) for the hot path.
 * A JS Set<string> of 16-hex ids costs about 80 bytes per entry and pressures
 * the GC; these store two u32 words per slot in a preallocated table.
 */

/** Split a hex id into two u32 words. Longer ids (32-hex trace ids) are folded by XOR. */
export function hexWords(hex: string): [number, number] {
  let hi = parseInt(hex.slice(0, 8), 16) >>> 0;
  let lo = parseInt(hex.slice(8, 16), 16) >>> 0;
  if (hex.length > 16) {
    hi = (hi ^ parseInt(hex.slice(16, 24), 16)) >>> 0;
    lo = (lo ^ parseInt(hex.slice(24, 32), 16)) >>> 0;
  }
  // NaN from a malformed id becomes 0; that only weakens dedupe for garbage ids.
  return [hi || 0, lo || 0];
}

function mix(hi: number, lo: number): number {
  let h = Math.imul(hi ^ 0x9e3779b9, 0x85ebca6b) ^ lo;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Open-addressing hash set of (hi, lo) pairs with a fixed capacity.
 * (0, 0) is the empty marker, so a zero id is stored as (0, 1).
 */
export class CompactIdSet {
  private readonly words: Uint32Array;
  private readonly mask: number;
  size = 0;

  /** `capacity` is rounded up to a power of two. */
  constructor(capacity: number) {
    let cap = 16;
    while (cap < capacity) cap *= 2;
    this.words = new Uint32Array(cap * 2);
    this.mask = cap - 1;
  }

  get capacity(): number {
    return this.mask + 1;
  }

  /** Adds the id. Returns false when it was already present. */
  add(hi: number, lo: number): boolean {
    if (hi === 0 && lo === 0) lo = 1;
    let i = mix(hi, lo) & this.mask;
    for (;;) {
      const h = this.words[i * 2];
      const l = this.words[i * 2 + 1];
      if (h === 0 && l === 0) {
        if (this.size >= this.mask) throw new RangeError('CompactIdSet is full');
        this.words[i * 2] = hi;
        this.words[i * 2 + 1] = lo;
        this.size++;
        return true;
      }
      if (h === hi && l === lo) return false;
      i = (i + 1) & this.mask;
    }
  }

  has(hi: number, lo: number): boolean {
    if (hi === 0 && lo === 0) lo = 1;
    let i = mix(hi, lo) & this.mask;
    for (;;) {
      const h = this.words[i * 2];
      const l = this.words[i * 2 + 1];
      if (h === 0 && l === 0) return false;
      if (h === hi && l === lo) return true;
      i = (i + 1) & this.mask;
    }
  }

  clear(): void {
    this.words.fill(0);
    this.size = 0;
  }
}

/**
 * Remembers ids for at least `minAgeMs` (unless the volume forces an early
 * rotation) using two generations. When the current generation is older than
 * `minAgeMs` or half full, the older one is cleared and the two swap. Memory is
 * fixed at 2 * capacity * 8 bytes.
 */
export class RotatingIdSet {
  private cur: CompactIdSet;
  private prev: CompactIdSet;
  private curSince: number;
  /** Rotations forced by volume before minAgeMs elapsed. */
  earlyRotations = 0;

  constructor(
    capacityPerGeneration: number,
    private readonly minAgeMs: number,
    now = Date.now(),
  ) {
    this.cur = new CompactIdSet(capacityPerGeneration);
    this.prev = new CompactIdSet(capacityPerGeneration);
    this.curSince = now;
  }

  add(hi: number, lo: number, now = Date.now()): void {
    if (this.cur.size * 2 >= this.cur.capacity || now - this.curSince >= this.minAgeMs) {
      if (now - this.curSince < this.minAgeMs) this.earlyRotations++;
      const old = this.prev;
      old.clear();
      this.prev = this.cur;
      this.cur = old;
      this.curSince = now;
    }
    this.cur.add(hi, lo);
  }

  has(hi: number, lo: number): boolean {
    return this.cur.has(hi, lo) || this.prev.has(hi, lo);
  }

  addHex(hex: string, now = Date.now()): void {
    const [hi, lo] = hexWords(hex);
    this.add(hi, lo, now);
  }

  hasHex(hex: string): boolean {
    const [hi, lo] = hexWords(hex);
    return this.has(hi, lo);
  }

  get size(): number {
    return this.cur.size + this.prev.size;
  }
}
