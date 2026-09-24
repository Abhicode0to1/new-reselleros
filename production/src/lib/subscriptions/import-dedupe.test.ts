import { describe, it, expect } from "vitest";
import { buildImportDedupeIndex, duplicateReason } from "./import-dedupe";

const existing = [
  { domain: "acme.in", customer_id: "c1", plan: "Google Workspace Business Starter" },
  { domain: null, customer_id: "c2", plan: "Microsoft 365 Business Premium" },
];
const index = buildImportDedupeIndex(existing);

describe("duplicateReason — the domain is the key", () => {
  it("catches a row for a domain that already has a subscription", () => {
    expect(duplicateReason({ domain: "acme.in", customer_id: "c1", plan: "Google Workspace Business Starter" }, index))
      .toBe("acme.in already has a subscription");
  });

  it("lets a genuinely new domain through", () => {
    expect(duplicateReason({ domain: "newco.in", customer_id: "c9", plan: "Google Workspace Business Starter" }, index))
      .toBeNull();
  });

  it("catches it however the plan name is spelled", () => {
    /* Plan names do not survive a trip between systems — the same subscription reads
       "Google Workspace Business Starter" here and "...- Annual, Monthly Pay" in an
       export. Keying on the plan would wave the duplicate straight through. */
    expect(duplicateReason({ domain: "acme.in", customer_id: "c1", plan: "Google Workspace Business Starter - Annual, Monthly Pay" }, index))
      .toBe("acme.in already has a subscription");
  });

  it("catches it even under a different customer", () => {
    // One domain is one Workspace tenant. If it is already tracked, importing it again
    // under another customer id is a mistake, not a second service.
    expect(duplicateReason({ domain: "acme.in", customer_id: "c-other", plan: "Anything" }, index))
      .toBe("acme.in already has a subscription");
  });
});

describe("duplicateReason — domains as a CSV actually delivers them", () => {
  it.each([
    ["ACME.IN",            "upper case"],
    ["  acme.in  ",        "padded by Excel"],
    ["www.acme.in",        "with www."],
    ["https://acme.in",    "pasted as a URL"],
    ["https://www.acme.in/", "URL with www and a slash"],
  ])("treats %s as the same domain (%s)", (domain) => {
    expect(duplicateReason({ domain, customer_id: "c1", plan: "p" }, index))
      .toBe("acme.in already has a subscription");
  });
});

describe("duplicateReason — rows with no domain", () => {
  it("falls back to customer + plan", () => {
    expect(duplicateReason({ domain: null, customer_id: "c2", plan: "Microsoft 365 Business Premium" }, index))
      .toBe("this customer already has this plan");
  });

  it("is case-insensitive on the plan", () => {
    expect(duplicateReason({ domain: "", customer_id: "c2", plan: "microsoft 365 business premium" }, index))
      .toBe("this customer already has this plan");
  });

  it("lets the same plan through for a DIFFERENT customer", () => {
    expect(duplicateReason({ domain: null, customer_id: "c3", plan: "Microsoft 365 Business Premium" }, index))
      .toBeNull();
  });

  it("lets a different plan through for the same customer", () => {
    expect(duplicateReason({ domain: null, customer_id: "c2", plan: "Google Workspace Business Starter" }, index))
      .toBeNull();
  });

  it("does not use the weaker check when the row HAS a domain", () => {
    /* A customer can legitimately run two tenants on the same plan — acme.in and
       acme-labs.in. The domain says they are different services, so the customer+plan
       fallback must not override it. */
    const idx = buildImportDedupeIndex([{ domain: "acme.in", customer_id: "c1", plan: "Starter" }]);
    expect(duplicateReason({ domain: "acme-labs.in", customer_id: "c1", plan: "Starter" }, idx))
      .toBeNull();
  });
});

describe("buildImportDedupeIndex — the edges a real table has", () => {
  it("ignores subscriptions with neither a domain nor a full customer+plan", () => {
    const idx = buildImportDedupeIndex([{ domain: null, customer_id: null, plan: null }]);
    expect(idx.domains.size).toBe(0);
    expect(idx.customerPlans.size).toBe(0);
  });

  it("handles an empty table — the genuine first migration", () => {
    const idx = buildImportDedupeIndex([]);
    expect(duplicateReason({ domain: "acme.in", customer_id: "c1", plan: "p" }, idx)).toBeNull();
  });

  it("normalises the EXISTING side too, not just the incoming row", () => {
    // The stored domain can be just as messy as the CSV's — both sides go through the
    // same cleaner or the comparison is a coin toss.
    const idx = buildImportDedupeIndex([{ domain: "WWW.Acme.IN", customer_id: "c1", plan: "p" }]);
    expect(duplicateReason({ domain: "acme.in", customer_id: "c1", plan: "p" }, idx))
      .toBe("acme.in already has a subscription");
  });
});
