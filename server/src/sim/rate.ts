/**
 * Runtime rate control for the demo traffic simulator: a mutable
 * traces-per-second dial plus the keyboard mapping that drives it. Kept
 * separate from simulate.ts so the clamp/step/pause logic is unit-testable
 * without a TTY.
 */

export const MIN_TPS = 0.25;
export const MAX_TPS = 96;

function clamp(tps: number): number {
  return Math.max(MIN_TPS, Math.min(MAX_TPS, tps));
}

export class RateControl {
  tps: number;
  paused = false;

  constructor(initialTps: number) {
    this.tps = clamp(initialTps);
  }

  up(): void {
    this.tps = clamp(this.tps * 2);
  }

  down(): void {
    this.tps = clamp(this.tps / 2);
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  /** Target delay between traces (per send loop) at the current rate. */
  intervalMs(): number {
    return 1000 / this.tps;
  }

  label(): string {
    return this.paused ? 'paused' : `${this.tps} traces/s`;
  }
}

/**
 * Apply one raw stdin keypress to the dial. Returns a status line to print
 * when the key changed something, or null for keys we don't handle (quit and
 * Ctrl+C are the caller's job).
 */
export function applyKey(rate: RateControl, key: string): string | null {
  switch (key) {
    case '+':
    case '=':
      rate.up();
      return `rate -> ${rate.label()}`;
    case '-':
    case '_':
      rate.down();
      return `rate -> ${rate.label()}`;
    case '0':
    case ' ':
    case 'p':
      rate.togglePause();
      return rate.paused ? 'paused (press again to resume)' : `resumed at ${rate.label()}`;
    default:
      return null;
  }
}
