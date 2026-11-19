/** A running task that can be stopped from outside (a worker thread, say). */
export interface Cancellable<T> {
  done: Promise<T>;
  /** Stop the task; `done` must settle soon after. */
  cancel(): Promise<unknown> | void;
}

/**
 * Like Promise.all, but when one task fails the others are cancelled and
 * awaited before the first error is rethrown, so nothing keeps writing after
 * the caller has given up.
 */
export async function allOrCancel<T>(tasks: Cancellable<T>[]): Promise<T[]> {
  let firstError: unknown = null;
  let failed = false;
  const watched = tasks.map((t) =>
    t.done.catch(async (err: unknown) => {
      if (!failed) {
        failed = true;
        firstError = err;
        await Promise.allSettled(tasks.map((o) => (o === t ? undefined : o.cancel())));
      }
      throw err;
    }),
  );
  const results = await Promise.allSettled(watched);
  if (failed) throw firstError;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
