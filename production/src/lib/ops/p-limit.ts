/**
 * Bounded concurrency for crons — a tiny p-limit, no dependency (S22, 28 Sep 2026).
 *
 * WHY: the renewals cron handled subscriptions strictly one after another — PDF render,
 * email send, several round trips — at 1–3s a row. Cloud Scheduler gives the request
 * 540s, so a long day ran out of time and the retry started from the top. Fully
 * parallel is the opposite mistake: fifty PDFs and fifty SMTP calls at once on one
 * Cloud Run instance. N at a time is the middle.
 *
 * Contract:
 *   - at most `limit` tasks run at once; the rest wait their turn in order;
 *   - results come back in INPUT order, whatever order they finish in;
 *   - one task rejecting does not stop the others — callers here catch per row, and
 *     a helper that aborted the batch would turn one bad subscription into none sent.
 *     If a task does reject, mapLimit rejects after every task has settled.
 */

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function pLimit(limit: number): Limiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`pLimit: limit must be a positive integer, got ${limit}`);
  }
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) run();
  };

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        /* Promise.resolve().then(task) so a task that THROWS synchronously is a
           rejection like any other, not an escape that leaks the slot. */
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** Split into runs of at most `size` — for `.in()` prefetches that must stay bounded. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk: size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Distinct values, first-seen order. */
export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Map over items with at most `limit` in flight. Results are in input order. */
export async function mapLimit<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const run = pLimit(limit);
  const settled = await Promise.allSettled(items.map((item, i) => run(() => fn(item, i))));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<O>).value);
}
