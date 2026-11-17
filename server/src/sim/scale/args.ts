/**
 * Command-line parsing for `npm run scale -- <command> [--flag value ...]`.
 * Unknown flags are errors, so a typo cannot silently run with a default.
 */

export type Command = 'seed' | 'load' | 'probe' | 'all';
export const COMMANDS: readonly Command[] = ['seed', 'load', 'probe', 'all'];

type Kind = 'number' | 'string' | 'bool' | 'duration';

interface FlagSpec {
  kind: Kind;
  default: number | string | boolean | null;
  help: string;
  /** Environment variable consulted before the default. */
  env?: string;
}

const FLEET: Record<string, FlagSpec> = {
  services: { kind: 'number', default: 5000, help: 'nodes on the map (services plus inferred peers)' },
  teams: { kind: 'number', default: 0, help: 'teams; 0 = one per 30 nodes' },
  'topology-seed': { kind: 'number', default: 1, help: 'seed for the fleet; seed and load must agree' },
};

const SEED: Record<string, FlagSpec> = {
  db: { kind: 'string', default: null, env: 'DATABASE_URL', help: 'database to seed (required; never defaults to the dev database)' },
  days: { kind: 'number', default: 7, help: 'whole days of history' },
  'recent-minutes': { kind: 'number', default: 120, help: 'minutes of 1m rows before now' },
  rate: { kind: 'number', default: 20000, help: 'spans/s the history is scaled to at the current time of day' },
  workers: { kind: 'number', default: 8, help: 'worker threads, one connection each' },
  'calibrate-traces': { kind: 'number', default: 200000, help: 'traces walked to measure rates and latencies' },
  chunk: { kind: 'number', default: 5000, help: 'rows per upsert statement' },
  compress: { kind: 'bool', default: true, help: 'compress chunks older than their policy, as on a long-running system (--compress=false to skip)' },
  reset: { kind: 'bool', default: false, help: 'clear rollup, kept-trace and catalog tables first (needs --yes)' },
  yes: { kind: 'bool', default: false, help: 'confirm writing to the database without a prompt (required with --reset or without a terminal)' },
  force: { kind: 'bool', default: false, help: 'seed even on port 5433 or into a database holding data the harness did not write' },
};

const LOAD: Record<string, FlagSpec> = {
  otlp: { kind: 'string', default: 'http://127.0.0.1:4318', env: 'OTLP_URL', help: 'collector base URL, http or https; /v1/traces is appended to any path' },
  timeout: { kind: 'duration', default: 30, help: 'give up on one export request after this long' },
  rate: { kind: 'number', default: 20000, help: 'target spans/s' },
  duration: { kind: 'duration', default: 0, help: 'how long to run (90s, 5m, 1h); 0 = until Ctrl-C' },
  connections: { kind: 'number', default: 8, help: 'parallel keep-alive connections' },
  batch: { kind: 'number', default: 1000, help: 'spans per export request' },
  gzip: { kind: 'bool', default: false, help: 'gzip request bodies, as most OTLP exporters do' },
  incident: { kind: 'string', default: null, help: 'service id to push into errors while running' },
  'incident-rate': { kind: 'number', default: 0.3, help: 'failure probability added to the incident service' },
  'incident-after': { kind: 'duration', default: 30, help: 'start the incident this long after the load starts' },
  'status-every': { kind: 'duration', default: 5, help: 'status line interval' },
};

const PROBE: Record<string, FlagSpec> = {
  api: { kind: 'string', default: 'http://127.0.0.1:4000', env: 'API_URL', help: 'API base URL (without /api)' },
  repeat: { kind: 'number', default: 5, help: 'requests per endpoint' },
  'sse-seconds': { kind: 'duration', default: 10, help: 'how long to watch the live stream' },
  out: { kind: 'string', default: null, help: 'write the results as JSON to this path' },
  service: { kind: 'string', default: null, help: 'service to probe (default: the worst one on the map)' },
  edge: { kind: 'string', default: null, help: 'edge to probe as source,target (default: a caller of the service)' },
};

const ALL: Record<string, FlagSpec> = {
  'no-seed': { kind: 'bool', default: false, help: 'skip the seed step' },
  'probe-every': { kind: 'duration', default: 60, help: 'run the probe this often while loading' },
};

export const SPECS: Record<Command, Record<string, FlagSpec>> = {
  seed: { ...FLEET, ...SEED },
  load: { ...FLEET, ...LOAD },
  probe: { ...FLEET, ...PROBE },
  all: { ...FLEET, ...SEED, ...LOAD, ...PROBE, ...ALL },
};

export type Opts = Record<string, number | string | boolean | null>;

export interface Parsed {
  command: Command;
  opts: Opts;
}

export class ArgError extends Error {}

/** "90", "90s", "5m", "1h" -> seconds. */
export function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(raw.trim());
  if (!m) throw new ArgError(`bad duration "${raw}" (use e.g. 90s, 5m, 1h)`);
  const v = Number(m[1]);
  return m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : v;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Parsed {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === 'help') throw new ArgError(usage());
  if (!COMMANDS.includes(cmd as Command)) throw new ArgError(`unknown command "${cmd}"\n\n${usage()}`);
  const command = cmd as Command;
  const spec = SPECS[command];
  const opts: Opts = {};
  for (const [name, s] of Object.entries(spec)) {
    const fromEnv = s.env ? env[s.env] : undefined;
    opts[name] = fromEnv != null && fromEnv !== '' ? convert(name, s, fromEnv) : s.default;
  }
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--help') throw new ArgError(usage(command));
    if (!tok.startsWith('--')) throw new ArgError(`unexpected argument "${tok}"`);
    let name = tok.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const s = spec[name];
    if (!s) throw new ArgError(`unknown flag --${name} for "${command}"\n\n${usage(command)}`);
    if (s.kind === 'bool') {
      opts[name] = value == null ? true : value !== 'false';
      continue;
    }
    if (value == null) {
      value = rest[++i];
      if (value == null || value.startsWith('--')) throw new ArgError(`--${name} needs a value`);
    }
    opts[name] = convert(name, s, value);
  }
  return { command, opts };
}

function convert(name: string, s: FlagSpec, raw: string): number | string | boolean {
  switch (s.kind) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ArgError(`--${name} must be a number, got "${raw}"`);
      return n;
    }
    case 'duration':
      return parseDuration(raw);
    case 'bool':
      return raw !== 'false' && raw !== '0';
    default:
      return raw;
  }
}

export function usage(command?: Command): string {
  const cmds = command ? [command] : COMMANDS;
  const lines = ['usage: npm run scale -- <command> [flags]', ''];
  for (const c of cmds) {
    lines.push(`${c}:`);
    for (const [name, s] of Object.entries(SPECS[c])) {
      const d = s.default == null || s.default === false ? '' : ` (default ${s.default})`;
      lines.push(`  --${name.padEnd(17)} ${s.help}${d}${s.env ? ` [env ${s.env}]` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
