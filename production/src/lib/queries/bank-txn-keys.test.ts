import { describe, it, expect, vi } from "vitest";

// bank.ts imports the browser Supabase client at module load; the key helpers need none of it.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { bankTxnKey, bankTxnKeys } from "./bank";

const isDup = (a: Parameters<typeof bankTxnKeys>[0], known: Parameters<typeof bankTxnKeys>[0][]) => {
  const seen = new Set(known.flatMap(bankTxnKeys));
  return bankTxnKeys(a).some((k) => seen.has(k));
};

describe("bankTxnKeys — the same line read twice is one line", () => {
  const csvLine = { txn_date: "2026-05-02", debit: 18999, credit: 0, description: "NEFT DR-FINO0001157-PRASHANT BHAIYA-NETBANK", balance_after: 262245 };

  it("CSV line vs the AI's differently-worded reading of it: duplicate by running balance", () => {
    const aiLine = { ...csvLine, description: "NEFT DR FINO PRASHANT BHAIYA" };
    expect(bankTxnKey(aiLine)).not.toBe(bankTxnKey(csvLine));   // the old key missed it
    expect(isDup(aiLine, [csvLine])).toBe(true);
  });

  it("two genuinely different lines with the same date and amount stay separate", () => {
    const other = { ...csvLine, description: "NEFT DR-HDFC0002222-SOMEONE ELSE", balance_after: 243246 };
    expect(isDup(other, [csvLine])).toBe(false);
  });

  it("without a running balance it falls back to the description key only", () => {
    const noBal = { txn_date: "2026-05-02", debit: 18999, credit: 0, description: "SOMETHING ELSE", balance_after: null };
    expect(bankTxnKeys(noBal)).toHaveLength(1);
    expect(isDup(noBal, [csvLine])).toBe(false);
  });
});
