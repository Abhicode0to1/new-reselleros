/**
 * POST /api/dms/start-trial (owner decision, 26 Sep 2026: the in-panel trial moves to
 * ResellerOS). Pinned: only DMS's key gets in; it starts the trial through the SAME
 * startHostingTrial the site uses; an earlier trial is a 409 carrying the reason; bad
 * input starts nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => ({}) }));
const trial = vi.hoisted(() => ({ startHostingTrial: vi.fn() }));
vi.mock("@/lib/hosting/start-trial", () => trial);

import { POST } from "./route";

const KEY = "panel-key-0123456789abcdef";
const body = { dmsUserId: "665f0c0ffee", fullName: "Asha Verma", email: "asha@example.invalid", phone: "9876543210", domain: "ashaco.in", cycle: "monthly" };
const req = (b: unknown, key: string | null = KEY) =>
  new NextRequest("https://app.example.invalid/api/dms/start-trial", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof b === "string" ? b : JSON.stringify(b),
  });

const ENV = { ...process.env };
beforeEach(() => {
  trial.startHostingTrial.mockReset().mockResolvedValue({ ok: true, leadId: "L-T1", trialEnds: "2026-10-11T00:00:00.000Z" });
  process.env.DMS_PANEL_API_KEY = KEY;
});
afterEach(() => { process.env = { ...ENV }; });

describe("only DMS gets in", () => {
  it("wrong key → 401, no key configured → 503, nothing started", async () => {
    expect((await POST(req(body, "wrong-key-0123456789abcdef"))).status).toBe(401);
    process.env.DMS_PANEL_API_KEY = "";
    expect((await POST(req(body))).status).toBe(503);
    expect(trial.startHostingTrial).not.toHaveBeenCalled();
  });
});

describe("the trial", () => {
  it("starts through the site's own startHostingTrial, with the customer's details and cycle", async () => {
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ success: true, leadId: "L-T1" });
    const [, input] = trial.startHostingTrial.mock.calls[0];
    expect(input).toMatchObject({ fullName: "Asha Verma", companyName: "Asha Verma", email: "asha@example.invalid", domain: "ashaco.in", cycle: "monthly" });
  });
  it("an earlier trial → 409 with the reason, so DMS can show it", async () => {
    trial.startHostingTrial.mockResolvedValue({ ok: false, error: "You have already had a free trial.", alreadyTrialled: true });
    const res = await POST(req(body));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "You have already had a free trial.", alreadyTrialled: true });
  });
  it("any other refusal → 500 with its message, never a quiet success", async () => {
    trial.startHostingTrial.mockResolvedValue({ ok: false, error: "We could not check your trial history just now." });
    const res = await POST(req(body));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/trial history/);
  });
  it("bad input → 400, nothing started", async () => {
    expect((await POST(req({ ...body, cycle: "weekly" }))).status).toBe(400);
    expect((await POST(req("{nope"))).status).toBe(400);
    expect(trial.startHostingTrial).not.toHaveBeenCalled();
  });
});
