/**
 * TraceMap demo traffic generator.
 *
 * Replays the 40-service e-commerce topology as real OTLP/JSON trace exports
 * against the collector, exactly the way instrumented services would:
 *  - internal calls produce a CLIENT span (caller) and a SERVER span (callee)
 *  - databases / queues / SaaS APIs produce only the caller's CLIENT span with
 *    semantic-convention attributes, so the collector has to infer the peer
 *  - every resource carries a `team.name` attribute, which the collector uses
 *    to auto-create teams and assign ownership on first sight
 *
 * Usage: npm run simulate [-- --otlp http://localhost:4318 --api http://localhost:4000 --tps 6]
 *
 * While running (attached to a TTY), the trace rate can be dialed live:
 *   [+] double rate, [-] halve rate, [0]/[space]/[p] pause/resume, [q] quit.
 *
 * This file is the entry orchestrator; the moving parts live in siblings:
 * args.ts (CLI/env config), trace.ts (trace generation), payload.ts
 * (OTLP/JSON encoding), http.ts (posting), seed.ts (ownership seeding),
 * metricsSample.ts (gauge exports), rate.ts (live rate dial).
 */
import { parseSimArgs } from './args.js';
import { buildTopology } from './genTopology.js';
import { postJson } from './http.js';
import { sendMetricsSample } from './metricsSample.js';
import { exportPayload } from './payload.js';
import { rand } from './random.js';
import { applyKey, RateControl } from './rate.js';
import { configureTopology } from './topology.js';
import { makeTrace, setRoots } from './trace.js';

const ARGS = parseSimArgs(process.argv.slice(2));
const { otlp: OTLP, api: API, tps: TPS } = ARGS;

// Build the active topology: the curated demo, augmented when --services asks
// for more than the baseline, plus any requested unassigned/duplicate peers.
const topo = buildTopology({
  services: ARGS.services,
  teams: ARGS.teams,
  unassigned: ARGS.unassigned,
  dupRatio: ARGS.dupRatio,
});
configureTopology(topo);
setRoots(topo.roots);

const rate = new RateControl(TPS);

/** One-line summary of what the configured topology contains. */
function topologySummary(): string {
  const teams = new Set(topo.services.map((s) => s.team)).size;
  const dupPeers = topo.meta.dupPairs.length * 2;
  const parts = [
    `${topo.services.length} services across ${teams} teams`,
    `${topo.meta.syntheticServiceCount} synthetic`,
  ];
  if (topo.unassigned.length) {
    parts.push(`${topo.unassigned.length} unassigned (${topo.meta.dupPairs.length} mergeable pairs / ${dupPeers} nodes)`);
  }
  return parts.join(', ');
}

/** Live rate dial: only active when stdin is an interactive terminal. */
function attachKeyboard(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003' /* Ctrl+C; raw mode swallows SIGINT */) process.exit(0);
    const msg = applyKey(rate, key);
    if (msg) console.log(msg);
  });
  console.log('Keys: [+] double rate, [-] halve rate, [0/space/p] pause, [q] quit');
}

/** Send one trace from every root so each team registers up front. */
async function warmUpSweep(): Promise<void> {
  const ids = topo.roots.map(([id]) => id);
  for (let i = 0; i < ids.length; i += 8) {
    const batch = ids.slice(i, i + 8).map((id) => {
      const t = makeTrace(Date.now(), id);
      return postJson(OTLP, '/v1/traces', exportPayload(t.traceId, t.spans)).catch(() => undefined);
    });
    await Promise.allSettled(batch);
  }
}

async function main(): Promise<void> {
  console.log(`TraceMap simulator: ${rate.label()} -> ${OTLP} (api ${API})`);
  console.log(`Topology: ${topologySummary()}`);
  attachKeyboard();

  // Warm-up sweep so every team's entry (and the peers it calls) registers up
  // front. Team ownership comes entirely from the `team.name` resource
  // attribute on instrumented services' traces -- the simulator never seeds
  // ownership through the management API. Inferred peers (databases, queues,
  // SaaS APIs) emit no telemetry of their own, so they surface as unassigned
  // nodes, exactly like real inferred dependencies, until an operator curates
  // them in the UI.
  await warmUpSweep();

  let sent = 0;
  let windowSent = 0;
  // Report throughput per window rather than a running total, so the log
  // doubles as feedback for the [+]/[-] rate dial.
  const REPORT_MS = 10_000;
  setInterval(() => {
    if (windowSent > 0) console.log(`${windowSent} traces sent in the last ${REPORT_MS / 1000}s`);
    windowSent = 0;
  }, REPORT_MS).unref();
  // Fire traces on a jittered cadence approximating the current dial; the
  // interval is re-read every iteration so [+]/[-] take effect immediately.
  const loop = async (): Promise<void> => {
    if (!rate.paused) {
      const t = makeTrace();
      try {
        await postJson(OTLP, '/v1/traces', exportPayload(t.traceId, t.spans));
        sent += 1;
        windowSent += 1;
        if (sent % 25 === 0) await sendMetricsSample(OTLP).catch(() => undefined);
      } catch (err) {
        console.warn('send failed:', (err as Error).message);
      }
    }
    setTimeout(loop, rate.paused ? 250 : rate.intervalMs() * rand(0.5, 1.5));
  };
  for (let i = 0; i < Math.max(1, Math.min(4, Math.round(TPS / 3))); i++) {
    setTimeout(loop, i * 120);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
