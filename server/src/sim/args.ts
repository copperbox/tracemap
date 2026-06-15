/**
 * CLI / environment configuration for the simulator.
 * Precedence per setting: `--flag value`, then environment variable, then
 * the built-in default.
 */

export interface SimArgs {
  /** OTLP collector base URL (`--otlp`, OTLP_URL). */
  otlp: string;
  /** Management API base URL (`--api`, API_URL). */
  api: string;
  /** Initial traces-per-second dial (`--tps`, SIM_TPS). */
  tps: number;
  /**
   * Target total service count (`--services`, SIM_SERVICES). When larger than
   * the curated baseline, the topology is augmented with synthetic teams and
   * services up to this count. 0 (default) keeps the curated demo only.
   */
  services: number;
  /**
   * Number of synthetic teams to spread the generated services across
   * (`--teams`, SIM_TEAMS). 0 (default) derives a count from `services`.
   */
  teams: number;
  /**
   * Number of team-less "unassigned" inferred peers to mint
   * (`--unassigned`, SIM_UNASSIGNED) for merge/association testing. Default 0.
   */
  unassigned: number;
  /**
   * Fraction (0-1) of the unassigned peers that are duplicate pairs -- two
   * differently-named nodes representing one backend, so they can be merged
   * (`--dup-ratio`, SIM_DUP_RATIO). Default 0.4.
   */
  dupRatio: number;
}

export function argOf(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

/** Parse a numeric flag, falling back to `dflt` when missing or non-numeric. */
export function numOf(args: string[], name: string, dflt: number): number {
  const raw = argOf(args, name, String(dflt));
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

export function parseSimArgs(args: string[], env: NodeJS.ProcessEnv = process.env): SimArgs {
  return {
    otlp: argOf(args, 'otlp', env.OTLP_URL ?? 'http://127.0.0.1:4318'),
    api: argOf(args, 'api', env.API_URL ?? 'http://127.0.0.1:4000'),
    tps: numOf(args, 'tps', Number(env.SIM_TPS ?? 6)),
    services: numOf(args, 'services', Number(env.SIM_SERVICES ?? 0)),
    teams: numOf(args, 'teams', Number(env.SIM_TEAMS ?? 0)),
    unassigned: numOf(args, 'unassigned', Number(env.SIM_UNASSIGNED ?? 0)),
    dupRatio: numOf(args, 'dup-ratio', Number(env.SIM_DUP_RATIO ?? 0.4)),
  };
}
