import { addValue, mergeInto, newHist, newWideHist } from '../rollup/hist.js';
import { key2, splitKey2 } from './keys.js';
import {
  ERROR_MESSAGE_MAX,
  OTHER_ERROR_CODE,
  OTHER_OPERATION,
  type RollupKindName,
} from '../rollup/tiers.js';

const MINUTE_MS = 60_000;

/** One rollup row being accumulated in memory. */
export class Cell {
  n = 0;
  err = 0;
  sumMs = 0;
  /** Example kept trace id (32-hex) for error kinds. */
  sample: string | null = null;
  /** Changed since it was last handed to the writer. */
  dirty = true;

  constructor(
    /** Key column values in table order (see ROLLUP_KINDS). */
    readonly keys: readonly string[],
    /** Dense latency histogram; null for count-only kinds. */
    readonly hist: Uint32Array | null,
  ) {}
}

type CellMap = Map<string, Cell>;

/** All cells for one minute of span start time. */
export class MinuteCells {
  readonly cells: Record<RollupKindName, CellMap> = {
    svc_rollup: new Map(),
    op_rollup: new Map(),
    edge_rollup: new Map(),
    edge_op_rollup: new Map(),
    svc_error_rollup: new Map(),
    edge_error_rollup: new Map(),
  };
  /** Distinct ops seen this minute per service, and per edge. */
  private opCount = new Map<string, number>();
  private edgeOpCount = new Map<string, number>();
  /** Distinct error signatures this minute per service, and per edge. */
  private sigCount = new Map<string, number>();
  private edgeSigCount = new Map<string, number>();
  /** All cells written after the minute closed; only svc/edge are kept, for the live window. */
  finalized = false;

  constructor(readonly minute: number) {}

  get startMs(): number {
    return this.minute * MINUTE_MS;
  }

  /** Apply a per-owner distinct-value cap. Returns true when `key` may get a new slot. */
  static admit(counts: Map<string, number>, owner: string, cap: number): boolean {
    const c = counts.get(owner) ?? 0;
    if (c >= cap) return false;
    counts.set(owner, c + 1);
    return true;
  }

  opKey(service: string, op: string, cap: number): string {
    const k = key2(service, op);
    if (op === OTHER_OPERATION || this.cells.op_rollup.has(k)) return op;
    return MinuteCells.admit(this.opCount, service, cap) ? op : OTHER_OPERATION;
  }

  edgeOpKey(edge: string, op: string, cap: number): string {
    const k = key2(edge, op);
    if (op === OTHER_OPERATION || this.cells.edge_op_rollup.has(k)) return op;
    return MinuteCells.admit(this.edgeOpCount, edge, cap) ? op : OTHER_OPERATION;
  }

  sigAllowed(kind: 'svc' | 'edge', owner: string, mapKey: string, cap: number): boolean {
    const map = kind === 'svc' ? this.cells.svc_error_rollup : this.cells.edge_error_rollup;
    if (map.has(mapKey)) return true;
    return MinuteCells.admit(kind === 'svc' ? this.sigCount : this.edgeSigCount, owner, cap);
  }

  /** Free the per-operation and error cells once they are written for good. */
  finalize(): void {
    this.finalized = true;
    this.cells.op_rollup = new Map();
    this.cells.edge_op_rollup = new Map();
    this.cells.svc_error_rollup = new Map();
    this.cells.edge_error_rollup = new Map();
    this.opCount.clear();
    this.edgeOpCount.clear();
    this.sigCount.clear();
    this.edgeSigCount.clear();
  }
}

function getCell(map: CellMap, key: string, keys: () => string[], withHist: boolean): Cell {
  let c = map.get(key);
  if (!c) {
    c = new Cell(keys(), withHist ? newHist() : null);
    map.set(key, c);
  }
  return c;
}

function addRed(c: Cell, durMs: number, isErr: boolean): void {
  c.n++;
  if (isErr) c.err++;
  c.sumMs += durMs;
  addValue(c.hist!, durMs);
  c.dirty = true;
}

export interface ErrorSigInput {
  code: string;
  message: string | null;
}

/** Where a counted error landed, so curation can attach a sample trace id to it. */
export interface SigRef {
  kind: 'svc' | 'edge';
  minute: number;
  mapKey: string;
}

export interface CellStoreOptions {
  /** Minutes (including the current one) that accept spans and are rewritten on each flush. */
  graceMinutes: number;
  /** Minutes of svc/edge cells kept readable for the live snapshot. */
  liveMinutes: number;
  maxOpsPerService: number;
  maxErrorSigsPerService: number;
}

export interface CellStoreCounters {
  /** Spans whose start was older than the grace window, counted into the oldest open minute. */
  clampedPast: number;
  /** Spans whose start was in a future minute, counted into the current minute. */
  clampedFuture: number;
}

/** Rows of one kind ready for the writer. Arrays are parallel. */
export interface RollupBatch {
  kind: RollupKindName;
  bucketMs: number[];
  keys: string[][];
  n: number[];
  err: number[];
  sumMs: number[];
  hist: (Uint32Array | null)[];
  sample: (string | null)[];
}

/** Snapshot handed to the writer; give it back with restoreDirty() if the write fails. */
export interface DirtySnapshot {
  batches: RollupBatch[];
  cells: Cell[];
  rows: number;
}

/**
 * Live-window aggregate for one service or edge: request-handling spans for a
 * service, the caller's client spans for an edge.
 */
export interface LiveAggregate {
  /** Span count. */
  n: number;
  /** Error span count. */
  err: number;
  /** Summed duration, ms. */
  sumMs: number;
  /** Merged latency histogram (see rollup/hist.ts quantile()). */
  hist: Float64Array;
}

export interface LiveWindow<K> {
  /** Start of the covered time, ms epoch: the oldest live minute, or collector start if later. */
  fromMs: number;
  /** End of the covered time (now), ms epoch. */
  toMs: number;
  /** toMs - fromMs in seconds, at least 1. Divide n by this for a rate. */
  seconds: number;
  entries: Map<K, LiveAggregate>;
}

/**
 * Per-minute rollup cells for all six kinds, keyed by minute of span start.
 *
 * The newest `graceMinutes` minutes are open: spans land there (older starts
 * clamp into the oldest open minute, future starts into the current one), and
 * every flush rewrites their changed rows whole. A minute that has left the
 * window gets one last write, then its op and error cells are freed; svc and
 * edge cells stay until they leave the live window.
 */
export class CellStore {
  private minutes = new Map<number, MinuteCells>();
  readonly counters: CellStoreCounters = { clampedPast: 0, clampedFuture: 0 };

  constructor(
    readonly opts: CellStoreOptions,
    /** Collector start, ms epoch: the live window never claims time before it. */
    readonly createdAtMs = Date.now(),
  ) {}

  /** Minute index a span starting at `startMs` is counted in, after clamping. */
  minuteFor(startMs: number, now = Date.now()): number {
    const cur = Math.floor(now / MINUTE_MS);
    const m = Math.floor(startMs / MINUTE_MS);
    if (m > cur) {
      this.counters.clampedFuture++;
      return cur;
    }
    const oldest = cur - this.opts.graceMinutes + 1;
    if (m < oldest || !Number.isFinite(m)) {
      this.counters.clampedPast++;
      return oldest;
    }
    return m;
  }

  private minuteCells(minute: number): MinuteCells {
    let mc = this.minutes.get(minute);
    if (!mc) {
      mc = new MinuteCells(minute);
      this.minutes.set(minute, mc);
    }
    return mc;
  }

  /**
   * Count a request-handling span. Returns the operation name actually used
   * (it may be capped to "(other)") and, for errors, where the signature landed.
   */
  addRequest(
    minute: number,
    service: string,
    operation: string,
    durMs: number,
    isErr: boolean,
    sig: ErrorSigInput | null,
  ): { op: string; sigRef: SigRef | null } {
    const mc = this.minuteCells(minute);
    addRed(getCell(mc.cells.svc_rollup, service, () => [service], true), durMs, isErr);
    const op = mc.opKey(service, operation, this.opts.maxOpsPerService);
    const opKey = key2(service, op);
    addRed(getCell(mc.cells.op_rollup, opKey, () => [service, op], true), durMs, isErr);
    let sigRef: SigRef | null = null;
    if (isErr && sig) sigRef = this.addError(mc, 'svc', service, opKey, [service, op], sig);
    return { op, sigRef };
  }

  /** Count one resolved edge observation (the caller's client span). */
  addEdge(
    minute: number,
    source: string,
    target: string,
    operation: string,
    durMs: number,
    isErr: boolean,
    sig: ErrorSigInput | null,
  ): SigRef | null {
    const mc = this.minuteCells(minute);
    const edgeKey = key2(source, target);
    addRed(getCell(mc.cells.edge_rollup, edgeKey, () => [source, target], true), durMs, isErr);
    const op = mc.edgeOpKey(edgeKey, operation, this.opts.maxOpsPerService);
    const eo = getCell(mc.cells.edge_op_rollup, key2(edgeKey, op), () => [source, target, op], false);
    eo.n++;
    if (isErr) eo.err++;
    eo.dirty = true;
    if (isErr && sig) return this.addError(mc, 'edge', edgeKey, key2(edgeKey, op), [source, target, op], sig);
    return null;
  }

  private addError(
    mc: MinuteCells,
    kind: 'svc' | 'edge',
    owner: string,
    prefix: string,
    prefixKeys: string[],
    sig: ErrorSigInput,
  ): SigRef {
    let code = sig.code;
    let message = (sig.message ?? '').slice(0, ERROR_MESSAGE_MAX);
    let mapKey = key2(prefix, key2(code, message));
    if (!mc.sigAllowed(kind, owner, mapKey, this.opts.maxErrorSigsPerService)) {
      code = OTHER_ERROR_CODE;
      message = '';
      mapKey = key2(prefix, key2(code, ''));
    }
    const map = kind === 'svc' ? mc.cells.svc_error_rollup : mc.cells.edge_error_rollup;
    const c = getCell(map, mapKey, () => [...prefixKeys, code, message], false);
    c.n++;
    c.dirty = true;
    return { kind, minute: mc.minute, mapKey };
  }

  /** Record a kept trace as the example for an error signature, if its row is still open. */
  setSample(ref: SigRef, traceId: string): void {
    const mc = this.minutes.get(ref.minute);
    if (!mc || mc.finalized) return;
    const c = (ref.kind === 'svc' ? mc.cells.svc_error_rollup : mc.cells.edge_error_rollup).get(ref.mapKey);
    if (!c || c.sample === traceId) return;
    c.sample = traceId;
    c.dirty = true;
  }

  /** Histogram of a service operation over minutes [fromMinute, toMinute], or null if unseen. */
  opHist(service: string, op: string, fromMinute: number, toMinute: number): Float64Array | null {
    let out: Float64Array | null = null;
    const k = key2(service, op);
    for (let m = fromMinute; m <= toMinute; m++) {
      const c = this.minutes.get(m)?.cells.op_rollup.get(k);
      if (!c) continue;
      out ??= newWideHist();
      mergeInto(out, c.hist!);
    }
    return out;
  }

  /** Take every dirty cell for the writer and mark it clean. */
  takeDirty(): DirtySnapshot {
    const byKind = new Map<RollupKindName, RollupBatch>();
    const cells: Cell[] = [];
    for (const mc of this.minutes.values()) {
      for (const kind of Object.keys(mc.cells) as RollupKindName[]) {
        for (const c of mc.cells[kind].values()) {
          if (!c.dirty) continue;
          let b = byKind.get(kind);
          if (!b) {
            b = { kind, bucketMs: [], keys: [], n: [], err: [], sumMs: [], hist: [], sample: [] };
            byKind.set(kind, b);
          }
          b.bucketMs.push(mc.startMs);
          b.keys.push(c.keys as string[]);
          b.n.push(c.n);
          b.err.push(c.err);
          b.sumMs.push(c.sumMs);
          // Copy: the live cell keeps counting while the write is in flight.
          b.hist.push(c.hist ? c.hist.slice() : null);
          b.sample.push(c.sample);
          c.dirty = false;
          cells.push(c);
        }
      }
    }
    return { batches: [...byKind.values()], cells, rows: cells.length };
  }

  /** Put a failed snapshot's cells back so the next flush retries them. */
  restoreDirty(snap: DirtySnapshot): void {
    for (const c of snap.cells) c.dirty = true;
  }

  /**
   * After a successful write: finalize minutes that have left the grace window
   * and have nothing left to write, and drop minutes older than the live window.
   */
  retire(now = Date.now()): void {
    const cur = Math.floor(now / MINUTE_MS);
    const oldestOpen = cur - this.opts.graceMinutes + 1;
    const oldestLive = cur - Math.max(this.opts.liveMinutes, this.opts.graceMinutes) + 1;
    for (const [m, mc] of this.minutes) {
      if (m >= oldestOpen) continue;
      if (!mc.finalized && !hasDirty(mc)) mc.finalize();
      if (mc.finalized && m < oldestLive) this.minutes.delete(m);
    }
  }

  /** Closed minutes still waiting for a successful write (grows when the database is down). */
  backlogMinutes(now = Date.now()): number {
    const oldestOpen = Math.floor(now / MINUTE_MS) - this.opts.graceMinutes + 1;
    let n = 0;
    for (const [m, mc] of this.minutes) if (m < oldestOpen && !mc.finalized) n++;
    return n;
  }

  /** Minutes held in memory. */
  get minuteCount(): number {
    return this.minutes.size;
  }

  /** Total cells held, all kinds. */
  cellCount(): number {
    let n = 0;
    for (const mc of this.minutes.values()) for (const m of Object.values(mc.cells)) n += m.size;
    return n;
  }

  /** Per-service aggregates over the live window. */
  liveServices(now = Date.now(), minutes = this.opts.liveMinutes): LiveWindow<string> {
    return this.live('svc_rollup', now, minutes, (c) => c.keys[0]);
  }

  /** Per-edge aggregates over the live window, keyed edgeKey(source, target); use splitEdgeKey(). */
  liveEdges(now = Date.now(), minutes = this.opts.liveMinutes): LiveWindow<string> {
    return this.live('edge_rollup', now, minutes, (c) => key2(c.keys[0], c.keys[1]));
  }

  private live(
    kind: 'svc_rollup' | 'edge_rollup',
    now: number,
    minutes: number,
    keyOf: (c: Cell) => string,
  ): LiveWindow<string> {
    const cur = Math.floor(now / MINUTE_MS);
    const first = cur - minutes + 1;
    const fromMs = Math.max(first * MINUTE_MS, this.createdAtMs);
    const entries = new Map<string, LiveAggregate>();
    for (const [m, mc] of this.minutes) {
      if (m < first || m > cur) continue;
      for (const c of mc.cells[kind].values()) {
        const k = keyOf(c);
        let a = entries.get(k);
        if (!a) {
          a = { n: 0, err: 0, sumMs: 0, hist: newWideHist() };
          entries.set(k, a);
        }
        a.n += c.n;
        a.err += c.err;
        a.sumMs += c.sumMs;
        mergeInto(a.hist, c.hist!);
      }
    }
    return { fromMs, toMs: now, seconds: Math.max(1, (now - fromMs) / 1000), entries };
  }
}

function hasDirty(mc: MinuteCells): boolean {
  for (const m of Object.values(mc.cells)) for (const c of m.values()) if (c.dirty) return true;
  return false;
}

/** Key of the edge (source, target) in liveEdges(). Collision-free for any ids. */
export const edgeKey = key2;

/** Split a liveEdges() key into [sourceId, targetId]. */
export const splitEdgeKey = splitKey2;
