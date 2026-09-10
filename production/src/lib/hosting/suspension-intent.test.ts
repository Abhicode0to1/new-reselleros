import { describe, it, expect } from "vitest";
import { serverIntentFor, type HostingSuspensionStatus } from "./suspension-intent";

const NOW = new Date("2026-09-11T10:00:00.000Z");
const DUE = "2026-09-11T09:59:00.000Z";
const NOT_DUE = "2026-09-11T10:01:00.000Z";

const base = { nextActionAt: DUE, daUsername: "sitea", now: NOW };

describe("serverIntentFor — the two directions", () => {
  it("a suspended row means: tell the server to suspend", () => {
    expect(serverIntentFor({ ...base, status: "suspended" })).toEqual({ action: "suspend" });
  });

  it("an active row with work queued means: tell the server to restore", () => {
    expect(serverIntentFor({ ...base, status: "active" })).toEqual({ action: "restore" });
  });

  /* The whole reason this file exists. If these two ever swap, the job takes
     down every live site with a queued action. Asserted as a pair so a single
     inverted comparison cannot pass. */
  it("never confuses the two", () => {
    const s = serverIntentFor({ ...base, status: "suspended" });
    const a = serverIntentFor({ ...base, status: "active" });
    expect(s).not.toEqual(a);
    expect(s.action).toBe("suspend");
    expect(a.action).toBe("restore");
  });
});

describe("serverIntentFor — everything it refuses to send", () => {
  /* An explicit allow-list, not `suspended ? suspend : restore`. That shape
     would send RESTORE for all four of these — un-suspending an account that
     should be off, or one that was never created. */
  it.each<HostingSuspensionStatus>(["pending", "expired", "terminated", "failed"])(
    "sends nothing for a %s account",
    (status) => {
      const r = serverIntentFor({ ...base, status });
      expect(r.action).toBe("none");
      if (r.action === "none") expect(r.reason).toContain(status);
    },
  );

  it("sends nothing when nothing is queued", () => {
    const r = serverIntentFor({ ...base, status: "suspended", nextActionAt: null });
    expect(r.action).toBe("none");
    if (r.action === "none") expect(r.reason).toMatch(/agree/);
  });

  it("sends nothing before the due time", () => {
    const r = serverIntentFor({ ...base, status: "suspended", nextActionAt: NOT_DUE });
    expect(r.action).toBe("none");
    if (r.action === "none") expect(r.reason).toMatch(/not due/);
  });

  it("sends nothing without a DirectAdmin username", () => {
    const r = serverIntentFor({ ...base, status: "suspended", daUsername: null });
    expect(r.action).toBe("none");
    if (r.action === "none") expect(r.reason).toMatch(/username/);
  });

  /* A deleted row is not the server's business. Checked FIRST in the function,
     so a deleted-and-queued row cannot be acted on. */
  it("sends nothing for a deleted row, even one that is due", () => {
    const r = serverIntentFor({
      ...base,
      status: "suspended",
      deletedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(r.action).toBe("none");
    if (r.action === "none") expect(r.reason).toMatch(/deleted/);
  });

  it("a row due to the millisecond IS due", () => {
    /* An off-by-one here would leave an item stuck for one more cycle every
       time, which reads as "the job is slow" rather than "the comparison is
       wrong". */
    expect(
      serverIntentFor({ ...base, status: "suspended", nextActionAt: NOW.toISOString() }).action,
    ).toBe("suspend");
  });

  it("every refusal carries a reason a person can read", () => {
    const cases = [
      { status: "pending" as const, nextActionAt: DUE, daUsername: "x" },
      { status: "suspended" as const, nextActionAt: null, daUsername: "x" },
      { status: "suspended" as const, nextActionAt: NOT_DUE, daUsername: "x" },
      { status: "suspended" as const, nextActionAt: DUE, daUsername: null },
    ];
    for (const c of cases) {
      const r = serverIntentFor({ ...c, now: NOW });
      expect(r.action).toBe("none");
      if (r.action === "none") expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});
