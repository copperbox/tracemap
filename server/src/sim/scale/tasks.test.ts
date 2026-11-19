import { describe, expect, it } from 'vitest';
import { allOrCancel, type Cancellable } from './tasks.js';

/** A task that runs until it finishes after `ms`, fails, or is cancelled. */
function task(ms: number, fail = false) {
  const log = { cancelled: false, settled: false };
  let stop: () => void = () => {};
  const done = new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => (fail ? reject(new Error(`failed after ${ms}`)) : resolve(ms)), ms);
    stop = () => {
      clearTimeout(t);
      // Like a terminated worker: settles a little later, as a failure.
      setTimeout(() => reject(new Error('terminated')), 5);
    };
  }).finally(() => (log.settled = true));
  const c: Cancellable<number> = {
    done,
    cancel: () => {
      log.cancelled = true;
      stop();
    },
  };
  return { c, log };
}

describe('allOrCancel', () => {
  it('returns every result in order when all succeed', async () => {
    await expect(allOrCancel([task(20).c, task(5).c, task(10).c])).resolves.toEqual([20, 5, 10]);
  });

  it('cancels and awaits the others when one fails, then rethrows its error', async () => {
    const a = task(10_000);
    const b = task(10, true);
    const c = task(10_000);
    const started = Date.now();
    await expect(allOrCancel([a.c, b.c, c.c])).rejects.toThrow('failed after 10');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(a.log.cancelled && c.log.cancelled).toBe(true);
    expect(b.log.cancelled).toBe(false);
    // Nothing is still running when the error reaches the caller.
    expect(a.log.settled && c.log.settled).toBe(true);
  });

  it('does not cancel twice when several fail', async () => {
    const a = task(10, true);
    const b = task(12, true);
    let cancels = 0;
    const counted = (t: ReturnType<typeof task>) => ({ done: t.c.done, cancel: () => (cancels++, t.c.cancel()) });
    await expect(allOrCancel([counted(a), counted(b)])).rejects.toThrow('failed after 10');
    expect(cancels).toBe(1);
  });
});
