import { describe, it, expect, vi } from "vitest";
import {
  pickReminderTemplate, decideReminder, slotValues, renewalReminderKind, dunningReminderKind,
  reminderAction, parseParamMap, reminderTemplateProblem, STARTER_REMINDER_TEMPLATES,
  type ReminderTemplateRow, type ApprovedTemplate,
} from "./whatsapp-reminders";
import { paramCount } from "./whatsapp-broadcast";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => { throw new Error("no DB in unit tests"); } }));
vi.mock("@/lib/ai/autonomy.server", () => ({ loadAutonomyPolicy: async () => { throw new Error("no DB"); } }));
vi.mock("@/lib/whatsapp/client", () => ({ sendWhatsApp: async () => { throw new Error("real send must never run in tests"); } }));

import { createReminderSender, type ReminderDeps, type ReminderLogRow, type TenantReminderConfig } from "./whatsapp-reminders.server";
import { WhatsAppNotConfiguredError } from "@/lib/whatsapp/send-failure";

const ROW: ReminderTemplateRow = {
  kind: "invoice_overdue", template_name: "invoice_overdue_v1", language: "en",
  param_map: ["customer_name", "invoice_id", "amount"], enabled: true,
};
const APPROVED: ApprovedTemplate[] = [{ name: "invoice_overdue_v1", language: "en", status: "approved" }];

describe("template selection", () => {
  it("picks the mapped template only when Meta has approved the same name + language", () => {
    const r = pickReminderTemplate("invoice_overdue", [ROW], APPROVED);
    expect(r).toEqual({ ok: true, template: { name: "invoice_overdue_v1", language: "en", paramMap: ["customer_name", "invoice_id", "amount"] } });
  });
  it("a mapping with no approval sends nothing", () => {
    expect(pickReminderTemplate("invoice_overdue", [ROW], [])).toEqual({ ok: false, reason: "template_not_approved" });
    expect(pickReminderTemplate("invoice_overdue", [ROW], [{ ...APPROVED[0], status: "submitted" }]))
      .toEqual({ ok: false, reason: "template_not_approved" });
    // approved in a different language is a different template
    expect(pickReminderTemplate("invoice_overdue", [ROW], [{ ...APPROVED[0], language: "hi" }]))
      .toEqual({ ok: false, reason: "template_not_approved" });
  });
  it("no row for the kind, or row switched off", () => {
    expect(pickReminderTemplate("invoice_due", [ROW], APPROVED)).toEqual({ ok: false, reason: "no_template" });
    expect(pickReminderTemplate("invoice_overdue", [{ ...ROW, enabled: false }], APPROVED)).toEqual({ ok: false, reason: "template_disabled" });
  });
  it("an unknown field in param_map is refused, not sent as a blank", () => {
    expect(parseParamMap(["customer_name", "gstin"])).toBeNull();
    expect(pickReminderTemplate("invoice_overdue", [{ ...ROW, param_map: ["lol"] }], APPROVED)).toEqual({ ok: false, reason: "bad_param_map" });
  });
  it("maps the existing ladders onto kinds", () => {
    expect(renewalReminderKind("early")).toBe("renewal_upcoming");
    expect(renewalReminderKind("urgent")).toBe("renewal_upcoming");
    expect(renewalReminderKind("final")).toBe("renewal_final");
    expect(renewalReminderKind("grace")).toBe("renewal_grace");
    expect(dunningReminderKind("pre_due")).toBe("invoice_due");
    expect(dunningReminderKind("due_today")).toBe("invoice_due");
    expect(dunningReminderKind("retry")).toBe("invoice_overdue");
    expect(dunningReminderKind("final")).toBe("invoice_final");
    expect(reminderAction("renewal_grace")).toBe("renewal.send");
    expect(reminderAction("invoice_due")).toBe("dunning.send");
  });
  it("starter templates are internally consistent", () => {
    for (const t of STARTER_REMINDER_TEMPLATES) {
      expect(reminderTemplateProblem(t.name, t.body, t.param_map), t.name).toBeNull();
      expect(paramCount(t.body)).toBe(t.param_map.length);
    }
  });
});

describe("slot values", () => {
  it("a money slot with no value blocks the send instead of printing a fallback", () => {
    expect(slotValues(["customer_name", "amount"], { customer_name: "Asha" })).toEqual({ ok: false, missing: "amount" });
  });
  it("text slots fall back so Meta never gets an empty parameter", () => {
    expect(slotValues(["customer_name", "link", "amount"], { customer_name: " ", amount: "₹1,200" }))
      .toEqual({ ok: true, values: ["Customer", "reply to this message", "₹1,200"] });
  });
});

describe("the gate", () => {
  const ok = pickReminderTemplate("invoice_overdue", [ROW], APPROVED);
  const g = { enabled: true, automationAllows: true, pick: ok, phone: "+919800000001", optedOut: false, alreadySent: false };
  it("sends when every lock is open", () => {
    expect(decideReminder(g).send).toBe(true);
  });
  it("default off: disabled wins over everything and is not logged", () => {
    expect(decideReminder({ ...g, enabled: false })).toEqual({ send: false, reason: "disabled", log: false });
  });
  it("opt-out skips and is logged", () => {
    expect(decideReminder({ ...g, optedOut: true })).toEqual({ send: false, reason: "opted_out", log: true });
  });
  it("kill switch, no phone, already sent", () => {
    expect(decideReminder({ ...g, automationAllows: false })).toMatchObject({ send: false, reason: "automation_off" });
    expect(decideReminder({ ...g, phone: null })).toMatchObject({ send: false, reason: "no_phone" });
    expect(decideReminder({ ...g, alreadySent: true })).toMatchObject({ send: false, reason: "already_sent", log: false });
  });
});

/* ─── The sender, with a fake store: proves the wiring, not just the rule ─── */

function harness(cfg: Partial<TenantReminderConfig> & { optOut?: string[]; sent?: boolean; sendThrows?: Error } = {}) {
  const logs: ReminderLogRow[] = [];
  const send = vi.fn(async () => {
    if (cfg.sendThrows) throw cfg.sendThrows;
    return { wamid: "wamid.X" };
  });
  const loadConfig = vi.fn(async (): Promise<TenantReminderConfig> => ({
    enabled: cfg.enabled ?? false, templates: cfg.templates ?? [ROW], approved: cfg.approved ?? APPROVED,
  }));
  const deps: ReminderDeps = {
    store: {
      loadConfig,
      resolvePhone: async () => "+919800000001",
      isOptedOut: async (_t, p) => (cfg.optOut ?? []).includes(p),
      alreadySent: async () => cfg.sent ?? false,
      insertLog: async (r) => { logs.push(r); },
    },
    automationAllows: async () => true,
    send,
    now: () => new Date("2026-09-28T04:00:00Z"),
  };
  return { sender: createReminderSender(deps), send, logs, loadConfig };
}

const REQ = {
  tenantId: "t1", kind: "invoice_overdue" as const, subjectType: "invoice" as const, subjectId: "INV-1",
  step: "reminder", customerId: "c1", values: { customer_name: "Asha", invoice_id: "INV-1", amount: "₹1,200" },
};

describe("createReminderSender", () => {
  it("DEFAULT OFF — a tenant with no switch sends nothing and writes nothing", async () => {
    const h = harness(); // enabled defaults to false
    const out = await h.sender.send(REQ);
    expect(out).toEqual({ status: "skipped", reason: "disabled" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(0);
    expect(h.sender.totals.disabled).toBe(1);
  });

  it("reads each tenant's config once per run", async () => {
    const h = harness();
    await h.sender.send(REQ); await h.sender.send({ ...REQ, subjectId: "INV-2" });
    expect(h.loadConfig).toHaveBeenCalledTimes(1);
  });

  it("an unreadable config is treated as OFF", async () => {
    const h = harness({ enabled: true });
    h.loadConfig.mockRejectedValueOnce(new Error("db down"));
    expect(await h.sender.send(REQ)).toEqual({ status: "skipped", reason: "disabled" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("opted-out number: no send, one skipped log row", async () => {
    const h = harness({ enabled: true, optOut: ["+919800000001"] });
    expect(await h.sender.send(REQ)).toEqual({ status: "skipped", reason: "opted_out" });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.logs).toEqual([expect.objectContaining({ status: "skipped", skip_reason: "opted_out", subject_id: "INV-1" })]);
  });

  it("enabled + approved: sends the template with the slots in order and logs sent", async () => {
    const h = harness({ enabled: true });
    const out = await h.sender.send(REQ);
    expect(out).toEqual({ status: "sent", wamid: "wamid.X" });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", to: "+919800000001",
      message: {
        kind: "template", name: "invoice_overdue_v1", language: "en",
        components: [{ type: "body", parameters: [{ type: "text", text: "Asha" }, { type: "text", text: "INV-1" }, { type: "text", text: "₹1,200" }] }],
      },
    }));
    expect(h.logs).toEqual([expect.objectContaining({ status: "sent", wamid: "wamid.X", template_name: "invoice_overdue_v1", step: "reminder" })]);
  });

  it("already sent for this step: nothing", async () => {
    const h = harness({ enabled: true, sent: true });
    expect(await h.sender.send(REQ)).toEqual({ status: "skipped", reason: "already_sent" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a failed send is logged as failed and NEVER throws into the cron", async () => {
    const h = harness({ enabled: true, sendThrows: new Error("WhatsApp send failed: 131026") });
    const out = await h.sender.send(REQ);
    expect(out.status).toBe("failed");
    expect(h.logs[0]).toMatchObject({ status: "failed", error_message: "WhatsApp send failed: 131026" });
    expect(h.sender.totals.failed).toBe(1);
  });

  it("no WhatsApp credentials is a skip, not a failure", async () => {
    const h = harness({ enabled: true, sendThrows: new WhatsAppNotConfiguredError("not configured") });
    expect(await h.sender.send(REQ)).toEqual({ status: "skipped", reason: "not_configured" });
  });

  it("even a broken log write does not throw", async () => {
    const send = vi.fn(async () => ({ wamid: null }));
    const s = createReminderSender({
      store: {
        loadConfig: async () => ({ enabled: true, templates: [ROW], approved: APPROVED }),
        resolvePhone: async () => "+919800000001", isOptedOut: async () => true,
        alreadySent: async () => false, insertLog: async () => { throw new Error("insert failed"); },
      },
      automationAllows: async () => true, send, now: () => new Date(),
    });
    await expect(s.send(REQ)).resolves.toMatchObject({ status: "failed" });
  });
});
