import type { ServerResponse } from 'node:http';

/**
 * Server-sent event fan-out for GET /api/live.
 *
 * Every event is a small notice that supersedes the previous one (the client
 * then fetches the shared structure or frame), so a client that cannot keep up
 * loses nothing by skipping notices: while its socket buffer has not drained,
 * new notices are not queued for it. A client stalled longer than `stallMs`,
 * or holding more than `maxBufferedBytes`, is disconnected. One timer for all
 * clients sends the heartbeat comment and sweeps stalled ones.
 */
export interface SseClient {
  res: ServerResponse;
  /** When the client first failed to take a write, ms; null while healthy. */
  stalledSince: number | null;
  skipped: number;
}

export interface SseOptions {
  heartbeatMs: number;
  stallMs: number;
  maxBufferedBytes: number;
  now: () => number;
}

export const DEFAULT_SSE_OPTIONS: SseOptions = {
  heartbeatMs: 15_000,
  stallMs: 60_000,
  maxBufferedBytes: 256 * 1024,
  now: Date.now,
};

/** Headers for an event stream that no proxy or compressor should buffer. */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export function formatEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseHub {
  readonly opts: SseOptions;
  private readonly clients = new Set<SseClient>();
  private timer: NodeJS.Timeout | null = null;
  readonly stats = { connected: 0, total: 0, dropped: 0, skipped: 0 };

  constructor(opts: Partial<SseOptions> = {}) {
    this.opts = { ...DEFAULT_SSE_OPTIONS, ...opts };
  }

  get size(): number {
    return this.clients.size;
  }

  /** Take over a response: write headers and the first events, track until it closes. */
  add(res: ServerResponse, headers: Record<string, string | number | string[] | undefined>, first: string): SseClient {
    const client: SseClient = { res, stalledSince: null, skipped: 0 };
    res.writeHead(200, { ...headers, ...SSE_HEADERS });
    res.socket?.setNoDelay(true);
    res.socket?.setTimeout(0);
    res.write(`retry: 3000\n\n${first}`);
    this.clients.add(client);
    this.stats.total++;
    this.stats.connected = this.clients.size;
    const remove = () => this.remove(client);
    res.once('close', remove);
    res.once('error', remove);
    if (!this.timer) this.startTimer();
    return client;
  }

  private remove(client: SseClient): void {
    if (!this.clients.delete(client)) return;
    this.stats.connected = this.clients.size;
    if (!this.clients.size) this.stopTimer();
  }

  private drop(client: SseClient): void {
    this.stats.dropped++;
    this.remove(client);
    client.res.destroy();
  }

  /** Write to one client unless it is still behind; returns false when skipped or dropped. */
  private write(client: SseClient, chunk: string, now: number): boolean {
    const res = client.res;
    if (res.destroyed || res.writableEnded) {
      this.remove(client);
      return false;
    }
    if (res.writableNeedDrain || res.writableLength > 0) {
      client.stalledSince ??= now;
      if (now - client.stalledSince > this.opts.stallMs || res.writableLength > this.opts.maxBufferedBytes) {
        this.drop(client);
      } else {
        client.skipped++;
        this.stats.skipped++;
      }
      return false;
    }
    client.stalledSince = null;
    res.write(chunk);
    return true;
  }

  broadcast(chunk: string): void {
    const now = this.opts.now();
    for (const c of this.clients) this.write(c, chunk, now);
  }

  /** Heartbeat comment to everyone; also sweeps clients that stopped reading. */
  heartbeat(): void {
    this.broadcast(`: hb ${this.opts.now()}\n\n`);
  }

  private startTimer(): void {
    this.timer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** End every stream (shutdown), so the HTTP server can close. */
  close(): void {
    for (const c of [...this.clients]) {
      this.remove(c);
      c.res.end();
    }
    this.stopTimer();
  }
}
