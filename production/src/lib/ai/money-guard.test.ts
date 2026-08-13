import { describe, it, expect } from "vitest";
import { verifyDraftMoney } from "./money-guard";

describe("verifyDraftMoney — the figure the model was given", () => {
  it("accepts a draft that restates the authorised amount", () => {
    const r = verifyDraftMoney("Gentle reminder — ₹4,500 is outstanding on your account.", [4500]);
    expect(r.ok).toBe(true);
    expect(r.found).toEqual([4500]);
  });

  // ── The failure this file exists to catch ────────────────────────────────
  it("REJECTS an amount the model invented", () => {
    // The prompt said ₹4,500. A fluent, plausible message asking for ten times
    // that is exactly what must never reach a customer.
    const r = verifyDraftMoney("Gentle reminder — ₹45,000 is outstanding.", [4500]);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["₹45,000"]);
  });

  it("rejects a subtly wrong amount, not just a wildly wrong one", () => {
    expect(verifyDraftMoney("Balance: ₹4,550", [4500]).ok).toBe(false);
    expect(verifyDraftMoney("Balance: ₹450", [4500]).ok).toBe(false);
  });

  it("catches the second figure when the first is right", () => {
    const r = verifyDraftMoney("₹4,500 due now, and ₹9,000 next month.", [4500]);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["₹9,000"]);
  });
});

describe("Indian money formats all normalise", () => {
  const forms = [
    "₹45,000", "₹45000", "Rs 45000", "Rs. 45,000", "INR 45,000", "45,000/-",
  ];
  for (const f of forms) {
    it(`accepts ${f}`, () => {
      expect(verifyDraftMoney(`Outstanding: ${f} — please pay.`, [45000]).ok).toBe(true);
    });
  }

  it("accepts lakh and crore wordings for the same value", () => {
    // Rejecting a CORRECT message written as "₹4.5 lakh" would be its own
    // false alarm, and false alarms are how a guard gets switched off.
    expect(verifyDraftMoney("Total is ₹4.5 lakh for the year.", [450000]).ok).toBe(true);
    expect(verifyDraftMoney("Total is ₹4.5 lakhs for the year.", [450000]).ok).toBe(true);
    expect(verifyDraftMoney("Deal size ₹1.2 cr.", [12000000]).ok).toBe(true);
    expect(verifyDraftMoney("Deal size ₹1.2 crore.", [12000000]).ok).toBe(true);
  });

  it("still catches a wrong lakh figure", () => {
    expect(verifyDraftMoney("Total is ₹45 lakh.", [450000]).ok).toBe(false);
  });

  it("handles paise without tripping", () => {
    expect(verifyDraftMoney("Exactly ₹4,500.00 due.", [4500]).ok).toBe(true);
  });
});

describe("what it must NOT flag — or the guard gets switched off", () => {
  it("ignores seat counts, percentages, days and dates", () => {
    const text =
      "Hi Rohit, your 22 seats of Google Workspace renew on 13 Aug 2026. " +
      "GST is 18% and payment terms are Net 7 days. Outstanding: ₹4,500.";
    const r = verifyDraftMoney(text, [4500]);
    expect(r.ok).toBe(true);
    expect(r.found).toEqual([4500]);
  });

  it("ignores invoice numbers and phone numbers", () => {
    const text = "Ref INV-ET-2026-27-0042. Call me on 9999930300. Balance ₹4,500.";
    expect(verifyDraftMoney(text, [4500]).ok).toBe(true);
  });

  it("permits zero without it being authorised", () => {
    // "Nothing outstanding" is never a harmful claim.
    expect(verifyDraftMoney("You have ₹0 outstanding — all clear!", []).ok).toBe(true);
  });

  it("passes a draft with no money in it at all", () => {
    const r = verifyDraftMoney("Just checking in — is everything running smoothly?", []);
    expect(r.ok).toBe(true);
    expect(r.found).toEqual([]);
  });
});

describe("bareNumberFloor — the stricter, opt-in sweep", () => {
  it("catches an unmarked amount when enabled", () => {
    const text = "Your outstanding is 45000, please clear it.";
    expect(verifyDraftMoney(text, [4500]).ok).toBe(true);                       // off by default
    expect(verifyDraftMoney(text, [4500], { bareNumberFloor: 1000 }).ok).toBe(false);
  });

  it("does not double-count a marked figure as also being bare", () => {
    const r = verifyDraftMoney("Balance ₹45,000 due.", [45000], { bareNumberFloor: 1000 });
    expect(r.ok).toBe(true);
    expect(r.found).toEqual([45000]);   // once, not twice
  });

  it("leaves small numbers alone even when enabled", () => {
    const r = verifyDraftMoney("22 seats, 18% GST, 7 days.", [], { bareNumberFloor: 1000 });
    expect(r.ok).toBe(true);
  });
});

describe("robustness", () => {
  it("never throws on odd input", () => {
    for (const t of ["", "₹", "Rs.", "₹,", "/-", "₹ ₹ ₹", "INR abc"]) {
      expect(() => verifyDraftMoney(t, [100])).not.toThrow();
    }
  });

  it("rounds authorised values so 4500.4 matches a drafted ₹4,500", () => {
    expect(verifyDraftMoney("Due ₹4,500", [4500.4]).ok).toBe(true);
  });

  it("reports every violation, not only the first", () => {
    const r = verifyDraftMoney("₹100 then ₹200 then ₹300.", [200]);
    expect(r.violations).toEqual(["₹100", "₹300"]);
  });
});
