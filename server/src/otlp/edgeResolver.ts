import type { PeerGuess } from './infer.js';

export interface ClientSpanInfo {
  spanId: string;
  serviceId: string;
  operation: string;
  /** Span start, ms epoch. */
  timeMs: number;
  durationMs: number;
  isError: boolean;
  peerGuess: PeerGuess | null;
}

export interface EdgeObservation {
  timeMs: number;
  sourceId: string;
  targetId: string;
  targetGuess: PeerGuess | null; // set when target came from attribute inference
  operation: string;
  durationMs: number;
  isError: boolean;
}

interface HeldClient extends ClientSpanInfo {
  insertedAt: number;
  resolved: boolean;
}

interface HeldServer {
  parentSpanId: string;
  serviceId: string;
  insertedAt: number;
}

/**
 * Correlates CLIENT/PRODUCER spans with the SERVER/CONSUMER spans they caused
 * to learn cross-service edges, regardless of which side's batch arrives first.
 *
 * - A client span with an attribute-inferred peer emits an edge immediately
 *   (covers databases, queues and external APIs that never report telemetry,
 *   and HTTP calls whose host matches an instrumented service).
 * - A client span with no inferrable peer is held until a server span whose
 *   parentSpanId matches it arrives (or until TTL expiry).
 * - Edge metrics always come from the CALLER's span: the edge represents the
 *   calling service's measurements of its upstream dependency.
 */
export class EdgeResolver {
  private clientsBySpanId = new Map<string, HeldClient>();
  private serversByParentId = new Map<string, HeldServer>();

  constructor(private ttlMs = 90_000) {}

  onClientSpan(info: ClientSpanInfo, now = Date.now()): EdgeObservation[] {
    const out: EdgeObservation[] = [];
    const held: HeldClient = { ...info, insertedAt: now, resolved: false };

    const server = this.serversByParentId.get(info.spanId);
    if (server) {
      this.serversByParentId.delete(info.spanId);
      if (server.serviceId !== info.serviceId) {
        held.resolved = true;
        out.push(this.observation(held, server.serviceId, null));
      }
    }

    if (!held.resolved && info.peerGuess && info.peerGuess.id !== info.serviceId) {
      held.resolved = true;
      out.push(this.observation(held, info.peerGuess.id, info.peerGuess));
    }

    // Keep resolved clients around briefly so a late server span does not
    // re-emit the same edge through some other path; unresolved ones wait
    // for their server span.
    this.clientsBySpanId.set(info.spanId, held);
    return out;
  }

  onServerSpan(parentSpanId: string | null, serviceId: string, now = Date.now()): EdgeObservation[] {
    if (!parentSpanId) return [];
    const client = this.clientsBySpanId.get(parentSpanId);
    if (client) {
      if (client.resolved || client.serviceId === serviceId) return [];
      client.resolved = true;
      return [this.observation(client, serviceId, null)];
    }
    this.serversByParentId.set(parentSpanId, { parentSpanId, serviceId, insertedAt: now });
    return [];
  }

  /** Drop expired entries. Unresolved clients with no guess are simply forgotten. */
  flush(now = Date.now()): void {
    for (const [k, v] of this.clientsBySpanId) {
      if (now - v.insertedAt > this.ttlMs) this.clientsBySpanId.delete(k);
    }
    for (const [k, v] of this.serversByParentId) {
      if (now - v.insertedAt > this.ttlMs) this.serversByParentId.delete(k);
    }
  }

  get pendingCount(): number {
    return this.clientsBySpanId.size + this.serversByParentId.size;
  }

  private observation(c: HeldClient, targetId: string, guess: PeerGuess | null): EdgeObservation {
    return {
      timeMs: c.timeMs,
      sourceId: c.serviceId,
      targetId,
      targetGuess: guess,
      operation: c.operation,
      durationMs: c.durationMs,
      isError: c.isError,
    };
  }
}
