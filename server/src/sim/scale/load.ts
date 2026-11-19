/**
 * `scale load`: OTLP/protobuf traces for the seeded fleet at a target span
 * rate over several keep-alive connections, honoring 429 Retry-After.
 *
 * Generation runs on the main thread: the hand-written encoder builds well
 * over 100,000 spans/s on one core (printed at start), so the default 20,000
 * spans/s leaves ample headroom. The status line says when the generator, the
 * connections or the collector is what limits the rate.
 */
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import type { Opts } from './args.js';
import { BatchBuilder, type Batch } from './batch.js';
import { buildFleet, describeFleet, type Fleet } from './fleet.js';
import { latencyFactor } from './model.js';
import { Prng } from './prng.js';
import { decide } from './retry.js';
import { noEffects, Walker } from './walker.js';

export interface LoadTotals {
  seconds: number;
  sentSpans: number;
  acceptedSpans: number;
  droppedSpans: number;
  requests: number;
  retries: number;
  status: Record<string, number>;
}

export interface LoadHandle {
  /** Resolves when the run ends (duration reached or stop() called). */
  done: Promise<LoadTotals>;
  stop(): void;
}

interface Window {
  at: number;
  sent: number;
  accepted: number;
  c4xx: number;
  c429: number;
  c5xx: number;
  neterr: number;
  retries: number;
  dropped: number;
  genMs: number;
  reqMs: number[];
  busySamples: number;
  busySum: number;
}

const newWindow = (): Window => ({ at: performance.now(), sent: 0, accepted: 0, c4xx: 0, c429: 0, c5xx: 0, neterr: 0, retries: 0, dropped: 0, genMs: 0, reqMs: [], busySamples: 0, busySum: 0 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The OTLP/HTTP traces endpoint for a collector base URL, as OTLP exporters
 * derive it from OTEL_EXPORTER_OTLP_ENDPOINT: `/v1/traces` appended to any path
 * prefix. A URL that already ends in `/v1/traces` is used as is.
 */
export function tracesEndpoint(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`--otlp ${base}: not a URL (use e.g. http://127.0.0.1:4318)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`--otlp ${base}: use http:// or https://`);
  const prefix = url.pathname.replace(/\/+$/, '');
  if (!prefix.endsWith('/v1/traces')) url.pathname = `${prefix}/v1/traces`;
  url.hash = '';
  return url;
}

/** A keep-alive agent for the endpoint's protocol. */
export function agentFor(url: URL, maxSockets: number): http.Agent {
  return url.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets }) : new http.Agent({ keepAlive: true, maxSockets });
}

export interface PostResult {
  /** HTTP status, or null when the request failed or the response did not complete. */
  status: number | null;
  retryAfter?: string;
  ms: number;
}

/**
 * POST one export request. Always settles: on a complete response, on any
 * request or response error, when the connection closes before the body
 * ends, and at `deadlineMs` after the start (the request is then destroyed).
 */
export function post(agent: http.Agent, url: URL, body: Buffer, gzip: boolean, deadlineMs = 30_000): Promise<PostResult> {
  const started = performance.now();
  const payload = gzip ? gzipSync(body, { level: 1 }) : body;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (status: number | null, retryAfter?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ status, retryAfter, ms: performance.now() - started });
    };
    const request = url.protocol === 'https:' ? https.request : http.request;
    const req = request(
      url,
      {
        agent,
        method: 'POST',
        headers: {
          'content-type': 'application/x-protobuf',
          'content-length': payload.length,
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => settle(res.statusCode ?? null, res.headers['retry-after'] as string | undefined));
        // The collector hung up after the headers: the export may not have been taken, so count it as failed.
        res.on('aborted', () => settle(null));
        res.on('error', () => settle(null));
        res.on('close', () => settle(null));
      },
    );
    const deadline = setTimeout(() => {
      settle(null);
      req.destroy(new Error('deadline'));
    }, deadlineMs);
    req.on('error', () => settle(null));
    req.on('close', () => settle(null));
    req.end(payload);
  });
}

/** Spans/s one thread can build and encode, measured for `ms`. */
export function measureGenerator(builder: BatchBuilder, batch: number, ms = 400): number {
  const t0 = performance.now();
  let spans = 0;
  while (performance.now() - t0 < ms) spans += builder.build(batch).spans;
  return spans / ((performance.now() - t0) / 1000);
}

const q50 = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const fmtRate = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Start a load run. Returns immediately; `done` resolves with totals.
 * `fleet` may be passed in to share it with the caller.
 */
export function startLoad(opts: Opts, log: (s: string) => void = console.log, fleetIn?: Fleet): LoadHandle {
  const fleet = fleetIn ?? buildFleet({ services: opts.services as number, teams: opts.teams as number, seed: opts['topology-seed'] as number });
  const rate = opts.rate as number;
  const connections = Math.max(1, Math.floor(opts.connections as number));
  const batchSpans = Math.max(1, Math.floor(opts.batch as number));
  const durationS = opts.duration as number;
  const gzip = !!opts.gzip;
  const url = tracesEndpoint(opts.otlp as string);
  const deadlineMs = (opts.timeout as number) * 1000;
  const statusEveryMs = (opts['status-every'] as number) * 1000;

  const r = new Prng((Date.now() ^ process.pid) >>> 0);
  const effects = noEffects(fleet);
  const walker = new Walker(fleet, r, effects);
  const builder = new BatchBuilder(fleet, walker, r);
  const agent = agentFor(url, connections);
  // Latency follows the same time-of-day model as the seeded history, so charts continue across the seam.
  const updateLatency = () => {
    const now = Date.now();
    for (let i = 0; i < fleet.nodes.length; i++) effects.latMul[i] = latencyFactor(fleet.nodes[i], now);
  };
  updateLatency();

  let incidentNode = -1;
  if (opts.incident) {
    incidentNode = fleet.byId.get(opts.incident as string) ?? -1;
    if (incidentNode < 0) throw new Error(`--incident ${opts.incident}: no such service in this fleet (check --services/--teams/--topology-seed)`);
  }

  log(`[load] fleet: ${describeFleet(fleet)}`);
  log(`[load] sending to ${url.href}`);
  const capacity = measureGenerator(builder, batchSpans);
  log(`[load] generator capacity on one thread: ${fmtRate(capacity)} spans/s; target ${fmtRate(rate)} spans/s over ${connections} connections, ${batchSpans} spans per request${gzip ? ', gzip' : ''}`);
  if (capacity < rate * 1.2) log(`[load] warning: one thread cannot build ${fmtRate(rate)} spans/s with headroom; the status line will say "generator-bound"`);

  let stopped = false;
  let stopResolve: () => void = () => {};
  const stopSignal = new Promise<void>((res) => (stopResolve = res));
  const stop = () => {
    stopped = true;
    stopResolve();
  };

  const totals: LoadTotals = { seconds: 0, sentSpans: 0, acceptedSpans: 0, droppedSpans: 0, requests: 0, retries: 0, status: {} };
  let win = newWindow();
  let busy = 0;
  let t0 = 0;

  const send = async (batch: Batch): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      busy++;
      const res = await post(agent, url, batch.body, gzip, deadlineMs);
      busy--;
      totals.requests++;
      win.reqMs.push(res.ms);
      const key = res.status == null ? 'neterr' : String(res.status);
      totals.status[key] = (totals.status[key] ?? 0) + 1;
      if (res.status == null) win.neterr++;
      else if (res.status === 429) win.c429++;
      else if (res.status >= 500) win.c5xx++;
      else if (res.status >= 400) win.c4xx++;
      const d = decide(res.status, res.retryAfter, attempt);
      if (d.action === 'accepted') {
        totals.acceptedSpans += batch.spans;
        win.accepted += batch.spans;
        return;
      }
      if (d.action === 'drop') {
        totals.droppedSpans += batch.spans;
        win.dropped += batch.spans;
        return;
      }
      totals.retries++;
      win.retries++;
      await Promise.race([sleep(d.delayMs), stopSignal]);
      if (stopped) {
        totals.droppedSpans += batch.spans;
        return;
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      const elapsed = (performance.now() - t0) / 1000;
      const ahead = totals.sentSpans - elapsed * rate;
      if (ahead > 0) {
        await Promise.race([sleep(Math.min(250, (ahead / rate) * 1000)), stopSignal]);
        continue;
      }
      const g = performance.now();
      const batch = builder.build(batchSpans);
      win.genMs += performance.now() - g;
      totals.sentSpans += batch.spans;
      win.sent += batch.spans;
      await send(batch);
    }
  };

  const statusLine = (): void => {
    const now = performance.now();
    const secs = (now - win.at) / 1000;
    const sent = win.sent / secs;
    const accepted = win.accepted / secs;
    const genFrac = win.genMs / (now - win.at);
    const avgBusy = win.busySamples ? win.busySum / win.busySamples : 0;
    let verdict = 'on target';
    if (sent < rate * 0.95) {
      if (genFrac > 0.8) verdict = `generator-bound: building spans used ${Math.round(genFrac * 100)}% of the thread`;
      else if (win.c429 > 0) verdict = 'collector is shedding load (429)';
      else if (avgBusy >= connections - 0.5) verdict = `connection-bound: all ${connections} connections waiting on the collector; add --connections or the collector is slow`;
      else verdict = 'below target';
    }
    const el = Math.round((now - t0) / 1000);
    const clock = `${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}`;
    log(
      `[load ${clock}] target ${fmtRate(rate)}  sent ${fmtRate(sent)}/s  accepted ${fmtRate(accepted)}/s  ` +
        `4xx ${win.c4xx}  429 ${win.c429}  5xx ${win.c5xx}  neterr ${win.neterr}  retries ${win.retries}  dropped ${win.dropped}  ` +
        `req p50 ${q50(win.reqMs).toFixed(0)}ms  busy ${avgBusy.toFixed(1)}/${connections}  gen ${Math.round(genFrac * 100)}%  ${verdict}`,
    );
    win = newWindow();
  };

  const done = (async (): Promise<LoadTotals> => {
    // Register every service first, so peers resolve to instrumented callees from the first trace.
    await send(builder.registration());
    Object.assign(totals, { acceptedSpans: 0, droppedSpans: 0, requests: 0, retries: 0, status: {} });
    t0 = performance.now();
    win = newWindow();
    const timers = [
      setInterval(statusLine, statusEveryMs),
      setInterval(updateLatency, 1000),
      setInterval(() => {
        win.busySamples++;
        win.busySum += busy;
      }, 100),
    ];
    if (incidentNode >= 0) {
      const afterMs = (opts['incident-after'] as number) * 1000;
      timers.push(
        setTimeout(() => {
          effects.errAdd[incidentNode] = opts['incident-rate'] as number;
          log(`[load] incident started: ${fleet.nodes[incidentNode].id} now fails ${Math.round((opts['incident-rate'] as number) * 100)}% more requests`);
        }, afterMs),
      );
    }
    if (durationS > 0) timers.push(setTimeout(stop, durationS * 1000));
    await Promise.all(Array.from({ length: connections }, loop));
    for (const t of timers) clearTimeout(t);
    agent.destroy();
    totals.seconds = (performance.now() - t0) / 1000;
    return totals;
  })();

  return { done, stop };
}

export function formatTotals(t: LoadTotals): string {
  const non200 = Object.entries(t.status).filter(([k]) => k !== '200').reduce((a, [, v]) => a + v, 0);
  return (
    `[load] ${t.seconds.toFixed(0)} s: sent ${t.sentSpans.toLocaleString('en-US')} spans (${fmtRate(t.sentSpans / t.seconds)}/s), ` +
    `accepted ${t.acceptedSpans.toLocaleString('en-US')} (${fmtRate(t.acceptedSpans / t.seconds)}/s), dropped ${t.droppedSpans}, ` +
    `${t.requests} requests, ${non200} non-200, ${t.retries} retries, status ${JSON.stringify(t.status)}`
  );
}

export async function runLoad(opts: Opts): Promise<LoadTotals> {
  const h = startLoad(opts);
  const onSig = () => {
    console.log('\n[load] stopping (Ctrl-C again to quit at once)');
    process.off('SIGINT', onSig);
    h.stop();
  };
  process.on('SIGINT', onSig);
  const totals = await h.done;
  console.log(formatTotals(totals));
  return totals;
}
