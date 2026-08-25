import { describe, it, expect } from "vitest";
import {
  AGREEMENT_SLOTS,
  CLAUSES_WE_DO_NOT_WRITE,
  decideSignatureRequest,
  fillTemplate,
  verifyOnlySlotsChanged,
  type SlotValues,
} from "./agreement";
import { AI_ACTIONS } from "@/lib/ai/autonomy";

/** A stand-in for what a lawyer would supply: fixed prose, blanks for facts. */
const TEMPLATE = [
  "MASTER SERVICES AGREEMENT",
  "",
  "This Agreement is made on {{AGREEMENT_DATE}} between {{SELLER_LEGAL_NAME}}, GSTIN",
  "{{SELLER_GSTIN}}, of {{SELLER_ADDRESS}} (the Supplier), and {{CUSTOMER_LEGAL_NAME}}, GSTIN",
  "{{CUSTOMER_GSTIN}}, of {{CUSTOMER_ADDRESS}} (the Customer).",
  "",
  "1. SERVICES. The Supplier shall supply {{SEAT_COUNT}} subscriptions to {{PRODUCT_NAME}} at",
  "Rs {{RATE_PER_SEAT_PER_YEAR}} per seat per year, billed {{BILLING_TERM}}, for a term of",
  "{{TERM_MONTHS}} months, as set out in quotation {{QUOTE_REFERENCE}}.",
  "",
  "2. GOVERNING LAW. [To be completed by counsel.]",
].join("\n");

const VALUES: SlotValues = {
  AGREEMENT_DATE: "25 Aug 2026",
  SELLER_LEGAL_NAME: "ANUTECH DIGITAL PVT LTD",
  SELLER_GSTIN: "07ABDCA0298H1ZP",
  SELLER_ADDRESS: "New Delhi",
  CUSTOMER_LEGAL_NAME: "Sharma Traders Private Limited",
  CUSTOMER_GSTIN: "07AABCS1429B1ZX",
  CUSTOMER_ADDRESS: "Karol Bagh, New Delhi",
  SEAT_COUNT: "30",
  PRODUCT_NAME: "Google Workspace Business Starter",
  RATE_PER_SEAT_PER_YEAR: "3,240",
  BILLING_TERM: "annually",
  TERM_MONTHS: "12",
  QUOTE_REFERENCE: "Q-ADPL-2026-27-0004",
};

/* ══ THE CLAUSES THIS WILL NOT WRITE ═════════════════════════════════════════ */

describe("what the brief asked for and this module refuses to generate", () => {
  const all = CLAUSES_WE_DO_NOT_WRITE.join(" | ");

  it("refuses an uptime commitment, with the arithmetic attached", () => {
    /* ─── MEASURED ON THE LIVE CATALOGUE, NOT ASSERTED ────────────────────────
       30-seat Business Starter: the customer pays Rs 8,100/month, our margin is Rs 4,800. Applying
       Google's own service-credit schedule to OUR invoice, a sub-95% month at 50% credit is
       Rs 4,050 — 84% of that month's margin — for downtime we neither cause nor control. And
       TASKS.md:1564 records the Google reseller agreement as NOT approved, so today the credit
       would be owed with nothing to claim back upstream. */
    expect(all).toContain("An uptime or availability commitment");
    expect(all).toContain("Rs 4,050 against a margin of");
    expect(all).toContain("nothing to claim back");
  });

  it("refuses liability, indemnity and caps", () => {
    expect(all).toContain("A limitation of liability, an indemnity, or a cap");
    expect(all).toContain("not a software default");
  });

  it("refuses termination, data protection and jurisdiction", () => {
    expect(all).toContain("A termination, notice or renewal clause");
    expect(all).toContain("DPDP Act 2023");
    expect(all).toContain("governing-law or jurisdiction clause");
  });

  it("keeps the slot list to FACTS, with no legal term among them", () => {
    /* The closed list IS the boundary. An open Record<string,string> would let a caller invent a
       slot called LIABILITY_CAP and fill it from anywhere, which is the door this shuts. */
    for (const slot of AGREEMENT_SLOTS) {
      expect(slot).not.toMatch(/LIABILIT|INDEMN|WARRANT|JURISDICT|UPTIME|SLA|CAP$|PENALT|CREDIT/);
    }
    expect(AGREEMENT_SLOTS.length).toBeLessThan(20);
  });

  it("refuses a template that asks for a legal term", () => {
    const bad = "The Supplier's liability shall not exceed {{LIABILITY_CAP}}.";
    const r = fillTemplate(bad, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("not a fact this application holds");
      expect(r.reason).toContain("belongs in the lawyer's text");
    }
  });
});

/* ══ A half-filled contract is worse than none ═══════════════════════════════ */

describe("fillTemplate fails closed", () => {
  it("fills every slot when every fact is present", () => {
    const r = fillTemplate(TEMPLATE, VALUES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toContain("{{");
      expect(r.text).toContain("ANUTECH DIGITAL PVT LTD");
      expect(r.text).toContain("Q-ADPL-2026-27-0004");
      expect(r.filled.length).toBe(13);
    }
  });

  it("REFUSES rather than leaving a blank in a contract", () => {
    /* A signed agreement still reading "{{CUSTOMER_GSTIN}}" has an arguable term and an
       unidentified party. A quotation with a gap gets corrected; a contract with a gap gets
       litigated. */
    const { CUSTOMER_GSTIN: _omitted, ...rest } = VALUES;
    const r = fillTemplate(TEMPLATE, rest);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toEqual(["CUSTOMER_GSTIN"]);
      expect(r.reason).toContain("possibly an unidentified party");
    }
  });

  it("treats an empty or whitespace value as missing", () => {
    for (const bad of ["", "   "]) {
      const r = fillTemplate(TEMPLATE, { ...VALUES, SEAT_COUNT: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.missing).toContain("SEAT_COUNT");
    }
  });

  it("REFUSES a value the template has no place for", () => {
    /* Silently dropping it is not a tidiness problem on a contract — a seat count nobody
       notices is missing is the one that ends up disputed. */
    const noSeats = TEMPLATE.replace("{{SEAT_COUNT}} subscriptions", "the subscriptions");
    const r = fillTemplate(noSeats, VALUES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain("SEAT_COUNT");
      expect(r.reason).toContain("would be silently dropped");
    }
  });

  it("lists every missing slot at once rather than one per attempt", () => {
    const r = fillTemplate(TEMPLATE, { AGREEMENT_DATE: "25 Aug 2026" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing.length).toBeGreaterThan(5);
  });

  it("does not treat a single brace in legal prose as a slot", () => {
    const prose = "The parties agree {as set out below} on {{AGREEMENT_DATE}}.";
    const r = fillTemplate(prose, { AGREEMENT_DATE: "25 Aug 2026" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("{as set out below}");
  });

  it("handles an empty template without pretending it succeeded usefully", () => {
    const r = fillTemplate("", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("");
  });
});

/* ══ Proving nothing but facts changed ═══════════════════════════════════════ */

describe("verifyOnlySlotsChanged", () => {
  it("passes when the rendered text is the template plus facts", () => {
    /* "The AI did not invent a clause" is a hope when a document is generated and a FACT when it
       is a substitution. Reversing the substitution must reproduce the template exactly. */
    const r = fillTemplate(TEMPLATE, VALUES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(verifyOnlySlotsChanged({ template: TEMPLATE, rendered: r.text, values: VALUES }).clean).toBe(true);
  });

  it("CATCHES a clause inserted after the fill", () => {
    const r = fillTemplate(TEMPLATE, VALUES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tampered = r.text.replace(
      "2. GOVERNING LAW.",
      "2. AVAILABILITY. The Supplier guarantees 99.9% monthly uptime.\n\n3. GOVERNING LAW.",
    );
    const check = verifyOnlySlotsChanged({ template: TEMPLATE, rendered: tampered, values: VALUES });
    expect(check.clean).toBe(false);
    expect(check.reason).toContain("Something other than a fact has changed");
    expect(check.reason).toContain("not a document to send on trust");
  });

  it("CATCHES a deleted clause too", () => {
    const r = fillTemplate(TEMPLATE, VALUES);
    if (!r.ok) return;
    const gutted = r.text.replace("2. GOVERNING LAW. [To be completed by counsel.]", "");
    expect(verifyOnlySlotsChanged({ template: TEMPLATE, rendered: gutted, values: VALUES }).clean).toBe(false);
  });

  it("reverses the LONGEST values first, so an overlapping number cannot corrupt it", () => {
    /* SEAT_COUNT "30" is a substring of TERM_MONTHS "300". Replacing the short one first would
       turn "300" into "{{SEAT_COUNT}}0" and the check would report tampering on a clean
       document — a false alarm on a contract is how a real one gets ignored. */
    const values: SlotValues = { ...VALUES, SEAT_COUNT: "30", TERM_MONTHS: "300" };
    const r = fillTemplate(TEMPLATE, values);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(verifyOnlySlotsChanged({ template: TEMPLATE, rendered: r.text, values }).clean).toBe(true);
  });

  it("catches a change in whitespace, and refuses rather than judging it harmless", () => {
    /* A reflowed paragraph is almost certainly innocent, and this check cannot tell it apart
       from an inserted clause. So it refuses and a person looks. */
    const r = fillTemplate(TEMPLATE, VALUES);
    if (!r.ok) return;
    expect(
      verifyOnlySlotsChanged({ template: TEMPLATE, rendered: `${r.text}\n`, values: VALUES }).clean,
    ).toBe(false);
  });
});

/* ══ The signature request ══════════════════════════════════════════════════ */

describe("decideSignatureRequest", () => {
  const ready = {
    mode: "hold" as const,
    providerConfigured: true,
    provider: "digio" as const,
    reviewedByPerson: true,
    matchesTemplate: true,
  };

  it("refuses when the document does not match the template", () => {
    /* Checked FIRST: a document that is not the one anybody approved should not even reach the
       question of who may send it. */
    const d = decideSignatureRequest({ ...ready, matchesTemplate: false });
    expect(d.send).toBe(false);
    expect(d.reason).toContain("not the document anybody approved");
  });

  it("refuses when no licensed provider is configured — which is today", () => {
    /* Aadhaar eSign is not a link you can mint. Under the IT Act 2000 s.3A and its Second
       Schedule it runs through an eSign Service Provider licensed by the CCA, against a
       contract, with UIDAI authentication of the signer. Having heard of Digio is not the same
       as having an agreement with it, and nothing in this repo integrates one. */
    const d = decideSignatureRequest({ ...ready, providerConfigured: false, provider: null });
    expect(d.send).toBe(false);
    expect(d.reason).toContain("licensed by the CCA under the IT Act");
    expect(d.reason).toContain("collect a signature the usual way");
  });

  it("refuses when the dial is off", () => {
    const d = decideSignatureRequest({ ...ready, mode: "off" });
    expect(d.send).toBe(false);
    expect(d.reason).toContain("switched off for this workspace");
  });

  it("refuses an unread agreement AT EVERY DIAL SETTING", () => {
    /* The check that is deliberately not a config. The dial answers "may we act unattended";
       reading a contract before sending it is not a preference. Nobody can un-sign it. */
    for (const mode of ["hold", "auto"] as const) {
      const d = decideSignatureRequest({ ...ready, mode, reviewedByPerson: false });
      expect(d.send, `mode ${mode} sent an unread contract`).toBe(false);
      expect(d.reason).toContain("will not send unread at any dial setting");
    }
  });

  it("allows it only with everything in place", () => {
    expect(decideSignatureRequest(ready).send).toBe(true);
  });

  it("is refused by every combination that is missing something", () => {
    /* Exhaustive over the four booleans and the three modes — 48 combinations, and the only
       sendable ones are those with all four conditions met and the dial not off. */
    let sendable = 0;
    for (const mode of ["off", "hold", "auto"] as const) {
      for (const providerConfigured of [true, false]) {
        for (const reviewedByPerson of [true, false]) {
          for (const matchesTemplate of [true, false]) {
            const d = decideSignatureRequest({
              mode,
              providerConfigured,
              provider: providerConfigured ? "digio" : null,
              reviewedByPerson,
              matchesTemplate,
            });
            if (d.send) {
              sendable += 1;
              expect(mode).not.toBe("off");
              expect(providerConfigured).toBe(true);
              expect(reviewedByPerson).toBe(true);
              expect(matchesTemplate).toBe(true);
            }
            expect(d.reason.length).toBeGreaterThan(20);
          }
        }
      }
    }
    expect(sendable).toBe(2);
  });
});

/* ══ The dial ══════════════════════════════════════════════════════════════ */

describe("the autonomy dial for signatures", () => {
  it("is declared, and starts off", () => {
    const entry = AI_ACTIONS["agreement.esign.send"];
    expect(entry).toBeDefined();
    expect(entry.today).toBe("off");
  });

  it("does not offer an `auto` setting at all", () => {
    /* Unlike every other action here. There is no reading of "send contracts for signature
       automatically" that this application should make available — the obligations exist the
       moment it lands, and nobody can un-sign it. */
    expect(entry_supports()).not.toContain("auto");
    expect(entry_supports()).toEqual(["off", "hold"]);
  });

  function entry_supports(): readonly string[] {
    return AI_ACTIONS["agreement.esign.send"].supports;
  }
});
