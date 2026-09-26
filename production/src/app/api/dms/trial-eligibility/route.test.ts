/**
 * POST /api/dms/trial-eligibility (owner decision, 26 Sep 2026: "Ask ResellerOS instead").
 * Pinned: only DMS's key gets in; it asks the SAME checkTrialEligibility that startHostingTrial
 * uses; an unreadable history is 503, never "eligible"; bad input asks nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
const trial = vi.hoisted(() => ({ checkTrialEligibility: vi.fn() }));
vi.mock("@/lib/hosting/start-trial", () => trial);

import { POST } from "./route";

const KEY = "panel-key-0123456789abcdef";
const body = { email: "asha@example.invalid", phone: "9876543210", domain: "ashaco.in" };
const req = (b: unknown, key: string | null = KEY) =>
  new NextRequest("https://app.example.invalid/api/dms/trial-eligibility", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof b === "string" ? b : JSON.stringify(b),
  });

const ENV = { ...process.env };
beforeEach(() => {
  trial.checkTrialEligibility.mockReset().mockResolvedValue({ ok: true, eligible: true });
  process.env.DMS_PANEL_API_KEY = KEY;
});
afterEach(() => { process.env = { ...ENV }; });

describe("only DMS gets in", () => {
  it("wrong key → 401, no key configured → 503, nothing asked", async () => {
    expect((await POST(req(body, "wrong-key-0123456789abcdef"))).status).toBe(401);
    process.env.DMS_PANEL_API_KEY = "";
    expect((await POST(req(body))).status).toBe(503);
    expect(trial.checkTrialEligibility).not.toHaveBeenCalled();
  });
});

describe("the answer", () => {
  it("eligible → 200 { eligible: true }, asked with the customer's email, phone and domain", async () => {
    const res = await POST(req(body));
    expect(await res.json()).toEqual({ eligible: true });
    expect(trial.checkTrialEligibility.mock.calls[0][1]).toEqual({ email: "asha@example.invalid", phone: "9876543210", domain: "ashaco.in" });
  });
  it("an earlier trial → 200 { eligible: false, reason } in the customer's words", async () => {
    trial.checkTrialEligibility.mockResolvedValue({ ok: true, eligible: false, error: "You've already had a free hosting trial with us." });
    expect(await (await POST(req(body))).json()).toEqual({ eligible: false, reason: "You've already had a free hosting trial with us." });
  });
  it("an unreadable history → 503, never eligible", async () => {
    trial.checkTrialEligibility.mockResolvedValue({ ok: false, error: "We couldn't check whether you've had a trial before." });
    const res = await POST(req(body));
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("eligible");
  });
  it("bad input → 400, nothing asked", async () => {
    expect((await POST(req({ email: "not-an-email" }))).status).toBe(400);
    expect((await POST(req("{nope"))).status).toBe(400);
    expect(trial.checkTrialEligibility).not.toHaveBeenCalled();
  });
});

describe("one rule, not two", () => {
  it("startHostingTrial decides through checkTrialEligibility, so the panel's answer is checkout's answer", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "hosting", "start-trial.ts"), "utf8");
    const start = src.slice(src.indexOf("export async function startHostingTrial("));
    expect(start).toContain("await checkTrialEligibility(admin");
    // The old inline copy of the check must not come back inside startHostingTrial.
    expect(start).not.toContain('.eq("source", "buy-hosting-trial")');
  });
});
