import type { LiveHello, LiveMetricsNotice, LiveStructure, Topology } from '../../api/types';
import { decodeFrame, FrameError } from './frame';
import { checkFrameMatches, mergeFrame, type LiveSnapshot } from './merge';

/**
 * Owns the live feed: the SSE notice stream, the structure, and the binary
 * frames. The stream only says "something new exists"; the client then fetches
 * the structure (when its version moved) or the latest frame. Notices that
 * arrive while a frame fetch is in flight are dropped, not queued: the next
 * fetch returns the newest frame anyway. When the stream is down it polls the
 * frame every 5 s and keeps trying to reconnect with backoff; a stream that
 * goes silent for several intervals counts as down. While the tab is
 * hidden it closes the stream and does nothing; on return it reconnects, and
 * the server's hello brings it up to date.
 */

/** The subset of EventSource the client uses (lets tests pass a fake). */
export interface EventSourceLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, fn: (ev: { data: string }) => void): void;
  close(): void;
}

export interface VisibilityLike {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export type LiveMode = 'connecting' | 'stream' | 'polling' | 'paused' | 'stopped';

export interface LiveStats {
  mode: LiveMode;
  framesApplied: number;
  /** Frames dropped by validation or a structure mismatch. */
  framesIgnored: number;
  noticesDropped: number;
  structureLoads: number;
  /** Decode + merge time of the last applied frame, ms. */
  lastApplyMs: number;
  lastSeq: number | null;
  lastError: string | null;
}

export interface LiveClientDeps {
  streamUrl: string;
  openStream: (url: string) => EventSourceLike;
  fetchStructure: () => Promise<LiveStructure>;
  fetchFrame: () => Promise<ArrayBuffer>;
  onTopology: (t: Topology) => void;
  /** A frame or structure fetch failed (the feed may be offline). */
  onFetchError?: (err: unknown) => void;
  visibility?: VisibilityLike;
  now?: () => number;
  pollMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Treat the stream as dead after this long without an event (before hello gives the interval). */
  silenceMs?: number;
}

export interface LiveClient {
  stop: () => void;
  stats: LiveStats;
}

export function startLiveClient(deps: LiveClientDeps): LiveClient {
  const now = deps.now ?? (() => performance.now());
  const pollMs = deps.pollMs ?? 5000;
  const backoffMin = deps.backoffMinMs ?? 1000;
  const backoffMax = deps.backoffMaxMs ?? 30_000;
  let silenceMs = deps.silenceMs ?? 15_000;

  const stats: LiveStats = {
    mode: 'connecting',
    framesApplied: 0,
    framesIgnored: 0,
    noticesDropped: 0,
    structureLoads: 0,
    lastApplyMs: 0,
    lastSeq: null,
    lastError: null,
  };

  let snapshot: LiveSnapshot | null = null;
  let structure: LiveStructure | null = null;
  /** Latest structure version the server has told us about. */
  let wantVersion: number | null = null;
  let structureLoading = false;
  let frameLoading = false;
  /** Fetch one more frame when the current one lands (structure just loaded). */
  let frameAgain = false;
  let es: EventSourceLike | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let backoff = backoffMin;
  let stopped = false;
  let paused = deps.visibility?.hidden ?? false;

  const fail = (err: unknown) => {
    stats.lastError = err instanceof Error ? err.message : String(err);
    deps.onFetchError?.(err);
  };

  const loadStructure = () => {
    if (structureLoading || stopped || paused) return;
    structureLoading = true;
    deps
      .fetchStructure()
      .then((s) => {
        if (stopped) return;
        stats.structureLoads++;
        structure = s;
        // Only chase a frame when this is the version we were told about,
        // so a server whose structure lags its frames cannot make us spin.
        if (wantVersion == null || s.version === wantVersion) requestFrame(true);
      })
      .catch(fail)
      .finally(() => {
        structureLoading = false;
      });
  };

  const noteVersion = (v: number) => {
    wantVersion = v;
    if (structure?.version !== v) loadStructure();
  };

  const apply = (buf: ArrayBuffer) => {
    if (!structure) return;
    const t0 = now();
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch (err) {
      stats.framesIgnored++;
      stats.lastError = (err as Error).message;
      return;
    }
    if (frame.structureVersion !== structure.version) {
      // Hold off until the matching structure is loaded; it fetches the frame again.
      stats.framesIgnored++;
      noteVersion(frame.structureVersion);
      return;
    }
    if (snapshot?.structure === structure && frame.seq === stats.lastSeq) return;
    try {
      checkFrameMatches(structure, frame);
      snapshot = mergeFrame(structure, frame, snapshot);
    } catch (err) {
      if (!(err instanceof FrameError)) throw err;
      stats.framesIgnored++;
      stats.lastError = err.message;
      return;
    }
    stats.lastSeq = frame.seq;
    stats.framesApplied++;
    stats.lastApplyMs = now() - t0;
    deps.onTopology(snapshot.topology);
  };

  function requestFrame(force: boolean) {
    if (stopped || paused) return;
    if (!structure) {
      loadStructure();
      return;
    }
    if (frameLoading) {
      if (force) frameAgain = true;
      else stats.noticesDropped++;
      return;
    }
    frameLoading = true;
    deps
      .fetchFrame()
      .then((buf) => {
        if (!stopped) apply(buf);
      })
      .catch(fail)
      .finally(() => {
        frameLoading = false;
        if (frameAgain) {
          frameAgain = false;
          requestFrame(false);
        }
      });
  }

  const startPolling = () => {
    if (pollTimer || stopped || paused) return;
    stats.mode = 'polling';
    requestFrame(false);
    pollTimer = setInterval(() => requestFrame(false), pollMs);
  };

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const closeStream = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (!es) return;
    es.onopen = null;
    es.onerror = null;
    es.close();
    es = null;
  };

  const scheduleReconnect = () => {
    if (reconnectTimer || stopped || paused) return;
    // Jitter so a fleet of tabs does not reconnect in lockstep after a restart.
    const wait = backoff * (0.75 + Math.random() * 0.5);
    backoff = Math.min(backoffMax, backoff * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  };

  const parse = <T>(ev: { data: string }): T | null => {
    try {
      return JSON.parse(ev.data) as T;
    } catch {
      return null;
    }
  };

  const streamFailed = () => {
    // Take over from EventSource's own retry so the fallback poll and the
    // backoff are ours.
    closeStream();
    startPolling();
    scheduleReconnect();
  };

  // A proxy can keep the browser's side of a dead stream open, and SSE
  // heartbeat comments never reach script, so silence is the only signal.
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      watchdog = null;
      stats.lastError = `no stream event for ${silenceMs} ms`;
      streamFailed();
    }, silenceMs);
  };

  function connect() {
    if (stopped || paused || es) return;
    if (!pollTimer) stats.mode = 'connecting';
    let stream: EventSourceLike;
    try {
      stream = deps.openStream(deps.streamUrl);
    } catch (err) {
      fail(err);
      startPolling();
      scheduleReconnect();
      return;
    }
    es = stream;
    stream.onopen = () => {
      stopPolling();
      stats.mode = 'stream';
      armWatchdog();
    };
    stream.onerror = streamFailed;
    stream.addEventListener('hello', (ev) => {
      const h = parse<LiveHello>(ev);
      if (!h) return;
      // Reset the backoff only once the server has spoken, so one that
      // accepts and drops connections still gets backed off.
      backoff = backoffMin;
      if (h.intervalMs > 0) silenceMs = Math.max(deps.silenceMs ?? 10_000, 4 * h.intervalMs);
      armWatchdog();
      noteVersion(h.structureVersion);
      if (structure?.version === h.structureVersion && h.seq !== stats.lastSeq) requestFrame(true);
    });
    stream.addEventListener('structure', (ev) => {
      armWatchdog();
      const s = parse<{ version: number }>(ev);
      if (s) noteVersion(s.version);
    });
    stream.addEventListener('metrics', (ev) => {
      armWatchdog();
      const n = parse<LiveMetricsNotice>(ev);
      if (!n) return;
      if (structure?.version !== n.structureVersion) {
        noteVersion(n.structureVersion);
        return;
      }
      if (n.seq === stats.lastSeq) return;
      requestFrame(false);
    });
  }

  const onVisibility = () => {
    if (stopped || !deps.visibility) return;
    if (deps.visibility.hidden) {
      paused = true;
      stats.mode = 'paused';
      closeStream();
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    } else if (paused) {
      paused = false;
      backoff = backoffMin;
      connect();
    }
  };

  deps.visibility?.addEventListener('visibilitychange', onVisibility);
  if (paused) stats.mode = 'paused';
  else connect();

  return {
    stats,
    stop: () => {
      stopped = true;
      stats.mode = 'stopped';
      deps.visibility?.removeEventListener('visibilitychange', onVisibility);
      closeStream();
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    },
  };
}
