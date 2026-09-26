import { describe, it, expect } from "vitest";
import { detectGovtPayment } from "./govt-payment";

describe("detectGovtPayment", () => {
  it.each([
    ["01026130346651/ESIC", "esi"],                                                     // real line
    ["GST/BANK REFERENCE NO: R2626675889909/CIN NO: HDFC26090700332468", "gst"],        // real line
    ["EPFO ECR CHALLAN 1234567", "pf"],
    ["PROVIDENT FUND ORG TRRN 998877", "pf"],
    ["ITNS 281 TDS CHALLAN", "tds"],
    ["CBDT ITNS280 ADVANCE TAX", "income_tax"],
    ["SELF ASSESSMENT TAX AY 2026-27", "income_tax"],
  ])("%s → %s", (narration, kind) => {
    expect(detectGovtPayment(narration)?.kind).toBe(kind);
  });

  it.each([
    "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK",
    "50100784857169-TPT-SALARY APR 2026-PAWAN",
    "UBER TAXI TRIP",                  // "TAX" inside TAXI
    "UPI/PFIZER PHARMA",               // "PF" inside a word
    "",
  ])("%s → not a government payment", (narration) => {
    expect(detectGovtPayment(narration)).toBeNull();
  });
});
