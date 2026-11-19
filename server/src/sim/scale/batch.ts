/**
 * Turns walker traces into OTLP/protobuf export requests: spans grouped by
 * service (one ResourceSpans each), unique trace ids, current timestamps and
 * the attributes the collector infers peers and error signatures from.
 */
import type { Fleet, FleetNode } from './fleet.js';
import { encodeRequest, encodeResourceHeader, PbWriter, writeSpan } from './otlpEncode.js';
import type { Prng } from './prng.js';
import { KIND_CONSUMER, TraceBuf, type Walker } from './walker.js';

type Attrs = [string, string | number][];

function splitOp(op: string): [string, string] {
  const sp = op.indexOf(' ');
  if (sp < 0) return ['POST', op.startsWith('/') ? op : `/${op}`];
  const method = op.slice(0, sp);
  const path = op.slice(sp + 1);
  return /^[A-Z]+$/.test(method) ? [method, path] : ['GET', path.startsWith('/') ? path : `/${path}`];
}

/** Static attributes of a client span calling `target` with op `op`. */
export function clientAttrs(target: FleetNode, op: string): Attrs {
  switch (target.type) {
    case 'postgres':
      return [['db.system', 'postgresql'], ['db.statement', `${op} WHERE id = $1`], ['server.address', target.host], ['server.port', 5432]];
    case 'redis':
      return [['db.system', 'redis'], ['db.statement', op], ['server.address', target.host], ['server.port', 6379]];
    case 'elastic':
      return [['db.system', 'elasticsearch'], ['db.operation', op], ['server.address', target.host], ['server.port', 9200]];
    case 'kafka':
      return [['messaging.system', 'kafka'], ['messaging.destination.name', op.split(' ')[0]], ['messaging.operation', 'publish'], ['server.address', target.host]];
    case 's3':
      return [['rpc.system', 'aws-api'], ['rpc.service', 'S3'], ['rpc.method', op.replace('S3.', '')]];
    case 'external': {
      const [method, path] = splitOp(op);
      return [['http.request.method', method], ['url.full', `https://${target.host}${path}`], ['server.address', target.host]];
    }
    default: {
      const [method, path] = splitOp(op);
      return [['http.request.method', method], ['url.full', `http://${target.host}:8080${path}`], ['server.address', target.host], ['server.port', 8080]];
    }
  }
}

function serverAttrs(node: FleetNode, op: string, kind: number): Attrs {
  if (kind === KIND_CONSUMER) return [['messaging.system', 'kafka'], ['messaging.operation', 'process']];
  const [method, route] = splitOp(op);
  return [['http.request.method', method], ['http.route', route]];
}

export interface Batch {
  body: Buffer;
  spans: number;
  traces: number;
}

export class BatchBuilder {
  private readonly headers: ({ resource: Buffer; scope: Buffer } | null)[];
  private readonly serverAttrsByOp: Attrs[];
  private readonly clientAttrsByEdgeOp: Attrs[];
  private readonly groups = new Map<number, PbWriter>();
  private readonly pool: PbWriter[] = [];
  private readonly out = new PbWriter(1 << 20);
  private readonly buf = new TraceBuf();
  private readonly runId: number;
  private traceCounter = 0;

  constructor(
    private readonly fleet: Fleet,
    private readonly walker: Walker,
    private readonly r: Prng,
  ) {
    this.runId = r.u32();
    this.headers = fleet.nodes.map((n) => {
      if (!n.instrumented) return null;
      const attrs: Record<string, string | number> = { 'service.name': n.id };
      if (n.team != null) attrs['team.name'] = fleet.teams[n.team].name;
      attrs['telemetry.sdk.language'] = n.lang ?? 'unknown';
      attrs['telemetry.sdk.name'] = 'opentelemetry';
      attrs['telemetry.sdk.version'] = '1.30.0';
      attrs['cloud.region'] = n.region;
      return encodeResourceHeader(attrs, 'tracemap-scale', '1.0.0');
    });
    this.serverAttrsByOp = [];
    for (const n of fleet.nodes) n.ops.forEach((op, i) => (this.serverAttrsByOp[n.opBase + i] = serverAttrs(n, op, i === n.rootOp ? KIND_CONSUMER : 2)));
    this.clientAttrsByEdgeOp = [];
    for (const e of fleet.edges) e.ops.forEach((op, j) => (this.clientAttrsByEdgeOp[e.opBase + j] = clientAttrs(fleet.nodes[e.t], op)));
  }

  private writerFor(node: number): PbWriter {
    let w = this.groups.get(node);
    if (!w) {
      w = this.pool.pop() ?? new PbWriter(4096);
      w.reset();
      this.groups.set(node, w);
    }
    return w;
  }

  /** A 16-byte trace id: run id, counter, then random bits. Unique within a run, and across runs in practice. */
  private traceId(): Buffer {
    const id = Buffer.allocUnsafe(16);
    id.writeUInt32BE(this.runId, 0);
    id.writeUInt32BE(this.traceCounter++ >>> 0, 4);
    id.writeUInt32BE(this.r.u32(), 8);
    id.writeUInt32BE(this.r.u32(), 12);
    return id;
  }

  /** Append one walked trace ending at `nowMs`. Returns its span count. */
  private addTrace(nowMs: number): number {
    const { fleet, buf } = this;
    const rootDur = this.walker.trace(buf);
    const traceId = this.traceId();
    const ids = Buffer.allocUnsafe(8 * buf.len);
    for (let i = 0; i < buf.len; i++) {
      ids.writeUInt32BE(this.r.u32(), i * 8);
      ids.writeUInt32BE((this.r.u32() | 1) >>> 0, i * 8 + 4);
    }
    const baseMs = nowMs - rootDur;
    for (let i = 0; i < buf.len; i++) {
      const node = fleet.nodes[buf.node[i]];
      const isClient = buf.edge[i] >= 0;
      const attrs: Attrs = isClient
        ? this.clientAttrsByEdgeOp[fleet.edges[buf.edge[i]].opBase + buf.op[i]].slice()
        : this.serverAttrsByOp[node.opBase + buf.op[i]].slice();
      const sig = buf.sig[i];
      if (!isClient && buf.kind[i] !== KIND_CONSUMER) attrs.push(['http.response.status_code', buf.status[i]]);
      else if (isClient && buf.err[i] && buf.status[i]) attrs.push(['http.response.status_code', buf.status[i]]);
      if (sig) for (const [k, v] of Object.entries(sig.attrs)) attrs.push([k, v]);
      const startMs = baseMs + buf.startMs[i];
      const p = buf.parent[i];
      writeSpan(this.writerFor(buf.node[i]), {
        traceId,
        spanId: ids.subarray(i * 8, i * 8 + 8),
        parentSpanId: p >= 0 ? ids.subarray(p * 8, p * 8 + 8) : null,
        name: isClient ? fleet.edges[buf.edge[i]].ops[buf.op[i]] : node.ops[buf.op[i]],
        kind: buf.kind[i],
        startNs: Math.round(startMs * 1e6),
        endNs: Math.round((startMs + buf.durMs[i]) * 1e6),
        attrs,
        statusCode: buf.err[i] ? 2 : 0,
        statusMessage: sig?.message ?? '',
      });
    }
    return buf.len;
  }

  /** Whole traces until at least `targetSpans` spans, as one export request. */
  build(targetSpans: number, nowMs = Date.now()): Batch {
    let spans = 0;
    let traces = 0;
    while (spans < targetSpans) {
      spans += this.addTrace(nowMs);
      traces++;
    }
    return { body: this.flush(), spans, traces };
  }

  /** One SERVER span per instrumented service, so the collector learns every service up front. */
  registration(nowMs = Date.now()): Batch {
    let spans = 0;
    for (const n of this.fleet.nodes) {
      if (!n.instrumented || !n.ops.length) continue;
      const op = n.rootOp >= 0 ? n.rootOp : 0;
      writeSpan(this.writerFor(n.idx), {
        traceId: this.traceId(),
        spanId: Buffer.from([1, 2, 3, 4, 5, 6, 7, (spans & 0x7f) | 1]),
        parentSpanId: null,
        name: n.ops[op],
        kind: op === n.rootOp ? KIND_CONSUMER : 2,
        startNs: Math.round((nowMs - n.selfMs) * 1e6),
        endNs: Math.round(nowMs * 1e6),
        attrs: [...this.serverAttrsByOp[n.opBase + op], ...(op === n.rootOp ? [] : ([['http.response.status_code', 200]] as Attrs))],
        statusCode: 0,
        statusMessage: '',
      });
      spans++;
    }
    return { body: this.flush(), spans, traces: spans };
  }

  private flush(): Buffer {
    const groups: { resource: Buffer; scope: Buffer; spans: PbWriter }[] = [];
    for (const [node, w] of this.groups) {
      const h = this.headers[node]!;
      groups.push({ resource: h.resource, scope: h.scope, spans: w });
    }
    const body = encodeRequest(groups, this.out);
    for (const w of this.groups.values()) this.pool.push(w);
    this.groups.clear();
    return body;
  }
}
