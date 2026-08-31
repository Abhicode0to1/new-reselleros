import { describe, it, expect } from "vitest";
import { apiProductFor } from "./quote-mapping";
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
