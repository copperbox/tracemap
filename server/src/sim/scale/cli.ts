/**
 * Scale harness entry: `npm run scale -- <seed|load|probe|all> [flags]`.
 * See docs/scale-harness.md.
 */
import { ArgError, parseArgs } from './args.js';
import { runAll } from './all.js';
import { runLoad } from './load.js';
import { runProbe } from './probe.js';
import { runSeed } from './seed.js';

async function main(): Promise<void> {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'seed':
      await runSeed(opts);
      break;
    case 'load':
      await runLoad(opts);
      break;
    case 'probe':
      await runProbe(opts);
      break;
    case 'all':
      await runAll(opts);
      break;
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof ArgError) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
