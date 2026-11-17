import { describe, expect, it } from 'vitest';
import { checkFrame, decodeFrame, FRAME_MAGIC, frameBytes, SseParser } from './frame.js';

/** Build a frame the way the contract describes (test helper). */
function encodeFrame(o: { seq: number; version: number; services: number[][]; edges: number[][]; sFlags: number[]; eFlags: number[]; at: number }): Buffer {
  const buf = Buffer.alloc(frameBytes(o.services.length, o.edges.length));
  buf.writeUInt32LE(FRAME_MAGIC, 0);
  buf.writeUInt32LE(o.seq, 4);
  buf.writeUInt32LE(o.version, 8);
  buf.writeUInt32LE(o.services.length, 12);
  buf.writeUInt32LE(o.edges.length, 16);
  buf.writeDoubleLE(o.at, 24);
  let off = 32;
  for (const row of [...o.services, ...o.edges]) for (const v of row) (buf.writeFloatLE(v, off), (off += 4));
  for (const f of [...o.sFlags, ...o.eFlags]) buf[off++] = f;
  return buf;
}

const sample = {
  seq: 7,
  version: 42,
  services: [
    [10, 1, 5, 9, 0],
    [NaN, NaN, NaN, NaN, NaN],
    [2, 3, 4, 5, 3.5],
  ],
  edges: [[1, 2, 3, 4, 0.5]],
  sFlags: [0, 1, 4],
  eFlags: [2],
  at: 1_763_370_000_000,
};

describe('decodeFrame', () => {
  it('reads header, values and flags', () => {
    const f = decodeFrame(encodeFrame(sample));
    expect(f).toMatchObject({ seq: 7, structureVersion: 42, nServices: 3, nEdges: 1, generatedAtMs: sample.at });
    expect(f.services[0]).toBe(10);
    expect(f.services[14]).toBeCloseTo(3.5);
    expect(Number.isNaN(f.services[5])).toBe(true);
    expect(f.edges[4]).toBeCloseTo(0.5);
    expect(Array.from(f.serviceFlags)).toEqual([0, 1, 4]);
    expect(Array.from(f.edgeFlags)).toEqual([2]);
  });

  it('decodes from an unaligned offset', () => {
    const inner = encodeFrame(sample);
    const outer = Buffer.alloc(inner.length + 1);
    inner.copy(outer, 1);
    expect(decodeFrame(outer.subarray(1)).services[10]).toBe(2);
  });

  it('rejects a bad magic or a wrong length', () => {
    const b = encodeFrame(sample);
    const bad = Buffer.from(b);
    bad.writeUInt32LE(0xdeadbeef, 0);
    expect(() => decodeFrame(bad)).toThrow(/magic/);
    expect(() => decodeFrame(b.subarray(0, b.length - 1))).toThrow(/expected/);
    expect(() => decodeFrame(Buffer.alloc(8))).toThrow(/short/);
  });
});

describe('checkFrame', () => {
  const f = decodeFrame(encodeFrame(sample));

  it('counts statuses, stale and missing data', () => {
    const c = checkFrame(f, { version: 42, services: [{}, {}, {}], edges: [{}] });
    expect(c.ok).toBe(true);
    expect(c.services).toEqual({ ok: 2, warn: 0, crit: 1, stale: 1, noData: 1 });
    expect(c.edges).toEqual({ ok: 0, warn: 1, crit: 0, stale: 0, noData: 0 });
  });

  it('reports a frame that does not match the structure', () => {
    const c = checkFrame(f, { version: 41, services: [{}, {}], edges: [{}, {}] });
    expect(c.ok).toBe(false);
    expect(c.problems).toHaveLength(3);
  });

  it('flags invalid status bits', () => {
    const bad = decodeFrame(encodeFrame({ ...sample, sFlags: [0, 6, 0] }));
    expect(checkFrame(bad, { version: 42, services: [{}, {}, {}], edges: [{}] }).ok).toBe(false);
  });
});

describe('SseParser', () => {
  it('assembles events split across chunks and counts heartbeats', () => {
    const p = new SseParser();
    const evs = [
      ...p.feed('event: hello\ndata: {"seq":1,'),
      ...p.feed('"structureVersion":3}\n\n: heartbeat\n\nevent: metr'),
      ...p.feed('ics\ndata: {"seq":2}\n\r\n'),
    ];
    expect(evs).toEqual([
      { event: 'hello', data: '{"seq":1,"structureVersion":3}' },
      { event: 'metrics', data: '{"seq":2}' },
    ]);
    expect(p.comments).toBe(1);
  });

  it('joins multi-line data and defaults the event name', () => {
    expect(new SseParser().feed('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});
