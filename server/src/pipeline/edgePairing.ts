import type { PeerGuess } from '../otlp/infer.js';
import { RotatingIdSet, hexWords } from './idSet.js';

export interface ClientSpanInfo {
  spanId: string;
  serviceId: string;
  operation: string;
  /** Span start, ms epoch. */
  timeMs: number;
  durationMs: number;
  isError: boolean;
  /** Error signature, only for error spans. */
  errCode?: string;
  errMessage?: string;
  peerGuess: PeerGuess | null;
}

export interface EdgeObservation {
  timeMs: number;
  sourceId: string;
  targetId: string;
  /** Set when the target came from attribute inference rather than a server span. */
  targetGuess: PeerGuess | null;
  operation: string;
  durationMs: number;
  isError: boolean;
  errCode?: string;
  errMessage?: string;
}

interface HeldClient {
  info: ClientSpanInfo;
  at: number;
}

interface HeldServer {
  serviceId: string;
  at: number;
}

export interface EdgePairingOptions {
  /** How long an unpaired span waits for its other half, ms. */
  ttlMs: number;
  /** Hard cap on held client + server spans; oldest are evicted first. */
  maxPending: number;
  /** Slots per generation of the resolved-client-span memory. */
  resolvedCapacity: number;
}

export interface EdgePairingStats {
  pendingClients: number;
  pendingServers: number;
  resolvedByGuess: number;
  resolvedByServer: number;
  /** Server spans whose client had already resolved (ignored, not double counted). */
  lateServers: number;
  expired: number;
  evicted: number;
  resolvedRemembered: number;
  resolvedEarlyRotations: number;
}

/**
 * Pairs CLIENT/PRODUCER spans with the SERVER/CONSUMER spans they caused to
 * learn cross-service edges, whichever side arrives first.
 *
 * - A client span with an attribute-inferred peer resolves at once (databases,
 *   queues, external APIs, and HTTP calls to a host that is a known service).
 *   Its span id goes into a compact rotating set so a later server span for it
 *   is recognised and neither held nor counted twice.
 * - A client span with no inferable peer is held until a server span whose
 *   parentSpanId matches arrives, or until the TTL.
 * - A server span whose client has not arrived is held the same way.
 * - Edge metrics always come from the CALLER's span: the edge is the calling
 *   service's view of its dependency.
 *
 * Memory is bounded: held entries are capped (oldest evicted) and the resolved
 * set is a fixed-size table.
 */
export class EdgePairing {
  private clients = new Map<string, HeldClient>();
  private servers = new Map<string, HeldServer>();
  private resolved: RotatingIdSet;
  private counters = { resolvedByGuess: 0, resolvedByServer: 0, lateServers: 0, expired: 0, evicted: 0 };

  constructor(private readonly opts: EdgePairingOptions, now = Date.now()) {
    this.resolved = new RotatingIdSet(opts.resolvedCapacity, opts.ttlMs, now);
  }

  onClientSpan(info: ClientSpanInfo, now = Date.now()): EdgeObservation | null {
    const server = this.servers.get(info.spanId);
    if (server) {
      this.servers.delete(info.spanId);
      if (server.serviceId !== info.serviceId) {
        this.markResolved(info.spanId, now);
        this.counters.resolvedByServer++;
        return observation(info, server.serviceId, null);
      }
    }
    // A real server span beats an attribute guess, so this check comes second.
    if (info.peerGuess && info.peerGuess.id !== info.serviceId) {
      this.markResolved(info.spanId, now);
      this.counters.resolvedByGuess++;
      return observation(info, info.peerGuess.id, info.peerGuess);
    }
    if (!server) {
      this.clients.set(info.spanId, { info, at: now });
      this.enforceCap();
    }
    return null;
  }

  onServerSpan(parentSpanId: string | null, serviceId: string, now = Date.now()): EdgeObservation | null {
    if (!parentSpanId) return null;
    const client = this.clients.get(parentSpanId);
    if (client) {
      this.clients.delete(parentSpanId);
      if (client.info.serviceId === serviceId) return null;
      this.markResolved(parentSpanId, now);
      this.counters.resolvedByServer++;
      return observation(client.info, serviceId, null);
    }
    const [hi, lo] = hexWords(parentSpanId);
    if (this.resolved.has(hi, lo)) {
      this.counters.lateServers++;
      return null;
    }
    this.servers.set(parentSpanId, { serviceId, at: now });
    this.enforceCap();
    return null;
  }

  /** Drop entries older than the TTL. Maps are in insertion order, so this stops at the first live one. */
  sweep(now = Date.now()): void {
    const cutoff = now - this.opts.ttlMs;
    for (const [k, v] of this.clients) {
      if (v.at > cutoff) break;
      this.clients.delete(k);
      this.counters.expired++;
    }
    for (const [k, v] of this.servers) {
      if (v.at > cutoff) break;
      this.servers.delete(k);
      this.counters.expired++;
    }
  }

  /** Held client + server spans. */
  get pendingCount(): number {
    return this.clients.size + this.servers.size;
  }

  stats(): EdgePairingStats {
    return {
      pendingClients: this.clients.size,
      pendingServers: this.servers.size,
      ...this.counters,
      resolvedRemembered: this.resolved.size,
      resolvedEarlyRotations: this.resolved.earlyRotations,
    };
  }

  private markResolved(spanId: string, now: number): void {
    const [hi, lo] = hexWords(spanId);
    this.resolved.add(hi, lo, now);
  }

  private enforceCap(): void {
    while (this.clients.size + this.servers.size > this.opts.maxPending) {
      const c = firstEntry(this.clients);
      const s = firstEntry(this.servers);
      if (c && (!s || c[1].at <= s[1].at)) this.clients.delete(c[0]);
      else if (s) this.servers.delete(s[0]);
      this.counters.evicted++;
    }
  }
}

function firstEntry<V>(m: Map<string, V>): [string, V] | undefined {
  return m.entries().next().value;
}

function observation(c: ClientSpanInfo, targetId: string, guess: PeerGuess | null): EdgeObservation {
  return {
    timeMs: c.timeMs,
    sourceId: c.serviceId,
    targetId,
    targetGuess: guess,
    operation: c.operation,
    durationMs: c.durationMs,
    isError: c.isError,
    errCode: c.errCode,
    errMessage: c.errMessage,
  };
}
