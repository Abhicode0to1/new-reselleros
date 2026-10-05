/**
 * Claims the public site may not make without a source (2 Oct 2026, Pardeep):
 * sample "Google review" cards, an unmeasured "11 minute" WhatsApp reply time, and a hosting
 * "from" price that disagreed with the /hosting page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTING_FROM_MO, HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const FILES = [
  "components/home/HomeV2.tsx", "lib/data/copy.ts", "components/chrome/Chrome.tsx",
  "components/chrome/Header.tsx", "components/trial/TrialForm.tsx", "components/agent/AgentChat.tsx",
  "components/home/HomeCompany.tsx", "lib/data/home-faqs.ts", "lib/data/company-faqs.ts",
];

describe("public site claims", () => {
  it("no sample reviews presented as Google reviews", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/· Google review"/);
  });
  it("no unmeasured 11-minute reply time", () => {
    for (const f of FILES) expect(read(f), f).not.toMatch(/11[ -]min|11 minutes|eleven[ -]minute/i);
  });
  it("one hosting 'from' price everywhere — the /hosting Starter yearly rate", () => {
    expect(HOSTING_FROM_MO).toBe(`₹${Math.min(...HOSTING_TIERS.map((t) => t.yearlyMo))}`);
    for (const f of ["lib/data/copy.ts", "components/chrome/Header.tsx"]) {
      expect(read(f), f).toContain(`from ${HOSTING_FROM_MO}/mo`);
      expect(read(f), f).not.toContain("₹159/mo");
    }
    expect(read("components/home/HomeV2.tsx")).toContain("from: HOSTING_FROM_MO");
  });
});
