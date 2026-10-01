/**
 * R-009 — credit / debit notes on the invoices LIST.
 *
 * A credit note lowers an invoice and a debit note raises it (CGST §34). The list
 * showed only the original `amount`, so an invoice with a ₹1,180 credit note looked
 * like ₹11,800 was still owed and the "Net due" line beside it called the gap an
 * "advance adjusted". This file turns the tenant's notes into per-invoice totals —
 * fetched ONCE for the whole list (useInvoiceNoteTotals), never one query per row —
 * and the net value of the invoice after those notes.
 *
 * Money: amounts are rupees as stored. Sums run in whole paise so adding many notes
 * cannot drift (0.1 + 0.2 ≠ 0.3), and every figure returned is rounded to 2 places.
 */

/** One credit or debit note, as far as the list needs it. */
export interface NoteAmountRow {
  invoice_id: string | null;
  amount: number | string | null;
  /** Notes have no status today; if one is ever added, a void note must not count. */
  status?: string | null;
}

export interface NoteTotals {
  /** Sum of credit notes (₹, positive number — it is subtracted). */
  credit: number;
  /** Sum of debit notes (₹, positive number — it is added). */
  debit: number;
}

const VOID_STATUSES = new Set(["void", "voided", "cancelled", "canceled"]);

const toPaise = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  if (!Number.isFinite(n)) return 0;
  /* toFixed(6) first: 10.005 * 100 is 1000.4999999999999 in floating point, and a bare
     Math.round would lose the paisa. */
  return Math.round(Number((n * 100).toFixed(6)));
};
const fromPaise = (p: number): number => p / 100;

/** Rupees rounded to paise. */
export function roundRupees(v: number): number {
  return fromPaise(toPaise(v));
}

/** Per-invoice credit / debit note totals. Invoices without notes are absent. */
export function noteTotalsByInvoice(
  creditNotes: readonly NoteAmountRow[],
  debitNotes: readonly NoteAmountRow[],
): Map<string, NoteTotals> {
  const paise = new Map<string, { credit: number; debit: number }>();
  const add = (rows: readonly NoteAmountRow[], kind: "credit" | "debit") => {
    for (const r of rows) {
      if (!r.invoice_id) continue;
      if (r.status && VOID_STATUSES.has(r.status.toLowerCase())) continue;
      const p = toPaise(r.amount);
      if (p === 0) continue;
      const t = paise.get(r.invoice_id) ?? { credit: 0, debit: 0 };
      t[kind] += p;
      paise.set(r.invoice_id, t);
    }
  };
  add(creditNotes, "credit");
  add(debitNotes, "debit");

  const out = new Map<string, NoteTotals>();
  for (const [id, t] of paise) {
    if (t.credit === 0 && t.debit === 0) continue;
    out.set(id, { credit: fromPaise(t.credit), debit: fromPaise(t.debit) });
  }
  return out;
}

/** Invoice value after its notes: amount − credit + debit, never below zero. */
export function netAfterNotes(amount: number | null | undefined, totals?: NoteTotals | null): number {
  const p = toPaise(amount) - toPaise(totals?.credit) + toPaise(totals?.debit);
  return fromPaise(Math.max(0, p));
}
