/**
 * `scale all`: seed (unless --no-seed), then load, running the probe every
 * --probe-every seconds and printing its table. With --out, every probe run
 * is written to that file as a JSON array.
 */
import { writeFile } from 'node:fs/promises';
import type { Opts } from './args.js';
import { formatTotals, startLoad } from './load.js';
import { runProbe, type ProbeResult } from './probe.js';
import { runSeed } from './seed.js';

export async function runAll(opts: Opts): Promise<void> {
  if (!opts['no-seed']) await runSeed(opts);
  const load = startLoad(opts);
  const onSig = () => {
    console.log('\n[all] stopping');
    process.off('SIGINT', onSig);
    load.stop();
  };
  process.on('SIGINT', onSig);

  const probes: ProbeResult[] = [];
  let ended = false;
  void load.done.then(() => (ended = true));
  const everyMs = (opts['probe-every'] as number) * 1000;
  const probing = (async () => {
    while (!ended) {
      await Promise.race([new Promise((r) => setTimeout(r, everyMs)), load.done]);
      if (ended) break;
      // The probe runs in this process, so its timings include some event-loop time taken by the generator.
      probes.push(await runProbe({ ...opts, out: null }));
      if (opts.out) await writeFile(opts.out as string, JSON.stringify(probes, null, 2));
    }
  })();
  const totals = await load.done;
  ended = true;
  await probing;
  console.log(formatTotals(totals));
}
