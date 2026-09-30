/**
 * A trial sends the OWNER no email (owner, 30 Sep 2026: "Remove this feature completely.
 * That will just annoy the owner."). Every trial — including every test run — used to email
 * pardeep@anutech.in up to three times. Staff see trials as leads with follow-up tasks; a
 * setup that fails becomes a task, not an email. This fails if an owner email comes back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILES = [
  "src/lib/hosting/start-trial.ts",
  "src/app/api/public/trial/hosting/confirm/route.ts",
  "src/app/api/public/trial/workspace/route.ts",
];
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("trials never email the owner", () => {
  for (const f of FILES) {
    it(f, () => {
      const c = code(f);
      expect(c).toContain("sendEmail("); // guard: the customer's email is still there to scan
      expect(c).not.toMatch(/buy_page_trial_owner/);
      expect(c).not.toMatch(/to:\s*owner\.to/);
    });
  }
});
