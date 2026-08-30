import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Does the auto-quote actually run on BOTH webhook branches?

   This file exists because of a bug no other test could see. On 23 Aug 2026 a live
   self-test mail — "quotation for 50 Google Workspace Business Starter users on annual
   billing" — arrived from an address that already had an open lead. The webhook appended
   it (correctly), the extractor rewrote the lead (seats 20 → 50, plan Standard → Starter),
   and NO QUOTE WAS DRAFTED, because the quote block sat inside the CREATE branch alone.

   Every decision was individually right and covered: planQuoteFromEnquiry had 17
   assertions, decideAutoSend had 17, the extractor had 83. Not one of them looks at where
   the functions are CALLED. The auto-reply had been wired to both branches in the same
   sitting and the auto-quote to one, and the suite stayed green.

   So this is a source scan, like autonomy-chokepoint.test.ts, and for the same reason:
   the failure mode is a missing call site, which reads plainly in the source and not at
   all in a mock.
   ───────────────────────────────────────────────────────────────────────────── */

const WEBHOOK = readFileSync(
  join(process.cwd(), "src", "lib", "inbound", "ingest.ts"),
  "utf8",
);
const code = WEBHOOK.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Where the append branch ends — everything after is the create branch. */
const APPEND_END = code.indexOf('appendedToLead: existing.id');

describe("the auto-quote runs on both branches", () => {
  it("is called twice, not once", () => {
    const calls = code.match(/autoQuoteForLead\(admin, \{/g) ?? [];
    expect(calls.length, `autoQuoteForLead is called ${calls.length} time(s) — the 23 Aug bug was exactly one`).toBe(2);
  });

  it("is called on the APPEND branch — the one that was missing", () => {
    /* A reply from somebody already in conversation, naming a seat count and a plan, is the
       most quote-worthy mail this app receives. It was the branch that priced nothing. */
    expect(APPEND_END).toBeGreaterThan(0);
    const appendBranch = code.slice(0, APPEND_END);
    expect(appendBranch).toContain("autoQuoteForLead(admin, {");
  });

  it("is called on the CREATE branch too", () => {
    const createBranch = code.slice(APPEND_END);
    expect(createBranch).toContain("autoQuoteForLead(admin, {");
  });

  it("asks shouldRequoteOnReply on the append branch and NOT on create", () => {
    /* A brand-new lead has nothing to compare against, so the gate is meaningless there —
       and asking it would need a fake "latest quote" to answer. On append it is what stops a
       five-message thread about the same fifty seats minting five GST documents. */
    const appendBranch = code.slice(0, APPEND_END);
    const createBranch = code.slice(APPEND_END);
    expect(appendBranch).toContain("shouldRequoteOnReply(");
    expect(createBranch).not.toContain("shouldRequoteOnReply(");
  });
});

describe("the AI sales agent also runs on both branches", () => {
  /* This described `runAutoReply` until 24 Aug 2026. The webhook now calls
     `runSalesAgentForLead` instead — a SWAP, not an addition, because two drafters answering
     one customer means two replies. The assertion follows the step rather than the name, which
     is what this block's original comment asked for: "whatever the next automated step is, it
     gets a line here." */
  it("is called twice, not once", () => {
    const calls = code.match(/runSalesAgentForLead\(\{/g) ?? [];
    expect(calls.length, `runSalesAgentForLead is called ${calls.length} time(s) — both branches need it`).toBe(2);
  });

  it("has fully replaced the old auto-reply — no call site is left behind", () => {
    /* The failure this catches is the half-done swap: one branch on the agent, one still on
       runAutoReply, so a customer replying to an existing thread gets a different system than
       a new enquiry — and on `auto`, one of them gets two emails. */
    expect(code).not.toMatch(/runAutoReply\(\{/);
  });

  it("runs on the APPEND branch", () => {
    expect(code.slice(0, APPEND_END)).toContain("runSalesAgentForLead({");
  });

  it("runs on the CREATE branch", () => {
    expect(code.slice(APPEND_END)).toContain("runSalesAgentForLead({");
  });
});

describe("no second copy of the money arithmetic", () => {
  it("the webhook does not build a quote row itself any more", () => {
    /* 130 lines used to sit inline, including next_document_number and the quotes insert.
       Copying them into the append branch would have left two versions of money arithmetic
       to keep in step — which is how the two paths end up disagreeing by a rupee. */
    expect(code).not.toContain('p_doc_type: "quote"');
    expect(code).not.toMatch(/from\("quotes"\)\s*\.insert/);
  });

  it("the shared function is the only place that allocates a quote number", () => {
    const lib = readFileSync(
      join(process.cwd(), "src", "lib", "quotes", "auto-quote-for-lead.ts"),
      "utf8",
    );
    expect(lib).toContain('p_doc_type: "quote"');
  });
});
