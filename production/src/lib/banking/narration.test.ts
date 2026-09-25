import { describe, it, expect } from "vitest";
import { payeeFromNarration } from "./narration";

describe("payeeFromNarration", () => {
  it.each([
    ["IMPS-612256087508-PRASHANT BHAIYA-FINO-XXXXXXX6722-IMPS TRANSACTION", "Prashant Bhaiya"],   // real line
    ["IMPS-622258187163-DARSHAN-PUNB-XXXXXXXXXX3174-JUNE SALARY", "Darshan"],
    ["NEFT-N123456789-SHARMA CLOUD SOLUTIONS-HDFC0000001", "Sharma Cloud Solutions"],
    ["UPI/412345678901/RAVI KUMAR/ravi@okaxis/Payment", "Ravi Kumar"],
    // Real lines from the HDFC statement, 25 Sep 2026:
    ["NEFT DR-BKID0006087-PRATIK-NETBANK, MUM-HDFCH01182738271-JULY SALARY", "Pratik"],
    ["RTGS DR-ICIC0000828-PARDEEP SHARMA-NETBANK, MUM-HDFCR52026071684013560-SALARY TO DIRECTOR", "Pardeep Sharma"],
    ["KYQX244FAR4KPNGVCU/PAYUAMAZON", "Amazon"],
    ["KYQX244FAR4KPNGVCU/PAYAMAZON", "Amazon"],
    ["DHFISM1TU2WOC/BILLDKGOOGLECLOUD", "Google Cloud"],
    ["DHDF2FB1SC5QBB/BILLDKPLAYSTOREGOOGL", "Google Play"],
    ["K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK", "Facebook"],
  ])("%s → %s", (narration, payee) => {
    expect(payeeFromNarration(narration)).toBe(payee);
  });

  it.each([
    "01026130346651/ESIC",                         // not a gateway code
    "GST/BANK REFERENCE NO: R2626675889909/CIN NO: HDFC26090700332468",
    "50100784857169-TPT-SALARY APR 2026-PAWAN",    // TPT is not one of the rails handled here
    "IMPS-612256087508-XX-FINO",                   // too short to be a name
    "",
  ])("%s → null", (narration) => {
    expect(payeeFromNarration(narration)).toBeNull();
  });
});
