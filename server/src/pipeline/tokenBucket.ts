/** Classic token bucket: `ratePerSec` tokens accrue up to `capacity`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly ratePerSec: number,
    readonly capacity: number,
    initial = capacity,
    now = Date.now(),
  ) {
    this.tokens = Math.min(initial, capacity);
    this.last = now;
  }

  /** Tokens available now. */
  available(now = Date.now()): number {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
    }
    return this.tokens;
  }

  /** Spend `n` tokens if at least `n` (and, when given, more than `floor`) are available. */
  trySpend(n: number, now = Date.now(), floor = 0): boolean {
    const t = this.available(now);
    if (t < n || t <= floor) return false;
    this.tokens = t - n;
    return true;
  }
}
