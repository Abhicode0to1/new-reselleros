import { describe, it, expect } from "vitest";
import { GST_STATE_BY_CODE, isValidGstin } from "@/lib/utils";
import { stateCodeFromGstin } from "./gstin-state";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ─── ONE TABLE, ONE COPY ────────────────────────────────────────────────────
 * The GSTR-1 exporter kept its own 38-entry literal of state codes beside the canonical
 * `GST_STATE_BY_CODE`. Same count, different membership — which is what two copies of a
 * regulatory table do over time, not what a careless edit does:
 *
 *   25  the copy said "Daman and Diu"; canonical had correctly dropped it, because 25 was
 *       merged into 26 in Jan 2020 and the portal no longer accepts it.
 *   99  canonical has "Centre Jurisdiction"; the copy had nothing at all — so a customer
 *       under central jurisdiction produced a Place of Supply of "99-", malformed, in a
 *       CSV bound for the GST portal.
 *
 * The exporter now imports the canonical table. This test is the guard: it reads the page
 * source and fails if a literal state-code map ever reappears there.
 */
describe("the GST state table has exactly one home", () => {
  const gstPageSrc = readFileSync(
    join(process.cwd(), "src/app/(app)/accounting/gst/page.tsx"), "utf8");

  it("has no second literal map of state codes in the GSTR-1 exporter", () => {
    /* A literal map looks like `"27": "Maharashtra"`. Three or more such pairs in one
       file is a table, not an incidental string. */
    const pairs = gstPageSrc.match(/"\d\d":\s*"[A-Z][^"]+"/g) ?? [];
    expect(pairs.length).toBeLessThan(3);
  });

  it("imports the canonical table instead", () => {
    expect(gstPageSrc).toMatch(/GST_STATE_BY_CODE/);
  });
});

describe("the canonical table itself", () => {
  it("carries 99 — Centre Jurisdiction — because a POS of '99-' is malformed", () => {
    expect(GST_STATE_BY_CODE["99"]).toBe("Centre Jurisdiction");
  });

  it("does NOT carry 25, merged into 26 in Jan 2020", () => {
    expect(GST_STATE_BY_CODE["25"]).toBeUndefined();
    expect(GST_STATE_BY_CODE["26"]).toBe("Dadra and Nagar Haveli and Daman and Diu");
  });

  it("does NOT carry 28 — it was never issued", () => {
    /* Code 28 was pre-bifurcation Andhra Pradesh. GST began 1 July 2017; the AP/Telangana
       split was 2014. So no GSTIN has ever carried 28: 36 is Telangana and 37 is Andhra
       Pradesh. Asserted because its absence looks like an oversight and is not. */
    expect(GST_STATE_BY_CODE["28"]).toBeUndefined();
    expect(GST_STATE_BY_CODE["36"]).toBe("Telangana");
    expect(GST_STATE_BY_CODE["37"]).toBe("Andhra Pradesh");
  });

  it("names ANUTECH's own state and the one the old invoice fallback claimed", () => {
    /* 07 vs 27 is the pair that flipped a tax head — see
       lib/invoices/supplier-identity.ts. */
    expect(GST_STATE_BY_CODE["07"]).toBe("Delhi");
    expect(GST_STATE_BY_CODE["27"]).toBe("Maharashtra");
  });

  it("gives every code a non-empty name, so no POS can render as 'NN-'", () => {
    for (const [code, name] of Object.entries(GST_STATE_BY_CODE)) {
      expect(code).toMatch(/^\d\d$/);
      expect(name.trim().length).toBeGreaterThan(2);
    }
  });
});

describe("a state code is only trusted from a GSTIN that passes its checksum", () => {
  it("reads Delhi out of ANUTECH's real GSTIN", () => {
    expect(isValidGstin("07ABDCA0298H1ZP")).toBe(true);
    expect(stateCodeFromGstin("07ABDCA0298H1ZP")).toBe("07");
  });

  it("refuses the signup form's placeholder, which fails the checksum", () => {
    /* Reading the first two characters of an unvalidated string is how seeded dummy data
       starts deciding tax heads. */
    expect(stateCodeFromGstin("27AABCE9876D1Z3")).toBeNull();
  });

  it("returns null rather than guessing on junk", () => {
    for (const junk of [null, undefined, "", "8P", "GUJARAT", "9999999999999999"]) {
      expect(stateCodeFromGstin(junk)).toBeNull();
    }
  });
});
