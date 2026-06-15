/**
 * Procedural topology augmentation for stress testing.
 *
 * Starts from the curated baseline and layers on synthetic teams, services, and
 * infra up to a requested total node count, plus a configurable number of
 * team-less "unassigned" inferred peers. A fraction of the unassigned peers are
 * minted as *duplicate pairs*: two differently-named nodes that stand for one
 * real backend, so the merge/association flow has something to merge.
 *
 * Generation is deterministic given a seed, so a config reproduces the same
 * topology (handy for demos and tests). Traffic-time randomness still comes
 * from random.ts -- this module's RNG only shapes the static topology.
 */
import {
  BASE_DEPS,
  BASE_ERROR_RATE,
  BASE_LATENCY_MULTIPLIER,
  BASE_ROOTS,
  BASE_SERVICES,
  type SimService,
  type SimType,
  type Topology,
} from './topology.js';

export interface TopologyConfig {
  /** Target total instrumented + infra node count (curated + synthetic). */
  services: number;
  /** Synthetic team count; 0 derives one from the synthetic service count. */
  teams: number;
  /** Number of team-less inferred peers to mint. */
  unassigned: number;
  /** Fraction (0-1) of unassigned peers that are mergeable duplicate pairs. */
  dupRatio: number;
  /** Seed for deterministic generation (default 1). */
  seed?: number;
}

export interface GenTopology extends Topology {
  meta: {
    syntheticServiceCount: number;
    teamSizes: { team: string; size: number }[];
    /** [a, b] node id pairs that represent the same backend (merge candidates). */
    dupPairs: [string, string][];
    /** Unassigned peers with no duplicate (genuinely distinct unknown backends). */
    singletonUnassigned: string[];
  };
}

const MAX_SYNTHETIC = 5000;

// ---- deterministic RNG (mulberry32) ----

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));
const pickOne = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const TEAM_NAMES = [
  'Aurora', 'Boreal', 'Cobalt', 'Dynamo', 'Ember', 'Falcon', 'Glacier', 'Helix',
  'Indigo', 'Juniper', 'Krypton', 'Lumen', 'Magnet', 'Nimbus', 'Onyx', 'Pulsar',
  'Quartz', 'Raven', 'Saffron', 'Titan', 'Umbra', 'Vertex', 'Willow', 'Xenon',
  'Yonder', 'Zephyr',
];
const LANGS = ['go', 'java', 'python', 'nodejs', 'rust'];
const INFRA_KINDS: SimType[] = ['postgres', 'redis', 'kafka'];
/** Curated nodes synthetic teams call, to tie the synthetic graph to the demo. */
const SHARED_TARGETS = ['auth-svc', 'catalog-svc', 'kafka-events'];
const BACKEND_WORDS = [
  'billing', 'ledger', 'sessions', 'archive', 'reporting', 'geo', 'audit',
  'search-index', 'media-cdn', 'notifications', 'metrics', 'feature-flags',
];

function teamName(i: number): string {
  return i < TEAM_NAMES.length ? TEAM_NAMES[i] : `Team-${i + 1}`;
}
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function opsFor(type: SimType, slug: string): string[] {
  switch (type) {
    case 'postgres':
      return ['SELECT rows', 'INSERT row', 'UPDATE row'];
    case 'redis':
      return [`GET ${slug}:{id}`, `SETEX ${slug}:{id}`];
    case 'kafka':
      return [`${slug}.changed`, `${slug}.queued`];
    case 'bff':
      return ['GET /home', `GET /${slug}`];
    default:
      return [`GET /v1/${slug}`, `POST /v1/${slug}`, `GET /v1/${slug}/{id}`];
  }
}

/** Split nSynth across teamCount teams with deliberate variation in size. */
function teamSizes(r: () => number, nSynth: number, teamCount: number): number[] {
  const weights = Array.from({ length: teamCount }, () => 0.4 + r() * 1.8);
  const total = weights.reduce((a, w) => a + w, 0);
  const sizes = weights.map((w) => Math.max(2, Math.round((nSynth * w) / total)));
  // Reconcile rounding so the sizes sum to exactly nSynth.
  let diff = nSynth - sizes.reduce((a, s) => a + s, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % teamCount) {
    if (diff > 0) {
      sizes[i] += 1;
      diff -= 1;
    } else if (sizes[i] > 2) {
      sizes[i] -= 1;
      diff += 1;
    }
  }
  return sizes;
}

export function buildTopology(config: TopologyConfig): GenTopology {
  const r = rng((config.seed ?? 1) >>> 0);

  const services: SimService[] = BASE_SERVICES.map((s) => ({ ...s }));
  const unassigned: SimService[] = [];
  const deps: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(BASE_DEPS)) deps[k] = [...v];
  const errorRate: Record<string, number> = { ...BASE_ERROR_RATE };
  const latencyMultiplier: Record<string, number> = { ...BASE_LATENCY_MULTIPLIER };
  const usedIds = new Set(services.map((s) => s.id));

  const nSynth = clamp(Math.floor(config.services) - BASE_SERVICES.length, 0, MAX_SYNTHETIC);
  const teamCount = nSynth === 0 ? 0 : clamp(config.teams > 0 ? Math.floor(config.teams) : Math.round(nSynth / 12), 1, nSynth);

  const sizes = teamCount > 0 ? teamSizes(r, nSynth, teamCount) : [];
  const teamSizesMeta: { team: string; size: number }[] = [];
  const entries: string[] = []; // synthetic team entry points (roots)
  /** Instrumented callers eligible to reference unassigned peers. */
  const callers: string[] = services.filter((s) => s.type === 'service').map((s) => s.id);

  const uniqueId = (base: string): string => {
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  for (let t = 0; t < teamCount; t++) {
    const team = teamName(t);
    const slug = slugify(team);
    const size = sizes[t];

    // Each team has one entry (bff/root), some infra, and the rest services.
    const nInfra = clamp(Math.round((size - 1) * 0.25), 0, 4);
    const nSvc = Math.max(1, size - 1 - nInfra);

    const entryId = uniqueId(`${slug}-bff`);
    services.push({ id: entryId, type: 'bff', team, lang: 'nodejs', ops: opsFor('bff', slug) });
    entries.push(entryId);

    const infraIds: string[] = [];
    for (let i = 0; i < nInfra; i++) {
      const kind = INFRA_KINDS[i % INFRA_KINDS.length];
      const id = uniqueId(`${slug}-${kind}-${i + 1}`);
      services.push({ id, type: kind, team, ops: opsFor(kind, slug) });
      infraIds.push(id);
    }

    const svcIds: string[] = [];
    for (let i = 0; i < nSvc; i++) {
      const id = uniqueId(`${slug}-svc-${i + 1}`);
      services.push({ id, type: 'service', team, lang: pickOne(r, LANGS), ops: opsFor('service', slug) });
      svcIds.push(id);
      callers.push(id);
      // Sprinkle hotspots so a big topology still has visible error/latency.
      if (r() < 0.12) errorRate[id] = 0.02 + r() * 0.05;
      if (r() < 0.1) latencyMultiplier[id] = 1.5 + r() * 1.7;
    }

    // Layered DAG: entry -> low-index svcs -> higher-index svcs -> infra.
    const entryFanout = svcIds.slice(0, clamp(randInt(r, 2, 4), 1, svcIds.length));
    deps[entryId] = [...entryFanout];
    if (r() < 0.25) deps[entryId].push(pickOne(r, SHARED_TARGETS)); // tie into the curated core
    svcIds.forEach((id, i) => {
      const out: string[] = [];
      const downstream = svcIds.slice(i + 1);
      const fan = clamp(randInt(r, 1, 3), 0, downstream.length);
      for (let k = 0; k < fan; k++) out.push(pickOne(r, downstream));
      if (infraIds.length && r() < 0.8) out.push(pickOne(r, infraIds));
      if (out.length) deps[id] = [...new Set(out)];
    });

    teamSizesMeta.push({ team, size });
  }

  // ---- unassigned peers (team-less inferred nodes) ----
  const M = Math.max(0, Math.floor(config.unassigned));
  const R = clamp(config.dupRatio, 0, 1);
  const pairCount = Math.floor((M * R) / 2);
  const singletonCount = M - pairCount * 2;
  const dupPairs: [string, string][] = [];
  const singletonUnassigned: string[] = [];

  const callerPool = callers.length ? callers : BASE_SERVICES.filter((s) => s.type === 'service').map((s) => s.id);
  const addDep = (caller: string, target: string): void => {
    (deps[caller] ??= []).push(target);
  };
  const mintPeer = (peer: SimService): void => {
    usedIds.add(peer.id);
    unassigned.push(peer);
  };

  for (let i = 0; i < singletonCount; i++) {
    const kind = pickOne(r, ['postgres', 'redis', 'kafka', 'external'] as SimType[]);
    let peer: SimService;
    if (kind === 'external') {
      const host = `unknown-${i + 1}.vendor.example`;
      peer = { id: host, type: 'external', team: '', host, ops: ['POST /v1/op'] };
    } else {
      const id = uniqueId(`legacy-${kind}-${i + 1}`);
      peer = { id, type: kind, team: '', ops: opsFor(kind, 'legacy') };
    }
    mintPeer(peer);
    addDep(pickOne(r, callerPool), peer.id);
    singletonUnassigned.push(peer.id);
  }

  for (let p = 0; p < pairCount; p++) {
    const base = `${pickOne(r, BACKEND_WORDS)}-${p + 1}`;
    let a: SimService;
    let b: SimService;
    if (p % 2 === 0) {
      // Same database under two host spellings -> two postgres nodes.
      a = { id: uniqueId(`${base}-db`), type: 'postgres', team: '', ops: opsFor('postgres', base) };
      b = { id: uniqueId(`pg-${base}`), type: 'postgres', team: '', ops: opsFor('postgres', base) };
    } else {
      // Same vendor reached via two hostnames -> two external nodes.
      const hostA = `${base}.example.com`;
      const hostB = `api.${base}.io`;
      a = { id: hostA, type: 'external', team: '', host: hostA, ops: ['POST /v1/op'] };
      b = { id: hostB, type: 'external', team: '', host: hostB, ops: ['POST /v1/op'] };
    }
    mintPeer(a);
    mintPeer(b);
    // Two different callers reference the same backend by different names.
    addDep(pickOne(r, callerPool), a.id);
    addDep(pickOne(r, callerPool), b.id);
    dupPairs.push([a.id, b.id]);
  }

  // ---- weighted roots: split traffic between curated and synthetic by node share ----
  const denom = BASE_SERVICES.length + nSynth;
  const curatedMass = nSynth > 0 ? BASE_SERVICES.length / denom : 1;
  const synthMass = nSynth > 0 ? nSynth / denom : 0;
  const roots: [string, number][] = BASE_ROOTS.map(([id, w]) => [id, w * curatedMass]);
  const perEntry = entries.length ? synthMass / entries.length : 0;
  for (const id of entries) roots.push([id, perEntry]);
  const wTotal = roots.reduce((a, [, w]) => a + w, 0) || 1;
  const normRoots: [string, number][] = roots.map(([id, w]) => [id, w / wTotal]);

  return {
    services,
    unassigned,
    deps,
    errorRate,
    latencyMultiplier,
    roots: normRoots,
    meta: { syntheticServiceCount: nSynth, teamSizes: teamSizesMeta, dupPairs, singletonUnassigned },
  };
}
