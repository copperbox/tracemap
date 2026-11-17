/**
 * Builds one trace by walking the fleet's call graph from a root. Used by
 * `load` (which encodes the spans) and by seed calibration (which only counts
 * them), so seeded history and live traffic come from the same model.
 *
 * - An instrumented callee yields the caller's CLIENT span plus the callee's
 *   SERVER span (parent = that client span). The client span fails when the
 *   callee fails and records the callee's HTTP status.
 * - A peer (database, queue, SaaS) yields only the caller's CLIENT/PRODUCER span.
 * - Gateways route each request to exactly one entry point.
 */
import type { Fleet } from './fleet.js';
import type { Prng } from './prng.js';
import { callerSig, type Sig } from './signatures.js';

export const KIND_SERVER = 2;
export const KIND_CONSUMER = 5;

const MAX_SPANS = 120;
const MAX_DEPTH = 8;

/** Spans of one trace, struct-of-arrays, reused between traces. */
export class TraceBuf {
  len = 0;
  node: number[] = [];
  /** Server spans: op index in the node. Client spans: op index in the edge. */
  op: number[] = [];
  /** Edge index for client spans, -1 for server spans. */
  edge: number[] = [];
  kind: number[] = [];
  parent: number[] = [];
  startMs: number[] = [];
  durMs: number[] = [];
  err: boolean[] = [];
  sig: (Sig | null)[] = [];
  status: number[] = [];

  reset(): void {
    this.len = 0;
  }

  push(node: number, op: number, edge: number, kind: number, parent: number, startMs: number): number {
    const i = this.len++;
    this.node[i] = node;
    this.op[i] = op;
    this.edge[i] = edge;
    this.kind[i] = kind;
    this.parent[i] = parent;
    this.startMs[i] = startMs;
    this.durMs[i] = 0;
    this.err[i] = false;
    this.sig[i] = null;
    this.status[i] = 0;
    return i;
  }
}

/** Per-node overrides while generating: incidents. */
export interface Effects {
  /** Added to the failure probability of every op of the node. */
  errAdd: Float64Array;
  /** Multiplies the node's latency. */
  latMul: Float64Array;
}

export function noEffects(fleet: Fleet): Effects {
  return { errAdd: new Float64Array(fleet.nodes.length), latMul: new Float64Array(fleet.nodes.length).fill(1) };
}

function pickSig(r: Prng, sigs: Sig[]): Sig {
  let total = 0;
  for (const s of sigs) total += s.weight;
  let x = r.next() * total;
  for (const s of sigs) {
    x -= s.weight;
    if (x < 0) return s;
  }
  return sigs[sigs.length - 1];
}

export class Walker {
  private readonly rootW: number[];
  private readonly rootTotal: number;
  private readonly routeW: number[][];

  constructor(
    private readonly fleet: Fleet,
    private readonly r: Prng,
    public effects: Effects = noEffects(fleet),
  ) {
    this.rootW = fleet.roots.map((x) => x.weight);
    this.rootTotal = this.rootW.reduce((a, b) => a + b, 0);
    this.routeW = fleet.nodes.map((n) => (n.routes ? fleet.out[n.idx].map((e) => fleet.edges[e].p) : []));
  }

  /** Fill `buf` with one trace starting at time 0 (ms, relative). Returns the root's duration. */
  trace(buf: TraceBuf): number {
    buf.reset();
    const root = this.fleet.roots[this.r.weighted(this.rootW, this.rootTotal)].node;
    const node = this.fleet.nodes[root];
    if (node.routes) {
      this.server(buf, root, -1, -1, 0, 0, KIND_SERVER);
    } else {
      this.server(buf, root, node.rootOp, -1, 0, 0, KIND_CONSUMER);
    }
    return buf.durMs[0];
  }

  /**
   * One server span and its subtree. `op` -1 means "chosen by the route"
   * (gateways only). Returns the span's index.
   */
  private server(buf: TraceBuf, nodeIdx: number, op: number, parent: number, startMs: number, depth: number, kind: number): number {
    const { fleet, r, effects } = this;
    const node = fleet.nodes[nodeIdx];
    const out = fleet.out[nodeIdx];
    let route = -1;
    if (node.routes) {
      route = r.weighted(this.routeW[nodeIdx]);
      op = route;
    }
    const i = buf.push(nodeIdx, op, -1, kind, parent, startMs);
    const self = r.lognormal(node.selfMs * effects.latMul[nodeIdx], node.sigma);
    const isErr = r.next() < node.opErr[op] + effects.errAdd[nodeIdx];
    const sig = isErr ? pickSig(r, node.sigs) : null;

    let cursor = startMs + self * 0.2;
    let lastEnd = cursor;
    const call = (ei: number): void => {
      const e = fleet.edges[ei];
      const eop = e.ops.length > 1 ? r.weighted(e.opW) : 0;
      const ci = buf.push(nodeIdx, eop, ei, e.kind, i, cursor);
      const target = fleet.nodes[e.t];
      let dur: number;
      if (target.instrumented) {
        const si = this.server(buf, e.t, e.targetOps[eop], ci, cursor + 0.3, depth + 1, KIND_SERVER);
        dur = buf.durMs[si] + 0.6;
        if (buf.err[si]) {
          buf.err[ci] = true;
          buf.status[ci] = buf.status[si];
          buf.sig[ci] = callerSig(buf.status[si]);
        }
      } else {
        dur = r.lognormal(target.selfMs * effects.latMul[e.t], target.sigma);
        if (r.next() < target.opErr[e.targetOps[eop]] + effects.errAdd[e.t]) {
          const s = pickSig(r, target.sigs);
          buf.err[ci] = true;
          buf.sig[ci] = s;
          buf.status[ci] = s.httpStatus ?? 0;
        }
      }
      buf.durMs[ci] = dur;
      lastEnd = Math.max(lastEnd, cursor + dur);
      // Some calls overlap the next one.
      cursor += r.next() < 0.3 ? dur * 0.3 : dur;
    };

    if (route >= 0) {
      call(out[route]);
    } else if (depth < MAX_DEPTH) {
      for (const ei of out) {
        if (buf.len >= MAX_SPANS) break;
        if (r.next() < fleet.edges[ei].p) call(ei);
      }
    }
    buf.durMs[i] = Math.max(cursor, lastEnd) - startMs + self * 0.8;
    buf.err[i] = isErr;
    buf.sig[i] = sig;
    buf.status[i] = isErr ? (sig?.httpStatus ?? 500) : 200;
    return i;
  }
}
