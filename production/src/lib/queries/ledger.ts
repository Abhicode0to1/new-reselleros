/**
 * Ledger data — every transaction against one customer or one vendor.
 *
 * ─── OPENING BALANCE IS NEVER ZEROED BY THE DATE FILTER ─────────────────────
 * A statement for FY 2026-27 that starts at zero claims the party had no history before
 * 1 April. Until S17 (28 Sep 2026) these hooks therefore fetched the party's WHOLE history
 * and `buildLedger` derived the opening. Now `report_party_ledger` (migration
 * 20260928110000) does the same sum in SQL — the signed total of everything before the
 * window — and returns only the window's entries; `buildLedgerFromWindow` renders them.
 * Same numbers, and a customer with ten years of invoices no longer ships all of them to
 * the browser (or gets silently cut at PostgREST's row cap).
 *
 * The RPC is SECURITY INVOKER with an explicit tenant filter on top of RLS.
 *
 * ─── WHAT IS DELIBERATELY NOT IN THE VENDOR LEDGER ──────────────────────────
 * `purchase_orders`. A PO is an ORDER placed with Google or Microsoft, not a bill they have
 * sent. Nothing is owed until the vendor invoices. The vendor's bill IS `expenses` (it
 * carries bill_no, bill_type, due_date, paid, paid_date), which is what this uses.
 *
 * ─── amount IS GST-INCLUSIVE. VERIFIED, NOT ASSUMED ─────────────────────────
 * A live bill reads `amount = 24293, gst_paid = 3706` — `amount` is the GROSS. The ledger
 * uses `amount` alone; adding `gst_paid` would make every payable 18% too high.
 *
 * ─── A REFUNDED PAYMENT IS TWO EVENTS, NOT ZERO ─────────────────────────────
 * A Receipt on `received_at` and a Refund on `refunded_at`, which is what the bank shows.
 * One paid expense is likewise a Purchase on its date and a Payment on its paid date.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  buildLedgerFromWindow, type LedgerEntry, type LedgerKind, type LedgerPeriod, type LedgerStatement,
} from "@/lib/accounting/ledger";
import { rpcValueOrThrow } from "@/lib/accounting/report-rpc";

/** `report_party_ledger` ka jawab. */
export interface PartyLedgerRpc {
  opening: number;
  entries: LedgerEntry[];
}

export function statementFromRpc(kind: LedgerKind, r: PartyLedgerRpc, period: LedgerPeriod): LedgerStatement {
  return buildLedgerFromWindow(kind, r.opening, r.entries, period);
}

function usePartyLedger(kind: LedgerKind, party: string | null | undefined, period: LedgerPeriod) {
  return useQuery({
    queryKey: ["ledger", kind, party, period.from, period.to],
    enabled: !!party,
    queryFn: async (): Promise<LedgerStatement> => {
      const supabase = createClient();
      const res = await supabase.rpc("report_party_ledger", {
        p_kind: kind, p_party: party!, p_from: period.from, p_to: period.to,
      });
      return statementFromRpc(kind, rpcValueOrThrow<PartyLedgerRpc>(res, "report_party_ledger"), period);
    },
    staleTime: 15_000,
  });
}

/** One customer's statement: invoices, receipts, refunds, credit and debit notes. */
export function useCustomerLedger(customerId: string | null | undefined, period: LedgerPeriod) {
  return usePartyLedger("customer", customerId, period);
}

/**
 * One vendor's statement: their bills (expenses) and what we paid against them.
 *
 * ─── KEYED ON THE NAME, NOT THE ID, AND THAT IS NOT LAZINESS ────────────────
 * `expenses.vendor_id` is mostly empty: ANUTECH has 14 distinct vendor NAMES across its
 * bills and only 3 rows in `vendors`. Keying on the id would produce an empty ledger for
 * eleven of the fourteen. The name is what the data actually has.
 */
export function useVendorLedger(vendorName: string | null | undefined, period: LedgerPeriod) {
  return usePartyLedger("vendor", vendorName, period);
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
   * ANUTECH's real `expenses` are dominated by payroll: the top five names by value are all
   * `Salaries`, and the actual suppliers sit below them. Excluding payroll would have HIDDEN
   * ₹12L of genuine payables from the only screen that shows a party's running balance.
   * Salary is money owed to a person; Tally files it under Sundry Creditors too. So nothing
   * is excluded and the picker LABELS what each party is.
   */
  categories: string[];
  /** True when every bill for this party is payroll. Drives the "Staff" tag. */
  isPayroll: boolean;
}

/** RPC rows → picker rows. Every category is payroll — not merely "some" (Darshan carries
 *  Salaries AND an Employee Advance AND ESI, and is still staff). */
export function ledgerVendorsFromRpc(rows: Omit<LedgerVendor, "isPayroll">[]): LedgerVendor[] {
  return rows.map((v) => ({
    ...v,
    isPayroll: v.categories.length > 0 && v.categories.every((c) => PAYROLL_CATEGORIES.has(c)),
  }));
}

/**
 * The parties a vendor ledger can be drawn for — distinct names on the bills themselves,
 * biggest first. `report_ledger_vendors` groups in SQL; the old `.limit(2000)` read would
 * have silently dropped every vendor whose bills came after row 2000.
 */
export function useLedgerVendors() {
  return useQuery({
    queryKey: ["ledger", "vendors"],
    queryFn: async (): Promise<LedgerVendor[]> => {
      const supabase = createClient();
      const res = await supabase.rpc("report_ledger_vendors");   // no-arg fn: generated Args = never
      return ledgerVendorsFromRpc(rpcValueOrThrow<Omit<LedgerVendor, "isPayroll">[]>(res, "report_ledger_vendors"));
    },
    staleTime: 60_000,
  });
}
