import { describe, it, expect } from "vitest";
import { reminderStepFor, dueReminders, renderReminder, REMINDER_LADDER } from "./reminders";
import type { ComplianceRow, Obligation } from "./obligations";

const ob = (key: string, extra: Partial<Obligation> = {}): Obligation => ({
  key, name: `${key} name`, authority: "GST Network", category: "gst", freq: "monthly",
  next: () => ({ dueDate: "2026-08-20", periodKey: "2026-07", periodLabel: "Jul 2026" }),
  ...extra,
});

const row = (
  key: string,
  daysToDue: number,
  status: ComplianceRow["status"] = "upcoming",
  extra: Partial<Obligation> = {},
): ComplianceRow => ({
  ob: ob(key, extra),
  inst: { dueDate: "2026-08-20", periodKey: "2026-07", periodLabel: "Jul 2026" },
  status, daysToDue, filedDate: status === "filed" ? "2026-08-01" : null,
});

const nothingSent = () => false;

describe("reminderStepFor — which rung is this on", () => {
  it("fires each rung at its exact day", () => {
    expect(reminderStepFor({ status: "upcoming", daysToDue: 15 })).toBe(15);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 7 })).toBe(7);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 3 })).toBe(3);
  });

  // ── Catch-up, not exact-day matching ─────────────────────────────────────
  it("still sends the T-15 rung on day 14 when the cron missed a day", () => {
    // Exact-day matching would drop this rung silently on any day the job did
    // not run, and nobody would know a reminder was owed.
    expect(reminderStepFor({ status: "upcoming", daysToDue: 14 })).toBe(15);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 8 })).toBe(15);
  });

  it("takes the MOST urgent rung reached, not the earliest", () => {
    // At 5 days out both 15 and 7 have been reached; 7 is the honest one to send.
    expect(reminderStepFor({ status: "due_soon", daysToDue: 5 })).toBe(7);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 1 })).toBe(3);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 0 })).toBe(3);
  });

  it("says nothing before the first rung", () => {
    expect(reminderStepFor({ status: "upcoming", daysToDue: 16 })).toBeNull();
    expect(reminderStepFor({ status: "upcoming", daysToDue: 200 })).toBeNull();
  });

  it("says nothing once filed", () => {
    // Chasing someone for a return they already filed is how a reminder system
    // gets muted.
    expect(reminderStepFor({ status: "filed", daysToDue: 3 })).toBeNull();
  });

  it("says nothing once overdue", () => {
    // A "reminder" for a passed deadline is a different message; the page
    // already shows it in red.
    expect(reminderStepFor({ status: "overdue", daysToDue: -1 })).toBeNull();
  });

  it("does not depend on the order the ladder is written in", () => {
    // The first version of this picked the first match in list order, which sent
    // the 15-day notice to someone who had 7 days left. Order-independence is now
    // the property, so a future edit to the ladder cannot silently reintroduce it.
    const shuffled = [...REMINDER_LADDER].sort((a, b) => a - b);
    expect(shuffled).toEqual([3, 7, 15]);
    expect(reminderStepFor({ status: "due_soon", daysToDue: 7 })).toBe(7);
  });
});

describe("dueReminders", () => {
  it("returns one reminder per eligible row, most urgent first", () => {
    const rows = [row("a", 15), row("b", 3), row("c", 7)];
    expect(dueReminders(rows, nothingSent).map((r) => r.obligationKey)).toEqual(["b", "c", "a"]);
  });

  it("skips a rung already sent for that period", () => {
    // Without this a daily cron re-sends the same T-7 notice four days running.
    const sent = (k: string, p: string, d: number) => k === "a" && p === "2026-07" && d === 7;
    expect(dueReminders([row("a", 6)], sent)).toEqual([]);
  });

  it("does NOT skip the next rung down just because an earlier one went", () => {
    // T-15 sent, now at 6 days: T-7 is a different, more urgent rung and is owed.
    const sent = (_k: string, _p: string, d: number) => d === 15;
    const out = dueReminders([row("a", 6)], sent);
    expect(out).toHaveLength(1);
    expect(out[0].daysBefore).toBe(7);
  });

  it("treats a different period as a different reminder", () => {
    // Last year's T-7 must not suppress this year's.
    const sent = (k: string, p: string) => k === "a" && p === "2025-07";
    expect(dueReminders([row("a", 5)], sent)).toHaveLength(1);
  });

  it("carries the fields the message needs", () => {
    const out = dueReminders([row("gst_r1", 3, "due_soon", {
      form: "GSTR-1", penalty: "₹50/day", dataHref: { href: "/accounting/gst", label: "Open GST Report" },
    })], nothingSent);
    expect(out[0]).toMatchObject({
      form: "GSTR-1", penalty: "₹50/day", periodLabel: "Jul 2026", dueDate: "2026-08-20",
    });
  });

  it("returns nothing when everything is filed or far out", () => {
    expect(dueReminders([row("a", 3, "filed"), row("b", 60)], nothingSent)).toEqual([]);
  });
});

describe("renderReminder", () => {
  const base = dueReminders([row("gst_r1", 3, "due_soon", {
    form: "GSTR-1", name: "GSTR-1 — outward supplies", penalty: "₹50/day, capped",
    dataHref: { href: "/accounting/gst", label: "Open GST Report" },
  })], nothingSent)[0];

  it("leads with what and when", () => {
    const m = renderReminder(base, "https://app.example.com");
    expect(m.subject).toBe("GSTR-1 due in 3 days — Jul 2026");
    expect(m.body).toContain("2026-08-20");
  });

  // ── The reason anyone opens this on a Sunday ──────────────────────────────
  it("states the penalty", () => {
    expect(renderReminder(base, "https://app.example.com").body).toContain("₹50/day, capped");
  });

  it("links to the numbers, because finding them is the actual work", () => {
    const body = renderReminder(base, "https://app.example.com").body;
    expect(body).toContain("https://app.example.com/accounting/gst");
    expect(body).toContain("Open GST Report");
  });

  it("links to /compliance so it can be marked filed and stop chasing", () => {
    expect(renderReminder(base, "https://app.example.com/").body).toContain("https://app.example.com/compliance");
  });

  it("carries the confirm-with-your-CA caveat — these dates shift", () => {
    expect(renderReminder(base, "https://x.dev").body).toContain("confirm");
  });

  it("reads naturally at 0 and 1 days", () => {
    expect(renderReminder({ ...base, daysToDue: 0 }, "https://x.dev").subject).toContain("due today");
    expect(renderReminder({ ...base, daysToDue: 1 }, "https://x.dev").subject).toContain("due tomorrow");
  });

  it("omits the data link cleanly when the obligation has none", () => {
    const noLink = { ...base, dataHref: undefined };
    const body = renderReminder(noLink, "https://x.dev").body;
    expect(body).not.toContain("undefined");
    expect(body).not.toContain("The numbers are here");
  });
});
