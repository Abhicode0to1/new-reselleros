/**
 * Money out — every debit bank line with the payee and the "what" resolved from the
 * record it was reconciled to (lib/accounting/payments-made.ts).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { payeeFromNarration } from "@/lib/banking/narration";
import { groupOf, type PaidOutLine } from "@/lib/accounting/payments-made";

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function useMoneyOut() {
  return useQuery({
    queryKey: ["payments-made"],
    queryFn: async (): Promise<PaidOutLine[]> => {
      const supabase = createClient();
      const [{ data: txns, error }, { data: accounts }] = await Promise.all([
        supabase.from("bank_transactions")
          .select("id, txn_date, description, debit, reference, matched_to_type, matched_to_id, bank_account_id")
          .gt("debit", 0).order("txn_date", { ascending: false }).limit(2000),
        supabase.from("bank_accounts").select("id, name"),
      ]);
      if (error) throw error;
      const accountName = new Map((accounts ?? []).map((a) => [a.id, a.name]));
      const rows = (txns ?? []).filter((t) => t.matched_to_type !== "transfer");

      const idsOf = (type: string) => rows.filter((t) => t.matched_to_type === type && t.matched_to_id).map((t) => t.matched_to_id as string);
      const expIds = idsOf("expense"), salIds = idsOf("salary").concat(idsOf("split")), billIds = idsOf("vendor_bill"),
        statIds = idsOf("statutory"), prepIds = idsOf("prepaid"), commIds = idsOf("referral_commission");

      const [exps, sals, bills, dues, taxes, preps, comms] = await Promise.all([
        expIds.length ? supabase.from("expenses").select("id, vendor_name, category, bill_no, description").in("id", expIds) : Promise.resolve({ data: [] }),
        salIds.length ? supabase.from("salary_payments").select("id, period, employee_id, employees!salary_payments_employee_id_fkey(name)").in("id", salIds) : Promise.resolve({ data: [] }),
        billIds.length ? supabase.from("vendor_bills").select("id, vendor_name, bill_no").in("id", billIds) : Promise.resolve({ data: [] }),
        statIds.length ? supabase.from("statutory_dues_payments").select("id, kind, period, challan_no").in("id", statIds) : Promise.resolve({ data: [] }),
        statIds.length ? supabase.from("tax_payments").select("id, kind, period, fy").in("id", statIds) : Promise.resolve({ data: [] }),
        prepIds.length ? supabase.from("prepaid_advances").select("id, vendor_name, category").in("id", prepIds) : Promise.resolve({ data: [] }),
        commIds.length ? supabase.from("referral_commissions").select("id, referral_partners(name)").in("id", commIds) : Promise.resolve({ data: [] }),
      ]);
      const exp = new Map(((exps.data ?? []) as { id: string; vendor_name: string | null; category: string; bill_no: string | null; description: string | null }[]).map((e) => [e.id, e]));
      const sal = new Map(((sals.data ?? []) as unknown as { id: string; period: string; employees?: { name: string | null } | null }[]).map((s) => [s.id, s]));
      const bill = new Map(((bills.data ?? []) as { id: string; vendor_name: string; bill_no: string | null }[]).map((b) => [b.id, b]));
      const due = new Map(((dues.data ?? []) as { id: string; kind: string; period: string | null; challan_no: string | null }[]).map((d) => [d.id, d]));
      const tax = new Map(((taxes.data ?? []) as { id: string; kind: string; period: string | null; fy: string | null }[]).map((t) => [t.id, t]));
      const prep = new Map(((preps.data ?? []) as { id: string; vendor_name: string; category: string }[]).map((p) => [p.id, p]));
      const comm = new Map(((comms.data ?? []) as unknown as { id: string; referral_partners?: { name: string | null } | null }[]).map((c) => [c.id, c]));

      const KIND: Record<string, string> = { tds: "TDS challan", pf: "PF (EPFO) challan", esi: "ESI challan", mixed: "TDS/PF/ESI challan", gst: "GST (3B) challan", advance_tax: "Advance tax", self_assessment_tax: "Self-assessment tax" };
      const narr = (d: string | null) => { const p = payeeFromNarration(d); return p ? titleCase(p) : (d ?? "").slice(0, 40) || "—"; };

      return rows.flatMap((t) => {
        const group = groupOf(t.matched_to_type);
        if (!group) return [];
        const id = t.matched_to_id ?? "";
        let payee = narr(t.description), what = "—", reference: string | null = t.reference ?? null;
        switch (t.matched_to_type) {
          case "expense": { const e = exp.get(id); if (e) { payee = e.vendor_name || payee; what = e.category; reference = e.bill_no ?? reference; } break; }
          case "vendor_bill": { const b = bill.get(id); if (b) { payee = b.vendor_name; what = "Vendor bill"; reference = b.bill_no ?? reference; } break; }
          case "salary": case "split": { const s = sal.get(id); if (s) { payee = s.employees?.name ?? payee; what = `Salary ${s.period}${t.matched_to_type === "split" ? " (+ advance)" : ""}`; } else what = "Salary"; break; }
          case "statutory": {
            const d = due.get(id), x = tax.get(id);
            if (d) { payee = "Government"; what = `${KIND[d.kind] ?? d.kind}${d.period ? ` · ${d.period}` : ""}`; reference = d.challan_no ?? reference; }
            else if (x) { payee = "Government"; what = `${KIND[x.kind] ?? x.kind}${x.period ? ` · ${x.period}` : x.fy ? ` · FY ${x.fy}` : ""}`; }
            else what = "Statutory / tax";
            break;
          }
          case "prepaid": { const p = prep.get(id); if (p) { payee = p.vendor_name; what = `Advance (${p.category})`; } else what = "Advance"; break; }
          case "referral_commission": { const c = comm.get(id); payee = c?.referral_partners?.name ?? payee; what = "Referral commission"; break; }
          case "manual": what = "Capital / loan / EMI (hand-booked)"; break;
          case "project": what = "Project payment"; break;
          case "payment": what = "Customer refund"; break;
          default: what = t.matched_to_type ?? "Not reconciled";
        }
        return [{
          id: t.id, txn_date: t.txn_date, amount: t.debit, payee, what, reference,
          account: accountName.get(t.bank_account_id) ?? "—", group, matched_to_type: t.matched_to_type, matched_to_id: t.matched_to_id, description: t.description,
          bank_account_id: t.bank_account_id,
        } satisfies PaidOutLine];
      });
    },
    staleTime: 30_000,
  });
}
