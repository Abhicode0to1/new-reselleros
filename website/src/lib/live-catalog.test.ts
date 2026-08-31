import { describe, it, expect } from "vitest";
import { mergeEditions, liveGwMonthlyRate, type LiveWorkspaceItem } from "./live-catalog";
import { LICENCE_EDITIONS } from "./data/catalog";

/* ─────────────────────────────────────────────────────────────────────────────
   Website ↔ app ka daam-connection. Do niyam pin hain:

   1. LIVE placeholder ko DHAK deta hai — app me daam badle to website wahi dikhaye.
      31 Aug 2026 ka asli farak: placeholder ₹136, asli catalogue ₹270. Website ₹136
      dikhaye aur app ₹270 ki quotation bheje, to wahi "document apne aap se asahmat"
      wali galti grahak ke saamne hoti.

   2. Merge kabhi daam GADHTA nahi — live me monthly tier na ho to monthlyOrNull null
      rehta hai aur UI "annual only" kehta hai. Annual se monthly nikalna wahi 12×/term
      wali class ki galti hai jo app me ek baar ho chuki hai.
   ───────────────────────────────────────────────────────────────────────────── */

/** Bilkul wahi jo endpoint 31 Aug 2026 ko deta hai. */
const LIVE: LiveWorkspaceItem[] = [
  { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: 325 },
];

describe("merge — live jeet-ta hai", () => {
  it("GW Business Starter ka placeholder (136/160) live (270/325) se dhak jata hai", () => {
    const merged = mergeEditions(LIVE);
    const starter = merged.find((e) => e.name === "GW Business Starter");
    expect(starter).toBeDefined();
    expect(starter!.annual).toBe(270);
    expect(starter!.monthlyOrNull).toBe(325);
    expect(starter!.live).toBe(true);
  });

  it("baaki edition waise hi rehte hain, live ka thappa NAHI lagta", () => {
    const merged = mergeEditions(LIVE);
    const m365 = merged.find((e) => e.name === "M365 Business Standard");
    expect(m365).toBeDefined();
    expect(m365!.live).toBeUndefined();
    expect(m365!.annual).toBe(770);
  });

  it("naya live product APPEND hota hai — website deploy ka intezaar nahi", () => {
    const merged = mergeEditions([
      ...LIVE,
      { name: "Google Workspace Business Standard Plus", annualPerSeatMo: 999, monthlyPerSeatMo: 1200 },
    ]);
    const added = merged.find((e) => e.name === "GW Business Standard Plus");
    expect(added).toBeDefined();
    expect(added!.annual).toBe(999);
    expect(added!.live).toBe(true);
  });

  it("live null (app nahi mila) → placeholder jaise the waise, page girta nahi", () => {
    const merged = mergeEditions(null);
    expect(merged.map((e) => e.name)).toEqual(LICENCE_EDITIONS.map((e) => e.name));
    expect(merged.every((e) => !e.live)).toBe(true);
  });
});

describe("merge — daam kabhi gadha nahi jata", () => {
  it("monthly tier na ho to monthlyOrNull NULL — annual se koi jugaad nahi", () => {
    const merged = mergeEditions([
      { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: null },
    ]);
    const starter = merged.find((e) => e.name === "GW Business Starter")!;
    expect(starter.monthlyOrNull).toBeNull();
    /* Calculator isi null par Monthly chip disable karta hai aur "annual only" likhta hai. */
  });
});

describe("quote page ka GW rate", () => {
  it("Starter ka flexible rate uthata hai", () => {
    expect(liveGwMonthlyRate(LIVE)).toBe(325);
  });
  it("app na mile to null — QuoteBuilder placeholder par gir jata hai", () => {
    expect(liveGwMonthlyRate(null)).toBeNull();
    expect(liveGwMonthlyRate([])).toBeNull();
  });
});
