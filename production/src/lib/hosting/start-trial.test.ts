import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ status: "sent" })) }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: async () => ({ alert: { ok: false, reason: "test" }, tenant: null }) }));

const checkTrialHistory = vi.hoisted(() => vi.fn());
const recordTrialInDms = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dms-engine/trials", () => ({ checkTrialHistory, recordTrialInDms }));

import { startHostingTrial, likeEscape, quoteForOr } from "./start-trial";

type Admin = Parameters<typeof startHostingTrial>[0];

interface Fake {
  prior?: { id: string; created_at: string }[];
  priorError?: { message: string } | null;
  leadError?: { code: string; message: string; details?: string } | null;
}
const calls = { or: [] as string[], inserts: 0, leadUpdates: [] as Record<string, unknown>[] };

/** The two reads/writes startHostingTrial makes on `leads`: the history query, then the insert. */
const adminWith = (f: Fake) =>
  ({
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, order: () => q,
        update: (row: Record<string, unknown>) => { if (table === "leads") calls.leadUpdates.push(row); return q; },
        or: (s: string) => { calls.or.push(s); return q; },
        limit: async () => ({ data: f.prior ?? [], error: f.priorError ?? null }),
        // Only LEAD inserts are counted: a started trial also inserts its follow-up tasks.
        insert: async () => { if (table === "leads") calls.inserts += 1; return { error: table === "leads" ? f.leadError ?? null : null }; },
      };
      return q;
    },
  }) as unknown as Admin;

const req = new NextRequest("https://example.invalid/api/public/checkout/cart", { method: "POST" });
const input = { fullName: "T Tester", companyName: "T Co", email: "T@Example.invalid", phone: "+91 98765 43210", domain: "tco.in", cycle: "monthly" as const };

beforeEach(() => {
  calls.or = []; calls.inserts = 0; calls.leadUpdates = [];
  checkTrialHistory.mockReset().mockResolvedValue({ ok: true, trialled: false });
  recordTrialInDms.mockReset().mockResolvedValue({ ok: true });
});

describe("one free trial per customer (owner, 24 Sep 2026)", () => {
  it("an earlier trial on the same email, phone or domain refuses — and nothing is written", async () => {
    const r = await startHostingTrial(adminWith({ prior: [{ id: "L-OLD", created_at: "2026-09-01T00:00:00Z" }] }), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.alreadyTrialled).toBe(true);
      expect(r.error).toContain("one per customer");
      expect(r.error).toContain("Nothing was saved");
    }
    expect(calls.inserts).toBe(0);
  });

  it("matches on the lower-cased email, the last 10 phone digits and the domain", async () => {
    await startHostingTrial(adminWith({}), input, req, {});
    expect(calls.or[0]).toBe('contact_email.ilike."t@example.invalid",contact_phone.ilike."%9876543210",domain.eq."tco.in"');
  });

  it("no earlier trial → the trial starts", async () => {
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(true);
    expect(calls.inserts).toBe(1);
  });

  it("an unreadable history refuses rather than lets a second trial through", async () => {
    const r = await startHostingTrial(adminWith({ priorError: { message: "timeout" } }), input, req, {});
    expect(r.ok).toBe(false);
    expect(calls.inserts).toBe(0);
  });

  it("an email's _ or % cannot widen the match, and a comma cannot split the filter", () => {
    expect(likeEscape("a_b%c@x.in")).toBe("a\\_b\\%c@x.in");
    expect(quoteForOr('x,y"z')).toBe('"x,y\\"z"');
  });
});

describe("startHostingTrial — a missing buy-page tenant is a setup fault, not a retry", () => {
  it("the FK on tenant_id does not tell the customer to try again", async () => {
    const r = await startHostingTrial(
      adminWith({ leadError: { code: "23503", message: 'insert or update on table "leads" violates foreign key constraint "leads_tenant_id_fkey"', details: 'Key (tenant_id)=(x) is not present in table "tenants".' } }),
      input, req, {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("on our side");
      expect(r.error).not.toMatch(/please try again/i);
    }
  });

  it("any other insert failure keeps the retry wording", async () => {
    const r = await startHostingTrial(adminWith({ leadError: { code: "57014", message: "canceling statement due to statement timeout" } }), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/please try again/i);
  });
});

describe("one trial per customer across BOTH apps — DMS is the shared record", () => {
  it("a trial DMS knows of (its panel, or one recorded earlier) refuses, and nothing is written", async () => {
    checkTrialHistory.mockResolvedValueOnce({ ok: true, trialled: true, where: "dms", startedAt: "2026-09-10T00:00:00.000Z" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alreadyTrialled).toBe(true);
    expect(calls.inserts).toBe(0);
    expect(checkTrialHistory).toHaveBeenCalledWith({ email: "t@example.invalid", phone: "9876543210", domain: "tco.in" });
  });

  it("DMS not answering refuses the trial — never read as 'no earlier trial'", async () => {
    checkTrialHistory.mockResolvedValueOnce({ ok: false, reason: "DMS did not answer" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("couldn't check");
    expect(calls.inserts).toBe(0);
  });

  it("a started trial is recorded in DMS under its lead id", async () => {
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(true);
    expect(recordTrialInDms).toHaveBeenCalledWith(expect.objectContaining({ email: "t@example.invalid", domain: "tco.in", planId: "starter", cycle: "monthly" }));
    expect(calls.leadUpdates).toHaveLength(0);
  });

  it("if DMS cannot be told, the trial stands and the gap is written on the lead", async () => {
    recordTrialInDms.mockResolvedValueOnce({ ok: false, reason: "DMS answered HTTP 503" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(true);
    expect(String(calls.leadUpdates[0]?.notes)).toContain("NOT RECORDED IN DMS (DMS answered HTTP 503)");
  });
});
