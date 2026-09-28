/**
 * Bank Reconciliation Statement — one account, one date: balance per the bank's
 * lines, balance per the books, and every line that explains the gap. Month-end
 * routine for the owner; the CSV is what the CA asks for. lib/banking/brs.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { useBankAccounts, useBankTransactions } from "@/lib/queries/bank";
import { buildBrs, brsRows, type BrsLine } from "@/lib/banking/brs";
import { downloadCSV } from "@/lib/csv";
import { rupee, formatDate } from "@/lib/utils";

function todayIso(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function BrsPage() {
  const { data: accounts, isLoading: accLoading } = useBankAccounts();
  const bankAccounts = React.useMemo(() => (accounts ?? []).filter((a) => a.is_active && a.account_type !== "cash"), [accounts]);
  const [accountId, setAccountId] = React.useState("");
  const [asOf, setAsOf] = React.useState(todayIso());
  const [closing, setClosing] = React.useState("");
  React.useEffect(() => { if (!accountId && bankAccounts.length) setAccountId(bankAccounts[0].id); }, [bankAccounts, accountId]);
  const account = bankAccounts.find((a) => a.id === accountId) ?? null;
  const { data: txns, isLoading: txLoading } = useBankTransactions(accountId || null);

  const brs = React.useMemo(() => {
    if (!account) return null;
    const closingN = closing.trim() === "" ? null : Math.round(Number(closing) || 0);
    return buildBrs({
      openingBalance: account.opening_balance, openingDate: account.opening_balance_date, asOf,
      lines: (txns ?? []) as BrsLine[], statementClosing: closingN,
    });
  }, [account, txns, asOf, closing]);

  function exportCsv() {
    if (!brs || !account) return;
    downloadCSV(`BRS-${account.name.replace(/\s+/g, "-")}-${asOf}.csv`, ["Line", "Amount (INR)"], brsRows(brs, account.name));
  }

  const LineTable = ({ rows, sign }: { rows: BrsLine[]; sign: "credit" | "debit" | "net" }) => (
    <table className="w-full text-sm">
      <tbody className="divide-y divide-hairline">
        {rows.map((l) => (
          <tr key={l.id}>
            <td className="px-3 py-1.5 text-ink-3 whitespace-nowrap">{formatDate(l.txn_date)}</td>
            <td className="px-3 py-1.5 text-ink-2 truncate max-w-[420px]">{l.description}</td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">
              {sign === "credit" ? rupee(l.credit) : sign === "debit" ? rupee(l.debit) : (l.credit > 0 ? `+${rupee(l.credit)}` : `−${rupee(l.debit)}`)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1100px] mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            <Link href="/accounting/banking" className="hover:text-ink">Banking</Link> · Month-end
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Bank Reconciliation Statement</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Bank ke hisaab se balance aur books ke hisaab se balance — aur beech ka har farq naam se.
            Har mahine ke end par ye <b>zero farq</b> par aana chahiye, phir books lock karo.
          </p>
        </div>
        <Button variant="outline" size="sm" icon="download" onClick={exportCsv} disabled={!brs}>Export CSV (for CA)</Button>
      </div>

      <Card className="mb-6 p-3 md:p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="brs-bank-account" className="block text-xs font-medium text-ink-2 mb-1">Bank account</label>
            <select id="brs-bank-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
              {bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.bank_name}{a.account_number_last4 ? ` ····${a.account_number_last4}` : ""}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="brs-as-of" className="block text-xs font-medium text-ink-2 mb-1">As of</label>
            <Input id="brs-as-of" type="date" value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <div>
            <label htmlFor="brs-bank-statement-ka-closing" className="block text-xs font-medium text-ink-2 mb-1">Bank statement ka closing balance (optional)</label>
            <Input id="brs-bank-statement-ka-closing" type="number" value={closing} onChange={(e) => setClosing(e.target.value)} placeholder="Statement PDF se" />
          </div>
        </div>
      </Card>

      {accLoading || txLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : !account ? (
        <Card className="py-2"><EmptyState icon="rupee" title="Koi bank account nahi" body="Banking mein pehle account jodo aur statement import karo." /></Card>
      ) : brs ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="p-4">
              <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Balance per bank (imported lines)</div>
              <div className="font-serif text-2xl text-ink mt-1">{rupee(brs.statementBalance)}</div>
              <div className="text-2xs text-ink-3 mt-0.5">opening {rupee(account.opening_balance)} on {formatDate(account.opening_balance_date)}</div>
            </Card>
            <Card className="p-4">
              <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Balance per books (all lines)</div>
              <div className="font-serif text-2xl text-ink mt-1">{rupee(brs.bookBalance)}</div>
              <div className="text-2xs text-ink-3 mt-0.5">+ {rupee(brs.totals.depositsInTransit)} in transit − {rupee(brs.totals.paymentsNotPresented)} not presented</div>
            </Card>
            <Card className={`p-4 ${brs.clean ? "border-emerald/40 bg-emerald/5" : "border-amber/40 bg-amber-soft/20"}`}>
              <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Status</div>
              <div className={`font-serif text-2xl mt-1 ${brs.clean ? "text-emerald" : "text-amber-ink"}`}>{brs.clean ? "Reconciled" : "Farq hai"}</div>
              <div className="text-2xs text-ink-3 mt-0.5">
                {brs.unbookedImports.length ? `${brs.unbookedImports.length} bank line(s) books mein nahi` : "har bank line booked"}
                {brs.importGap !== null && brs.importGap !== 0 ? ` · import gap ${rupee(Math.abs(brs.importGap))}` : brs.importGap === 0 ? " · statement closing matches" : ""}
              </div>
            </Card>
          </div>

          {brs.importGap !== null && brs.importGap !== 0 && (
            <Card className="p-4 border-rose/40 bg-rose/5">
              <p className="text-sm text-ink">
                <Icon name="alert" size={14} className="inline mr-1 text-rose" />
                Statement ka closing balance imported lines se <b>{rupee(Math.abs(brs.importGap))} {brs.importGap > 0 ? "zyada" : "kam"}</b> hai —
                yaani kuch lines import nahi hui (ya delete ho gayi). Us mahine ka statement dobara import karo; reconcile karne se ye farq nahi jaata.
              </p>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between bg-paper-2/50 px-4 py-2.5">
              <span className="font-semibold text-ink">Bank mein hai, books mein nahi</span>
              <span className="text-xs font-mono text-ink-2">{brs.unbookedImports.length} line · net {rupee(brs.totals.unbookedImports)}</span>
            </div>
            {brs.unbookedImports.length === 0
              ? <p className="px-4 py-3 text-sm text-ink-3">Koi nahi — har imported line kisi entry se judi hai.</p>
              : <>
                  <p className="px-4 pt-2 text-2xs text-ink-3">Bank charges, interest, anjaan receipt — <Link href={`/accounting/banking/${account.id}`} className="text-amber-ink underline">Banking → is account</Link> par har line ko book / reconcile karo.</p>
                  <LineTable rows={brs.unbookedImports} sign="net" />
                </>}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between bg-paper-2/50 px-4 py-2.5">
                <span className="font-semibold text-ink">Payments not yet presented</span>
                <span className="text-xs font-mono text-ink-2">{rupee(brs.totals.paymentsNotPresented)}</span>
              </div>
              {brs.paymentsNotPresented.length === 0
                ? <p className="px-4 py-3 text-sm text-ink-3">Koi nahi.</p>
                : <>
                    <p className="px-4 pt-2 text-2xs text-ink-3">Books mein book ho chuke (Bills / Payroll / Referrals se), bank se abhi nikle nahi. Statement aane par wahi line reconcile karo — ye manual line replace ho jaayegi.</p>
                    <LineTable rows={brs.paymentsNotPresented} sign="debit" />
                  </>}
            </Card>
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between bg-paper-2/50 px-4 py-2.5">
                <span className="font-semibold text-ink">Deposits in transit</span>
                <span className="text-xs font-mono text-ink-2">{rupee(brs.totals.depositsInTransit)}</span>
              </div>
              {brs.depositsInTransit.length === 0
                ? <p className="px-4 py-3 text-sm text-ink-3">Koi nahi.</p>
                : <LineTable rows={brs.depositsInTransit} sign="credit" />}
            </Card>
          </div>

          {brs.ignoredBeforeOpening > 0 && (
            <Card className="p-4 border-amber/40 bg-amber-soft/20">
              <p className="text-sm text-ink">
                <Icon name="alert" size={14} className="inline mr-1 text-amber-ink" />
                <b>{brs.ignoredBeforeOpening} line(s)</b> opening balance ki tareekh ({formatDate(account.opening_balance_date)}) se <b>pehle</b> ki hain — ye ginti mein nahi, isliye upar ke balance adhoore hain.
                Banking → account → Edit mein opening balance ki tareekh sabse purani line se pehle rakho (aur us din ka asli balance likho).
              </p>
            </Card>
          )}
        </div>
      ) : null}
    </div>
  );
}
