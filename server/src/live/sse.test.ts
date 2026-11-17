import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SseHub, formatEvent } from './sse.js';

/** A ServerResponse stand-in whose socket buffer we control. */
class FakeRes extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, unknown> = {};
  writableLength = 0;
  writableNeedDrain = false;
  destroyed = false;
  writableEnded = false;
  socket = null;
  writeHead(_code: number, h: Record<string, unknown>) {
    this.headers = h;
    return this;
  }
  write(c: string) {
    this.chunks.push(c);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

const res = () => new FakeRes() as FakeRes & ServerResponse;

describe('SseHub', () => {
  it('sends headers that disable proxy buffering and the hello event first', () => {
    const hub = new SseHub();
    const r = res();
    hub.add(r, { 'access-control-allow-origin': '*' }, formatEvent('hello', { seq: 1 }));
    expect(r.headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
      'cache-control': 'no-cache, no-transform',
      'access-control-allow-origin': '*',
    });
    expect(r.chunks[0]).toBe('retry: 3000\n\nevent: hello\ndata: {"seq":1}\n\n');
    hub.close();
  });

  it('skips a slow client instead of buffering, then drops it after the stall limit', () => {
    let now = 0;
    const hub = new SseHub({ stallMs: 10_000, now: () => now });
    const fast = res();
    const slow = res();
    hub.add(fast, {}, '');
    hub.add(slow, {}, '');
    slow.writableLength = 4096;
    slow.writableNeedDrain = true;

    hub.broadcast('a');
    now = 5_000;
    hub.broadcast('b');
    expect(fast.chunks.slice(1)).toEqual(['a', 'b']);
    expect(slow.chunks.slice(1)).toEqual([]);
    expect(hub.size).toBe(2);

    now = 10_001;
    hub.heartbeat();
    expect(slow.destroyed).toBe(true);
    expect(hub.size).toBe(1);
    expect(hub.stats.dropped).toBe(1);
    hub.close();
  });

  it('resumes a client once its buffer drains', () => {
    let now = 0;
    const hub = new SseHub({ now: () => now });
    const r = res();
    hub.add(r, {}, '');
    r.writableLength = 10;
    hub.broadcast('x');
    r.writableLength = 0;
    now = 1000;
    hub.broadcast('y');
    expect(r.chunks.slice(1)).toEqual(['y']);
    hub.close();
  });

  it('forgets a client that disconnects and ends all streams on close', () => {
    const hub = new SseHub();
    const a = res();
    const b = res();
    hub.add(a, {}, '');
    hub.add(b, {}, '');
    a.emit('close');
    expect(hub.size).toBe(1);
    expect(a.listenerCount('close')).toBe(0);
    hub.close();
    expect(b.writableEnded).toBe(true);
    expect(hub.size).toBe(0);
  });

  it('drops a client whose buffer exceeds the byte cap', () => {
    const hub = new SseHub({ maxBufferedBytes: 100 });
    const r = res();
    hub.add(r, {}, '');
    r.writableLength = 1000;
    hub.broadcast('x');
    expect(r.destroyed).toBe(true);
    hub.close();
  });
});
