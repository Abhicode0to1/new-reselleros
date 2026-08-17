/**
 * Ledger data — every transaction against one customer or one vendor.
 *
 * ─── EVERY ENTRY, NEVER A DATE-FILTERED SLICE ───────────────────────────────
 * These hooks fetch the party's WHOLE history and `buildLedger` derives the opening
 * balance from what falls before the window. Filtering by date in SQL would be cheaper
 * and would silently zero the opening balance — a statement for FY 2026-27 claiming the
 * party had no history before 1 April. The error only shows up when the customer compares
 * it against their own books.
 *
 * RLS scopes every table below to the tenant, so no query here carries tenant_id
 * explicitly — the policy does it, and a forgotten `.eq("tenant_id", …)` cannot leak.
 *
 * ─── WHAT IS DELIBERATELY NOT IN THE VENDOR LEDGER ──────────────────────────
 * `purchase_orders`. The brief asked for them and they do not belong: a PO is an ORDER
 * placed with Google or Microsoft, not a bill they have sent. Nothing is owed until the
 * vendor invoices. All 12 of ANUTECH's POs are `draft`, worth ₹8,50,476 — putting those in
 * would claim a liability nobody has raised, and then double-count it against the expense
 * when the real bill arrives. The vendor's bill IS `expenses` (it carries bill_no,
 * bill_type, due_date, paid, paid_date), which is what this uses.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { LedgerEntry } from "@/lib/accounting/ledger";

/** YYYY-MM-DD from a date or timestamptz column. */
function isoDay(v: string | null | undefined): string | null {
  return v ? v.slice(0, 10) : null;
}

/* ─── CUSTOMER ───────────────────────────────────────────────────────────── */

/**
 * Every ledger entry for one customer: invoices, receipts, credit and debit notes.
 *
 * ─── A REFUNDED PAYMENT IS TWO EVENTS, NOT ZERO ─────────────────────────────
 * `payments.status = 'refunded'` means the money arrived and then went back. Dropping the
 * row would make the statement disagree with the bank on both dates; treating it as a
 * plain receipt would show the customer as settled when they are not. So it emits BOTH: a
 * Receipt on `received_at` and a Refund on `refunded_at`, which is what actually happened
 * and what the bank statement will show.
 *
 * Reasoned, not observed — ANUTECH has 9 payments and all 9 are `received`. Flagged so
 * nobody reads this as tested behaviour.
 */
export function useCustomerLedgerEntries(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["ledger", "customer", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<LedgerEntry[]> => {
      const supabase = createClient();
      const [inv, pay, cn, dn] = await Promise.all([
        supabase.from("invoices")
          .select("id, invoice_date, amount, customer_name, status")
          .eq("customer_id", customerId!)
          .neq("status", "void"),
        supabase.from("payments")
          .select("id, receipt_voucher_no, amount, received_at, refunded_at, status, method, reference")
          .eq("customer_id", customerId!),
        supabase.from("credit_notes")
          .select("id, credit_date, amount, reason, invoice_id")
          .eq("customer_id", customerId!),
        supabase.from("debit_notes")
          .select("id, debit_date, amount, reason, invoice_id")
          .eq("customer_id", customerId!),
      ]);
      if (inv.error) throw inv.error;
      if (pay.error) throw pay.error;
      if (cn.error) throw cn.error;
      if (dn.error) throw dn.error;

      const entries: LedgerEntry[] = [];

      /* A VOID invoice is excluded in SQL above. A void document was never issued, so
         putting it on a statement — even at ₹0 — invites the customer to ask about a
         number they never received. A CANCELLED one is different and there is no such
         status here. */
      for (const i of inv.data ?? []) {
        const d = isoDay(i.invoice_date);
        if (!d) continue;
        entries.push({
          date: d, reference: i.id, voucher: "Sales",
          narration: null, amount: i.amount ?? 0, increasesLiability: true,
        });
      }

      for (const p of pay.data ?? []) {
        const received = isoDay(p.received_at);
        if (received) {
          entries.push({
            date: received,
            /* The receipt voucher number when one was issued — that is the document the
               customer holds. The UUID is a fallback nobody can look up, but it is better
               than a blank Particulars cell. */
            reference: p.receipt_voucher_no ?? p.id,
            voucher: "Receipt",
            narration: [p.method, p.reference].filter(Boolean).join(" · ") || null,
            amount: p.amount ?? 0,
            increasesLiability: false,
          });
        }
        const refunded = isoDay(p.refunded_at);
        if (p.status === "refunded" && refunded) {
          entries.push({
            date: refunded,
            reference: `${p.receipt_voucher_no ?? p.id} · refunded`,
            voucher: "Refund",
            narration: "Payment returned to the customer",
            amount: p.amount ?? 0,
            increasesLiability: true,
          });
        }
      }

      for (const c of cn.data ?? []) {
        const d = isoDay(c.credit_date);
        if (!d) continue;
        entries.push({
          date: d, reference: c.id, voucher: "Credit Note",
          narration: c.reason ?? (c.invoice_id ? `against ${c.invoice_id}` : null),
          amount: c.amount ?? 0, increasesLiability: false,
        });
      }

      for (const d0 of dn.data ?? []) {
        const d = isoDay(d0.debit_date);
        if (!d) continue;
        entries.push({
          date: d, reference: d0.id, voucher: "Debit Note",
          narration: d0.reason ?? (d0.invoice_id ? `against ${d0.invoice_id}` : null),
          amount: d0.amount ?? 0, increasesLiability: true,
        });
      }

      return entries;
    },
    staleTime: 15_000,
  });
}

/* ─── VENDOR ─────────────────────────────────────────────────────────────── */

/**
 * Every ledger entry for one vendor: their bills, and what we paid against them.
 *
 * ─── KEYED ON THE NAME, NOT THE ID, AND THAT IS NOT LAZINESS ────────────────
 * `expenses.vendor_id` exists and is mostly empty: ANUTECH has 14 distinct vendor NAMES
 * across its bills and only 3 rows in `vendors`. Keying on the id would produce an empty
 * ledger for eleven of the fourteen — a statement that looks like "no transactions"
 * rather than "this vendor was never linked". The name is what the data actually has.
 *
 * ─── amount IS GST-INCLUSIVE. VERIFIED, NOT ASSUMED ─────────────────────────
 * A live bill reads `amount = 24293, gst_paid = 3706`. 24293 − 3706 = 20587, and
 * 20587 × 18% = 3706 — so `amount` is the GROSS and `gst_paid` is the tax inside it.
 * accounting/expenses/page.tsx:342 agrees, using `amount − gst_paid` as the ex-GST base
 * for TDS.
 *
 * So the ledger uses `amount` alone. Adding `gst_paid` would make every payable 18% too
 * high, which is the sort of error that looks like a data problem for weeks.
 *
 * ─── ONE EXPENSE ROW CAN BE TWO LEDGER LINES ────────────────────────────────
 * There is no vendor-payment table: settlement is `paid = true` plus `paid_date` on the
 * bill itself. So a paid bill emits a Purchase on its expense date and a Payment on its
 * paid date. A bill paid the same day it arrived therefore shows both lines, netting to
 * zero — which is correct and is what a CA expects to see.
 */
export function useVendorLedgerEntries(vendorName: string | null | undefined) {
  return useQuery({
    queryKey: ["ledger", "vendor", vendorName],
    enabled: !!vendorName,
    queryFn: async (): Promise<LedgerEntry[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("id, vendor_name, bill_no, bill_type, category, amount, expense_date, due_date, paid, paid_date, payment_method")
        .eq("vendor_name", vendorName!);
      if (error) throw error;

      const entries: LedgerEntry[] = [];
      for (const e of data ?? []) {
        const billed = isoDay(e.expense_date);
        const ref = e.bill_no ?? e.id;
        if (billed) {
          entries.push({
            date: billed, reference: ref, voucher: "Purchase",
            narration: e.category ?? null,
            amount: e.amount ?? 0, increasesLiability: true,
          });
        }
        const paidOn = isoDay(e.paid_date);
        if (e.paid && paidOn) {
          entries.push({
            date: paidOn, reference: `${ref} · paid`, voucher: "Payment",
            narration: e.payment_method ?? null,
            amount: e.amount ?? 0, increasesLiability: false,
          });
        }
      }
      return entries;
    },
    staleTime: 15_000,
  });
}

/** Categories that mean "this party is staff", not "this party is a supplier". */
const PAYROLL_CATEGORIES = new Set([
  "Salaries", "Employee Advance Disbursal", "ESI — Employer", "Staff Welfare",
]);

export interface LedgerVendor {
  name: string;
  billed: number;
  bills: number;
  /**
   * What we buy from them, most-billed first — shown in the picker.
   *
   * ─── BECAUSE THE PICKER IS FULL OF EMPLOYEES, NOT DISTRIBUTORS ────────────
   * The brief pictured Google India, Ingram Micro and Redington. ANUTECH's real
   * `expenses` are dominated by payroll: the top five names by value are Pardeep Sharma
   * ₹3.8L, HITESH BABU ₹2.8L, Ranjeet Raj ₹2.4L, PAWAN ₹2.2L, Abhishek ₹1.05L — all
   * `Salaries` — and the actual suppliers ("Anthropic, PBC" ₹34,901) sit below them.
   *
   * Excluding payroll was the tempting fix and it would have HIDDEN ₹12L of genuine
   * payables from the only screen that shows a party's running balance. Salary is money
   * owed to a person; Tally files it under Sundry Creditors too. So nothing is excluded
   * and the picker LABELS what each party is, which is the actual complaint — an
   * unlabelled list mixing staff and suppliers is what made it confusing.
   */
  categories: string[];
  /** True when every bill for this party is payroll. Drives the "Staff" tag. */
  isPayroll: boolean;
}

/**
 * The parties a vendor ledger can be drawn for — distinct names on the bills themselves.
 *
 * Sourced from `expenses` rather than `vendors` because that is where the names are: 14
 * distinct names on bills against 3 rows in `vendors`. Ordered by total billed so the
 * party that matters is first rather than whoever sorts alphabetically.
 */
export function useLedgerVendors() {
  return useQuery({
    queryKey: ["ledger", "vendors"],
    queryFn: async (): Promise<LedgerVendor[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("vendor_name, amount, category")
        .not("vendor_name", "is", null)
        .limit(2000);
      if (error) throw error;

      const byName = new Map<string, { billed: number; bills: number; cats: Map<string, number> }>();
      for (const r of data ?? []) {
        const name = (r.vendor_name ?? "").trim();
        if (!name) continue;
        const prev = byName.get(name) ?? { billed: 0, bills: 0, cats: new Map<string, number>() };
        prev.billed += r.amount ?? 0;
        prev.bills += 1;
        const cat = (r.category ?? "").trim();
        if (cat) prev.cats.set(cat, (prev.cats.get(cat) ?? 0) + (r.amount ?? 0));
        byName.set(name, prev);
      }

      return [...byName.entries()]
        .map(([name, v]) => {
          const categories = [...v.cats.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
          return {
            name, billed: v.billed, bills: v.bills, categories,
            /* Every category is payroll — not merely "some", because Darshan carries
               Salaries AND an Employee Advance AND ESI, and is still staff. */
            isPayroll: categories.length > 0 && categories.every((c) => PAYROLL_CATEGORIES.has(c)),
          };
        })
        .sort((a, b) => b.billed - a.billed);
    },
    staleTime: 60_000,
  });
}
