/**
 * The register-domains worker (24 Sep 2026, owner decision 21).
 *
 * Pinned: it sends nothing while either switch is off or the workspace's
 * automation is off; it sends exactly one live command per ready row with a
 * stable, day-keyed id; and each engine answer becomes the right queue state —
 * done → activated, hold → note (still queued), lost response → note + owner
 * alert, refusal → failed + owner alert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const prov = vi.hoisted(() => ({
  listReadyDomainRequests: vi.fn(),
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

const quoteRow = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: quoteRow.value, error: null }) }) }) }) }),
  }),
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { GET } from "./route";

const registrant = { firstName: "A", lastName: "B", email: "a@example.invalid", phone: "9999999999", phoneCc: "91", address: { line1: "x", city: "y", state: "z", country: "IN", zipcode: "110001" } };
const row = { id: "R1", tenant_id: "T1", quote_id: "Q1", domain: "acme.in", amount_paid: 708, note: null };
const req = () => new Request("https://example.invalid/api/cron/register-domains", { headers: { authorization: "Bearer s3cret" } });

const ENV = { ...process.env };
beforeEach(() => {
  for (const f of [...Object.values(prov), ...Object.values(engine), autonomy.loadAutonomyPolicy, mail.sendEmail, mail.loadOwnerAlert]) f.mockReset();
  process.env.CRON_SECRET = "s3cret";
  process.env.DOMAIN_REGISTRATION_LIVE = "1";
  engine.commandsConfigured.mockReturnValue(true);
  prov.listReadyDomainRequests.mockResolvedValue([row]);
  prov.noteProvisioning.mockResolvedValue(true);
  autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: false, modes: {} });
  mail.loadOwnerAlert.mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid" } });
  mail.sendEmail.mockResolvedValue({ status: "sent" });
  quoteRow.value = { id: "Q1", line_items: [{ domain: "acme.in", registrant }] };
});
afterEach(() => { process.env = { ...ENV }; });

describe("nothing is sent while anything is switched off", () => {
  it("the paying side's switch off → no-op", async () => {
    process.env.DOMAIN_REGISTRATION_LIVE = "";
    const body = await (await GET(req())).json();
    expect(body.note).toMatch(/switched off/);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("no command key → 503, nothing sent", async () => {
    engine.commandsConfigured.mockReturnValue(false);
    expect((await GET(req())).status).toBe(503);
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
  });
  it("the workspace's automation kill switch → noted, nothing sent", async () => {
    autonomy.loadAutonomyPolicy.mockResolvedValue({ killSwitch: true, modes: {} });
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/automation is switched off/));
  });
  it("no registrant on the quote → held, nothing sent", async () => {
    quoteRow.value = { id: "Q1", line_items: [{ domain: "acme.in" }] };
    await GET(req());
    expect(engine.sendEngineCommand).not.toHaveBeenCalled();
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/no registrant details/));
  });
  it("unauthenticated → 401", async () => {
    expect((await GET(new Request("https://example.invalid/x"))).status).toBe(401);
  });
});

describe("what it sends", () => {
  it("one live domain.register, day-keyed id, the registrant and the pre-GST cover", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    await GET(req());
    expect(engine.sendEngineCommand).toHaveBeenCalledTimes(1);
    const cmd = engine.sendEngineCommand.mock.calls[0][0];
    expect(cmd).toMatchObject({ command: "domain.register", subject: "acme.in", mode: "live" });
    expect(cmd.commandId).toMatch(/^rsos-domreg-R1-\d{4}-\d{2}-\d{2}$/);
    expect(cmd.payload).toMatchObject({ years: 1, registrant, coverRupees: 600, paymentMode: "live", sourceRef: "Q1" });
  });
});

describe("what it does with the answer", () => {
  it("done → activated with the registrar's order id", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "done", result: { orderId: "RC-9" }, replayed: false });
    await GET(req());
    expect(prov.markProvisioningActivated).toHaveBeenCalledWith("R1", "RC-9");
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it("held → note, still queued, no alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "held", reason: "[held] daily limit" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", "Held: [held] daily limit");
    expect(prov.markProvisioningFailed).not.toHaveBeenCalled();
    expect(prov.markProvisioningActivated).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it("lost response → note + owner alert, NOT failed (it may have happened)", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "needs_reconciliation", reason: "no answer" });
    await GET(req());
    expect(prov.noteProvisioning).toHaveBeenCalledWith("R1", expect.stringMatching(/^RECONCILE:/));
    expect(prov.markProvisioningFailed).not.toHaveBeenCalled();
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/needs checking/) }));
  });
  it("refused → failed + owner alert", async () => {
    engine.sendEngineCommand.mockResolvedValue({ kind: "refused", reason: "invalid name" });
    await GET(req());
    expect(prov.markProvisioningFailed).toHaveBeenCalledWith("R1", expect.stringMatching(/refused/));
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/refused/) }));
  });
  it("the engine's own gate closed → stops the whole run", async () => {
    prov.listReadyDomainRequests.mockResolvedValue([row, { ...row, id: "R2" }]);
    engine.sendEngineCommand.mockResolvedValue({ kind: "gate_closed", reason: "ENGINE_DOMAIN_REGISTER_LIVE" });
    await GET(req());
    expect(engine.sendEngineCommand).toHaveBeenCalledTimes(1);
  });
});
