import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* S28 — the sender is only as good as where it is called. Source scan, because the question
   is WIRING: does each cron call it, only on a real (non-dry) pass, and — for dunning —
   outside the try block whose catch would log the EMAIL step as failed and re-send it. */

const read = (p: string) =>
  readFileSync(join(process.cwd(), "src", p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("WhatsApp reminders are wired into both crons", () => {
  it("invoice-dunning: after the dry-run exit, after the email try/catch", () => {
    const src = read("app/api/cron/invoice-dunning/route.ts");
    const dry = src.indexOf("if (dryRun) continue;");
    const catchLog = src.indexOf('status: "failed", error_message: message.slice(0, 500)');
    const send = src.indexOf("await wa.send(");
    expect(src).toContain("createReminderSender()");
    expect(dry).toBeGreaterThan(0);
    expect(catchLog).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(dry);
    expect(send).toBeGreaterThan(catchLog);
    expect(src).toContain('subjectType: "invoice"');
  });

  it("renewals: never on the dry run, and before the no-email skip", () => {
    const src = read("app/api/cron/renewals/route.ts");
    const dry = src.indexOf("if (isDry) return");
    const send = src.indexOf("await wa.send(");
    const noEmail = src.indexOf("if (!recipient) {");
    expect(dry).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(dry);
    expect(send).toBeLessThan(noEmail);
    expect(src).toContain('subjectType: "subscription"');
    // planOnly (the dry run) must not send anything
    expect(src.slice(src.indexOf("async function planOnly("))).not.toContain("wa.send(");
  });

  it("the webhook still records STOP into the opt-out list the sender reads", () => {
    const hook = read("app/api/webhooks/whatsapp/route.ts");
    expect(hook).toContain('.from("whatsapp_opt_outs")');
    expect(read("lib/marketing/whatsapp-reminders.server.ts")).toContain('.from("whatsapp_opt_outs")');
  });
});
