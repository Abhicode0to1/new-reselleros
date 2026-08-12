/**
 * QuoteAcceptView — client component for the public quote-accept page.
 * Handles billing-cycle aware display + accept/reject actions.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { isForeignCurrency, formatForeign } from "@/lib/currency";
import { loadRazorpayCheckout } from "@/lib/razorpay/checkout-client";
import type { LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  cycleInvoicesPerYear, cycleUnitLabel, cycleScheduleLabel, cycleFromLegacyCommitment,
} from "@/lib/quotes/billing";

/** Customer-SAFE quote shape — no cost/margin. Built server-side in page.tsx. */
export type PublicQuote = {
  id: string;
  status: string;
  customer_name: string;
  subtotal: number;
  discount_pct: number;
  tax_rate: number;
  amount: number | null;
  expires_date: string | null;
  notes: string | null;
  billing_cycle?: BillingCycle;
  /** Billing currency + rate (migration 0153). Foreign → show the whole quote in
   *  that currency; the ₹ books value stays canonical server-side. */
  currency?: string | null;
  exchange_rate?: number | null;
};
export type PublicLine = {
  id: string;
  name: string;
  qty: number;
  rate: number;
  commitment?: LineCommitment;
};

function scheduleLabel(commitment: LineCommitment | undefined, cycle: BillingCycle): string {
  const tier = commitment === "monthly" ? "Monthly (flex)" : "Annual commit";
  return `${tier} · ${cycleScheduleLabel(cycle)}`;
}

interface Props {
  quote:         PublicQuote;
  lineItems:     PublicLine[];
  token:         string;
  /** Reseller has Razorpay wired + this is a ₹ quote → show "Pay online now". */
  payOnline?:    boolean;
  tenantName:    string;
  tenantGstin:   string | null;
  tenantEmail:   string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;
}

export function QuoteAcceptView({
  quote, lineItems, token, payOnline = false, tenantName, tenantGstin, tenantEmail, tenantPhone, tenantAddress,
}: Props) {
  const [accepting, setAccepting] = React.useState(false);
  const [accepted, setAccepted] = React.useState(quote.status === "accepted");
  const [paying, setPaying] = React.useState(false);
  const [paid, setPaid] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [poOpen, setPoOpen] = React.useState(false);
  const [poNumber, setPoNumber] = React.useState("");
  const [poNotes, setPoNotes] = React.useState("");

  // ── Money, computed CONSISTENTLY in the display currency ──
  // For a foreign quote we work per-unit in the client's currency (₹ ÷ rate,
  // rounded to 2dp) and derive the line amounts + totals from THAT — so qty × rate
  // always equals the amount and the lines sum to the total. Converting each ₹
  // figure independently would let a rounded unit rate disagree with the exact
  // total (e.g. 32 × $32.00 ≠ $1,023.88). The books stay the canonical ₹.
  const fxRate    = quote.exchange_rate && quote.exchange_rate > 0 ? quote.exchange_rate : 1;
  const isForeign = isForeignCurrency(quote.currency);
  const dRound = (v: number) => (isForeign ? Math.round(v * 100) / 100 : Math.round(v));
  const toDisp = (inr: number) => (isForeign ? dRound(inr / fxRate) : inr);
  const fmtC   = (v: number) => (isForeign ? formatForeign(v, quote.currency ?? "") : rupee(v));

  const firstCommitment = lineItems[0]?.commitment;
  const effectiveCycle: BillingCycle = quote.billing_cycle ?? cycleFromLegacyCommitment(firstCommitment);
  const billingN    = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit = cycleUnitLabel(effectiveCycle);
  const perInvoice  = billingN > 1;

  // Per-line figures (annual) in the display currency — rounded unit → amount.
  const dispLines = lineItems.map((line) => {
    const unit   = toDisp(line.rate);       // per seat / year
    const amount = dRound(line.qty * unit); // line total / year
    return { line, unit, amount };
  });
  // ₹ canonical — used as-is for a domestic quote (no rounding drift vs the saved
  // amount); foreign rebuilds in the display currency from the rounded lines.
  const discountInr = Math.round(quote.subtotal * (quote.discount_pct / 100));
  const taxableInr  = quote.subtotal - discountInr;
  const taxInr      = Math.round(taxableInr * (quote.tax_rate / 100));
  const totalInr    = quote.amount ?? (taxableInr + taxInr);
  const dSubtotal = isForeign ? dRound(dispLines.reduce((s, x) => s + x.amount, 0)) : quote.subtotal;
  const dDiscount = isForeign ? dRound(dSubtotal * (quote.discount_pct / 100)) : discountInr;
  const dTaxable  = isForeign ? dRound(dSubtotal - dDiscount) : taxableInr;
  const dTax      = isForeign ? dRound(dTaxable * (quote.tax_rate / 100)) : taxInr;
  const dTotal    = isForeign ? dRound(dTaxable + dTax) : totalInr;

  // Format an ANNUAL display-currency figure, slicing per-invoice when the cycle
  // bills more than once a year.
  const fmtInv = (annual: number) =>
    perInvoice ? `${fmtC(dRound(annual / billingN))}${billingUnit}` : fmtC(annual);

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/accept?t=${encodeURIComponent(token)}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not accept");
      setConfirmOpen(false);
      setAccepted(true);
      toast.success("Quote accepted · the reseller has been notified");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAccepting(false);
    }
  };

  const handlePoAccept = async () => {
    setAccepting(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/accept?t=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poNumber: poNumber.trim(), notes: poNotes.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not accept quote");
      setPoOpen(false);
      setAccepted(true);
      toast.success("Quote accepted with Purchase Order · reseller notified");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAccepting(false);
    }
  };

  const handleRequestChanges = () => {
    if (!tenantEmail) {
      toast.info("Reach out to the reseller via the email they sent you.");
      return;
    }
    const subject = `Changes requested on quote ${quote.id}`;
    const body =
      `Hi ${tenantName},\n\nI'd like to discuss some changes on quote ${quote.id} (total ${fmtC(dTotal)}) before accepting.\n\n` +
      `My questions / changes:\n\n[Type your message here]\n\nThanks,\n${quote.customer_name}`;
    window.location.href = `mailto:${tenantEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const handlePayOnline = async () => {
    setPaying(true);
    try {
      const res = await fetch(`/api/public/quote/${quote.id}/pay?t=${encodeURIComponent(token)}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not start payment");

      // Simulation (no live keys) — the server already recorded the payment.
      if (json.simulated) {
        setPaid(true);
        return;
      }

      // Live — open Razorpay Checkout. The webhook settles via record_payment
      // on capture; we just show the "payment received" screen on success.
      const RazorpayCtor = await loadRazorpayCheckout();
      const rzp = new RazorpayCtor({
        key:         json.razorpayKeyId,
        amount:      json.amount,
        currency:    json.currency,
        name:        tenantName,
        description: `Quote ${quote.id}`,
        order_id:    json.orderId,
        prefill:     { name: quote.customer_name ?? undefined },
        theme:       { color: "#C2410C" },
        handler:     () => { setPaid(true); },
        modal:       { ondismiss: () => setPaying(false) },
      });
      rzp.on("payment.failed", (r) => {
        toast.error(r.error?.description ?? "Payment failed — please try again.");
        setPaying(false);
      });
      rzp.open();
    } catch (e) {
      toast.error((e as Error).message);
      setPaying(false);
    }
  };

  // ──────────── Thank-you screen (accepted OR paid) ────────────
  if (accepted || paid) {
    return (
      <div className="min-h-screen bg-paper-2/30 flex items-start justify-center py-10 px-4">
        <div className="max-w-2xl w-full bg-paper rounded-xl shadow-sm border border-hairline p-8 md:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-emerald/15 grid place-items-center">
            <Icon name="check_circle" size={32} className="text-emerald" />
          </div>
          <h1 className="font-serif text-3xl text-ink mb-2">{paid ? "Payment received" : "Quote accepted"}</h1>
          <p className="text-sm text-ink-3">
            {paid ? (
              <>Thank you! Your payment to <b className="text-ink">{tenantName}</b> is being confirmed.
              Your GST invoice will be issued and emailed to you shortly.</>
            ) : (
              <><b className="text-ink">{tenantName}</b> has been notified and will reach out with
              payment instructions. Your GST invoice is issued once payment is received.</>
            )}
          </p>
          <div className="bg-paper-2 rounded-lg p-4 mt-6 text-sm text-left">
            <div className="flex justify-between mb-1.5">
              <span className="text-ink-3">Quote ID</span>
              <span className="font-mono font-semibold">{quote.id}</span>
            </div>
            <div className="flex justify-between mb-1.5">
              <span className="text-ink-3">Total</span>
              <span className="font-serif text-lg">{fmtC(dTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-3">Billing</span>
              <span>{scheduleLabel(firstCommitment, effectiveCycle)}</span>
            </div>
          </div>
          <Button
            variant="ghost"
            icon="printer"
            className="mt-6"
            onClick={() => window.print()}
          >
            Print this confirmation
          </Button>
        </div>
      </div>
    );
  }

  // ──────────── No-longer-available screen (expired / rejected) ────────────
  // These states can't be accepted (the API rejects them), so don't show the
  // customer a working "Accept" button that only errors when clicked.
  if (quote.status === "expired" || quote.status === "rejected") {
    return (
      <div className="min-h-screen bg-paper-2/30 flex items-start justify-center py-10 px-4">
        <div className="max-w-2xl w-full bg-paper rounded-xl shadow-sm border border-hairline p-8 md:p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-rose/15 grid place-items-center">
            <Icon name="alert" size={32} className="text-rose" />
          </div>
          <h1 className="font-serif text-3xl text-ink mb-2">
            {quote.status === "expired" ? "This quote has expired" : "This quote is no longer available"}
          </h1>
          <p className="text-sm text-ink-3">
            Quote <span className="font-mono">{quote.id}</span> can no longer be accepted online.
            Please contact <b className="text-ink">{tenantName}</b> for an updated quote.
          </p>
          {tenantEmail && (
            <Button asChild variant="primary" className="mt-6">
              <a href={`mailto:${tenantEmail}?subject=${encodeURIComponent(`New quote request (ref ${quote.id})`)}`}>
                Request a fresh quote
              </a>
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ──────────── Quote review screen ────────────
  return (
    <div className="min-h-screen bg-paper-2/30 py-6 px-4">
      <div className="max-w-3xl mx-auto bg-paper rounded-xl shadow-sm border border-hairline overflow-hidden">
        {/* Top action bar — sticky, hidden in print */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-hairline bg-paper-2 print:hidden sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <Icon name="file" size={16} className="text-ink-3" />
            <span className="text-sm font-semibold text-ink">Your quote · review and accept</span>
          </div>
          <Button size="sm" icon="file" variant="ghost" onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>

        {/* ── PDF-style document ── */}
        <div className="p-8 md:p-12 print:p-0 font-sans text-ink">
          {/* Brand header */}
          <div className="flex items-start justify-between border-b-2 border-ink pb-5 mb-6 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-ink text-paper grid place-items-center font-serif text-2xl">
                {tenantName.charAt(0)}
              </div>
              <div>
                <div className="font-serif text-2xl leading-tight">{tenantName}</div>
                {tenantGstin && (
                  <div className="text-xs text-ink-3 mt-0.5">
                    GSTIN: <span className="font-mono">{tenantGstin}</span>
                  </div>
                )}
                {tenantAddress && (
                  <div className="text-xs text-ink-3 mt-0.5 max-w-[280px]">{tenantAddress}</div>
                )}
                {(tenantEmail || tenantPhone) && (
                  <div className="text-xs text-ink-3 font-mono mt-0.5">
                    {tenantEmail}
                    {tenantEmail && tenantPhone && " · "}
                    {tenantPhone}
                  </div>
                )}
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold">Quotation</p>
              <p className="font-serif text-3xl mt-1">{quote.id}</p>
              {quote.expires_date && (
                <p className="text-xs text-ink-3 mt-1">
                  Valid until: <b>{formatDate(quote.expires_date)}</b>
                </p>
              )}
            </div>
          </div>

          {/* Bill to + billing */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Prepared for</p>
              <p className="font-serif text-lg leading-tight">{quote.customer_name}</p>
            </div>
            <div className="sm:text-right">
              {lineItems.length > 0 && firstCommitment && (
                <>
                  <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Billing schedule</p>
                  <p className="text-sm">{scheduleLabel(firstCommitment, effectiveCycle)}</p>
                  {billingN > 1 && (
                    <p className="text-[11px] text-ink-3">{billingN} invoices per year</p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Line items */}
          <table className="w-full mb-6">
            <thead className="border-y-2 border-ink">
              <tr>
                <th className="text-left py-2 text-[11px] uppercase tracking-wider font-semibold">Item</th>
                <th className="text-right py-2 text-[11px] uppercase tracking-wider font-semibold w-16">Qty</th>
                <th className="text-right py-2 text-[11px] uppercase tracking-wider font-semibold w-28">Rate</th>
                <th className="text-right py-2 text-[11px] uppercase tracking-wider font-semibold w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {dispLines.map(({ line, unit, amount }) => (
                <tr key={line.id} className="border-b border-hairline">
                  <td className="py-3 text-sm">
                    <p className="font-medium">{line.name}</p>
                    {line.commitment && (
                      <p className="text-[11px] text-ink-3 mt-0.5">
                        {scheduleLabel(line.commitment, effectiveCycle)}
                      </p>
                    )}
                  </td>
                  <td className="py-3 text-right text-sm tabular-nums">{line.qty}</td>
                  <td className="py-3 text-right text-sm tabular-nums">{fmtInv(unit)}</td>
                  <td className="py-3 text-right text-sm tabular-nums font-medium">{fmtInv(amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end mb-6">
            <div className="w-full max-w-xs space-y-2 text-sm">
              <Row label="Subtotal" value={fmtInv(dSubtotal)} />
              {quote.discount_pct > 0 && (
                <Row label={`Discount (${quote.discount_pct}%)`} value={`−${fmtInv(dDiscount)}`} accent />
              )}
              <Row label="Taxable" value={fmtInv(dTaxable)} />
              <Row label={`GST (${quote.tax_rate}%)`} value={fmtInv(dTax)} />
              <div className="border-t-2 border-ink pt-2 mt-2">
                <div className="flex justify-between items-baseline">
                  <span className="text-[11px] uppercase tracking-widest font-semibold">
                    {/* Annual upfront (single yearly invoice) → emphasize "payable now"
                        so customer knows full amount needs to clear in one go. */}
                    {perInvoice ? `Per invoice (${billingN}/yr)` : (billingN === 1 ? "Total payable now" : "Total")}
                  </span>
                  <span className="font-serif text-2xl tabular-nums">
                    {perInvoice
                      ? `${fmtC(dRound(dTotal / billingN))}${billingUnit}`
                      : fmtC(dTotal)}
                  </span>
                </div>
                {perInvoice && (
                  <div className="flex justify-between items-baseline mt-1.5 text-ink-3">
                    <span className="text-[11px]">Annual contract value</span>
                    <span className="text-sm tabular-nums">{fmtC(dTotal)}/yr</span>
                  </div>
                )}
                {!perInvoice && billingN === 1 && (
                  <div className="mt-1.5 text-[11px] text-emerald font-medium">
                    ✓ One-time payment · covers full 12 months of service
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Notes */}
          {quote.notes && (
            <div className="mb-6 pt-4 border-t border-hairline">
              <p className="text-[10px] uppercase tracking-widest text-ink-3 font-semibold mb-1.5">Notes</p>
              <p className="text-sm whitespace-pre-wrap leading-relaxed text-ink-2">{quote.notes}</p>
            </div>
          )}

          {/* Action zone — hidden in print */}
          <div className="pt-6 mt-6 border-t border-hairline print:hidden space-y-3">
            {payOnline && (
              <Button
                variant="primary"
                size="lg"
                icon="rupee"
                loading={paying}
                onClick={handlePayOnline}
                className="w-full justify-center"
              >
                Pay online now · {fmtC(dTotal)}
              </Button>
            )}
            <Button
              variant={payOnline ? "default" : "primary"}
              size="lg"
              icon="check_circle"
              loading={accepting}
              disabled={paying}
              onClick={() => setConfirmOpen(true)}
              className="w-full justify-center"
            >
              {payOnline ? "Accept & pay later" : `Accept this quote · ${fmtC(dTotal)}`}
            </Button>
            <Button
              variant="default"
              size="lg"
              icon="file"
              disabled={paying || accepting}
              onClick={() => setPoOpen(true)}
              className="w-full justify-center border border-hairline bg-paper hover:bg-paper-2 transition-colors"
            >
              Submit Purchase Order (PO) / Request PI
            </Button>
            <Button
              variant="ghost"
              icon="mail"
              onClick={handleRequestChanges}
              className="w-full justify-center"
            >
              Request changes / revision
            </Button>
            <p className="text-[11px] text-ink-3 text-center leading-relaxed pt-2">
              {payOnline
                ? <>Pay securely via Razorpay (UPI / card / net-banking) — your GST invoice is issued automatically once payment is confirmed. Or accept with PO and {tenantName} will share payment instructions.</>
                : <>By accepting, you agree to the pricing and billing terms shown above. {tenantName} will share payment instructions and issue your GST invoice once payment is received. No payment is taken on this page.</>}
            </p>
          </div>
        </div>
      </div>

      {/* Accept with Purchase Order (PO) Dialog */}
      {poOpen && (
        <div
          className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !accepting && setPoOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-paper w-full sm:max-w-md rounded-t-2xl sm:rounded-xl shadow-lg border border-hairline p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-full bg-indigo/10 text-indigo grid place-items-center shrink-0">
                <Icon name="file" size={20} />
              </div>
              <div>
                <h3 className="font-serif text-xl text-ink leading-tight">
                  Submit Purchase Order (PO)
                </h3>
                <p className="text-xs text-ink-3">Accept quote with PO details or request Proforma Invoice</p>
              </div>
            </div>
            <div className="space-y-3 mt-4">
              <div>
                <label htmlFor="poNum" className="block text-xs font-semibold text-ink-2 mb-1">
                  Purchase Order Number (Optional)
                </label>
                <input
                  id="poNum"
                  type="text"
                  placeholder="e.g. PO-2026-8941"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm font-mono text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                />
              </div>
              <div>
                <label htmlFor="poNotes" className="block text-xs font-semibold text-ink-2 mb-1">
                  Notes / Billing Instructions
                </label>
                <textarea
                  id="poNotes"
                  rows={3}
                  placeholder="e.g. Please issue Proforma Invoice to Accounts Dept."
                  value={poNotes}
                  onChange={(e) => setPoNotes(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-ink"
                />
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => setPoOpen(false)}
                disabled={accepting}
                className="sm:w-auto justify-center"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="check_circle"
                loading={accepting}
                onClick={handlePoAccept}
                className="sm:w-auto justify-center"
              >
                Submit &amp; Accept
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Accept confirmation — styled dialog, not a browser confirm() */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !accepting && setConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="accept-confirm-title"
        >
          <div
            className="bg-paper w-full sm:max-w-md rounded-t-2xl sm:rounded-xl shadow-lg border border-hairline p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="h-10 w-10 rounded-full bg-emerald/10 text-emerald grid place-items-center shrink-0">
                <Icon name="check_circle" size={20} />
              </div>
              <h3 id="accept-confirm-title" className="font-serif text-xl text-ink leading-tight">
                Accept this quote?
              </h3>
            </div>
            <p className="text-sm text-ink-2 leading-relaxed">
              You&apos;re accepting quote <span className="font-mono text-ink">{quote.id}</span> for{" "}
              <span className="font-semibold text-ink">{fmtC(dTotal)}</span>.
            </p>
            <p className="text-[13px] text-ink-3 leading-relaxed mt-2">
              {tenantName} will be notified and will share payment instructions. No payment is taken now.
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={accepting}
                className="sm:w-auto justify-center"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="check_circle"
                loading={accepting}
                onClick={handleAccept}
                className="sm:w-auto justify-center"
              >
                Confirm &amp; accept
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-ink-3">{label}</span>
      <span className={`tabular-nums ${accent ? "text-emerald" : "text-ink"}`}>{value}</span>
    </div>
  );
}
