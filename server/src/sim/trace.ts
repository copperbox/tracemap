/**
 * Trace generation: builds the spans of one synthetic trace by walking the
 * demo topology from a weighted entry point, the way instrumented services
 * would emit them:
 *  - internal calls produce a CLIENT span (caller) and a SERVER span (callee)
 *  - databases / queues / SaaS APIs produce only the caller's CLIENT span with
 *    semantic-convention attributes, so the collector has to infer the peer
 */
import { errorFor } from './errors.js';
import { hex, pick, rand } from './random.js';
import {
  BASE_LATENCY,
  BASE_ROOTS,
  byId,
  DEFAULT_ERROR_RATE,
  DEPS,
  ERROR_RATE,
  INFRA_TYPES,
  LATENCY_MULTIPLIER,
  type SimService,
} from './topology.js';

export interface SimSpan {
  service: SimService;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startNs: bigint;
  endNs: bigint;
  isError: boolean;
  attrs: Record<string, string | number>;
}

function latencyOf(svc: SimService): number {
  const [a, b] = BASE_LATENCY[svc.type];
  return rand(a, b) * (LATENCY_MULTIPLIER[svc.id] ?? 1);
}

function errors(svc: SimService): boolean {
  return Math.random() < (ERROR_RATE[svc.id] ?? DEFAULT_ERROR_RATE);
}

export function clientAttrsFor(target: SimService, op: string): Record<string, string | number> {
  switch (target.type) {
    case 'postgres':
      return { 'db.system': 'postgresql', 'db.statement': `${op} WHERE ...`, 'server.address': `${target.id}.internal`, 'server.port': 5432 };
    case 'redis':
      return { 'db.system': 'redis', 'db.statement': op, 'server.address': `${target.id}.internal`, 'server.port': 6379 };
    case 'elastic':
      return { 'db.system': 'elasticsearch', 'db.operation': op, 'server.address': `${target.id}.internal`, 'server.port': 9200 };
    case 'kafka':
      return { 'messaging.system': 'kafka', 'messaging.destination.name': op, 'messaging.operation': 'publish', 'server.address': `${target.id}.internal` };
    case 's3':
      return { 'rpc.system': 'aws-api', 'rpc.service': 'S3', 'rpc.method': op, 'aws.s3.bucket': 'media-prod' };
    case 'external': {
      const [method, path] = op.includes(' ') ? op.split(' ') : ['POST', op];
      return { 'http.request.method': method, 'url.full': `https://${target.host}${path}`, 'server.address': target.host ?? target.id };
    }
    default: {
      const [method, path] = op.includes(' ') ? op.split(' ') : ['POST', op];
      return { 'http.request.method': method, 'url.full': `http://${target.id}.internal:8080${path.startsWith('/') ? path : '/' + path}`, 'server.address': `${target.id}.internal`, 'server.port': 8080 };
    }
  }
}

/**
 * Recursively build the spans of one trace rooted at `svcId`.
 * Returns the root server span's duration.
 */
interface WalkResult {
  endNs: bigint;
  /** Did this service's own SERVER span error (what its caller observes)? */
  isError: boolean;
  /** Status the SERVER span returned (200 when healthy). */
  httpStatus: number;
}

function walk(
  svcId: string,
  parentSpanId: string | null,
  startNs: bigint,
  depth: number,
  spans: SimSpan[],
  traceErr: { has: boolean },
): WalkResult {
  const svc = byId.get(svcId)!;
  const op = pick(svc.ops);
  const serverSpanId = hex(16);
  const selfMs = latencyOf(svc);
  let cursorNs = startNs + BigInt(Math.round(selfMs * 0.25 * 1e6));
  let childTotalNs = 0n;

  const isErr = errors(svc);
  const err = isErr ? errorFor(svc) : null;
  if (isErr) traceErr.has = true;
  const serverHttp = err?.httpStatus ?? (isErr ? 500 : 200);

  const children = (DEPS[svcId] ?? []).filter(() => Math.random() < (depth > 2 ? 0.5 : 0.88));
  const childSpans: SimSpan[] = [];

  for (const depId of children) {
    if (spans.length + childSpans.length > 40 || depth > 6) break;
    const dep = byId.get(depId)!;
    const depOp = pick(dep.ops);
    const clientSpanId = hex(16);
    const clientStart = startNs + BigInt(Math.round(selfMs * 0.25 * 1e6)) + childTotalNs;

    if (INFRA_TYPES.includes(dep.type)) {
      const depMs = latencyOf(dep);
      const depErr = errors(dep);
      let depAttrs = clientAttrsFor(dep, depOp);
      if (depErr) {
        traceErr.has = true;
        const e = errorFor(dep);
        depAttrs = { ...depAttrs, ...e.attrs };
        if (e.httpStatus != null) depAttrs['http.response.status_code'] = e.httpStatus;
      }
      childSpans.push({
        service: svc,
        spanId: clientSpanId,
        parentSpanId: serverSpanId,
        name: depOp,
        kind: 3, // CLIENT
        startNs: clientStart,
        endNs: clientStart + BigInt(Math.round(depMs * 1e6)),
        isError: depErr,
        attrs: depAttrs,
      });
      childTotalNs += BigInt(Math.round(depMs * 0.7 * 1e6));
    } else {
      const sub = walk(depId, clientSpanId, clientStart + BigInt(Math.round(0.4 * 1e6)), depth + 1, spans, traceErr);
      const clientEnd = sub.endNs + BigInt(Math.round(0.4 * 1e6));
      // The caller's CLIENT span records the status its callee returned, so a
      // downstream failure surfaces as an error on this edge too.
      let depAttrs = clientAttrsFor(dep, depOp);
      if (sub.isError) {
        depAttrs = { ...depAttrs, 'http.response.status_code': sub.httpStatus, 'error.type': String(sub.httpStatus) };
      }
      childSpans.push({
        service: svc,
        spanId: clientSpanId,
        parentSpanId: serverSpanId,
        name: depOp,
        kind: dep.type === 'kafka' ? 4 : 3,
        startNs: clientStart,
        endNs: clientEnd,
        isError: sub.isError,
        attrs: depAttrs,
      });
      childTotalNs += (clientEnd - clientStart) * 7n / 10n;
    }
  }

  const endNs =
    startNs +
    BigInt(Math.round(selfMs * 1e6)) +
    childTotalNs +
    BigInt(Math.round(rand(0, selfMs * 0.3) * 1e6));

  const [method, path] = op.includes(' ') ? op.split(' ') : ['POST', op];
  spans.push({
    service: svc,
    spanId: serverSpanId,
    parentSpanId,
    name: op,
    kind: 2, // SERVER
    startNs,
    endNs,
    isError: isErr,
    attrs: {
      'http.request.method': method,
      'http.route': path ?? op,
      'http.response.status_code': serverHttp,
      ...(err?.attrs ?? {}),
    },
  });
  spans.push(...childSpans);
  cursorNs = endNs;
  return { endNs: cursorNs, isError: isErr, httpStatus: serverHttp };
}

/**
 * Weighted trace entry points. Defaults to the curated baseline; the simulator
 * replaces it (via setRoots) with the augmented topology's roots so synthetic
 * teams also receive traffic.
 */
export let ROOTS: [string, number][] = BASE_ROOTS;

/** Install a new weighted root set (weights are expected to sum to ~1). */
export function setRoots(roots: [string, number][]): void {
  ROOTS = roots.length ? roots : BASE_ROOTS;
}

export function pickRoot(): string {
  let r = Math.random();
  for (const [id, w] of ROOTS) {
    if ((r -= w) <= 0) return id;
  }
  return ROOTS[0][0];
}

/** Build one trace, optionally forced to start at `rootId` (used for warm-up coverage). */
export function makeTrace(atMs = Date.now(), rootId?: string): { traceId: string; spans: SimSpan[] } {
  const spans: SimSpan[] = [];
  const traceErr = { has: false };
  walk(rootId ?? pickRoot(), null, BigInt(Math.round(atMs * 1e6)) - BigInt(Math.round(rand(5, 60) * 1e6)), 0, spans, traceErr);
  return { traceId: hex(32), spans };
}
