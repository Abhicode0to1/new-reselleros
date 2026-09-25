import { describe, it, expect } from "vitest";
import { payeeFromNarration } from "./narration";

describe("payeeFromNarration", () => {
  it.each([
    ["IMPS-612256087508-PRASHANT BHAIYA-FINO-XXXXXXX6722-IMPS TRANSACTION", "Prashant Bhaiya"],   // real line
    ["IMPS-622258187163-DARSHAN-PUNB-XXXXXXXXXX3174-JUNE SALARY", "Darshan"],
    ["NEFT-N123456789-SHARMA CLOUD SOLUTIONS-HDFC0000001", "Sharma Cloud Solutions"],
    ["UPI/412345678901/RAVI KUMAR/ravi@okaxis/Payment", "Ravi Kumar"],
  ])("%s → %s", (narration, payee) => {
    expect(payeeFromNarration(narration)).toBe(payee);
  });

  it.each([
    "01026130346651/ESIC",
    "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK",
    "50100784857169-TPT-SALARY APR 2026-PAWAN",    // TPT is not one of the rails handled here
    "IMPS-612256087508-XX-FINO",                   // too short to be a name
    "",
  ])("%s → null", (narration) => {
    expect(payeeFromNarration(narration)).toBeNull();
  });
});
