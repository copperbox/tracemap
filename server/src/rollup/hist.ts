/**
 * Log-bucket latency histogram shared by the collector, the rollup tiers and
 * the read path.
 *
 * Bucket i covers [0.01 * 1.1^i, 0.01 * 1.1^(i+1)) milliseconds, 176 buckets,
 * so 0.01 ms up to about 186 s. Values outside clamp into bucket 0 or 175.
 * A quantile is interpolated inside its bucket by rank, log-linearly between
 * the bucket's bounds, so it always lands inside the bucket that holds the
 * true value: the error is at most one bucket width (10%), and much less for
 * smooth distributions. Series move continuously instead of in 10% steps.
 *
 * In memory a histogram is a dense array of counts: Uint32Array for one
 * collector-minute, Float64Array for anything merged (exact up to 2^53).
 * On disk it is a sparse byte string of repeated
 * (varint bucket-index delta, varint count) pairs.
 */

export const HIST_BUCKETS = 176;
export const HIST_BASE_MS = 0.01;
export const HIST_GROWTH = 1.1;

const LN_GROWTH = Math.log(HIST_GROWTH);

/** Dense counts, indexed by bucket. */
export type Hist = Uint32Array | Float64Array;

/** A fresh per-minute histogram (counts fit u32). */
export function newHist(): Uint32Array {
  return new Uint32Array(HIST_BUCKETS);
}

/** A fresh histogram for merged data; f64 so daily counts cannot overflow. */
export function newWideHist(): Float64Array {
  return new Float64Array(HIST_BUCKETS);
}

/** Bucket index for a duration in ms. Non-finite or non-positive values land in bucket 0. */
export function bucketOf(ms: number): number {
  if (!(ms > HIST_BASE_MS)) return 0;
  const b = Math.floor(Math.log(ms / HIST_BASE_MS) / LN_GROWTH);
  return b >= HIST_BUCKETS ? HIST_BUCKETS - 1 : b;
}

/** Lower bound of bucket i, in ms. */
export function bucketLowerMs(i: number): number {
  return HIST_BASE_MS * Math.pow(HIST_GROWTH, i);
}

/** Geometric midpoint of bucket i, in ms. */
export function bucketMidMs(i: number): number {
  return HIST_BASE_MS * Math.pow(HIST_GROWTH, i + 0.5);
}

/** Count one observation of `ms`. */
export function addValue(hist: Hist, ms: number): void {
  hist[bucketOf(ms)] += 1;
}

/** Sum of all counts. */
export function histTotal(hist: ArrayLike<number>): number {
  let t = 0;
  for (let i = 0; i < hist.length; i++) t += hist[i];
  return t;
}

/** Largest count a bucket of `target` can hold exactly. */
function limitOf(target: Hist): number {
  return target instanceof Uint32Array ? 0xffff_ffff : Number.MAX_SAFE_INTEGER;
}

/**
 * target += src, bucket by bucket. Throws instead of wrapping a Uint32Array
 * bucket or rounding a Float64Array one past 2^53.
 */
export function mergeInto(target: Hist, src: ArrayLike<number>): Hist {
  const limit = limitOf(target);
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const c = src[i];
    if (!c) continue;
    const v = target[i] + c;
    if (v > limit) throw new RangeError(`histogram bucket ${i} overflows: ${v}`);
    target[i] = v;
  }
  return target;
}

/**
 * Quantile q in [0, 1], in ms. Finds the first bucket whose cumulative count
 * reaches q * total, then places the value by its rank within that bucket:
 * lower * 1.1^f, where f is the share of the bucket's count below the target
 * rank (0 at the lower bound, 1 at the upper). The result never leaves the
 * bucket. NaN for an empty histogram.
 */
export function quantile(hist: ArrayLike<number>, q: number): number {
  const total = histTotal(hist);
  if (total <= 0) return NaN;
  const target = Math.min(Math.max(q, 0), 1) * total;
  let acc = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const c = hist[i];
    if (!(c > 0)) continue;
    if (acc + c >= target) {
      const f = Math.min(1, Math.max(0, (target - acc) / c));
      return HIST_BASE_MS * Math.pow(HIST_GROWTH, i + f);
    }
    acc += c;
  }
  // Only reachable through float rounding of the target: the top non-empty bucket.
  for (let i = HIST_BUCKETS - 1; i >= 0; i--) if (hist[i] > 0) return bucketLowerMs(i + 1);
  return NaN;
}

// ---- sparse codec ----

const MAX_COUNT = Number.MAX_SAFE_INTEGER;

function varintLen(v: number): number {
  let n = 1;
  while (v >= 128) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

function writeVarint(buf: Buffer, pos: number, v: number): number {
  // Division instead of shifts: counts can exceed 2^32.
  while (v >= 128) {
    buf[pos++] = (v % 128) | 128;
    v = Math.floor(v / 128);
  }
  buf[pos++] = v;
  return pos;
}

/** Encode to the sparse on-disk form. An empty histogram encodes to zero bytes. */
export function encode(hist: ArrayLike<number>): Buffer {
  let len = 0;
  let prev = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const c = hist[i];
    if (!c) continue;
    if (!(c > 0 && c <= MAX_COUNT && Number.isInteger(c))) {
      throw new RangeError(`histogram bucket ${i} has invalid count ${c}`);
    }
    len += varintLen(i - prev) + varintLen(c);
    prev = i;
  }
  const out = Buffer.allocUnsafe(len);
  let pos = 0;
  prev = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    const c = hist[i];
    if (!c) continue;
    pos = writeVarint(out, pos, i - prev);
    pos = writeVarint(out, pos, c);
    prev = i;
  }
  return out;
}

/**
 * Decode a sparse histogram and ADD its counts into `target`.
 * Throws on a malformed buffer, a count above 2^53 - 1, or a sum the target
 * cannot hold exactly, rather than silently miscounting.
 */
export function decodeInto(buf: Uint8Array, target: Hist): Hist {
  const limit = limitOf(target);
  let pos = 0;
  let idx = 0;
  const readVarint = (): number => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (pos >= buf.length) throw new RangeError('truncated histogram varint');
      const b = buf[pos++];
      v += (b & 127) * mul;
      if (v > MAX_COUNT) throw new RangeError('histogram varint exceeds 2^53 - 1');
      if (b < 128) return v;
      mul *= 128;
      if (mul > 2 ** 56) throw new RangeError('histogram varint too long');
    }
  };
  while (pos < buf.length) {
    idx += readVarint();
    const count = readVarint();
    if (idx >= HIST_BUCKETS) throw new RangeError(`histogram bucket ${idx} out of range`);
    const sum = target[idx] + count;
    if (sum > limit) throw new RangeError(`histogram bucket ${idx} overflows: ${sum}`);
    target[idx] = sum;
  }
  return target;
}

/** Decode into a fresh wide histogram. */
export function decode(buf: Uint8Array): Float64Array {
  return decodeInto(buf, newWideHist()) as Float64Array;
}
