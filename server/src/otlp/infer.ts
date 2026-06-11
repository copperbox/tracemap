/**
 * Intelligent association of spans to peer services.
 *
 * For CLIENT/PRODUCER spans we try to work out which service is being called,
 * using OTEL semantic conventions (both current and legacy attribute names).
 */

export type ServiceType =
  | 'service'
  | 'bff'
  | 'gateway'
  | 'postgres'
  | 'redis'
  | 'kafka'
  | 'elastic'
  | 's3'
  | 'external';

export interface PeerGuess {
  id: string;
  type: ServiceType;
  /** True when the peer cannot emit its own telemetry (db, queue, SaaS API). */
  isExternal: boolean;
}

const DB_SYSTEM_TYPE: Record<string, ServiceType> = {
  postgresql: 'postgres',
  mysql: 'postgres',
  mariadb: 'postgres',
  mssql: 'postgres',
  oracle: 'postgres',
  cockroachdb: 'postgres',
  redis: 'redis',
  memcached: 'redis',
  valkey: 'redis',
  elasticsearch: 'elastic',
  opensearch: 'elastic',
};

const MESSAGING_TYPE: Record<string, ServiceType> = {
  kafka: 'kafka',
  rabbitmq: 'kafka',
  activemq: 'kafka',
  aws_sqs: 'kafka',
  gcp_pubsub: 'kafka',
  nats: 'kafka',
};

function attrStr(attrs: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function stripPort(host: string): string {
  const i = host.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(host.slice(i + 1))) return host.slice(0, i);
  return host;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * First DNS label of a host, used to match in-cluster hostnames like
 * "orders-svc.prod.svc.cluster.local" to the instrumented service "orders-svc".
 */
export function hostLabel(host: string): string {
  return stripPort(host).split('.')[0];
}

/**
 * Infer the peer service for a CLIENT or PRODUCER span.
 *
 * `isInternal(candidate)` lets the caller match inferred hosts against
 * services already known from their own telemetry (so an HTTP call to
 * "orders-svc.internal" resolves to the instrumented service "orders-svc"
 * instead of creating a duplicate external node).
 */
export function inferPeer(
  attrs: Record<string, unknown>,
  isInternal: (id: string) => boolean,
): PeerGuess | null {
  // Explicit peer.service wins outright.
  const peerService = attrStr(attrs, 'peer.service');
  if (peerService) {
    return { id: peerService, type: isInternal(peerService) ? 'service' : 'external', isExternal: !isInternal(peerService) };
  }

  const dbSystem = attrStr(attrs, 'db.system.name', 'db.system');
  if (dbSystem) {
    const type = DB_SYSTEM_TYPE[dbSystem.toLowerCase()] ?? 'external';
    const host = attrStr(attrs, 'server.address', 'net.peer.name', 'db.connection_string');
    const dbName = attrStr(attrs, 'db.namespace', 'db.name');
    const id = host ? hostLabel(host) : dbName ? `${dbSystem}-${dbName}` : dbSystem;
    return { id, type, isExternal: true };
  }

  const messaging = attrStr(attrs, 'messaging.system');
  if (messaging) {
    const type = MESSAGING_TYPE[messaging.toLowerCase()] ?? 'kafka';
    const host = attrStr(attrs, 'server.address', 'net.peer.name');
    const id = host ? hostLabel(host) : messaging;
    return { id, type, isExternal: true };
  }

  const rpcSystem = attrStr(attrs, 'rpc.system');
  if (rpcSystem === 'aws-api') {
    const awsService = attrStr(attrs, 'rpc.service');
    if (awsService && awsService.toLowerCase().includes('s3')) {
      return { id: 'aws-s3', type: 's3', isExternal: true };
    }
    return { id: awsService ? `aws-${awsService.toLowerCase()}` : 'aws-api', type: 'external', isExternal: true };
  }

  // HTTP / gRPC calls: resolve via host.
  const url = attrStr(attrs, 'url.full', 'http.url');
  const host =
    attrStr(attrs, 'server.address', 'net.peer.name', 'http.host') ?? (url ? hostOf(url) : null);
  if (host) {
    const label = hostLabel(host);
    if (isInternal(label)) return { id: label, type: 'service', isExternal: false };
    if (isInternal(stripPort(host))) return { id: stripPort(host), type: 'service', isExternal: false };
    // Unknown host: treat as external API, keyed by full host for clarity.
    return { id: stripPort(host), type: 'external', isExternal: true };
  }

  if (rpcSystem) {
    const rpcService = attrStr(attrs, 'rpc.service');
    if (rpcService) {
      const internal = isInternal(rpcService);
      return { id: rpcService, type: internal ? 'service' : 'external', isExternal: !internal };
    }
  }

  return null;
}

/** Guess a sensible default type for an instrumented service from its name. */
export function inferOwnType(serviceName: string): ServiceType {
  const n = serviceName.toLowerCase();
  if (/gateway|ingress|envoy|edge/.test(n)) return 'gateway';
  if (/bff|frontend|web-?app/.test(n)) return 'bff';
  return 'service';
}

/** Human-readable runtime string from OTEL resource attributes. */
export function runtimeOf(resourceAttrs: Record<string, unknown>): string | null {
  const lang = attrStr(resourceAttrs, 'telemetry.sdk.language');
  const sdk = attrStr(resourceAttrs, 'telemetry.sdk.name');
  const ver = attrStr(resourceAttrs, 'telemetry.sdk.version');
  const rt = attrStr(resourceAttrs, 'process.runtime.name');
  const rtv = attrStr(resourceAttrs, 'process.runtime.version');
  const parts: string[] = [];
  if (rt) parts.push(rtv ? `${rt} ${rtv}` : rt);
  if (lang) parts.push(`${sdk ?? 'otel'}-${lang}${ver ? ` ${ver}` : ''}`);
  return parts.length ? parts.join(' \u00B7 ') : null;
}

export function regionOf(resourceAttrs: Record<string, unknown>): string | null {
  return attrStr(
    resourceAttrs,
    'cloud.region',
    'cloud.availability_zone',
    'deployment.environment.name',
    'deployment.environment',
  );
}
