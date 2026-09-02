import { describe, it, expect } from "vitest";
import { apiProductFor, gwTierFor } from "./quote-mapping";
import { LICENCE_EDITIONS } from "./data/catalog";

/* Galat bucket = lead galat vendor ke neeche file hoti hai, aur app ka agent galat catalogue
   padhta hai. Isliye mapping pure hai aur har edition ke liye pin hai. */
describe("edition → API product bucket", () => {
  it("saare GW edition google-workspace me", () => {
    for (const e of LICENCE_EDITIONS.filter((e) => e.name.startsWith("GW")))
      expect(apiProductFor(e.name), e.name).toBe("google-workspace");
  });
  it("app ke catalogue ka poora naam bhi (append hua live product)", () => {
    expect(apiProductFor("Google Workspace Business Starter")).toBe("google-workspace");
  });
  it("M365 aur Zoho apne bucket me", () => {
    expect(apiProductFor("M365 Business Basic")).toBe("microsoft-365");
    expect(apiProductFor("M365 Business Standard")).toBe("microsoft-365");
    expect(apiProductFor("Zoho Workplace")).toBe("zoho");
  });
  it("baaki sab other", () => {
    for (const p of ["Anutech Mail", "Hosting", "Domains"]) expect(apiProductFor(p), p).toBe("other");
  });
});

describe("edition → GW tier (auto-quote raasta)", () => {
  it("teeno GW edition apne tier par", () => {
    expect(gwTierFor("GW Business Starter")).toBe("starter");
    expect(gwTierFor("GW Business Standard")).toBe("standard");
    expect(gwTierFor("GW Business Plus")).toBe("plus");
  });
  it("app ke poore naam wale (live-append) bhi", () => {
    expect(gwTierFor("Google Workspace Business Starter")).toBe("starter");
  });
  it("non-GW par null — wo general raaste par jate hain", () => {
    for (const n of ["M365 Business Basic", "Zoho Workplace", "Anutech Mail", "Hosting", "Domains"])
      expect(gwTierFor(n), n).toBeNull();
  });
  it("GW hai par tier pehchana nahi → null, andaza nahi", () => {
    /* Naya edition (jaise Enterprise) tier-map me nahi hai to auto-quote par zabardasti
       nahi bhejte — app enterprise ko waise bhi hand-price karta hai. */
    expect(gwTierFor("GW Enterprise")).toBeNull();
  });
});
