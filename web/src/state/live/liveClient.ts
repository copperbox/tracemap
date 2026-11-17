import type { LiveHello, LiveMetricsNotice, LiveStructure, Topology } from '../../api/types';
import { decodeFrame, FrameError } from './frame';
import { checkFrameMatches, mergeFrame, type LiveSnapshot } from './merge';

/**
 * Owns the live feed: the SSE notice stream, the structure, and the binary
 * frames. The stream only says "something new exists"; the client then fetches
 * the structure (when its version moved) or the latest frame. Notices that
 * arrive while a frame fetch is in flight are not queued, but the client
 * remembers the newest announced seq and fetches once more if the frame it
 * got is older. Structure versions are opaque (only equality matters), and
 * the structure is refetched on every hello: a restarted server can reuse a
 * version number for a different structure. When the stream is down it polls
 * the frame every 5 s and keeps trying to reconnect with backoff; a stream
 * that goes silent for several intervals counts as down. While the tab is
 * hidden it closes the stream, aborts its fetches and does nothing; on return
 * it reconnects, and the server's hello brings it up to date. Stop and pause
 * abort in-flight fetches, and a late response never publishes.
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
  fetchStructure: (signal: AbortSignal) => Promise<LiveStructure>;
  fetchFrame: (signal: AbortSignal) => Promise<ArrayBuffer>;
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
  /** False from a hello until the structure it implies has loaded. */
  let structureFresh = false;
  // In-flight requests. A completion whose controller is no longer the
  // current one (superseded, stopped, paused) is ignored.
  let structureReq: AbortController | null = null;
  let frameReq: AbortController | null = null;
  /** Fetch one more frame when the current one lands (structure just loaded). */
  let frameAgain = false;
  /** Newest frame seq the server announced, and the last one we refetched for. */
  let announcedSeq: number | null = null;
  let chasedSeq: number | null = null;
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

  const abortFetches = (): void => {
    const s = structureReq;
    const f = frameReq;
    structureReq = null;
    frameReq = null;
    frameAgain = false;
    s?.abort();
    f?.abort();
  };

  /** `restart` drops a load already in flight (it may describe an older server). */
  const loadStructure = (restart = false) => {
    if (stopped || paused) return;
    if (structureReq) {
      if (!restart) return;
      structureReq.abort();
    }
    const ctrl = new AbortController();
    structureReq = ctrl;
    deps.fetchStructure(ctrl.signal).then(
      (s) => {
        if (structureReq !== ctrl) return;
        structureReq = null;
        stats.structureLoads++;
        structure = s;
        structureFresh = true;
        // Only chase a frame when this is the version we were told about,
        // so a server whose structure lags its frames cannot make us spin.
        if (wantVersion == null || s.version === wantVersion) requestFrame(true);
      },
      (err) => {
        if (structureReq !== ctrl) return;
        structureReq = null;
        fail(err);
      },
    );
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
    if (!structure || !structureFresh) {
      loadStructure();
      return;
    }
    if (frameReq) {
      if (force) frameAgain = true;
      else stats.noticesDropped++;
      return;
    }
    const ctrl = new AbortController();
    frameReq = ctrl;
    deps.fetchFrame(ctrl.signal).then(
      (buf) => {
        if (frameReq !== ctrl) return;
        frameReq = null;
        apply(buf);
        if (frameAgain) {
          frameAgain = false;
          requestFrame(false);
          return;
        }
        // A notice that arrived mid-fetch can name a newer frame than the one
        // this response carried. Fetch once more for it, and only once, so a
        // server whose frame lags its notices cannot make us spin.
        const latest = announcedSeq;
        if (
          latest != null &&
          stats.lastSeq != null &&
          stats.lastSeq < latest &&
          chasedSeq !== latest &&
          structure?.version === wantVersion
        ) {
          chasedSeq = latest;
          requestFrame(false);
        }
      },
      (err) => {
        if (frameReq !== ctrl) return;
        frameReq = null;
        fail(err);
        if (frameAgain) {
          frameAgain = false;
          requestFrame(false);
        }
      },
    );
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
      announcedSeq = h.seq;
      chasedSeq = null;
      // Every (re)connect reloads the structure, even at an equal version: the
      // server may have restarted with a different one. Its load fetches the frame.
      wantVersion = h.structureVersion;
      structureFresh = false;
      loadStructure(true);
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
      announcedSeq = n.seq;
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
      abortFetches();
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
      abortFetches();
      closeStream();
      stopPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    },
  };
}
