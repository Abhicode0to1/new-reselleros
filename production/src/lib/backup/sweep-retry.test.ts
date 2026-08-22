import { describe, it, expect, vi } from "vitest";
import {
  isRetryableSweepError,
  runSweepWithRetry,
  SWEEP_RETRY,
  type SweepAttempt,
} from "./sweep-retry";

/* ─────────────────────────────────────────────────────────────────────────────
   THE INCIDENT THIS FILE EXISTS FOR — measured, not imagined.

   Cloud Run log, 2026-08-20T18:30:05Z (= 21 Aug 00:00 IST):

       [cron/backup] sweep failed: JWT issued at future

   That was the whole night. `backup.snapshots` has automated rows labelled
   2026-08-17, -18, -19, -20 and -22 — and NOTHING for 2026-08-21. One night in
   six, gone, on a free plan with no PITR.

   Nothing retried it: the Cloud Scheduler job `resellersos-backup` carries a
   retryConfig with no `retryCount`, and in Cloud Scheduler that means zero
   retries — it waits for tomorrow. And nothing said a word, so the gap was found
   two days later by reading logs, not by anybody being told.

   A clock-skew rejection that fixes itself by the next night is transient by
   definition. So the sweep gets a bounded retry — and, more importantly, only
   for failures a second attempt could actually fix.
   ───────────────────────────────────────────────────────────────────────────── */

const OK: SweepAttempt = {
  ok: true,
  data: { label: "Automated Daily Backup - 2026-08-21", ok: 2, failed: 0, total_bytes: 789232, results: [] },
};

const fail = (message: string): SweepAttempt => ({ ok: false, message });

/** A sleep that records what it was asked to wait, and waits for none of it. */
function fakeSleep() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => { waited.push(ms); } };
}

describe("isRetryableSweepError", () => {
  it("retries the exact message that lost the night of 21 Aug 2026", () => {
    expect(isRetryableSweepError("JWT issued at future")).toBe(true);
  });

  it("retries the same skew whatever case or padding PostgREST uses", () => {
    expect(isRetryableSweepError("  JWT ISSUED AT FUTURE  ")).toBe(true);
  });

  it("retries a transport blip, which is the other thing a second attempt fixes", () => {
    for (const m of ["fetch failed", "socket hang up", "ECONNRESET", "read ETIMEDOUT", "502 Bad Gateway"]) {
      expect(isRetryableSweepError(m), m).toBe(true);
    }
  });

  it("retries a Postgres contention error, which is by definition momentary", () => {
    expect(isRetryableSweepError("deadlock detected")).toBe(true);
    expect(isRetryableSweepError("could not serialize access due to concurrent update")).toBe(true);
  });

  /* ── The half that matters more ───────────────────────────────────────────── */

  it("does NOT retry a missing grant — that is configuration, and three tries hide it", () => {
    expect(isRetryableSweepError("permission denied for function backup_all_tenants")).toBe(false);
  });

  it("does NOT retry a missing function — the migration is not applied and waiting will not apply it", () => {
    expect(isRetryableSweepError('function public.backup_all_tenants(text) does not exist')).toBe(false);
  });

  it("does NOT retry a bad or expired key, which looks like the skew error but is permanent", () => {
    /* Both mention JWT. Only one is worth another attempt, and lumping them together
       would turn a wrong SUPABASE_SERVICE_ROLE_KEY into a silent 15-second outage
       every night instead of an error somebody reads. */
    expect(isRetryableSweepError("JWT expired")).toBe(false);
    expect(isRetryableSweepError("invalid JWT: unable to parse or verify signature")).toBe(false);
  });

  it("does NOT retry a statement timeout, on purpose", () => {
    /* A backup sweep that runs out of time is outgrowing its window. That is a fact the
       owner needs to see, and retrying it three times both hides it and triples the load
       that caused it. */
    expect(isRetryableSweepError("canceling statement due to statement timeout")).toBe(false);
  });

  it("does NOT retry an error it has never seen — unknown means surface it", () => {
    /* Default-deny. An unrecognised failure retried is an alert delayed and nothing
       learned; an unrecognised failure surfaced is exactly what a human should get. */
    expect(isRetryableSweepError("column snapshots.tenant_id does not exist")).toBe(false);
    expect(isRetryableSweepError("something nobody has written down yet")).toBe(false);
    expect(isRetryableSweepError("")).toBe(false);
  });
});

describe("runSweepWithRetry", () => {
  it("turns the 21 Aug failure into a completed backup — the whole point", async () => {
    const { waited, sleep } = fakeSleep();
    const attempt = vi.fn<() => Promise<SweepAttempt>>()
      .mockResolvedValueOnce(fail("JWT issued at future"))
      .mockResolvedValueOnce(OK);

    const out = await runSweepWithRetry(attempt, { sleep });

    expect(out.result).toEqual(OK);
    expect(out.attemptsMade).toBe(2);
    expect(out.retriedBecause).toEqual(["JWT issued at future"]);
    expect(waited).toEqual([SWEEP_RETRY.backoffMs[0]]);
  });

  it("does not call the sweep twice when it succeeds first time", async () => {
    const attempt = vi.fn<() => Promise<SweepAttempt>>().mockResolvedValue(OK);
    const out = await runSweepWithRetry(attempt, { sleep: async () => {} });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.retriedBecause).toEqual([]);
  });

  it("stops at ONE attempt for a permanent error", async () => {
    const attempt = vi.fn<() => Promise<SweepAttempt>>().mockResolvedValue(fail("permission denied for function backup_all_tenants"));
    const out = await runSweepWithRetry(attempt, { sleep: async () => {} });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.attemptsMade).toBe(1);
    expect(out.result.ok).toBe(false);
  });

  it("gives up after the planned number of attempts and hands back the LAST error", async () => {
    const { waited, sleep } = fakeSleep();
    const attempt = vi.fn<() => Promise<SweepAttempt>>()
      .mockResolvedValueOnce(fail("JWT issued at future"))
      .mockResolvedValueOnce(fail("JWT issued at future"))
      .mockResolvedValueOnce(fail("fetch failed"));

    const out = await runSweepWithRetry(attempt, { sleep });

    expect(attempt).toHaveBeenCalledTimes(SWEEP_RETRY.attempts);
    expect(out.result).toEqual(fail("fetch failed"));
    expect(waited).toEqual(SWEEP_RETRY.backoffMs);
  });

  it("never sleeps after the final attempt", async () => {
    /* An extra sleep at the end buys nothing and eats the scheduler's deadline. */
    const { waited, sleep } = fakeSleep();
    await runSweepWithRetry(async () => fail("JWT issued at future"), { sleep });
    expect(waited).toHaveLength(SWEEP_RETRY.attempts - 1);
  });

  it("treats a thrown error as a failed attempt, not a crash", async () => {
    /* supabase-js rejects rather than resolving when the transport itself dies, and a
       cron that throws returns Cloud Run's own 500 with no log line of ours — so the
       throw has to be caught here or the failure arrives with no explanation at all. */
    const attempt = vi.fn<() => Promise<SweepAttempt>>()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(OK);

    const out = await runSweepWithRetry(attempt, { sleep: async () => {} });
    expect(out.result).toEqual(OK);
    expect(out.attemptsMade).toBe(2);
  });

  it("does not retry a thrown PERMANENT error either", async () => {
    const attempt = vi.fn<() => Promise<SweepAttempt>>().mockRejectedValue(new Error("permission denied for function backup_all_tenants"));
    const out = await runSweepWithRetry(attempt, { sleep: async () => {} });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.result).toEqual(fail("permission denied for function backup_all_tenants"));
  });

  it("keeps the whole retry budget well inside Cloud Scheduler's 540s attemptDeadline", async () => {
    /* Measured from the live job on 22 Aug 2026: attemptDeadline 540s. If the backoff ever
       grew past that, the scheduler would cut the request off mid-sweep and the log would
       show nothing at all — a worse failure than the one being fixed. */
    const total = SWEEP_RETRY.backoffMs.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(60_000);
    expect(SWEEP_RETRY.backoffMs).toHaveLength(SWEEP_RETRY.attempts - 1);
  });

  it("leaves a PARTIAL sweep alone — re-running it would evict real history", async () => {
    /* `result.failed > 0` is not an error path and must never reach this helper. The sweep
       already skips past a bad tenant, and `backup._take` keeps only the newest 30
       snapshots per tenant — so a second full sweep would write duplicate rows for the
       tenants that already succeeded and push genuine older restore points off the shelf. */
    const partial: SweepAttempt = {
      ok: true,
      data: { label: "L", ok: 2, failed: 1, total_bytes: 1, results: [{ tenant: "t", ok: false, error: "boom" }] },
    };
    const attempt = vi.fn<() => Promise<SweepAttempt>>().mockResolvedValue(partial);
    const out = await runSweepWithRetry(attempt, { sleep: async () => {} });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(out.result).toEqual(partial);
  });
});
