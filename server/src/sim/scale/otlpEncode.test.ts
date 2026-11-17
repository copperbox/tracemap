import { describe, expect, it } from 'vitest';
import { decodeTraces } from '../../otlp/decode.js';
import { BatchBuilder } from './batch.js';
import { buildFleet } from './fleet.js';
import { PbWriter } from './otlpEncode.js';
import { Prng } from './prng.js';
import { Walker } from './walker.js';

describe('PbWriter', () => {
  it('writes multi-byte lengths for large nested messages', async () => {
    const w = new PbWriter(16);
    w.begin(1);
    w.string(1, 'x'.repeat(300));
    w.begin(2);
    w.string(1, 'y'.repeat(20_000));
    w.end();
    w.end();
    const b = w.finish();
    // tag, then a two-byte length for the 20k+ body of field 1
    expect(b[0]).toBe(0x0a);
    let len = 0;
    let mul = 1;
    let i = 1;
    for (;;) {
      const x = b[i++];
      len += (x & 127) * mul;
      if (x < 128) break;
      mul *= 128;
    }
    expect(i + len).toBe(b.length);
  });
});

describe('BatchBuilder', () => {
  const fleet = buildFleet({ services: 300, teams: 0, seed: 5 });
  const r = new Prng(1);
  const builder = new BatchBuilder(fleet, new Walker(fleet, r), r);

  it('produces protobuf the collector decodes, grouped by service', async () => {
    const now = Date.now();
    const batch = builder.build(2000, now);
    expect(batch.spans).toBeGreaterThanOrEqual(2000);
    const decoded = await decodeTraces(batch.body, 'application/x-protobuf');
    const spans = decoded.flatMap((d) => d.spans);
    expect(spans).toHaveLength(batch.spans);
    const names = decoded.map((d) => d.serviceName);
    expect(new Set(names).size).toBe(names.length);
    for (const d of decoded) {
      expect(fleet.byId.get(d.serviceName!)).toBeDefined();
      expect(d.resourceAttrs['telemetry.sdk.language']).toBeTruthy();
    }
    const traces = new Set(spans.map((s) => s.traceId));
    expect(traces.size).toBe(batch.traces);
    const ids = new Set(spans.map((s) => `${s.traceId}/${s.spanId}`));
    expect(ids.size).toBe(spans.length);
    for (const s of spans) {
      if (s.parentSpanId) expect(ids.has(`${s.traceId}/${s.parentSpanId}`)).toBe(true);
      expect(Number(s.endUnixNano)).toBeLessThanOrEqual(now * 1e6 + 1e6);
      expect(Number(s.startUnixNano)).toBeGreaterThan((now - 120_000) * 1e6);
      expect(s.endUnixNano >= s.startUnixNano).toBe(true);
    }
    const roots = spans.filter((s) => !s.parentSpanId);
    expect(roots).toHaveLength(batch.traces);
  });

  it('marks failures the way the collector reads them', async () => {
    // Force failures on every service so error spans are certain.
    const f2 = buildFleet({ services: 300, teams: 0, seed: 5 });
    for (const n of f2.nodes) n.opErr = n.opErr.map(() => 1);
    const r2 = new Prng(2);
    const b = new BatchBuilder(f2, new Walker(f2, r2), r2).build(500);
    const spans = (await decodeTraces(b.body, 'application/x-protobuf')).flatMap((d) => d.spans);
    const server = spans.filter((s) => s.kind === 2);
    expect(server.length).toBeGreaterThan(0);
    for (const s of server) {
      expect(s.statusCode).toBe(2);
      expect(Number(s.attrs['http.response.status_code'])).toBeGreaterThanOrEqual(500);
    }
  });

  it('never repeats a trace id across batches', async () => {
    const seen = new Set<string>();
    let traces = 0;
    for (let i = 0; i < 20; i++) {
      const batch = builder.build(200);
      traces += batch.traces;
      for (const d of await decodeTraces(batch.body, 'application/x-protobuf')) for (const s of d.spans) seen.add(s.traceId);
    }
    expect(seen.size).toBe(traces);
  });

  it('registers every instrumented service in one request', async () => {
    const reg = builder.registration();
    const decoded = await decodeTraces(reg.body, 'application/x-protobuf');
    expect(decoded).toHaveLength(fleet.nodes.filter((n) => n.instrumented).length);
  });
});
