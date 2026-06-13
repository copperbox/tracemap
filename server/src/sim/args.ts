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
}

export function argOf(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

export function parseSimArgs(args: string[], env: NodeJS.ProcessEnv = process.env): SimArgs {
  return {
    otlp: argOf(args, 'otlp', env.OTLP_URL ?? 'http://127.0.0.1:4318'),
    api: argOf(args, 'api', env.API_URL ?? 'http://127.0.0.1:4000'),
    tps: Number(argOf(args, 'tps', env.SIM_TPS ?? '6')),
  };
}
