import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveStructure, Topology } from '../../api/types';
import { encodeFrame } from './frame';
import { startLiveClient, type EventSourceLike, type VisibilityLike } from './liveClient';

class FakeStream implements EventSourceLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private fns = new Map<string, ((ev: { data: string }) => void)[]>();
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.fns.set(type, [...(this.fns.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.fns.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

class FakeDoc implements VisibilityLike {
  hidden = false;
  private fn: (() => void) | null = null;
  addEventListener(_: string, fn: () => void) {
    this.fn = fn;
  }
  removeEventListener() {
    this.fn = null;
  }
  set(hidden: boolean) {
    this.hidden = hidden;
    this.fn?.();
  }
}

const structure = (version: number): LiveStructure => ({
  version,
  generatedAt: '2026-11-17T12:00:00.000Z',
  teams: [],
  services: [
    {
      id: 'a', name: 'a', description: null, type: 'service', teamId: null, runtime: null, region: null,
      isExternal: false, sloTarget: 99.9, sloAttain: null, firstSeen: '', lastSeen: '',
    },
  ],
  edges: [],
});

const frameBuf = (version: number, seq: number, rps = seq) =>
  encodeFrame({
    seq,
    structureVersion: version,
    generatedAtMs: seq * 1000,
    services: [{ values: [rps, 1, 2, 3, 0], flags: 0 }],
    edges: [],
  });

/** A fetch whose promise the test resolves by hand. */
function deferredFetch<T>() {
  const calls: { resolve: (v: T) => void; reject: (e: unknown) => void; signal?: AbortSignal }[] = [];
  const fn = vi.fn(
    (signal?: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        calls.push({ resolve, reject, signal });
      }),
  );
  return { fn, calls };
}

let streams: FakeStream[];
let topologies: Topology[];
let doc: FakeDoc;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  streams = [];
  topologies = [];
  doc = new FakeDoc();
});
afterEach(() => vi.useRealTimers());

function start(fetchStructure: () => Promise<LiveStructure>, fetchFrame: () => Promise<ArrayBuffer>) {
  return startLiveClient({
    streamUrl: '/api/live',
    openStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    fetchStructure,
    fetchFrame,
    onTopology: (t) => topologies.push(t),
    visibility: doc,
    backoffMinMs: 1000,
  });
}

describe('live client', () => {
  it('loads the structure on hello, then the frame, and publishes the topology', async () => {
    const st = deferredFetch<LiveStructure>();
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(st.fn, fr.fn);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 5, intervalMs: 2000 });
    expect(st.fn).toHaveBeenCalledTimes(1);
    st.calls[0].resolve(structure(1));
    await flush();
    expect(fr.fn).toHaveBeenCalledTimes(1);
    fr.calls[0].resolve(frameBuf(1, 5));
    await flush();
    expect(topologies).toHaveLength(1);
    expect(topologies[0].services[0].metrics.rps).toBe(5);
    expect(c.stats.mode).toBe('stream');
    c.stop();
  });

  it('coalesces notices during a fetch and fetches again when the response is older', async () => {
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(() => Promise.resolve(structure(1)), fr.fn);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    await flush();
    expect(fr.fn).toHaveBeenCalledTimes(1);
    streams[0].emit('metrics', { seq: 2, structureVersion: 1 });
    streams[0].emit('metrics', { seq: 3, structureVersion: 1 });
    expect(fr.fn).toHaveBeenCalledTimes(1);
    expect(c.stats.noticesDropped).toBe(2);
    // The response was built before seq 3 existed.
    fr.calls[0].resolve(frameBuf(1, 2));
    await flush();
    expect(c.stats.lastSeq).toBe(2);
    expect(fr.fn).toHaveBeenCalledTimes(2);
    fr.calls[1].resolve(frameBuf(1, 3));
    await flush();
    expect(c.stats.lastSeq).toBe(3);
    expect(topologies[topologies.length - 1].services[0].metrics.rps).toBe(3);
    // Caught up: nothing queued behind it.
    expect(fr.fn).toHaveBeenCalledTimes(2);
    streams[0].emit('metrics', { seq: 4, structureVersion: 1 });
    expect(fr.fn).toHaveBeenCalledTimes(3);
    c.stop();
  });

  it('chases an announced frame only once', async () => {
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(() => Promise.resolve(structure(1)), fr.fn);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    await flush();
    streams[0].emit('metrics', { seq: 5, structureVersion: 1 });
    fr.calls[0].resolve(frameBuf(1, 1));
    await flush();
    expect(fr.fn).toHaveBeenCalledTimes(2);
    // The server still serves the old frame: stop until the next notice.
    fr.calls[1].resolve(frameBuf(1, 1));
    await flush();
    expect(fr.fn).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it('aborts in-flight fetches on stop and never publishes after it', async () => {
    const st = deferredFetch<LiveStructure>();
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(st.fn, fr.fn);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    st.calls[0].resolve(structure(1));
    await flush();
    expect(fr.calls).toHaveLength(1);
    c.stop();
    expect(fr.calls[0].signal?.aborted).toBe(true);
    fr.calls[0].resolve(frameBuf(1, 1));
    await flush();
    expect(topologies).toHaveLength(0);
    expect(c.stats.lastError).toBeNull();
  });

  it('aborts on pause, ignores the late response, and catches up on return', async () => {
    const st = deferredFetch<LiveStructure>();
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(st.fn, fr.fn);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    st.calls[0].resolve(structure(1));
    await flush();
    doc.set(true);
    expect(fr.calls[0].signal?.aborted).toBe(true);
    fr.calls[0].resolve(frameBuf(1, 1));
    await flush();
    expect(topologies).toHaveLength(0);
    doc.set(false);
    streams[1].emit('hello', { structureVersion: 1, seq: 2, intervalMs: 2000 });
    st.calls[1].resolve(structure(1));
    await flush();
    expect(fr.calls).toHaveLength(2);
    fr.calls[1].resolve(frameBuf(1, 2));
    await flush();
    expect(topologies).toHaveLength(1);
    expect(topologies[0].services[0].metrics.rps).toBe(2);
    c.stop();
  });

  it('reloads the structure on every hello, even at the same version', async () => {
    const st = deferredFetch<LiveStructure>();
    const fetchFrame = vi.fn(() => Promise.resolve(frameBuf(1, 1)));
    const c = start(st.fn, fetchFrame);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    st.calls[0].resolve(structure(1));
    await flush();
    expect(topologies).toHaveLength(1);
    // The server restarted: same version number, different structure.
    streams[0].onerror?.(null);
    await vi.advanceTimersByTimeAsync(2000);
    const s2 = streams[streams.length - 1];
    s2.onopen?.(null);
    const restarted = structure(1);
    restarted.services[0] = { ...restarted.services[0], id: 'b', name: 'b' };
    s2.emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    expect(st.fn).toHaveBeenCalledTimes(2);
    st.calls[1].resolve(restarted);
    await flush();
    expect(topologies[topologies.length - 1].services[0].id).toBe('b');
    c.stop();
  });

  it('leaves exactly one live client after a StrictMode-style start, stop, start', async () => {
    const st = deferredFetch<LiveStructure>();
    const fr = deferredFetch<ArrayBuffer>();
    const first = start(st.fn, fr.fn);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    first.stop();
    const second = start(st.fn, fr.fn);
    expect(streams[0].closed).toBe(true);
    expect(st.calls[0].signal?.aborted).toBe(true);
    st.calls[0].resolve(structure(1));
    await flush();
    expect(fr.calls).toHaveLength(0);
    streams[1].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    st.calls[1].resolve(structure(1));
    await flush();
    fr.calls[0].resolve(frameBuf(1, 1));
    await flush();
    expect(topologies).toHaveLength(1);
    expect(streams.filter((s) => !s.closed)).toHaveLength(1);
    second.stop();
  });

  it('ignores a frame for another structure until that structure is loaded', async () => {
    const st = deferredFetch<LiveStructure>();
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(st.fn, fr.fn);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    st.calls[0].resolve(structure(1));
    await flush();
    fr.calls[0].resolve(frameBuf(2, 2)); // the server moved on to structure 2
    await flush();
    expect(topologies).toHaveLength(0);
    expect(c.stats.framesIgnored).toBe(1);
    expect(st.fn).toHaveBeenCalledTimes(2);
    st.calls[1].resolve(structure(2));
    await flush();
    expect(fr.fn).toHaveBeenCalledTimes(2);
    fr.calls[1].resolve(frameBuf(2, 2));
    await flush();
    expect(topologies).toHaveLength(1);
    c.stop();
  });

  it('ignores a corrupt frame', async () => {
    const fr = deferredFetch<ArrayBuffer>();
    const c = start(() => Promise.resolve(structure(1)), fr.fn);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    await flush();
    fr.calls[0].resolve(frameBuf(1, 1).slice(0, 40));
    await flush();
    expect(topologies).toHaveLength(0);
    expect(c.stats.framesIgnored).toBe(1);
    c.stop();
  });

  it('polls every 5 s while the stream is down and stops once it reconnects', async () => {
    let seq = 0;
    const fetchFrame = vi.fn(() => Promise.resolve(frameBuf(1, ++seq)));
    const c = start(() => Promise.resolve(structure(1)), fetchFrame);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 0, intervalMs: 2000 });
    await flush();
    expect(fetchFrame).toHaveBeenCalledTimes(1);

    streams[0].onerror?.(null);
    expect(streams[0].closed).toBe(true);
    expect(c.stats.mode).toBe('polling');
    await flush();
    expect(fetchFrame).toHaveBeenCalledTimes(2); // immediate poll
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFrame).toHaveBeenCalledTimes(3);
    // The reconnect (backoff about 1 s) already made a second stream; it fails too.
    expect(streams).toHaveLength(2);
    streams[1].onerror?.(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(streams.length).toBeGreaterThanOrEqual(3);
    const last = streams[streams.length - 1];
    last.onopen?.(null);
    expect(c.stats.mode).toBe('stream');
    last.emit('hello', { structureVersion: 1, seq, intervalMs: 2000 });
    await flush();
    const n = fetchFrame.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetchFrame).toHaveBeenCalledTimes(n);
    expect(topologies.length).toBeGreaterThanOrEqual(3);
    c.stop();
  });

  it('treats a silent stream as down and falls back to polling', async () => {
    const fetchFrame = vi.fn(() => Promise.resolve(frameBuf(1, 1)));
    const c = start(() => Promise.resolve(structure(1)), fetchFrame);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    await flush();
    // Notices keep it alive.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2000);
      streams[0].emit('metrics', { seq: 1, structureVersion: 1 });
    }
    expect(streams[0].closed).toBe(false);
    // Then nothing for 4 intervals (10 s floor).
    await vi.advanceTimersByTimeAsync(10_000);
    expect(streams[0].closed).toBe(true);
    expect(c.stats.mode).toBe('polling');
    c.stop();
  });

  it('closes the stream while hidden and catches up when visible', async () => {
    const fetchFrame = vi.fn(() => Promise.resolve(frameBuf(1, 1)));
    const c = start(() => Promise.resolve(structure(1)), fetchFrame);
    streams[0].onopen?.(null);
    streams[0].emit('hello', { structureVersion: 1, seq: 1, intervalMs: 2000 });
    await flush();
    doc.set(true);
    expect(streams[0].closed).toBe(true);
    expect(c.stats.mode).toBe('paused');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streams).toHaveLength(1);
    doc.set(false);
    expect(streams).toHaveLength(2);
    fetchFrame.mockImplementation(() => Promise.resolve(frameBuf(1, 9)));
    streams[1].onopen?.(null);
    streams[1].emit('hello', { structureVersion: 1, seq: 9, intervalMs: 2000 });
    await flush();
    expect(topologies[topologies.length - 1].services[0].metrics.rps).toBe(9);
    c.stop();
  });
});
