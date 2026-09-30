/**
 * The documents a buyer agrees to are reachable (30 Sep 2026). The checkout sentence named
 * "the terms of service and the refund policy" with no link to either, and the footer's
 * "Terms" opened /terms — the ResellerOS SOFTWARE terms, not the terms for what a customer
 * buys. Anutech's own terms now live at /terms-and-conditions.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { LEGAL } from "@/site/lib/data/misc";

const read = (f: string) => readFileSync(f, "utf8");

describe("buyer-facing legal documents", () => {
  it("each has a real page", () => {
    expect(read("src/app/(marketing)/terms-and-conditions/page.tsx")).toMatch(/<LegalDoc page="terms" \/>/);
    expect(read("src/app/(marketing)/refund/page.tsx")).toMatch(/<LegalDoc page="refund" \/>/);
    expect(existsSync("src/app/(public)/terms/page.tsx")).toBe(true); // the software's own terms stay
  });

  it("the checkout agreement links to both documents", () => {
    const c = read("src/app/(marketing)/checkout/page.tsx");
    expect(c).toMatch(/href="\/terms-and-conditions"[^>]*>terms and conditions</);
    expect(c).toMatch(/href="\/refund"[^>]*>refund policy</);
  });

  it("the site footer's Terms is the buyer's terms, not the software's", () => {
    const c = read("src/site/components/chrome/Chrome.tsx");
    expect(c).toMatch(/\["Terms", "\/terms-and-conditions"\]/);
    expect(c).not.toMatch(/\["Terms", "\/terms"\]/);
  });

  it("the documents do not promise what checkout cannot do", () => {
    const text = JSON.stringify(LEGAL);
    expect(text).not.toMatch(/NEFT|RTGS/);           // checkout takes Razorpay only
    expect(text).not.toMatch(/eleven minutes/);      // an average nobody measures
    expect(text).not.toMatch(/Message us on WhatsApp/); // the site's WhatsApp number is a placeholder
  });
});
