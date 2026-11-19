/**
 * Seeded randomness for the scale harness. Everything that must agree between
 * `seed` and `load` (service names, edges, rates) is drawn from here, never
 * from Math.random.
 */

/** sfc32: small, fast, good enough for simulation. Returns floats in [0, 1). */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = seed >>> 0;
    for (let i = 0; i < 12; i++) this.u32();
  }

  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  next(): number {
    return this.u32() / 4294967296;
  }

  /** Integer in [lo, hi], inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Index drawn with probability proportional to weights[i]. */
  weighted(weights: ArrayLike<number>, total?: number): number {
    let sum = total;
    if (sum == null) {
      sum = 0;
      for (let i = 0; i < weights.length; i++) sum += weights[i];
    }
    let r = this.next() * sum;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Standard normal (Box-Muller, one value per call). */
  normal(): number {
    let u = this.next();
    while (u <= 0) u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Lognormal with the given median and log-space sigma. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** Fisher-Yates sample of k distinct items. */
  sample<T>(arr: readonly T[], k: number): T[] {
    const copy = arr.slice();
    const n = Math.min(k, copy.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.next() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }
}

/** 32-bit integer hash of a few integers (stateless, for per-cell noise). */
export function hash32(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ c, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Stateless uniform in [0, 1) for a cell: same inputs, same value. */
export function hashUnit(a: number, b = 0, c = 0): number {
  return hash32(a, b, c) / 4294967296;
}

/** Seed for a named sub-stream, so adding draws to one part of the generator does not shift another. */
export function subSeed(seed: number, name: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < name.length; i++) h = hash32(h, name.charCodeAt(i));
  return h;
}
