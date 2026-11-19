import type { LiveMetrics, Status, Team, Topology, TopologyEdge, TopologyService } from '../api/types';

/**
 * Dev-only synthetic topology (`?synthetic=N`), so the map can be exercised at
 * any size without a backend. Same shape as the server simulator
 * (server/src/sim/genTopology.ts): teams with an entry point, layered services
 * and their own infra, plus team-less inferred peers (databases, queues, SaaS).
 * Deterministic for a given size and seed.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAM_WORDS = [
  'aurora', 'boreal', 'cobalt', 'dynamo', 'ember', 'falcon', 'glacier', 'helix', 'indigo', 'juniper',
  'krypton', 'lumen', 'magnet', 'nimbus', 'onyx', 'pulsar', 'quartz', 'raven', 'saffron', 'titan',
  'umbra', 'vertex', 'willow', 'xenon', 'yonder', 'zephyr',
];
const SVC_WORDS = [
  'orders', 'checkout', 'cart', 'pricing', 'catalog', 'search', 'ledger', 'billing', 'invoices', 'auth',
  'sessions', 'profile', 'inventory', 'shipping', 'returns', 'reviews', 'media', 'geo', 'audit', 'rules',
  'quotes', 'payouts', 'risk', 'fraud', 'notify', 'mailer', 'reports', 'export', 'import', 'sync',
];
const SAAS = ['stripe', 'twilio', 'sendgrid', 'segment', 'auth0', 'algolia', 'datadog', 'slack', 'github', 'okta'];
const ISO = '2026-10-17T14:22:31.482Z';

const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];

/** Thresholds the synthetic feed uses to turn an error rate into a status. */
export function statusOf(errPct: number): Status {
  return errPct >= 5 ? 'crit' : errPct >= 1 ? 'warn' : 'ok';
}

interface Hot {
  /** baseline error rate, percent */
  err: number;
  /** latency multiplier */
  slow: number;
}

/** Per-entity baseline the refresh jitters around, keyed by service id or edge key. */
export interface SyntheticBaseline {
  svc: Map<string, { rps: number; p50: number } & Hot>;
  edge: Map<string, { rps: number; p50: number } & Hot>;
}

export interface SyntheticTopology {
  topology: Topology;
  baseline: SyntheticBaseline;
}

function metricsFrom(b: { rps: number; p50: number } & Hot, r: () => number, wobble: number): LiveMetrics {
  const j = (amp: number): number => 1 + (r() * 2 - 1) * amp * wobble;
  const p50 = b.p50 * b.slow * j(0.1);
  const p95 = p50 * 3.1 * j(0.08);
  const err = Math.max(0, b.err * j(0.3));
  return { rps: b.rps * j(0.12), p50, p95, p99: p95 * 1.9, errPct: err, stale: false };
}

/**
 * Build a topology of about `n` nodes. Roughly 7% are team-less inferred
 * peers; the rest split into teams of 4 to 30. Edges average about 1.8 per
 * service. About 6% of services run hot (warn) and 1.5% critical.
 */
export function generateTopology(n: number, seed = 1): SyntheticTopology {
  const r = rng(seed);
  const total = Math.max(4, Math.floor(n));
  const nExt = Math.max(1, Math.round(total * 0.07));
  const nInternal = total - nExt;
  const nTeams = Math.max(1, Math.round(nInternal / 13));

  const teams: Team[] = [];
  const services: TopologyService[] = [];
  const edges: TopologyEdge[] = [];
  const baseline: SyntheticBaseline = { svc: new Map(), edge: new Map() };
  const used = new Set<string>();
  const uniq = (base: string): string => {
    let id = base;
    let i = 2;
    while (used.has(id)) id = `${base}-${i++}`;
    used.add(id);
    return id;
  };
  const hot = (): Hot => {
    const x = r();
    if (x < 0.015) return { err: 6 + r() * 8, slow: 2 + r() * 2 };
    if (x < 0.075) return { err: 1.2 + r() * 2.5, slow: 1.3 + r() };
    return { err: r() * 0.4, slow: 1 };
  };
  const addService = (
    id: string,
    type: string,
    teamId: number | null,
    isExternal: boolean,
    rps: number,
  ): void => {
    const h = hot();
    const b = { rps, p50: 2 + r() * 40, ...h };
    baseline.svc.set(id, b);
    const metrics = metricsFrom(b, r, 1);
    services.push({
      id,
      name: id,
      description: null,
      type,
      teamId,
      runtime: isExternal ? null : pick(r, ['opentelemetry-go 1.30.0', 'opentelemetry-java 2.9.0', 'opentelemetry-js 1.27.0']),
      region: pick(r, ['us-east-1', 'us-west-2', 'eu-west-1']),
      isExternal,
      sloTarget: 99.9,
      sloAttain: 99.9 - r() * 0.3,
      firstSeen: ISO,
      lastSeen: ISO,
      status: statusOf(metrics.errPct),
      metrics,
    });
  };
  const edgeSet = new Set<string>();
  const addEdge = (source: string, target: string): void => {
    if (source === target) return;
    const key = `${source}=>${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    const h = hot();
    const b = { rps: 1 + r() * 300, p50: 2 + r() * 40, ...h };
    baseline.edge.set(key, b);
    const metrics = metricsFrom(b, r, 1);
    edges.push({
      source,
      target,
      firstSeen: ISO,
      lastSeen: ISO,
      samples: Math.round(r() * 5e6),
      manual: false,
      confidence: 99,
      status: statusOf(metrics.errPct),
      metrics,
    });
  };

  // Inferred peers first so services can call them.
  const peers: string[] = [];
  for (let i = 0; i < nExt; i++) {
    const kind = r();
    let id: string;
    let type: string;
    if (kind < 0.35) {
      id = uniq(`${pick(r, SAAS)}-${i + 1}.api.example.com`);
      type = 'external';
    } else if (kind < 0.6) {
      id = uniq(`legacy-pg-${i + 1}`);
      type = 'postgres';
    } else if (kind < 0.8) {
      id = uniq(`queue-${i + 1}`);
      type = 'kafka';
    } else {
      id = uniq(`cache-${i + 1}`);
      type = 'redis';
    }
    addService(id, type, null, true, 5 + r() * 400);
    peers.push(id);
  }

  // Team sizes with deliberate variation, summing to nInternal.
  const weights = Array.from({ length: nTeams }, () => 0.3 + r() * 1.7);
  const wsum = weights.reduce((a, w) => a + w, 0);
  const sizes = weights.map((w) => Math.max(4, Math.round((nInternal * w) / wsum)));
  let diff = nInternal - sizes.reduce((a, s) => a + s, 0);
  for (let i = 0; diff !== 0 && i < 100000; i = (i + 1) % nTeams) {
    if (diff > 0) {
      sizes[i]++;
      diff--;
    } else if (sizes[i] > 4) {
      sizes[i]--;
      diff++;
    }
  }

  const teamSvcs: string[][] = [];
  for (let t = 0; t < nTeams; t++) {
    const id = t + 1;
    const word = TEAM_WORDS[t % TEAM_WORDS.length];
    const name = t < TEAM_WORDS.length ? word : `${word}-${Math.floor(t / TEAM_WORDS.length) + 1}`;
    teams.push({ id, name });
    const size = sizes[t];
    const nInfra = Math.min(4, Math.max(1, Math.round(size * 0.2)));
    const nSvc = Math.max(1, size - 1 - nInfra);

    const entry = uniq(`${name}-${t % 7 === 0 ? 'gateway' : 'bff'}`);
    addService(entry, t % 7 === 0 ? 'gateway' : 'bff', id, false, 200 + r() * 3000);
    const infra: string[] = [];
    for (let i = 0; i < nInfra; i++) {
      const type = (['postgres', 'redis', 'kafka', 'elastic', 's3'] as const)[i % 5];
      const iid = uniq(`${name}-${type}`);
      addService(iid, type, id, true, 20 + r() * 800);
      infra.push(iid);
    }
    const svcs: string[] = [];
    for (let i = 0; i < nSvc; i++) {
      const sid = uniq(`${name}-${pick(r, SVC_WORDS)}`);
      addService(sid, 'service', id, false, 5 + r() * 600);
      svcs.push(sid);
    }
    teamSvcs.push(svcs);

    // Layered DAG inside the team: entry -> early services -> later -> infra.
    const fan = Math.min(svcs.length, 2 + Math.floor(r() * 3));
    for (let i = 0; i < fan; i++) addEdge(entry, svcs[i]);
    svcs.forEach((sid, i) => {
      const down = svcs.slice(i + 1);
      const k = Math.min(down.length, r() < 0.3 ? 2 : r() < 0.75 ? 1 : 0);
      for (let j = 0; j < k; j++) addEdge(sid, pick(r, down));
      if (r() < 0.75) addEdge(sid, pick(r, infra));
    });
  }

  // Cross-team calls favor a handful of platform teams, plus inferred peers.
  const platform = teamSvcs.slice(0, Math.max(1, Math.round(nTeams * 0.1)));
  teamSvcs.forEach((svcs, t) => {
    for (const sid of svcs) {
      if (r() < 0.38 && nTeams > 1) {
        const pool = r() < 0.6 ? pick(r, platform) : teamSvcs[(t + 1 + Math.floor(r() * (nTeams - 1))) % nTeams];
        if (pool.length && pool !== svcs) addEdge(sid, pick(r, pool));
      }
      if (r() < 0.2) addEdge(sid, pick(r, peers));
    }
  });
  // Every peer gets at least one caller so nothing floats.
  const called = new Set(edges.map((e) => e.target));
  const allSvcs = teamSvcs.flat();
  for (const p of peers) if (!called.has(p) && allSvcs.length) addEdge(pick(r, allSvcs), p);

  return {
    topology: { services, edges, teams, generatedAt: new Date().toISOString() },
    baseline,
  };
}

/**
 * Next live frame: about `share` of services and edges get fresh metrics (new
 * objects); the rest keep their object identity, as the pushed feed will.
 */
export function refreshMetrics(
  prev: Topology,
  baseline: SyntheticBaseline,
  step: number,
  share = 0.6,
): Topology {
  const r = rng(0x9e3779b9 ^ step);
  const services = prev.services.map((s) => {
    const b = baseline.svc.get(s.id);
    if (!b || r() > share) return s;
    const metrics = metricsFrom(b, r, 1);
    return { ...s, metrics, status: statusOf(metrics.errPct) };
  });
  const edges = prev.edges.map((e) => {
    const b = baseline.edge.get(`${e.source}=>${e.target}`);
    if (!b || r() > share) return e;
    const metrics = metricsFrom(b, r, 1);
    return { ...e, metrics, status: statusOf(metrics.errPct) };
  });
  return { services, edges, teams: prev.teams, generatedAt: new Date().toISOString() };
}
