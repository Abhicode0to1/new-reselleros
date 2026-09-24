import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ status: "sent" })) }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: async () => ({ alert: { ok: false, reason: "test" }, tenant: null }) }));

import { startHostingTrial } from "./start-trial";

type Admin = Parameters<typeof startHostingTrial>[0];
const adminWith = (leadError: { code: string; message: string; details?: string } | null) =>
  ({ from: () => ({ insert: async () => ({ error: leadError }) }) }) as unknown as Admin;

const req = new NextRequest("https://example.invalid/api/public/checkout/cart", { method: "POST" });
const input = { fullName: "T Tester", companyName: "T Co", email: "t@example.invalid", phone: "9999999999", cycle: "monthly" as const };

describe("startHostingTrial — a missing buy-page tenant is a setup fault, not a retry", () => {
  it("24 Sep 2026: the FK on tenant_id no longer tells the customer to try again", async () => {
    const r = await startHostingTrial(
      adminWith({ code: "23503", message: 'insert or update on table "leads" violates foreign key constraint "leads_tenant_id_fkey"', details: "Key (tenant_id)=(x) is not present in table \"tenants\"." }),
      input, req, {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("on our side");
      expect(r.error).not.toMatch(/please try again/i);
    }
  });

  it("any other insert failure keeps the retry wording", async () => {
    const r = await startHostingTrial(adminWith({ code: "57014", message: "canceling statement due to statement timeout" }), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/please try again/i);
  });
});
