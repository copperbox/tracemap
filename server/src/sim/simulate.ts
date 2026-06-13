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
import { postJson } from './http.js';
import { sendMetricsSample } from './metricsSample.js';
import { exportPayload } from './payload.js';
import { rand } from './random.js';
import { applyKey, RateControl } from './rate.js';
import { seedOwnership } from './seed.js';
import { makeTrace } from './trace.js';

const { otlp: OTLP, api: API, tps: TPS } = parseSimArgs(process.argv.slice(2));

const rate = new RateControl(TPS);

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

async function main(): Promise<void> {
  console.log(`TraceMap simulator: ${rate.label()} -> ${OTLP} (api ${API})`);
  attachKeyboard();

  // Send one warm-up trace so services start registering (team.name on each
  // resource assigns instrumented services), then seed the inferred peers.
  const warm = makeTrace();
  await postJson(OTLP, '/v1/traces', exportPayload(warm.traceId, warm.spans));
  await new Promise((r) => setTimeout(r, 1500));
  await seedOwnership(API);
  // Inferred peers (databases, SaaS APIs) appear after the first edge flush;
  // re-run so they get their team/type too.
  setTimeout(() => seedOwnership(API).catch(() => undefined), 20_000);

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
