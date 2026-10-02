import { describe, it, expect } from "vitest";
import { vendorFromPlanText, suggestPlanProducts, productSupportSku, supplyStateMissing } from "./quote-assist";

const CAT = [
  { id: "GW-PLS-t", name: "Google Workspace Business Plus", vendor: "google", kind: "main", item_type: "subscription", is_active: true, msrp: 1380 },
  { id: "GW-STR-t", name: "Google Workspace Business Starter", vendor: "google", kind: "main", item_type: "subscription", is_active: true, msrp: 136 },
  { id: "GW-STD-t", name: "Google Workspace Business Standard", vendor: "google", kind: "main", item_type: "subscription", is_active: true, msrp: 736 },
  { id: "GW-OLD-t", name: "Old plan", vendor: "google", kind: "main", item_type: "subscription", is_active: false, msrp: 10 },
  { id: "GW-STO-t", name: "+1TB storage", vendor: "google", kind: "addon", item_type: "subscription", is_active: true, msrp: 300 },
  { id: "M365-BB-t", name: "Microsoft 365 Business Basic", vendor: "microsoft", kind: "main", item_type: "subscription", is_active: true, msrp: 145 },
  { id: "SUP-GW-STR-t-YR", name: "Google Workspace Business Starter Support (Yearly)", vendor: "support", kind: "addon", item_type: "subscription", is_active: true, msrp: 0 },
  { id: "SUP-GW-STR-t-MO", name: "Google Workspace Business Starter Support", vendor: "support", kind: "addon", item_type: "subscription", is_active: true, msrp: 999 },
];

describe("vendorFromPlanText", () => {
  it("reads the vendor out of a lead's interest", () => {
    expect(vendorFromPlanText("Google Workspace")).toBe("google");
    expect(vendorFromPlanText("google-workspace-standard")).toBe("google");
    expect(vendorFromPlanText("Microsoft 365 Business Basic")).toBe("microsoft");
    expect(vendorFromPlanText("Zoho Mail")).toBe("zoho");
    expect(vendorFromPlanText("email")).toBeNull();
    expect(vendorFromPlanText(null)).toBeNull();
  });
});

describe("suggestPlanProducts — the one-tap chips", () => {
  it("offers the named vendor's active main products, cheapest first", () => {
    expect(suggestPlanProducts(CAT, "Google Workspace").map((i) => i.id)).toEqual(["GW-STR-t", "GW-STD-t", "GW-PLS-t"]);
  });
  it("never offers add-ons, support or inactive items", () => {
    const ids = suggestPlanProducts(CAT, "Google Workspace").map((i) => i.id);
    expect(ids).not.toContain("GW-STO-t");
    expect(ids).not.toContain("GW-OLD-t");
    expect(ids.some((id) => id.startsWith("SUP-"))).toBe(false);
  });
  it("falls back to Google when the lead names no vendor", () => {
    expect(suggestPlanProducts(CAT, "")[0].id).toBe("GW-STR-t");
    expect(suggestPlanProducts(CAT, "Microsoft 365").map((i) => i.id)).toEqual(["M365-BB-t"]);
  });
});

describe("productSupportSku", () => {
  it("finds the product's own support add-on by cycle", () => {
    expect(productSupportSku(CAT, "GW-STR-t", "yearly")?.id).toBe("SUP-GW-STR-t-YR");
    expect(productSupportSku(CAT, "GW-STR-t", "monthly")?.id).toBe("SUP-GW-STR-t-MO");
    expect(productSupportSku(CAT, "GW-PLS-t", "yearly")).toBeUndefined();
    expect(productSupportSku(CAT, null, "yearly")).toBeUndefined();
  });
});

describe("supplyStateMissing — the GST guard", () => {
  it("a domestic quote with no state is missing it; an export never is", () => {
    expect(supplyStateMissing({ isExport: false, buyerStateCode: "" })).toBe(true);
    expect(supplyStateMissing({ isExport: false, buyerStateCode: null })).toBe(true);
    expect(supplyStateMissing({ isExport: false, buyerStateCode: "06" })).toBe(false);
    expect(supplyStateMissing({ isExport: true, buyerStateCode: null })).toBe(false);
  });
});
