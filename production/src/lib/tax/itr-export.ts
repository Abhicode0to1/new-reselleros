/**
 * ITR pack ka CSV — CA ko dene wali ek file.
 *
 * Excel nahi, CSV: is repo ka tay kiya hua raasta (lib/accounting/
 * ledger-export.ts:4 — xlsx dependency jaan-boojhkar nahi hai; CSV Excel me
 * waise hi khulta hai). Amounts KACCHE integer rupaye hain, formatted string
 * nahi — taki Excel unhe jod sake (lib/csv.ts:1 ka niyam).
 *
 * GAPS bhi file me hain, aankdo ke barabar. CA ko sirf jod nahi, ye bhi
 * chahiye ki kya IS FILE ME NAHI hai — warna wo ise poora maan kar sign
 * karne ki taraf badhta hai.
 */
import type { ItrPack } from "./itr";

export const ITR_CSV_HEADERS = ["Section", "Item", "Amount (₹)", "Rows", "Detail"] as const;

type Cell = string | number;

export function itrCsvRows(p: ItrPack): Cell[][] {
  const rows: Cell[][] = [];
  const add = (section: string, item: string, amount: Cell, count: Cell, detail: string) =>
    rows.push([section, item, amount, count, detail]);

  add("Period", p.fy.label, "", "", `${p.fy.start} se ${p.fy.end} · ${p.fy.assessmentYear} · ITR due ${p.fy.itrDue}`);

  for (const l of p.pnl) {
    add(l.kind === "income" ? "Income" : "Expense", l.label, l.amount, l.count, l.source);
  }
  add("Total", "Kul aamdani", p.totalIncome, "", "");
  add("Total", "Kul kharcha", p.totalExpense, "", "");
  add("Total", "Book profit", p.bookProfit, "", p.bookProfit < 0 ? "GHATA — carry-forward ke liye return time par bharna zaroori" : "");
  add("Computation", "Taxable income (288A round)", p.taxableIncome, "", "Andaza — CA depreciation/disallowance jodkar final karega");

  for (const e of p.estimates) {
    add("Tax estimate", `${e.regimeLabel} — base`, e.baseTax, "", `${e.ratePct}%`);
    add("Tax estimate", `${e.regimeLabel} — surcharge`, e.surcharge, "", "");
    add("Tax estimate", `${e.regimeLabel} — cess 4%`, e.cess, "", "");
    add("Tax estimate", `${e.regimeLabel} — TOTAL`, e.total, "", p.cheaperEstimate?.regime === e.regime ? "kam wala — schedule isi par" : "");
  }

  add("Credits", "TDS receivable (is FY ka)", -p.sources.tdsCredit, "", "tds_receivable — 26AS/AIS se milaan CA karega");
  add("Computation", "Net payable (TDS ke baad)", p.netPayableAfterTds, "", "");

  if (p.advanceTaxRequired) {
    for (const i of p.advanceTaxSchedule) {
      add("Advance tax", `${i.label} tak (cumulative ${i.cumulativePct}%)`, i.cumulativeDue, "", i.dueDate);
    }
  } else {
    add("Advance tax", "Zaroori nahi", "", "", "Section 208 — net payable ₹10,000 se kam");
  }

  p.gaps.forEach((g, idx) => add("GAP", `#${idx + 1}`, "", "", g));

  return rows;
}
