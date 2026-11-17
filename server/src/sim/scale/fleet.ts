/**
 * Deterministic synthetic fleet for the scale harness: teams, instrumented
 * services, inferred peers (databases, queues, SaaS APIs) and the call graph
 * between them. The same (services, teams, seed) always gives the same fleet,
 * so `seed` and `load` describe the same company.
 *
 * Shape:
 * - A few edge gateways route each request to one team entry point (a BFF).
 * - Each team has services in layers 2..5; calls only go to deeper layers, so
 *   the graph is a DAG and traces stay bounded. Most calls stay inside the
 *   team; some go to "platform" teams, whose services become shared hubs.
 * - Peers emit no telemetry; they exist only as the targets of client spans.
 * - A handful of services fail chronically (warn, crit) so the map has
 *   something to find, and a few historical incidents give charts and SLO
 *   rings some texture.
 */
import { Prng, subSeed } from './prng.js';
import { peerSigs, serviceSigs, type Sig } from './signatures.js';

export type NodeType = 'gateway' | 'bff' | 'service' | 'postgres' | 'redis' | 'kafka' | 'elastic' | 's3' | 'external';
export type Health = 'ok' | 'warn' | 'crit';

export interface FleetConfig {
  /** Total nodes on the map: instrumented services plus inferred peers. */
  services: number;
  /** Teams; 0 = one per 30 nodes. */
  teams: number;
  seed: number;
}

export const DEFAULT_FLEET: FleetConfig = { services: 5000, teams: 0, seed: 1 };

export interface FleetTeam {
  name: string;
  slug: string;
  region: string;
  platform: boolean;
}

export interface FleetNode {
  idx: number;
  id: string;
  type: NodeType;
  /** Index into Fleet.teams, or null for shared peers. */
  team: number | null;
  /** Emits its own spans (gateways, BFFs, services). */
  instrumented: boolean;
  lang: string | null;
  region: string;
  layer: number;
  /** Server operations (instrumented) or client span names used against it (peers). */
  ops: string[];
  /** Per-op failure probability. For peers, one value per op too. */
  opErr: number[];
  /** Index of this node's first op in the flat op numbering. */
  opBase: number;
  /** Op used when this node starts a trace on its own (workers), else -1. */
  rootOp: number;
  /** Median self latency, ms, and log-space spread. */
  selfMs: number;
  sigma: number;
  health: Health;
  sigs: Sig[];
  /** Host callers address: DNS name for internal nodes, the API host for SaaS. */
  host: string;
  sloTarget: number;
  /** Gateways pick one outbound route per request instead of calling every dependency. */
  routes: boolean;
}

export interface FleetEdge {
  idx: number;
  s: number;
  t: number;
  /** Client span names used on this edge. */
  ops: string[];
  /** Index of each op in the target's ops. */
  targetOps: number[];
  opW: number[];
  /** Probability the caller makes this call per request (or route weight for gateways). */
  p: number;
  /** OTLP span kind of the caller's span: 3 client, 4 producer. */
  kind: number;
  opBase: number;
}

export interface Incident {
  node: number;
  /** Start, in minutes before the seed's anchor time. */
  startMinAgo: number;
  durationMin: number;
  kind: 'error' | 'latency';
  /** Error probability added, or latency multiplier. */
  magnitude: number;
}

export interface Fleet {
  config: FleetConfig;
  teams: FleetTeam[];
  nodes: FleetNode[];
  edges: FleetEdge[];
  /** Outbound edge indexes per node. */
  out: number[][];
  /** Inbound edge indexes per node. */
  inbound: number[][];
  /** Trace entry points and their share of traces. */
  roots: { node: number; weight: number }[];
  opCount: number;
  edgeOpCount: number;
  incidents: Incident[];
  byId: Map<string, number>;
}

const DOMAINS = [
  'Payments', 'Search', 'Identity', 'Checkout', 'Catalog', 'Fulfillment', 'Growth', 'Data', 'Messaging', 'Billing',
  'Risk', 'Media', 'Logistics', 'Support', 'Ads', 'Pricing', 'Mobile', 'Partners', 'Compliance', 'Finance',
  'Inventory', 'Notifications', 'Analytics', 'Ranking', 'Security', 'Accounts', 'Loyalty', 'Marketplace', 'Content',
  'Travel', 'Maps', 'Insurance', 'Lending', 'Trading', 'Social', 'Video', 'Booking', 'Payroll', 'Tax', 'Reviews',
];
const FLAVORS = ['Core', 'Platform', 'Ops', 'Labs', 'Insights', 'Experience', 'Services', 'Systems', 'Engine', 'Tools'];
const NOUNS = [
  'orders', 'users', 'catalog', 'stock', 'payments', 'shipping', 'pricing', 'search', 'reviews', 'images', 'ledger',
  'invoices', 'accounts', 'sessions', 'profiles', 'carts', 'fraud', 'risk', 'recs', 'events', 'audit', 'config',
  'flags', 'geo', 'currency', 'rates', 'rewards', 'coupons', 'promos', 'subscriptions', 'plans', 'quotes',
  'contracts', 'documents', 'uploads', 'thumbnails', 'exports', 'reports', 'alerts', 'schedules', 'calendar',
  'bookings', 'availability', 'routing', 'dispatch', 'tracking', 'returns', 'refunds', 'disputes', 'kyc', 'tokens',
  'permissions', 'roles', 'orgs', 'tenants', 'webhooks', 'connectors', 'sync', 'imports', 'enrichment', 'classifier',
  'ranking', 'quota', 'limits', 'ledger-entries', 'statements', 'payouts', 'settlements', 'chargebacks', 'labels',
];
const SUFFIXES = ['svc', 'api', 'worker', 'service', 'engine', 'store', 'manager', 'processor'];
const LANGS = ['go', 'go', 'java', 'java', 'nodejs', 'python', 'python', 'rust'];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
const SAAS_HOSTS = [
  'api.stripe.com', 'api.sendgrid.com', 'api.twilio.com', 'api.easypost.com', 'api.taxjar.com', 'hooks.slack.com',
  'api.github.com', 'api.segment.io', 'api.mixpanel.com', 'maps.googleapis.com', 'api.paypal.com', 'api.adyen.com',
  'api.shippo.com', 'api.zendesk.com', 'api.intercom.io', 'login.salesforce.com', 'api.hubapi.com', 'tenant.auth0.com',
  'api.pagerduty.com', 'api.openexchangerates.org',
];
const SDK_VERSION = '1.30.0';

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** `runtime` column value, formatted the way otlp/infer.ts runtimeOf() formats it. */
export function runtimeString(lang: string): string {
  return `opentelemetry-${lang} ${SDK_VERSION}`;
}

function restOps(r: Prng, noun: string, count: number): string[] {
  const all = [
    `GET /v1/${noun}/{id}`, `GET /v1/${noun}`, `POST /v1/${noun}`, `PUT /v1/${noun}/{id}`,
    `DELETE /v1/${noun}/{id}`, `POST /v1/${noun}/search`, `GET /v1/${noun}/{id}/history`,
  ];
  return r.sample(all, count);
}

function peerOps(type: NodeType, slug: string, host: string): string[] {
  switch (type) {
    case 'postgres':
      return [`SELECT ${slug}`, `INSERT ${slug}`, `UPDATE ${slug}`];
    case 'redis':
      return ['GET', 'SETEX', 'MGET'];
    case 'kafka':
      return [`${slug} publish`];
    case 'elastic':
      return [`search ${slug}`, `bulk ${slug}`];
    case 's3':
      return ['S3.GetObject', 'S3.PutObject'];
    default:
      return [host.startsWith('api.stripe') ? 'POST /v1/payment_intents' : 'POST /v1/requests', 'GET /v1/status'];
  }
}

/** Split `total` across `count` parts with weights in [0.3, 3), each at least `min`. */
function splitSizes(r: Prng, total: number, count: number, min: number): number[] {
  const w = Array.from({ length: count }, () => Math.exp(r.range(-1.2, 1.1)));
  const sum = w.reduce((a, b) => a + b, 0);
  const free = total - min * count;
  const sizes = w.map((x) => min + Math.floor((free * x) / sum));
  let rest = total - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % count, rest--) sizes[i]++;
  return sizes;
}

export function buildFleet(config: FleetConfig): Fleet {
  const total = Math.max(10, Math.floor(config.services));
  const r = new Prng(subSeed(config.seed, 'fleet'));
  let teamCount = config.teams > 0 ? Math.floor(config.teams) : Math.max(1, Math.round(total / 30));
  teamCount = Math.max(1, Math.min(teamCount, Math.floor(total / 5)));

  const nodes: FleetNode[] = [];
  const edges: FleetEdge[] = [];
  const used = new Set<string>();
  const unique = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const teams: FleetTeam[] = [];
  const platformTeams = Math.max(1, Math.round(teamCount * 0.05));
  for (let t = 0; t < teamCount; t++) {
    const base = `${DOMAINS[t % DOMAINS.length]} ${FLAVORS[Math.floor(t / DOMAINS.length) % FLAVORS.length]}`;
    const round = Math.floor(t / (DOMAINS.length * FLAVORS.length));
    const name = round > 0 ? `${base} ${round + 1}` : base;
    teams.push({ name, slug: slugify(name), region: REGIONS[t % REGIONS.length], platform: t < platformTeams });
  }

  const addNode = (n: Omit<FleetNode, 'idx' | 'opBase' | 'opErr' | 'health' | 'sigs' | 'rootOp' | 'sloTarget' | 'routes'> & Partial<FleetNode>): FleetNode => {
    const node: FleetNode = {
      opBase: 0,
      opErr: [],
      health: 'ok',
      sigs: [],
      rootOp: -1,
      sloTarget: 99.9,
      routes: false,
      ...n,
      idx: nodes.length,
    };
    nodes.push(node);
    return node;
  };

  // ---- peers ----
  const teamPeers: { pg: number; redis: number; es: number }[] = [];
  for (let t = 0; t < teamCount; t++) {
    const team = teams[t];
    const mk = (type: NodeType, suffix: string, selfMs: number): number => {
      const id = unique(`${team.slug}-${suffix}`);
      return addNode({
        id, type, team: t, instrumented: false, lang: null, region: team.region, layer: 6,
        ops: peerOps(type, slugify(team.name.split(' ')[0]), id), selfMs, sigma: 0.5, host: `${id}.db.internal`,
      }).idx;
    };
    teamPeers.push({
      pg: r.chance(0.75) ? mk('postgres', 'pg', r.range(1, 8)) : -1,
      redis: r.chance(0.5) ? mk('redis', 'redis', r.range(0.3, 1.5)) : -1,
      es: r.chance(0.12) ? mk('elastic', 'es', r.range(15, 50)) : -1,
    });
  }
  const kafka: number[] = [];
  for (let k = 0; k < Math.max(1, Math.round(total / 1000)); k++) {
    const id = unique(`kafka-events-${k + 1}`);
    kafka.push(addNode({ id, type: 'kafka', team: null, instrumented: false, lang: null, region: REGIONS[k % REGIONS.length], layer: 6, ops: [`events-${k + 1} publish`], selfMs: r.range(2, 6), sigma: 0.4, host: `${id}.kafka.internal` }).idx);
  }
  // collector/infer.ts maps every S3 call to the single peer "aws-s3".
  const s3 = addNode({ id: unique('aws-s3'), type: 's3', team: null, instrumented: false, lang: null, region: 'us-east-1', layer: 6, ops: peerOps('s3', '', ''), selfMs: r.range(25, 70), sigma: 0.6, host: 's3.amazonaws.com' }).idx;
  const saas: number[] = [];
  for (let i = 0; i < Math.min(SAAS_HOSTS.length, Math.max(3, Math.round(total / 250))); i++) {
    const host = SAAS_HOSTS[i];
    used.add(host);
    saas.push(addNode({ id: host, type: 'external', team: null, instrumented: false, lang: null, region: 'internet', layer: 6, ops: peerOps('external', '', host), selfMs: r.range(80, 300), sigma: 0.55, host }).idx);
  }

  // ---- gateways and team services ----
  const gatewayCount = Math.max(1, Math.round(total / 1600));
  const gateways: number[] = [];
  for (let g = 0; g < gatewayCount; g++) {
    const id = unique(`edge-gateway-${g + 1}`);
    gateways.push(addNode({ id, type: 'gateway', team: 0, instrumented: true, lang: 'cpp', region: REGIONS[g % REGIONS.length], layer: 0, ops: [], selfMs: r.range(1, 3), sigma: 0.35, host: `${id}.svc.cluster.local`, routes: true }).idx);
  }
  const budget = Math.max(teamCount * 2, total - nodes.length);
  const sizes = splitSizes(r, budget, teamCount, 2);
  /** Per team: nodes by layer (index 1 = entry, 2..5 = services). */
  const layersOf: number[][][] = [];
  const platformByLayer: number[][] = [[], [], [], [], [], []];
  const nounPool = NOUNS.slice();

  for (let t = 0; t < teamCount; t++) {
    const team = teams[t];
    const byLayer: number[][] = [[], [], [], [], [], []];
    const entryId = unique(`${team.slug}-bff`);
    byLayer[1].push(
      addNode({ id: entryId, type: 'bff', team: t, instrumented: true, lang: 'nodejs', region: team.region, layer: 1, ops: ['GET /', `GET /${team.slug}`, `POST /${team.slug}/actions`], selfMs: r.range(4, 15), sigma: 0.45, host: `${entryId}.svc.cluster.local` }).idx,
    );
    for (let i = 1; i < sizes[t]; i++) {
      const noun = r.pick(nounPool);
      const id = unique(`${team.slug}-${noun}-${r.pick(SUFFIXES)}`);
      const roll = r.next();
      const layer = roll < 0.3 ? 2 : roll < 0.6 ? 3 : roll < 0.85 ? 4 : 5;
      const lang = r.pick(LANGS);
      const node = addNode({ id, type: 'service', team: t, instrumented: true, lang, region: team.region, layer, ops: restOps(r, noun, r.int(2, 4)), selfMs: r.range(3, 25), sigma: r.range(0.35, 0.7), host: `${id}.svc.cluster.local` });
      if (r.chance(0.08)) {
        // A worker that also starts traces on its own (queue consumer).
        node.ops.push(`consume ${noun}.events`);
        node.rootOp = node.ops.length - 1;
      }
      byLayer[layer].push(node.idx);
      if (team.platform) platformByLayer[layer].push(node.idx);
    }
    layersOf.push(byLayer);
  }

  // ---- edges ----
  const out: number[][] = nodes.map(() => []);
  const inbound: number[][] = nodes.map(() => []);
  const edgeKey = new Set<string>();
  const usedOps: Set<number>[] = [];
  const addEdge = (s: number, t: number, p: number): void => {
    if (s === t) return;
    const key = `${s}>${t}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    const target = nodes[t];
    let ops: string[];
    let targetOps: number[] = [];
    if (target.instrumented) {
      const callable = target.ops.map((_, i) => i).filter((i) => i !== target.rootOp);
      const k = nodes[s].routes ? 1 : r.int(1, Math.min(2, callable.length));
      // Prefer ops no caller uses yet, so most operations see traffic.
      const used = (usedOps[t] ??= new Set());
      const fresh = callable.filter((i) => !used.has(i));
      targetOps = r.sample(fresh.length >= k ? fresh : callable, k);
      for (const i of targetOps) used.add(i);
      ops = targetOps.map((i) => target.ops[i]);
    } else {
      targetOps = r.sample(target.ops.map((_, i) => i), r.int(1, Math.min(2, target.ops.length)));
      ops = targetOps.map((i) => target.ops[i]);
    }
    const e: FleetEdge = {
      idx: edges.length, s, t, ops, targetOps, opW: ops.map(() => r.range(0.3, 1)), p,
      kind: target.type === 'kafka' ? 4 : 3, opBase: 0,
    };
    edges.push(e);
    out[s].push(e.idx);
    inbound[t].push(e.idx);
  };

  for (let t = 0; t < teamCount; t++) {
    const gw = gateways[t % gateways.length];
    const entry = layersOf[t][1][0];
    addEdge(gw, entry, sizes[t] * r.range(0.5, 2));
    nodes[gw].ops.push(`route /${teams[t].slug}`);
  }
  for (const gw of gateways) {
    // Route op i belongs to route edge i.
    for (const ei of out[gw]) {
      const e = edges[ei];
      e.ops = [nodes[e.t].ops[0]];
      e.targetOps = [0];
    }
  }

  const deeper = (t: number, layer: number): number[] => {
    const res: number[] = [];
    for (let l = layer + 1; l <= 5; l++) res.push(...layersOf[t][l]);
    return res;
  };
  for (let t = 0; t < teamCount; t++) {
    const tp = teamPeers[t];
    const entry = layersOf[t][1][0];
    const firstTier = [...layersOf[t][2], ...layersOf[t][3]];
    for (const target of r.sample(firstTier.length ? firstTier : deeper(t, 1), r.int(2, 4))) addEdge(entry, target, 0.5);
    if (r.chance(0.1) && platformByLayer[2].length) addEdge(entry, r.pick(platformByLayer[2]), 0.5);

    for (let layer = 2; layer <= 5; layer++) {
      for (const s of layersOf[t][layer]) {
        if (layer < 5) {
          const roll = r.next();
          const calls = roll < 0.35 ? 0 : roll < 0.75 ? 1 : roll < 0.95 ? 2 : 3;
          for (let c = 0; c < calls; c++) {
            const own = deeper(t, layer);
            if (r.chance(0.8) && own.length) {
              addEdge(s, r.pick(own), 0.4);
            } else {
              const shared: number[] = [];
              for (let l = layer + 1; l <= 5; l++) shared.push(...platformByLayer[l]);
              const foreign = shared.filter((x) => nodes[x].team !== t);
              if (foreign.length) addEdge(s, r.pick(foreign), 0.35);
            }
          }
        }
        if (tp.pg >= 0 && r.chance(0.5)) addEdge(s, tp.pg, 0.85);
        if (tp.redis >= 0 && r.chance(0.35)) addEdge(s, tp.redis, 0.8);
        if (tp.es >= 0 && r.chance(0.1)) addEdge(s, tp.es, 0.7);
        if (r.chance(0.15)) addEdge(s, r.pick(kafka), 0.5);
        if (r.chance(0.03)) addEdge(s, r.pick(saas), 0.4);
        if (r.chance(0.03)) addEdge(s, s3, 0.5);
      }
    }
    // Every team service gets at least one caller, from a shallower layer of its team.
    for (let layer = 2; layer <= 5; layer++) {
      for (const s of layersOf[t][layer]) {
        if (inbound[s].length) continue;
        const callers: number[] = [];
        for (let l = 1; l < layer; l++) callers.push(...layersOf[t][l]);
        addEdge(r.pick(callers), s, 0.5);
      }
    }
  }
  // Peers nobody happened to call get one caller, so every node has traffic.
  const callersAll = nodes.filter((n) => n.type === 'service').map((n) => n.idx);
  for (const n of nodes) {
    if (!n.instrumented && inbound[n.idx].length === 0 && callersAll.length) {
      const own = n.team != null ? layersOf[n.team].slice(2).flat() : [];
      addEdge(own.length ? r.pick(own) : r.pick(callersAll), n.idx, 0.6);
    }
  }

  // ---- failure model ----
  const fr = new Prng(subSeed(config.seed, 'health'));
  const plainServices = nodes.filter((n) => n.type === 'service' && inbound[n.idx].length > 0);
  const nCrit = Math.max(1, Math.round(plainServices.length * 0.003));
  const nWarn = Math.max(1, Math.round(plainServices.length * 0.01));
  const chosen = fr.sample(plainServices, nCrit + nWarn);
  chosen.forEach((n, i) => (n.health = i < nCrit ? 'crit' : 'warn'));
  for (const n of fr.sample(plainServices, Math.max(1, Math.round(plainServices.length * 0.01)))) n.selfMs *= 3;

  for (const n of nodes) {
    let base: number;
    if (n.instrumented) {
      base = n.health === 'crit' ? fr.range(0.03, 0.08) : n.health === 'warn' ? fr.range(0.01, 0.018) : fr.range(0.0001, 0.0008);
      n.sigs = serviceSigs(n.lang ?? 'go', () => fr.next());
      n.sloTarget = fr.chance(0.15) ? 99.5 : fr.chance(0.1) ? 99.0 : 99.9;
    } else {
      base = n.type === 'external' ? fr.range(0.001, 0.006) : n.type === 'elastic' ? 0.001 : n.type === 's3' ? 0.0005 : 0.0002;
      n.sigs = peerSigs(n.type, n.type === 'external' ? n.host : null);
    }
    n.opErr = n.ops.map(() => Math.min(0.5, base * fr.range(0.6, 1.4)));
  }

  // ---- flat op numbering ----
  let opCount = 0;
  for (const n of nodes) {
    n.opBase = opCount;
    opCount += n.ops.length;
  }
  let edgeOpCount = 0;
  for (const e of edges) {
    e.opBase = edgeOpCount;
    edgeOpCount += e.ops.length;
  }

  // ---- roots: 85% of traces enter through a gateway, the rest start at workers ----
  const roots: { node: number; weight: number }[] = gateways.map((g) => ({ node: g, weight: 0.85 / gateways.length }));
  const workers = nodes.filter((n) => n.rootOp >= 0);
  for (const w of workers) roots.push({ node: w.idx, weight: 0.15 / workers.length });

  // ---- historical incidents (relative to the seed's anchor time) ----
  const ir = new Prng(subSeed(config.seed, 'incidents'));
  const candidates = nodes.filter((n) => inbound[n.idx].length > 0 && n.type !== 'gateway' && n.type !== 'bff');
  const incidents: Incident[] = [];
  const nInc = Math.max(3, Math.round(plainServices.length / 700));
  for (let i = 0; i < nInc && candidates.length; i++) {
    const node = ir.pick(candidates).idx;
    const kind = ir.chance(0.6) ? 'error' : 'latency';
    incidents.push({
      node,
      startMinAgo: ir.int(6 * 60, 7 * 24 * 60 - 120),
      durationMin: ir.int(15, 120),
      kind,
      magnitude: kind === 'error' ? ir.range(0.1, 0.35) : ir.range(3, 8),
    });
  }
  // One recent incident, so the 1 h and 24 h views show a spike.
  if (candidates.length) {
    incidents.push({ node: ir.pick(candidates).idx, startMinAgo: 95, durationMin: 25, kind: 'error', magnitude: 0.25 });
  }

  return {
    config: { services: total, teams: teamCount, seed: config.seed },
    teams,
    nodes,
    edges,
    out,
    inbound,
    roots,
    opCount,
    edgeOpCount,
    incidents,
    byId: new Map(nodes.map((n) => [n.id, n.idx])),
  };
}

/** One-line description for logs. */
export function describeFleet(f: Fleet): string {
  const inst = f.nodes.filter((n) => n.instrumented).length;
  const crit = f.nodes.filter((n) => n.health === 'crit').length;
  const warn = f.nodes.filter((n) => n.health === 'warn').length;
  return `${f.nodes.length} nodes (${inst} instrumented, ${f.nodes.length - inst} inferred peers), ${f.teams.length} teams, ${f.edges.length} edges, ${f.opCount} operations, ${warn} warn / ${crit} crit services`;
}
