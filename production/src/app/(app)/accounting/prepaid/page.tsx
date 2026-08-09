/**
 * Prepaid / Vendor Advances — money paid to a vendor before the service is used
 * (e.g. a Facebook ad top-up). Held as a prepaid ASSET; "Consume" books the real
 * expense (P&L) as it's used and reduces the balance.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
// (icons come via Button/FAB `icon` props)
import { FAB } from "@/components/ui/fab";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import { useVendors, ensureVendor } from "@/lib/queries/vendors";
import { Icon } from "@/components/ui/icon";
import {
  usePrepaidAdvances, useCreatePrepaidAdvance, useConsumePrepaidAdvance, useDeletePrepaidAdvance,
  type PrepaidAdvance,
} from "@/lib/queries/prepaid-advances";

const CATEGORIES = ["Marketing", "Advertising", "Software / SaaS", "Hosting", "Subscriptions", "Other"];
const METHODS = ["bank_transfer", "upi", "card", "cheque"];

export default function PrepaidAdvancesPage() {
  const q = usePrepaidAdvances();
  const del = useDeletePrepaidAdvance();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = React.useState(false);
  const [consume, setConsume] = React.useState<PrepaidAdvance | null>(null);

  const rows = q.data ?? [];
  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Prepaid / Advances</h1>
          <p className="text-sm text-ink-2 mt-1 max-w-2xl">
            Money paid to a vendor <b>before</b> the service is used — e.g. a Facebook ad top-up. Held as an
            asset; <b>Consume</b> it as the service runs to book the real expense in your P&amp;L.
          </p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex shrink-0" onClick={() => setAddOpen(true)}>Add advance</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
        <KPI label="Open advances" value={String(rows.filter((r) => r.balance > 0).length)} />
        <KPI label="Prepaid balance" value={rupee(totalBalance)} tone={totalBalance > 0 ? "amber" : undefined} sub="asset — not yet expensed" />
        <KPI label="Consumed (all)" value={rupee(rows.reduce((s, r) => s + r.consumed_amount, 0))} tone="emerald" sub="booked to P&L" />
      </div>

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="rupee" title="No prepaid advances yet"
            body="Paid a vendor in advance (like Facebook ads)? Record it here so it's tracked as an asset and expensed as you use it."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add advance</Button>} />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => {
            const pct = r.total_amount > 0 ? Math.min(100, Math.round((r.consumed_amount / r.total_amount) * 100)) : 0;
            const done = r.balance <= 0;
            return (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-ink">{r.vendor_name}</span>
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo/10 text-indigo">{r.category}</span>
                        {done && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald/10 text-emerald">Fully used</span>}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        Paid {formatDate(r.paid_date)}{r.payment_method ? ` · ${r.payment_method.replace(/_/g, " ")}` : ""}
                        {r.notes ? ` · ${r.notes}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-serif text-2xl text-ink leading-none">{rupee(r.balance)}</div>
                      <div className="text-[10px] text-ink-3 mt-0.5">balance of {rupee(r.total_amount)}</div>
                    </div>
                  </div>
                  {/* consumed bar */}
                  <div className="mt-3 h-1.5 rounded-full bg-paper-2 overflow-hidden">
                    <div className="h-full bg-emerald" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
                    <span>{rupee(r.consumed_amount)} used ({pct}%)</span>
                    <div className="flex items-center gap-1">
                      {!done && (
                        <Button variant="primary" className="h-7 px-2.5 text-[11px]" icon="check" onClick={() => setConsume(r)}>Consume</Button>
                      )}
                      <Button variant="ghost" className="h-7 px-2 text-[11px]"
                        onClick={async () => { if (await confirm({ title: `Delete this advance?`, body: "This removes the advance record. Expenses already booked from it stay.", danger: true, confirmLabel: "Delete" })) del.mutate(r.id); }}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <FAB icon="plus" label="Advance" onClick={() => setAddOpen(true)} ariaLabel="Add advance" />
      {addOpen && <AddAdvanceDialog onClose={() => setAddOpen(false)} />}
      {consume && <ConsumeDialog advance={consume} onClose={() => setConsume(null)} />}
    </div>
  );
}

function AddAdvanceDialog({ onClose }: { onClose: () => void }) {
  const create = useCreatePrepaidAdvance();
  const { data: accounts } = useBankAccounts();
  // All active accounts — bank AND petty cash (an advance can be paid in cash too).
  const payAccounts = (accounts ?? []).filter((a) => a.is_active !== false);
  const { data: vendors } = useVendors();
  const today = new Date().toISOString().slice(0, 10);
  const [vendor, setVendor] = React.useState("");
  const [vendorId, setVendorId] = React.useState<string | null>(null);
  const [vendorOpen, setVendorOpen] = React.useState(false);
  const [category, setCategory] = React.useState("Marketing");
  const [amount, setAmount] = React.useState("");
  const [paidDate, setPaidDate] = React.useState(today);
  const [method, setMethod] = React.useState("bank_transfer");
  const [bankId, setBankId] = React.useState("");
  const [notes, setNotes] = React.useState("");

  const vName = vendor.trim();
  const vMatch = (vendors ?? []).find((v) => v.name.toLowerCase() === vName.toLowerCase());
  const isNewVendor = vName.length > 0 && !vMatch;

  async function submit() {
    const amt = Math.round(Number(amount) || 0);
    if (!vName) { return; }
    if (amt <= 0) { return; }
    // Link an existing vendor, or create a new one in the master.
    const vId = vendorId ?? vMatch?.id ?? (isNewVendor ? await ensureVendor({ name: vName, defaultCategory: category }) : null);
    await create.mutateAsync({
      vendor_name: vName, vendor_id: vId, category, total_amount: amt, paid_date: paidDate,
      payment_method: method, bank_account_id: bankId || null, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add prepaid advance</DialogTitle>
          <DialogDescription>Money paid to a vendor before using the service. Held as an asset until consumed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Vendor" required htmlFor="pa_vendor">
            <div className="relative">
              <Input id="pa_vendor" autoComplete="off" placeholder="e.g. Facebook / Google Ads"
                value={vendor}
                onChange={(e) => { setVendor(e.target.value); setVendorId(null); setVendorOpen(true); }}
                onFocus={() => setVendorOpen(true)}
                onBlur={() => setTimeout(() => setVendorOpen(false), 130)} autoFocus />
              {vendorOpen && (vendors ?? []).length > 0 && (() => {
                const qy = vName.toLowerCase();
                const matches = (vendors ?? []).filter((v) => !qy || v.name.toLowerCase().includes(qy)).slice(0, 8);
                if (matches.length === 0) return null;
                return (
                  <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
                    {matches.map((v) => (
                      <button key={v.id} type="button"
                        onMouseDown={(e) => { e.preventDefault(); setVendor(v.name); setVendorId(v.id); setVendorOpen(false); }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2">
                        <span className="text-ink truncate">{v.name}</span>
                        {v.gstin && <span className="text-[10px] text-ink-3 font-mono shrink-0">{v.gstin}</span>}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            {vendorId || vMatch ? (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-emerald"><Icon name="check_circle" size={12} /> Existing vendor — isi se link hoga.</p>
            ) : isNewVendor ? (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-ink"><Icon name="plus" size={12} /> Naya vendor &ldquo;{vName}&rdquo; — Save par Vendors master me add ho jayega.</p>
            ) : null}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Will be expensed as" htmlFor="pa_cat">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="pa_cat"><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label="Advance amount (₹)" required htmlFor="pa_amt">
              <Input id="pa_amt" type="number" min={1} prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Paid on" htmlFor="pa_date">
              <Input id="pa_date" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </FormField>
            <FormField label="Paid by" htmlFor="pa_method">
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="pa_method"><SelectValue /></SelectTrigger>
                <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m}>{m.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>
          {payAccounts.length > 0 && (
            <FormField label="From which account?" htmlFor="pa_bank">
              <Select value={bankId || "none"} onValueChange={(v) => setBankId(v === "none" ? "" : v)}>
                <SelectTrigger id="pa_bank"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not sure / pick later</SelectItem>
                  {payAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.account_type === "cash" ? "💵 " : ""}{a.name}{a.bank_name ? ` · ${a.bank_name}` : ""}{a.account_type === "cash" ? " (cash)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-ink-3 mt-1">Bank ho to Banking me usi debit line se reconcile karo; petty cash bhi chun sakte ho.</p>
            </FormField>
          )}
          <FormField label="Note (optional)" htmlFor="pa_notes">
            <Input id="pa_notes" placeholder="e.g. Jan campaign top-up" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={create.isPending}
            disabled={!vendor.trim() || !(Number(amount) > 0)} onClick={submit}>Save advance</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConsumeDialog({ advance, onClose }: { advance: PrepaidAdvance; onClose: () => void }) {
  const consume = useConsumePrepaidAdvance();
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = React.useState(String(advance.balance));
  const [date, setDate] = React.useState(today);
  const [note, setNote] = React.useState("");
  const amt = Math.round(Number(amount) || 0);
  const tooMuch = amt > advance.balance;

  async function submit() {
    if (amt <= 0 || tooMuch) return;
    await consume.mutateAsync({ advanceId: advance.id, amount: amt, date, note: note.trim() || null });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Consume — {advance.vendor_name}</DialogTitle>
          <DialogDescription>
            Balance {rupee(advance.balance)}. This books a <b>{advance.category}</b> expense in your P&amp;L and reduces the advance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Amount used (₹)" required htmlFor="cons_amt">
            <Input id="cons_amt" type="number" min={1} prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} error={tooMuch ? "More than the remaining balance" : undefined} />
            <button type="button" className="text-[11px] text-amber-ink hover:underline mt-1" onClick={() => setAmount(String(advance.balance))}>Use full balance ({rupee(advance.balance)})</button>
          </FormField>
          <FormField label="Date" htmlFor="cons_date">
            <Input id="cons_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Note (optional)" htmlFor="cons_note">
            <Input id="cons_note" placeholder="e.g. ads run 1–15 Jan" value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={consume.isPending} disabled={amt <= 0 || tooMuch} onClick={submit}>
            Book {rupee(amt > 0 ? amt : 0)} expense
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KPI({ label, value, tone, sub }: { label: string; value: string; tone?: "emerald" | "amber"; sub?: string }) {
  const c = tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber-ink" : "text-ink";
  return (
    <Card className="p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5 truncate">{label}</div>
      <div className={`font-serif text-lg md:text-xl ${c} leading-tight truncate`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-3 truncate">{sub}</div>}
    </Card>
  );
}
