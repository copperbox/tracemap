/**
 * Runs `fn` every `intervalMs`, never overlapping itself: the next run is
 * scheduled only after the previous one settles. Errors go to `onError`.
 */
export class SerialLoop {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<unknown> | unknown,
    private readonly onError: (name: string, err: unknown) => void,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Run now (or join the run in progress). */
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.fn();
      } catch (err) {
        this.onError(this.name, err);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Stop scheduling and wait for a run in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
