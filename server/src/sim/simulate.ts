/**
 * TraceMap demo traffic generator.
 *
 * Replays the 40-service e-commerce topology as real OTLP/JSON trace exports
 * against the collector, exactly the way instrumented services would:
 *  - internal calls produce a CLIENT span (caller) and a SERVER span (callee)
 *  - databases / queues / SaaS APIs produce only the caller's CLIENT span with
 *    semantic-convention attributes, so the collector has to infer the peer
 *  - every resource carries a `team.name` attribute, which the collector uses
 *    to auto-create teams and assign ownership on first sight
 *
 * Usage: npm run simulate [-- --otlp http://localhost:4318 --api http://localhost:4000 --tps 6]
 *
 * While running (attached to a TTY), the trace rate can be dialed live:
 *   [+] double rate, [-] halve rate, [0]/[space]/[p] pause/resume, [q] quit.
 */
import { applyKey, RateControl } from './rate.js';
import {
  BASE_LATENCY,
  byId,
  DEFAULT_ERROR_RATE,
  DEPS,
  ERROR_RATE,
  INFRA_TYPES,
  LATENCY_MULTIPLIER,
  SERVICES,
  type SimService,
} from './topology.js';

const args = process.argv.slice(2);
function argOf(name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const OTLP = argOf('otlp', process.env.OTLP_URL ?? 'http://127.0.0.1:4318');
const API = argOf('api', process.env.API_URL ?? 'http://127.0.0.1:4000');
const TPS = Number(argOf('tps', process.env.SIM_TPS ?? '6'));

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const hex = (n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

interface SimSpan {
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

function clientAttrsFor(target: SimService, op: string): Record<string, string | number> {
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
function walk(
  svcId: string,
  parentSpanId: string | null,
  startNs: bigint,
  depth: number,
  spans: SimSpan[],
  traceErr: { has: boolean },
): bigint {
  const svc = byId.get(svcId)!;
  const op = pick(svc.ops);
  const serverSpanId = hex(16);
  const selfMs = latencyOf(svc);
  let cursorNs = startNs + BigInt(Math.round(selfMs * 0.25 * 1e6));
  let childTotalNs = 0n;

  const isErr = errors(svc);
  if (isErr) traceErr.has = true;

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
      if (depErr) traceErr.has = true;
      childSpans.push({
        service: svc,
        spanId: clientSpanId,
        parentSpanId: serverSpanId,
        name: depOp,
        kind: 3, // CLIENT
        startNs: clientStart,
        endNs: clientStart + BigInt(Math.round(depMs * 1e6)),
        isError: depErr,
        attrs: clientAttrsFor(dep, depOp),
      });
      childTotalNs += BigInt(Math.round(depMs * 0.7 * 1e6));
    } else {
      const subEnd = walk(depId, clientSpanId, clientStart + BigInt(Math.round(0.4 * 1e6)), depth + 1, spans, traceErr);
      const clientEnd = subEnd + BigInt(Math.round(0.4 * 1e6));
      childSpans.push({
        service: svc,
        spanId: clientSpanId,
        parentSpanId: serverSpanId,
        name: depOp,
        kind: dep.type === 'kafka' ? 4 : 3,
        startNs: clientStart,
        endNs: clientEnd,
        isError: false,
        attrs: clientAttrsFor(dep, depOp),
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
      'http.response.status_code': isErr ? 500 : 200,
    },
  });
  spans.push(...childSpans);
  cursorNs = endNs;
  return cursorNs;
}

// ---- OTLP/JSON encoding ----

function toAnyValue(v: string | number): Record<string, unknown> {
  return typeof v === 'number'
    ? Number.isInteger(v)
      ? { intValue: String(v) }
      : { doubleValue: v }
    : { stringValue: v };
}

function exportPayload(traceId: string, spans: SimSpan[]): unknown {
  const byService = new Map<string, SimSpan[]>();
  for (const s of spans) {
    const arr = byService.get(s.service.id) ?? [];
    arr.push(s);
    byService.set(s.service.id, arr);
  }
  return {
    resourceSpans: [...byService.entries()].map(([svcId, svcSpans]) => {
      const svc = byId.get(svcId)!;
      return {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: svcId } },
            { key: 'team.name', value: { stringValue: svc.team } },
            { key: 'telemetry.sdk.language', value: { stringValue: svc.lang ?? 'unknown' } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'opentelemetry' } },
            { key: 'telemetry.sdk.version', value: { stringValue: '1.30.0' } },
            { key: 'cloud.region', value: { stringValue: 'us-east-1' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'tracemap-sim', version: '1.0.0' },
            spans: svcSpans.map((s) => ({
              traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId ?? undefined,
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: Object.entries(s.attrs).map(([key, value]) => ({ key, value: toAnyValue(value) })),
              status: s.isError ? { code: 2, message: 'simulated failure' } : { code: 0 },
            })),
          },
        ],
      };
    }),
  };
}

async function post(path: string, body: unknown, base = OTLP): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
}

const ROOTS: [string, number][] = [
  ['api-gateway', 0.8],
  ['storefront-bff', 0.08],
  ['checkout-bff', 0.06],
  ['admin-bff', 0.06],
];

function pickRoot(): string {
  let r = Math.random();
  for (const [id, w] of ROOTS) {
    if ((r -= w) <= 0) return id;
  }
  return 'api-gateway';
}

function makeTrace(atMs = Date.now()): { traceId: string; spans: SimSpan[] } {
  const spans: SimSpan[] = [];
  const traceErr = { has: false };
  walk(pickRoot(), null, BigInt(Math.round(atMs * 1e6)) - BigInt(Math.round(rand(5, 60) * 1e6)), 0, spans, traceErr);
  return { traceId: hex(32), spans };
}

/**
 * Assign teams/types for inferred peers (databases, queues, SaaS APIs) via the
 * management API, like an operator would. Instrumented services do not need
 * this: they declare their owner through the `team.name` resource attribute
 * on their traces.
 */
async function seedOwnership(): Promise<void> {
  for (const svc of SERVICES.filter((s) => INFRA_TYPES.includes(s.type))) {
    try {
      const res = await fetch(`${API}/api/services/${encodeURIComponent(svc.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teamName: svc.team, type: svc.type }),
      });
      if (!res.ok && res.status !== 404) console.warn(`seed ${svc.id}: ${res.status}`);
    } catch (err) {
      console.warn(`seed ${svc.id} failed:`, (err as Error).message);
    }
  }
  console.log('Ownership seeded for inferred peers (teams + types).');
}

async function sendMetricsSample(): Promise<void> {
  const svc = pick(SERVICES.filter((s) => !INFRA_TYPES.includes(s.type)));
  const now = BigInt(Date.now()) * 1_000_000n;
  await post('/v1/metrics', {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: svc.id } }] },
        scopeMetrics: [
          {
            scope: { name: 'tracemap-sim' },
            metrics: [
              {
                name: 'process.runtime.memory.heap_used',
                unit: 'MiB',
                gauge: { dataPoints: [{ timeUnixNano: now.toString(), asDouble: rand(80, 480) }] },
              },
            ],
          },
        ],
      },
    ],
  });
}

const rate = new RateControl(TPS);

/** Live rate dial: only active when stdin is an interactive terminal. */
function attachKeyboard(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003' /* Ctrl+C; raw mode swallows SIGINT */) process.exit(0);
    const msg = applyKey(rate, key);
    if (msg) console.log(msg);
  });
  console.log('Keys: [+] double rate, [-] halve rate, [0/space/p] pause, [q] quit');
}

async function main(): Promise<void> {
  console.log(`TraceMap simulator: ${rate.label()} -> ${OTLP} (api ${API})`);
  attachKeyboard();

  // Send one warm-up trace so services start registering (team.name on each
  // resource assigns instrumented services), then seed the inferred peers.
  const warm = makeTrace();
  await post('/v1/traces', exportPayload(warm.traceId, warm.spans));
  await new Promise((r) => setTimeout(r, 1500));
  await seedOwnership();
  // Inferred peers (databases, SaaS APIs) appear after the first edge flush;
  // re-run so they get their team/type too.
  setTimeout(() => seedOwnership().catch(() => undefined), 20_000);

  let sent = 0;
  let windowSent = 0;
  // Report throughput per window rather than a running total, so the log
  // doubles as feedback for the [+]/[-] rate dial.
  const REPORT_MS = 10_000;
  setInterval(() => {
    if (windowSent > 0) console.log(`${windowSent} traces sent in the last ${REPORT_MS / 1000}s`);
    windowSent = 0;
  }, REPORT_MS).unref();
  // Fire traces on a jittered cadence approximating the current dial; the
  // interval is re-read every iteration so [+]/[-] take effect immediately.
  const loop = async (): Promise<void> => {
    if (!rate.paused) {
      const t = makeTrace();
      try {
        await post('/v1/traces', exportPayload(t.traceId, t.spans));
        sent += 1;
        windowSent += 1;
        if (sent % 25 === 0) await sendMetricsSample().catch(() => undefined);
      } catch (err) {
        console.warn('send failed:', (err as Error).message);
      }
    }
    setTimeout(loop, rate.paused ? 250 : rate.intervalMs() * rand(0.5, 1.5));
  };
  for (let i = 0; i < Math.max(1, Math.min(4, Math.round(TPS / 3))); i++) {
    setTimeout(loop, i * 120);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
