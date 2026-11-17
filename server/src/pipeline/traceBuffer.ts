import type { KeepReason } from '../rollup/tiers.js';
import type { SigRef } from './cells.js';
import { RotatingIdSet, hexWords } from './idSet.js';
import { TokenBucket } from './tokenBucket.js';

const KIND_SERVER = 2;
const KIND_CLIENT = 3;
const KIND_PRODUCER = 4;
const KIND_CONSUMER = 5;
const F_ERROR = 1;
const F_ROOT = 2;
const F_PARENT = 4;
const MAX_SIGS_PER_TRACE = 4;

/**
 * One span as the pipeline hands it to the buffer. The pipeline reuses a
 * single instance of this object, so the buffer copies what it keeps.
 */
export interface SpanInput {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceId: string;
  /** Callee, when edge pairing resolved it at ingest time. */
  peerServiceId: string | null;
  name: string;
  kind: number;
  startMs: number;
  durationMs: number;
  isError: boolean;
  isRoot: boolean;
  httpStatus: number | null;
  attrs: Record<string, unknown>;
  /** For counted error spans: the rollup row its signature landed in. */
  sigRef: SigRef | null;
  /** For roots: the (possibly capped) operation name used in op_rollup. */
  rootOp: string | null;
}

/** A kept span, ready for kept_spans. Ids are kept as u32 word pairs. */
export interface KeptSpanRow {
  traceId: string;
  startMs: number;
  spanHi: number;
  spanLo: number;
  /** null for roots. */
  parentHi: number | null;
  parentLo: number | null;
  serviceId: string;
  peerServiceId: string | null;
  name: string;
  kind: number;
  durationMs: number;
  isError: boolean;
  isRoot: boolean;
  httpStatus: number | null;
  attrsJson: string;
}

export interface KeptTrace {
  traceId: string;
  /** Earliest span start, ms epoch. */
  startMs: number;
  /** Root span duration, or the covered span range when the root never arrived. */
  durationMs: number;
  rootService: string | null;
  rootOperation: string | null;
  hasError: boolean;
  reason: KeepReason;
  spans: KeptSpanRow[];
  /** Services the trace touched, with the operations that errored there. */
  services: Map<string, { hasError: boolean; errorOps: Set<string> }>;
}

/** Where kept traces go (the kept-trace writer's bounded queue). */
export interface KeptSink {
  /** Can the queue take `spans` more spans right now? */
  hasRoom(spans: number): boolean;
  offer(trace: KeptTrace): void;
  /** A span that arrived after its trace was already kept. */
  offerLate(span: KeptSpanRow): boolean;
}

export interface CurationHooks {
  /** p99 in ms of a root operation over recent minutes, or NaN when there is too little data. */
  rootP99(service: string, op: string, now: number): number;
  /** Called when a trace is kept for an error, once per signature it was kept for. */
  onErrorKeep(ref: SigRef, traceId: string): void;
}

export interface TraceBufferOptions {
  /** Decide a trace once no span has arrived for this long, ms. */
  decisionWaitMs: number;
  /** Decide a trace at the latest this long after its first span arrived, ms. */
  maxAgeMs: number;
  /** Span bodies held at most; beyond that, new traces are tracked without bodies. */
  maxSpans: number;
  /** Span bodies held per trace at most; later spans of a big trace are counted only. */
  maxSpansPerTrace: number;
  /** Keeps per error signature per minute. */
  errorQuota: number;
  /** Slow keeps per root operation per minute. */
  slowQuota: number;
  /** Baseline keeps per root operation per minute. */
  baselineQuota: number;
  /** Global kept-span budget, spans/s; the bucket holds one minute of it. */
  keptSpansPerSec: number;
  /** How long decided trace ids are remembered, ms (at least; two generations). */
  decidedTtlMs: number;
  /** Slots per generation of the decided-dropped id set. */
  decidedCapacity: number;
  /**
   * Tokens in the budget at start. Default 0, so a restart cannot grant a
   * fresh minute of burst and kept spans/s never exceeds the budget from boot.
   */
  initialBudgetSpans?: number;
}

export interface TraceBufferStats {
  /** Traces waiting for a decision. */
  activeTraces: number;
  /** Span bodies held. */
  bufferedSpans: number;
  slabCapacity: number;
  /** Traces tracked without bodies because the buffer was full (cumulative). */
  overflowTraces: number;
  /** Spans not held because their trace hit maxSpansPerTrace (cumulative). */
  truncatedSpans: number;
  decided: number;
  kept: Record<KeepReason, number>;
  keptSpans: number;
  dropped: {
    /** No rule applied, or the rule's quota was used up. */
    notSelected: number;
    /** A rule applied but the global span budget was exhausted. */
    budget: number;
    /** Tracked without bodies (buffer full). */
    overflow: number;
    /** The kept-trace writer queue was full. */
    queueFull: number;
  };
  lateKeptSpans: number;
  lateDroppedSpans: number;
  /** Tokens left in the kept-span budget. */
  budgetTokens: number;
}

interface TraceEntry {
  id: string;
  head: number;
  tail: number;
  bodies: number;
  firstArrival: number;
  lastArrival: number;
  minStart: number;
  maxEnd: number;
  rootService: string | null;
  rootOp: string | null;
  rootName: string | null;
  rootDur: number;
  hasError: boolean;
  sigs: SigRef[] | null;
  bodiless: boolean;
}

/** Struct-of-arrays span storage with a free list; grows by doubling up to `max`. */
class SpanSlab {
  cap = 0;
  used = 0;
  start = new Float64Array(0);
  dur = new Float64Array(0);
  sidHi = new Uint32Array(0);
  sidLo = new Uint32Array(0);
  pidHi = new Uint32Array(0);
  pidLo = new Uint32Array(0);
  svc = new Int32Array(0);
  peer = new Int32Array(0);
  http = new Int32Array(0);
  next = new Int32Array(0);
  kind = new Uint8Array(0);
  flags = new Uint8Array(0);
  name: (string | undefined)[] = [];
  attrs: (string | undefined)[] = [];
  private free = new Int32Array(0);
  private freeTop = 0;

  constructor(private readonly max: number) {
    this.grow(Math.min(65_536, max));
  }

  private grow(to: number): void {
    const copy = <T extends Float64Array | Uint32Array | Int32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
      const b = make(to);
      b.set(a);
      return b;
    };
    this.start = copy(this.start, (n) => new Float64Array(n));
    this.dur = copy(this.dur, (n) => new Float64Array(n));
    this.sidHi = copy(this.sidHi, (n) => new Uint32Array(n));
    this.sidLo = copy(this.sidLo, (n) => new Uint32Array(n));
    this.pidHi = copy(this.pidHi, (n) => new Uint32Array(n));
    this.pidLo = copy(this.pidLo, (n) => new Uint32Array(n));
    this.svc = copy(this.svc, (n) => new Int32Array(n));
    this.peer = copy(this.peer, (n) => new Int32Array(n));
    this.http = copy(this.http, (n) => new Int32Array(n));
    this.next = copy(this.next, (n) => new Int32Array(n));
    this.kind = copy(this.kind, (n) => new Uint8Array(n));
    this.flags = copy(this.flags, (n) => new Uint8Array(n));
    const free = new Int32Array(to);
    free.set(this.free.subarray(0, this.freeTop));
    for (let i = to - 1; i >= this.cap; i--) free[this.freeTop++] = i;
    this.free = free;
    this.name.length = to;
    this.attrs.length = to;
    this.cap = to;
  }

  /** A free slot, or -1 when the slab is at its maximum. */
  alloc(): number {
    if (this.freeTop === 0) {
      if (this.cap >= this.max) return -1;
      this.grow(Math.min(this.cap * 2, this.max));
    }
    this.used++;
    return this.free[--this.freeTop];
  }

  release(slot: number): void {
    this.name[slot] = undefined;
    this.attrs[slot] = undefined;
    this.free[this.freeTop++] = slot;
    this.used--;
  }

  get full(): boolean {
    return this.used >= this.max;
  }
}

/** Interns strings so held spans share one copy of each service id and span name. */
class Interner {
  private ids = new Map<string, number>();
  private strs: string[] = [];
  id(s: string): number {
    let i = this.ids.get(s);
    if (i === undefined) {
      i = this.strs.length;
      this.strs.push(s);
      this.ids.set(s, i);
    }
    return i;
  }
  str(i: number): string {
    return this.strs[i];
  }
}

/** Dedupes span-name strings; cleared when large, which only costs some sharing. */
class StringPool {
  private m = new Map<string, string>();
  constructor(private readonly max = 100_000) {}
  get(s: string): string {
    const hit = this.m.get(s);
    if (hit !== undefined) return hit;
    if (this.m.size >= this.max) this.m.clear();
    this.m.set(s, s);
    return s;
  }
}

/**
 * Holds spans per trace until the trace is decided, then keeps or drops it.
 *
 * A trace is decided once quiet for `decisionWaitMs` or older than `maxAgeMs`.
 * Rules, first match wins:
 *   1. error: an error span whose signature has quota left this minute;
 *   2. slow: root duration at or above that root operation's p99;
 *   3. baseline: quota per root operation per minute.
 * Every keep spends its span count from a global token bucket; baseline keeps
 * spend only while the bucket is over half full, so errors and slow traces
 * get the budget under load.
 *
 * Decided ids are remembered for a while: late spans of a kept trace go
 * straight to the writer, late spans of a dropped one are ignored.
 */
export class TraceBuffer {
  private traces = new Map<string, TraceEntry>();
  private slab: SpanSlab;
  private services = new Interner();
  private names = new StringPool();
  private keptIds: RotatingIdSet;
  private droppedIds: RotatingIdSet;
  private budget: TokenBucket;
  private quotaMinute = -1;
  private quota = new Map<string, number>();
  private c = {
    overflowTraces: 0,
    truncatedSpans: 0,
    decided: 0,
    kept: { error: 0, slow: 0, baseline: 0 } as Record<KeepReason, number>,
    keptSpans: 0,
    dropped: { notSelected: 0, budget: 0, overflow: 0, queueFull: 0 },
    lateKeptSpans: 0,
    lateDroppedSpans: 0,
  };

  constructor(
    private readonly opts: TraceBufferOptions,
    private readonly sink: KeptSink,
    private readonly hooks: CurationHooks,
    now = Date.now(),
  ) {
    this.slab = new SpanSlab(opts.maxSpans);
    this.keptIds = new RotatingIdSet(Math.max(1024, opts.decidedCapacity >> 4), opts.decidedTtlMs, now);
    this.droppedIds = new RotatingIdSet(opts.decidedCapacity, opts.decidedTtlMs, now);
    const cap = opts.keptSpansPerSec * 60;
    this.budget = new TokenBucket(opts.keptSpansPerSec, cap, opts.initialBudgetSpans ?? 0, now);
  }

  add(s: SpanInput, now = Date.now()): void {
    let t = this.traces.get(s.traceId);
    if (!t) {
      const [hi, lo] = hexWords(s.traceId);
      if (this.keptIds.has(hi, lo)) {
        if (this.sink.offerLate(this.rowFromInput(s))) this.c.lateKeptSpans++;
        return;
      }
      if (this.droppedIds.has(hi, lo)) {
        this.c.lateDroppedSpans++;
        return;
      }
      const bodiless = this.slab.full;
      if (bodiless) this.c.overflowTraces++;
      t = {
        id: s.traceId,
        head: -1,
        tail: -1,
        bodies: 0,
        firstArrival: now,
        lastArrival: now,
        minStart: s.startMs,
        maxEnd: s.startMs + s.durationMs,
        rootService: null,
        rootOp: null,
        rootName: null,
        rootDur: 0,
        hasError: false,
        sigs: null,
        bodiless,
      };
      this.traces.set(s.traceId, t);
    }
    t.lastArrival = now;
    if (s.startMs < t.minStart) t.minStart = s.startMs;
    const end = s.startMs + s.durationMs;
    if (end > t.maxEnd) t.maxEnd = end;
    if (s.isRoot) {
      t.rootService = s.serviceId;
      t.rootOp = s.rootOp ?? s.name;
      t.rootName = s.name;
      t.rootDur = s.durationMs;
    }
    if (s.isError) {
      t.hasError = true;
      if (s.sigRef) {
        t.sigs ??= [];
        if (t.sigs.length < MAX_SIGS_PER_TRACE) t.sigs.push(s.sigRef);
      }
    }
    if (t.bodiless) return;
    if (t.bodies >= this.opts.maxSpansPerTrace) {
      this.c.truncatedSpans++;
      return;
    }
    const slot = this.slab.alloc();
    if (slot < 0) {
      // Full mid-trace: an incomplete trace is not worth keeping, so free what it holds.
      this.c.overflowTraces++;
      this.releaseBodies(t);
      t.bodiless = true;
      return;
    }
    this.store(slot, s);
    if (t.tail < 0) t.head = slot;
    else this.slab.next[t.tail] = slot;
    t.tail = slot;
    t.bodies++;
  }

  private store(slot: number, s: SpanInput): void {
    const sl = this.slab;
    sl.start[slot] = s.startMs;
    sl.dur[slot] = s.durationMs;
    const [shi, slo] = hexWords(s.spanId);
    sl.sidHi[slot] = shi;
    sl.sidLo[slot] = slo;
    let flags = 0;
    if (s.parentSpanId) {
      const [phi, plo] = hexWords(s.parentSpanId);
      sl.pidHi[slot] = phi;
      sl.pidLo[slot] = plo;
      flags |= F_PARENT;
    }
    if (s.isError) flags |= F_ERROR;
    if (s.isRoot) flags |= F_ROOT;
    sl.flags[slot] = flags;
    sl.kind[slot] = s.kind;
    sl.svc[slot] = this.services.id(s.serviceId);
    sl.peer[slot] = s.peerServiceId ? this.services.id(s.peerServiceId) : -1;
    sl.http[slot] = s.httpStatus ?? -1;
    sl.next[slot] = -1;
    sl.name[slot] = this.names.get(s.name);
    sl.attrs[slot] = JSON.stringify(s.attrs);
  }

  private rowFromInput(s: SpanInput): KeptSpanRow {
    const [spanHi, spanLo] = hexWords(s.spanId);
    const parent = s.parentSpanId ? hexWords(s.parentSpanId) : null;
    return {
      traceId: s.traceId,
      startMs: s.startMs,
      spanHi,
      spanLo,
      parentHi: parent ? parent[0] : null,
      parentLo: parent ? parent[1] : null,
      serviceId: s.serviceId,
      peerServiceId: s.peerServiceId,
      name: s.name,
      kind: s.kind,
      durationMs: s.durationMs,
      isError: s.isError,
      isRoot: s.isRoot,
      httpStatus: s.httpStatus,
      attrsJson: JSON.stringify(s.attrs),
    };
  }

  private releaseBodies(t: TraceEntry): void {
    let slot = t.head;
    while (slot >= 0) {
      const next = this.slab.next[slot];
      this.slab.release(slot);
      slot = next;
    }
    t.head = t.tail = -1;
    t.bodies = 0;
  }

  /** Decide every trace that is due. Call about once a second. */
  sweep(now = Date.now()): void {
    for (const t of this.traces.values()) {
      // Insertion order is first-arrival order: nothing after this can be due.
      if (now - t.firstArrival < this.opts.decisionWaitMs) break;
      if (now - t.lastArrival >= this.opts.decisionWaitMs || now - t.firstArrival >= this.opts.maxAgeMs) {
        this.decide(t, now);
      }
    }
  }

  /** Decide everything now (shutdown). */
  decideAll(now = Date.now()): void {
    for (const t of this.traces.values()) this.decide(t, now);
  }

  private takeQuota(key: string, cap: number, minute: number): boolean {
    if (minute !== this.quotaMinute) {
      this.quotaMinute = minute;
      this.quota.clear();
    }
    const used = this.quota.get(key) ?? 0;
    if (used >= cap) return false;
    this.quota.set(key, used + 1);
    return true;
  }

  private decide(t: TraceEntry, now: number): void {
    this.traces.delete(t.id);
    this.c.decided++;
    const [hi, lo] = hexWords(t.id);
    if (t.bodiless) this.c.dropped.overflow++;
    const reason = t.bodiless ? null : this.choose(t, now);
    if (!reason) {
      this.droppedIds.add(hi, lo, now);
      this.releaseBodies(t);
      return;
    }
    const kept = this.materialize(t, reason);
    this.releaseBodies(t);
    this.sink.offer(kept);
    this.keptIds.add(hi, lo, now);
    this.c.kept[reason]++;
    this.c.keptSpans += kept.spans.length;
    if (reason === 'error' && t.sigs) for (const ref of t.sigs) this.hooks.onErrorKeep(ref, t.id);
  }

  /** Apply the rules; on a keep the quota and budget are already spent. */
  private choose(t: TraceEntry, now: number): KeepReason | null {
    const minute = Math.floor(now / 60_000);
    const cost = t.bodies;
    if (cost === 0) {
      this.c.dropped.notSelected++;
      return null;
    }
    // The first rule with quota left decides; if the budget or queue cannot
    // take the trace, it is dropped rather than tried against a weaker rule.
    const keep = (reason: KeepReason, key: string, cap: number, floor: number): KeepReason | null => {
      if (!this.sink.hasRoom(cost)) {
        this.c.dropped.queueFull++;
        return null;
      }
      if (!this.budget.trySpend(cost, now, floor)) {
        this.c.dropped.budget++;
        return null;
      }
      this.takeQuota(key, cap, minute);
      return reason;
    };

    for (const ref of t.sigs ?? []) {
      const key = `e${ref.kind}|${ref.mapKey}`;
      if (this.quotaLeft(key, this.opts.errorQuota, minute)) return keep('error', key, this.opts.errorQuota, 0);
    }
    if (t.rootService && t.rootOp) {
      const rootKey = t.rootService + '|' + t.rootOp;
      const slowKey = `s|${rootKey}`;
      if (t.rootDur > 0 && this.quotaLeft(slowKey, this.opts.slowQuota, minute)) {
        const p99 = this.hooks.rootP99(t.rootService, t.rootOp, now);
        if (Number.isFinite(p99) && t.rootDur >= p99) return keep('slow', slowKey, this.opts.slowQuota, 0);
      }
      const baseKey = `b|${rootKey}`;
      if (this.quotaLeft(baseKey, this.opts.baselineQuota, minute)) {
        return keep('baseline', baseKey, this.opts.baselineQuota, this.budget.capacity / 2);
      }
    }
    this.c.dropped.notSelected++;
    return null;
  }

  private quotaLeft(key: string, cap: number, minute: number): boolean {
    if (minute !== this.quotaMinute) return cap > 0;
    return (this.quota.get(key) ?? 0) < cap;
  }

  private materialize(t: TraceEntry, reason: KeepReason): KeptTrace {
    const sl = this.slab;
    // Fill in callees edge pairing had not resolved yet, from server spans in the same trace.
    const serverByParent = new Map<string, number>();
    for (let s = t.head; s >= 0; s = sl.next[s]) {
      const k = sl.kind[s];
      if ((k === KIND_SERVER || k === KIND_CONSUMER) && sl.flags[s] & F_PARENT) {
        serverByParent.set(`${sl.pidHi[s]}:${sl.pidLo[s]}`, sl.svc[s]);
      }
    }
    const spans: KeptSpanRow[] = [];
    const services = new Map<string, { hasError: boolean; errorOps: Set<string> }>();
    for (let s = t.head; s >= 0; s = sl.next[s]) {
      const flags = sl.flags[s];
      const kind = sl.kind[s];
      const serviceId = this.services.str(sl.svc[s]);
      let peer = sl.peer[s];
      if (peer < 0 && (kind === KIND_CLIENT || kind === KIND_PRODUCER)) {
        const callee = serverByParent.get(`${sl.sidHi[s]}:${sl.sidLo[s]}`);
        if (callee !== undefined && callee !== sl.svc[s]) peer = callee;
      }
      const isError = (flags & F_ERROR) !== 0;
      const name = sl.name[s] ?? '';
      spans.push({
        traceId: t.id,
        startMs: sl.start[s],
        spanHi: sl.sidHi[s],
        spanLo: sl.sidLo[s],
        parentHi: flags & F_PARENT ? sl.pidHi[s] : null,
        parentLo: flags & F_PARENT ? sl.pidLo[s] : null,
        serviceId,
        peerServiceId: peer >= 0 ? this.services.str(peer) : null,
        name,
        kind,
        durationMs: sl.dur[s],
        isError,
        isRoot: (flags & F_ROOT) !== 0,
        httpStatus: sl.http[s] >= 0 ? sl.http[s] : null,
        attrsJson: sl.attrs[s] ?? '{}',
      });
      let svc = services.get(serviceId);
      if (!svc) {
        svc = { hasError: false, errorOps: new Set() };
        services.set(serviceId, svc);
      }
      if (isError) {
        svc.hasError = true;
        svc.errorOps.add(name);
      }
    }
    return {
      traceId: t.id,
      startMs: t.minStart,
      durationMs: t.rootService ? t.rootDur : Math.max(0, t.maxEnd - t.minStart),
      rootService: t.rootService,
      rootOperation: t.rootName,
      hasError: t.hasError,
      reason,
      spans,
      services,
    };
  }

  stats(now = Date.now()): TraceBufferStats {
    return {
      activeTraces: this.traces.size,
      bufferedSpans: this.slab.used,
      slabCapacity: this.slab.cap,
      overflowTraces: this.c.overflowTraces,
      truncatedSpans: this.c.truncatedSpans,
      decided: this.c.decided,
      kept: { ...this.c.kept },
      keptSpans: this.c.keptSpans,
      dropped: { ...this.c.dropped },
      lateKeptSpans: this.c.lateKeptSpans,
      lateDroppedSpans: this.c.lateDroppedSpans,
      budgetTokens: Math.floor(this.budget.available(now)),
    };
  }
}
