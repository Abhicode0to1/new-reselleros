/**
 * The provision-hosting worker, since 24 Sep 2026 a sender of the DMS engine's
 * `hosting.provision` rather than a DirectAdmin client of its own.
 *
 * Pinned: it never calls DirectAdmin itself; it sends nothing while either
 * switch or the workspace's automation is off; and each engine answer becomes
 * the right queue state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prov = vi.hoisted(() => ({
  listReadyHostingRequests: vi.fn(),
  markProvisioningActivated: vi.fn(),
  markProvisioningFailed: vi.fn(),
  noteProvisioning: vi.fn(),
}));
vi.mock("@/lib/provisioning/provisioning.server", () => prov);
const engine = vi.hoisted(() => ({ sendEngineCommand: vi.fn(), commandsConfigured: vi.fn() }));
vi.mock("@/lib/dms-engine/commands", () => engine);
const autonomy = vi.hoisted(() => ({ loadAutonomyPolicy: vi.fn() }));
vi.mock("@/lib/ai/autonomy.server", () => autonomy);
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), loadOwnerAlert: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: mail.loadOwnerAlert }));

const tables = vi.hoisted(() => ({ quotes: null as unknown, leads: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (t: "quotes" | "leads") => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tables[t], error: null }) }) }) }),
    }),
  }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { GET } from "./route";

const row = { id: "R1", tenant_id: "T1", quote_id: "Q1", domain: "acme.in", plan: "hosting-standard" };
const req = () => new Request("https://example.invalid/api/cron/provision-hosting", { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };

beforeEach(() => {
  for (const f of [...Object.values(prov), ...Object.values(engine), autonomy.loadAutonomyPolicy, mail.sendEmail, mail.loadOwnerAlert]) f.mockReset();
  process.env.CRON_SECRET = "s3cret";
  process.env.HOSTING_PROVISIONING_LIVE = "1";
  engine.commandsConfigured.mockReturnValue(true);
  prov.listReadyHostingRequests.mockResolvedValue([row]);
  prov.noteProvisioning.mockResolvedValue(true);
  autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: false, modes: {} });
  mail.loadOwnerAlert.mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid" } });
  mail.sendEmail.mockResolvedValue({ status: "sent" });
  tables.quotes = { id: "Q1", lead_id: "L1", customer_name: "Acme", domain: null, line_items: [{ name: "Standard hosting (billed monthly)", hostingPlan: "standard", months: 1 }] };
  tables.leads = { contact_name: "Asha Verma", contact_email: "Asha@Example.invalid", contact_phone: "+91 98765 43210", company: "Acme" };
});
afterEach(() => { process.env = { ...ENV }; });

describe("this app no longer writes to DirectAdmin for a sale", () => {
  it("the worker imports no DirectAdmin client", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/cron/provision-hosting/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    expect(src).not.toMatch(/directadmin\/provision|daCreateAccount|genPassword/);
  });
});

describe("nothing is sent while anything is off", () => {
  it("switch off → no-op", async () => {
    process.env.HOSTING_PROVISIONING_LIVE = "true";
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/switched off/);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("kill switch → noted, nothing sent", async () => {
    autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: true, modes: {} });
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("no buyer email → held, nothing sent", async () => {
    tables.leads = { contact_name: "A" };
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/buyer's email/));
  });
});

describe("what it sends and does", () => {
  it("one live hosting.provision with the plan, months and the buyer", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { daUsername: "acmeiab12c" }, replayed: false });
    await GET(req());
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd).toMatchObject({ command: "hosting.provision", subject: "acme.in", mode: "live" });
    expect(cmd.commandId).toMatch(/^rsos-hostprov-R1-\d{4}-\d{2}-\d{2}$/);
    expect(cmd.payload).toMatchObject({
      planId: "standard",
      months: 1,
      customer: { firstName: "Asha", lastName: "Verma", email: "asha@example.invalid", phone: "9876543210", phoneCc: "91", companyName: "Acme" },
      paymentMode: "live",
      sourceRef: "Q1",
    });
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "acmeiab12c");
  });
  it("lost response → note + owner alert, not failed", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "needs_reconciliation", reason: "no answer" });
    await GET(req());
    expect(prov.markProvisioningFailed).not.toHaveBeenCalled();
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/needs checking/) }));
  });
  it("refused → failed + owner alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "domain exists" });
    await GET(req());
    expect(prov.markProvisioningFailed).toHaveBeenCalledWith("R1", expect.stringMatching(/refused/));
  });
  it("held → note, still queued", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "held", reason: "[held] test-mode" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", "Held: [held] test-mode");
    expect(prov.markProvisioningActivated).not.toHaveBeenCalled();
  });
});
