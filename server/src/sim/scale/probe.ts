/**
 * `scale probe`: time every API endpoint the UI uses, measure response sizes
 * raw and gzip-compressed, decode the live metrics frame and check it against
 * the live structure, watch the SSE stream's cadence, and print /api/health.
 * A missing endpoint is reported as "not available", not as a failure.
 */
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Opts } from './args.js';
import { checkFrame, decodeFrame, SseParser, type FrameCheck } from './frame.js';

export interface EndpointResult {
  name: string;
  path: string;
  status: number | null;
  requests: number;
  p50Ms: number | null;
  maxMs: number | null;
  /** Decompressed body size. */
  rawBytes: number | null;
  /** gzip size: as sent by the server when it compressed, else computed here. */
  gzipBytes: number | null;
  /** True when the server itself sent gzip. */
  serverGzip: boolean;
  note: string;
}

export interface SseResult {
  available: boolean;
  seconds: number;
  hello: unknown;
  events: Record<string, number>;
  comments: number;
  metricsIntervalP50Ms: number | null;
  metricsIntervalMaxMs: number | null;
  note: string;
}

export interface ProbeResult {
  at: string;
  api: string;
  service: string | null;
  edge: [string, string] | null;
  traceId: string | null;
  endpoints: EndpointResult[];
  frame: (FrameCheck & { seq: number; structureVersion: number; nServices: number; nEdges: number; ageMs: number }) | { error: string } | null;
  sse: SseResult;
  health: unknown;
}

interface RawResponse {
  status: number | null;
  ms: number;
  wire: Buffer;
  body: Buffer;
  gzip: boolean;
  error?: string;
}

function get(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const started = performance.now();
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = lib.get(url, { headers: { 'accept-encoding': 'gzip', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const wire = Buffer.concat(chunks);
        const gz = res.headers['content-encoding'] === 'gzip';
        let body = wire;
        if (gz) {
          try {
            body = gunzipSync(wire);
          } catch {
            body = wire;
          }
        }
        resolve({ status: res.statusCode ?? null, ms: performance.now() - started, wire, body, gzip: gz });
      });
      res.on('error', (e) => resolve({ status: null, ms: performance.now() - started, wire: Buffer.alloc(0), body: Buffer.alloc(0), gzip: false, error: e.message }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error('timeout after 60 s')));
    req.on('error', (e) => resolve({ status: null, ms: performance.now() - started, wire: Buffer.alloc(0), body: Buffer.alloc(0), gzip: false, error: e.message }));
  });
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** Run one endpoint `repeat` times; returns the timing row and the last body. */
async function timeEndpoint(base: string, name: string, path: string, repeat: number): Promise<{ row: EndpointResult; last: RawResponse | null }> {
  const times: number[] = [];
  let last: RawResponse | null = null;
  for (let i = 0; i < repeat; i++) {
    last = await get(base + path);
    if (last.status == null) break;
    times.push(last.ms);
    if (last.status === 404) break;
  }
  const row: EndpointResult = {
    name, path, status: last?.status ?? null, requests: times.length,
    p50Ms: times.length ? median(times) : null, maxMs: times.length ? Math.max(...times) : null,
    rawBytes: null, gzipBytes: null, serverGzip: false, note: '',
  };
  if (!last || last.status == null) {
    row.note = `error: ${last?.error ?? 'no response'}`;
  } else if (last.status === 404) {
    row.note = 'not available';
  } else {
    row.rawBytes = last.body.length;
    row.serverGzip = last.gzip;
    row.gzipBytes = last.gzip ? last.wire.length : gzipSync(last.body).length;
    if (last.status >= 400) row.note = last.body.toString('utf8').slice(0, 80);
    else if (isEmptyJson(last)) row.note = 'empty';
  }
  return { row, last };
}

function isEmptyJson(r: RawResponse): boolean {
  if (r.body.length > 4096) return false;
  try {
    const v = JSON.parse(r.body.toString('utf8')) as unknown;
    if (Array.isArray(v)) return v.length === 0;
    if (v && typeof v === 'object') {
      const vals = Object.values(v as Record<string, unknown>);
      return vals.length > 0 && vals.every((x) => (Array.isArray(x) ? x.length === 0 : x == null));
    }
  } catch {
    // not JSON
  }
  return false;
}

function json<T>(r: RawResponse | null): T | null {
  if (!r || r.status !== 200) return null;
  try {
    return JSON.parse(r.body.toString('utf8')) as T;
  } catch {
    return null;
  }
}

interface StructureLike {
  version: number;
  services: { id: string; isExternal: boolean }[];
  edges: { s: number; t: number }[];
}
interface TopologyLike {
  services: { id: string; isExternal: boolean; metrics?: { rps: number; errPct: number } }[];
  edges: { source: string; target: string }[];
}

/** Watch the live stream for `seconds`. */
function watchSse(url: string, seconds: number): Promise<SseResult> {
  const result: SseResult = { available: false, seconds, hello: null, events: {}, comments: 0, metricsIntervalP50Ms: null, metricsIntervalMaxMs: null, note: '' };
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const parser = new SseParser();
    const metricsAt: number[] = [];
    let settled = false;
    const finish = (note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      result.comments = parser.comments;
      const gaps = metricsAt.slice(1).map((t, i) => t - metricsAt[i]);
      if (gaps.length) {
        result.metricsIntervalP50Ms = Math.round(median(gaps));
        result.metricsIntervalMaxMs = Math.round(Math.max(...gaps));
      }
      if (note) result.note = note;
      resolve(result);
    };
    const req = lib.get(url, { headers: { accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode === 404) return finish('not available');
      if (res.statusCode !== 200) return finish(`HTTP ${res.statusCode}`);
      if (!String(res.headers['content-type'] ?? '').includes('text/event-stream')) {
        return finish(`content-type ${res.headers['content-type'] ?? 'missing'}`);
      }
      result.available = true;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        for (const ev of parser.feed(chunk)) {
          result.events[ev.event] = (result.events[ev.event] ?? 0) + 1;
          if (ev.event === 'hello') {
            try {
              result.hello = JSON.parse(ev.data);
            } catch {
              result.hello = ev.data;
            }
          }
          if (ev.event === 'metrics') metricsAt.push(performance.now());
        }
      });
      res.on('end', () => finish('stream closed by server'));
    });
    req.on('error', (e) => finish(`error: ${e.message}`));
    const timer = setTimeout(() => finish(), seconds * 1000);
  });
}

export async function runProbe(opts: Opts, log: (s: string) => void = console.log): Promise<ProbeResult> {
  const api = (opts.api as string).replace(/\/+$/, '');
  const base = `${api}/api`;
  const repeat = Math.max(1, Math.floor(opts.repeat as number));
  const rows: EndpointResult[] = [];
  const run = async (name: string, path: string) => {
    const r = await timeEndpoint(base, name, path, repeat);
    rows.push(r.row);
    return r.last;
  };

  const health = json<unknown>(await run('health', '/health'));
  const structureRes = await run('live structure', '/live/structure');
  const metricsRes = await run('live metrics frame', '/live/metrics');
  const topologyRes = await run('topology', '/topology');
  await run('services', '/services');

  const structure = json<StructureLike>(structureRes);
  const topology = json<TopologyLike>(topologyRes);

  // ---- frame ----
  let frame: ProbeResult['frame'] = null;
  let frameErr: Float32Array | null = null;
  if (metricsRes?.status === 200) {
    try {
      const f = decodeFrame(metricsRes.body);
      frameErr = f.services;
      frame = structure
        ? { ...checkFrame(f, structure), seq: f.seq, structureVersion: f.structureVersion, nServices: f.nServices, nEdges: f.nEdges, ageMs: Date.now() - f.generatedAtMs }
        : { error: 'frame decoded but no structure to check it against' };
    } catch (e) {
      frame = { error: (e as Error).message };
    }
  }

  // ---- pick the service, edge and trace to probe ----
  let service = (opts.service as string | null) ?? null;
  if (!service) {
    if (topology?.services?.length) {
      const own = topology.services.filter((s) => !s.isExternal && s.metrics && s.metrics.rps > 0);
      own.sort((a, b) => (b.metrics!.errPct - a.metrics!.errPct) || (b.metrics!.rps - a.metrics!.rps));
      service = own[0]?.id ?? topology.services.find((s) => !s.isExternal)?.id ?? null;
    }
    if (!service && structure?.services?.length) {
      let best = -1;
      if (frameErr) {
        for (let i = 0; i < structure.services.length; i++) {
          if (structure.services[i].isExternal) continue;
          const e = frameErr[i * 5 + 4];
          if (Number.isFinite(e) && (best < 0 || e > frameErr[best * 5 + 4])) best = i;
        }
      }
      service = structure.services[best >= 0 ? best : 0].id;
    }
  }
  let edge: [string, string] | null = null;
  if (opts.edge) {
    const [s, t] = (opts.edge as string).split(',');
    edge = [s, t];
  } else {
    const all: [string, string][] = topology?.edges?.length
      ? topology.edges.map((e) => [e.source, e.target])
      : structure?.edges?.length
        ? structure.edges.map((e) => [structure.services[e.s].id, structure.services[e.t].id])
        : [];
    edge = all.find(([, t]) => t === service) ?? all.find(([s]) => s === service) ?? all[0] ?? null;
  }

  const now = Date.now();
  const range = (ms: number) => `from=${new Date(now - ms).toISOString()}&to=${new Date(now).toISOString()}`;
  const H = 3_600_000;
  let traceId: string | null = null;
  if (service) {
    const sid = encodeURIComponent(service);
    await run('service detail 1h', `/services/${sid}?${range(H)}`);
    await run('service detail 24h', `/services/${sid}?${range(24 * H)}`);
    await run('service detail 7d', `/services/${sid}?${range(7 * 24 * H)}`);
    await run('sparklines', `/services/${sid}/sparklines`);
    await run('service errors 1h', `/services/${sid}/errors?${range(H)}`);
    const list = json<{ traces: { traceId: string }[] }>(await run('trace list 1h', `/services/${sid}/traces?${range(H)}`));
    traceId = list?.traces?.[0]?.traceId ?? null;
  }
  if (edge) {
    const ep = `${encodeURIComponent(edge[0])}/${encodeURIComponent(edge[1])}`;
    await run('edge series', `/edges/${ep}/series`);
    await run('edge errors', `/edges/${ep}/errors`);
  }
  if (traceId) await run('trace by id', `/traces/${encodeURIComponent(traceId)}`);
  else rows.push({ name: 'trace by id', path: '/traces/:id', status: null, requests: 0, p50Ms: null, maxMs: null, rawBytes: null, gzipBytes: null, serverGzip: false, note: 'skipped: no kept trace in the list' });

  const sse = await watchSse(`${base}/live`, opts['sse-seconds'] as number);

  const result: ProbeResult = { at: new Date().toISOString(), api, service, edge, traceId, endpoints: rows, frame, sse, health };
  log(formatProbe(result));
  if (opts.out) {
    await writeFile(opts.out as string, JSON.stringify(result, null, 2));
    log(`[probe] wrote ${opts.out}`);
  }
  return result;
}

const kb = (b: number | null) => (b == null ? '-' : b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
const ms = (v: number | null) => (v == null ? '-' : v < 10 ? v.toFixed(1) : Math.round(v).toString());

export function formatProbe(r: ProbeResult): string {
  const head = ['endpoint', 'status', 'n', 'p50 ms', 'max ms', 'raw', 'gzip', 'note'];
  const body = r.endpoints.map((e) => [
    e.name,
    e.status == null ? '-' : String(e.status),
    String(e.requests),
    ms(e.p50Ms),
    ms(e.maxMs),
    kb(e.rawBytes),
    e.gzipBytes == null ? '-' : kb(e.gzipBytes) + (e.serverGzip ? '' : '*'),
    e.note,
  ]);
  const sseRow = [
    'live stream (SSE)',
    r.sse.available ? '200' : '-',
    String(r.sse.events.metrics ?? 0),
    ms(r.sse.metricsIntervalP50Ms),
    ms(r.sse.metricsIntervalMaxMs),
    '-',
    '-',
    r.sse.available
      ? `${r.sse.seconds}s: ${Object.entries(r.sse.events).map(([k, v]) => `${k} ${v}`).join(', ') || 'no events'}; ${r.sse.comments} heartbeats; p50/max = gap between metrics events`
      : r.sse.note,
  ];
  body.push(sseRow);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (i === 7 ? 0 : row[i].length))));
  const right = new Set([1, 2, 3, 4, 5, 6]);
  const line = (row: string[]) => row.map((c, i) => (i === 7 ? c : right.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  const out = [`probe ${r.api} at ${r.at}`, `service ${r.service ?? '-'}  edge ${r.edge ? r.edge.join(' -> ') : '-'}  trace ${r.traceId ?? '-'}`, '', line(head), ...body.map(line)];
  out.push('', '* gzip size computed by the probe; the server sent the body uncompressed');
  if (r.frame) {
    if ('error' in r.frame) out.push(`frame: ${r.frame.error}`);
    else {
      const f = r.frame;
      out.push(
        `frame: seq ${f.seq}, structure v${f.structureVersion}, ${f.nServices} services / ${f.nEdges} edges, ${Math.round(f.ageMs)} ms old; ` +
          `services ok ${f.services.ok} warn ${f.services.warn} crit ${f.services.crit} stale ${f.services.stale} no-data ${f.services.noData}; ` +
          `edges ok ${f.edges.ok} warn ${f.edges.warn} crit ${f.edges.crit} stale ${f.edges.stale}; ` +
          (f.ok ? 'matches structure' : `PROBLEMS: ${f.problems.join('; ')}`),
      );
    }
  } else {
    out.push('frame: not available');
  }
  out.push('', 'health:', ...flatten(r.health).slice(0, 60).map((l) => `  ${l}`));
  return out.join('\n');
}

function flatten(v: unknown, prefix = ''): string[] {
  if (v == null || typeof v !== 'object') return [`${prefix || 'value'} = ${JSON.stringify(v)}`];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (x && typeof x === 'object' && !Array.isArray(x)) out.push(...flatten(x, key));
    else out.push(`${key} = ${JSON.stringify(x)}`);
  }
  return out;
}
