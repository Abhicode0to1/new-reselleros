/**
 * The site's enquiry proxy tells the form the truth (30 Sep 2026): a refused or unreachable
 * upstream is `ok: false` with a message, and `ackSent` says whether the customer's copy was
 * really emailed — the trial form and quote builder say "check your inbox" only then.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const body = { fullName: "Asha Co", companyName: "Asha Co", email: "asha@example.invalid", phone: "9876543210", requirement: "x" };
const req = (b: Record<string, unknown>) =>
  new NextRequest("https://site.example.invalid/api/enquiry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const upstream = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

describe("/api/enquiry — honest answers for the site forms", () => {
  it("passes on that the customer's copy WAS emailed (general path)", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-1", ackSent: true }));
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ ok: true, ackSent: true });
  });

  it("and that it was NOT (general path)", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-1", ackSent: false }));
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, ackSent: false });
  });

  it("the Workspace path passes it on too", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, draftQuoteId: "Q-1", autoSent: false, ackSent: true }));
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, ackSent: true });
  });

  it("an upstream refusal is ok:false with a message — never a quiet success", async () => {
    fetchMock.mockResolvedValue(upstream(500, { error: "boom" }));
    const res = await POST(req(body));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/could not record your request.*nothing was saved/i) });
  });

  it("an unreachable upstream is ok:false too", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ ok: false });
  });
});
