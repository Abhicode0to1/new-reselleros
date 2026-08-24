import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Every path that emails a quote must also move the lead into "Quote Sent".

   Darshan's report, 24 Aug 2026: "Customer ko quotation sent kar di lekin Quote sent mein
   show nahi kar raha." The cause was one line in folders.ts — "Quote Sent" is a lead STAGE —
   and the fact that the ONLY place in the codebase which ever set `stage: "quote"` was the
   public buy-page checkout.

   This is the THIRD bug of the same shape in two days, which is why it gets a scan rather
   than only a unit test:

     L75  the auto-quote was wired to one webhook branch instead of two
     L97  the self-test flag reached two gates out of three
     this the stage rule existed at one of three send paths

   Every one of them had correct logic and incomplete wiring, and a unit test cannot see the
   difference. The scan can.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OPERATOR_SEND = strip(
  readFileSync(join(SRC, "app", "api", "quotes", "[id]", "send", "route.ts"), "utf8"),
);
const AUTO_SEND = strip(
  readFileSync(join(SRC, "lib", "quotes", "send-auto-quote.ts"), "utf8"),
);

describe("both send paths apply the stage rule", () => {
  it("the operator's Send button moves the lead", () => {
    expect(OPERATOR_SEND).toContain("stageAfterQuoteSent(");
  });

  it("the automatic send moves the lead too", () => {
    /* Wired in the same edit as the operator path, on purpose. Two of this week's bugs were
       a rule reaching some of its call sites and not the rest. */
    expect(AUTO_SEND).toContain("stageAfterQuoteSent(");
  });

  it("the operator route actually reads lead_id, or it could not move anything", () => {
    /* Part of why the bug lasted: this route never selected lead_id, so it had no idea which
       lead it was quoting for. A `stageAfterQuoteSent` call with nothing to apply it to would
       satisfy the assertion above and fix nothing. */
    expect(OPERATOR_SEND).toMatch(/public_token, lead_id/);
    expect(OPERATOR_SEND).toContain("quote.lead_id");
  });

  it("both scope the stage write to the tenant", () => {
    /* CLAUDE.md §4 — an app-layer check alone is not isolation, and these run on the ADMIN
       client, which bypasses RLS entirely. The explicit filter IS the boundary. */
    for (const [name, code] of [["operator", OPERATOR_SEND], ["auto", AUTO_SEND]] as const) {
      const block = code.slice(code.indexOf("stageAfterQuoteSent("));
      expect(block, name).toMatch(/from\("leads"\)[\s\S]{0,220}\.eq\("tenant_id"/);
    }
  });

  it("both check the error on the stage write", () => {
    /* Today's other lesson (L84): supabase-js does not throw, so an unchecked update reports
       success while the board stays wrong — which is the very symptom being fixed. */
    for (const [name, code] of [["operator", OPERATOR_SEND], ["auto", AUTO_SEND]] as const) {
      expect(code, name).toMatch(/const \{ error: stageErr \} = await/);
    }
  });
});

describe("the buy-page checkout is still the only place that sets the stage inline", () => {
  it("no NEW hardcoded stage:\"quote\" appeared instead of using the rule", () => {
    /* The checkout sets `stage: "quote"` at INSERT time, which is correct — it creates the
       lead and the quote together, so there is no prior stage to move forward from. What must
       not happen is somebody copying that literal into a send path instead of calling the
       rule, which would skip the Won/Lost guard entirely. */
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(SRC);

    const offenders = files.filter((f) => {
      const code = strip(readFileSync(f, "utf8"));
      if (!/stage:\s*"quote"/.test(code)) return false;
      /* The checkout is the one legitimate holder. */
      return !f.includes(join("public", "checkout"));
    });

    expect(offenders, `these hardcode stage:"quote" instead of calling stageAfterQuoteSent: ${offenders.join(", ")}`)
      .toEqual([]);
  });
});

describe("the builder — the third copy, folded in", () => {
  /* Found by the scan above on its very first run, which is the whole argument for having it.
     The builder sets the stage when a quote is created ALREADY sent, as opposed to saved as a
     draft and sent later (the route path). It wrote `stage: "quote"` flat, with no Won/Lost
     guard — so an upsell quote to a won customer pulled them back into the pipeline and
     restarted their stage age. One decision, three divergent copies, and the newest was the
     only one that was right. */

  const BUILDER = strip(
    readFileSync(join(SRC, "components", "features", "quotes", "quote-builder.tsx"), "utf8"),
  );

  it("calls the rule rather than writing the stage itself", () => {
    expect(BUILDER).toContain("stageAfterQuoteSent(");
  });

  it("omits the key entirely when the rule refuses, instead of writing null", () => {
    /* `stage: null` would be worse than the bug: the column is what folders.ts reads, and a
       nulled stage drops the lead out of EVERY board column at once. */
    expect(BUILDER).toMatch(/move\.nextStage !== null && \{ stage: move\.nextStage \}/);
  });

  it("passes the lead's CURRENT stage in, or the guard has nothing to guard", () => {
    /* stageAfterQuoteSent(undefined) returns null for everything — so a call that forgot its
       argument would satisfy the assertion above while silently never moving any lead again.
       That failure is invisible: no error, no log, just a column that stays empty. */
    expect(BUILDER).toMatch(/stageAfterQuoteSent\(leadFromQuery\?\.stage\)/);
  });
});
