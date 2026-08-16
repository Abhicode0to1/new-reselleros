/**
 * AddSubscriptionDialog — 1-Click Onboard Subscription with Auto-Synced Customer & Quote/Invoice records.
 *
 * Allows adding/importing an active subscription directly from the Subscriptions page:
 *   1. Auto-creates or links Customer CRM record.
 *   2. Auto-generates Quote & Audit Invoice record (Accepted / Credit Term or Paid).
 *   3. Auto-creates Active Subscription with Domain, Seats, MRR & Renewal Date.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useItems } from "@/lib/queries/items";
import {
  subscriptionProducts, catalogVendors, productsForVendor, findProduct, judgePrice,
  type CatalogProduct,
} from "@/lib/subscriptions/catalog-options";
import type { Item } from "@/lib/supabase/database.types";

/** Display names for the vendor enum. All seven — the DB has always allowed them. */
const VENDOR_LABEL: Record<Item["vendor"], string> = {
  google:    "🌐 Google Cloud / Workspace",
  microsoft: "🪟 Microsoft 365 / Azure",
  zoho:      "💼 Zoho Suite",
  hosting:   "🖥️ Hosting",
  support:   "🛠️ Support plan",
  domain:    "🔗 Domain",
  other:     "📦 Other Cloud Vendor",
};
import { useQueryClient } from "@tanstack/react-query";
import { rupee } from "@/lib/utils";

import type { QuoteLineItem } from "@/lib/supabase/database.types";

/*
 * The hardcoded PRODUCTS_BY_VENDOR list that used to live here is GONE.
 *
 * It held 29 products with their own ids ("gw-starter") and their own prices. Two
 * things were wrong with that, and both cost money:
 *
 *  1. Its ids matched nothing in the catalog ("GW-STR-fbb"), so this dialog could not
 *     supply subscriptions.item_id and a DB trigger had to infer the link from the
 *     plan text — which only worked because a normaliser papers over the fact that the
 *     two lists disagreed on names ("Business Standard" vs "Standard").
 *  2. Its PRICES had drifted BELOW the tenant’s own vendor cost on four of the eight
 *     overlapping products. M365 Business Standard pre-filled ₹7,920/seat/year against
 *     a ₹9,840 cost — a guaranteed ₹1,920 loss per seat per year, suggested by the app,
 *     with nothing on screen to mark it. See lib/subscriptions/catalog-options.ts for
 *     the full measured table.
 *
 * Products, prices and the vendor list now all come from the catalog the operator
 * maintains at /items. There is nothing left here to drift.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AddSubscriptionDialog({ open, onOpenChange, onSuccess }: Props) {
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();

  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [vendor, setVendor] = React.useState<Item["vendor"]>("google");
  const [plan, setPlan] = React.useState("");
  const [isCustomPlan, setIsCustomPlan] = React.useState(false);
  const [seats, setSeats] = React.useState(10);
  const [pricePerSeatYear, setPricePerSeatYear] = React.useState(0);
  /** The catalog row being sold → subscriptions.item_id. Null on a custom plan. */
  const [itemId, setItemId] = React.useState<string | null>(null);
  const [paymentTerms, setPaymentTerms] = React.useState<"paid" | "credit">("credit");
  const [startDate, setStartDate] = React.useState(() => new Date().toISOString().split("T")[0]);
  const [renewalDate, setRenewalDate] = React.useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split("T")[0];
  });

  const [selectedCustomerId, setSelectedCustomerId] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [existingCustomers, setExistingCustomers] = React.useState<Array<{ id: string; name: string; domain?: string | null }>>([]);

  // Fetch existing customers for autocomplete selection
  React.useEffect(() => {
    if (!open) return;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("customers").select("id, name, domain").order("name");
      setExistingCustomers(data ?? []);
    })();
  }, [open]);

  /* ── The catalog, which is now the only source of products and prices ────────
     Loaded from /items. `subscriptionProducts` drops one-time items and converts
     ₹/seat/month to the ₹/seat/year this dialog charges in — once, in one place. */
  const { data: items, isLoading: catalogLoading } = useItems();
  const products   = React.useMemo(() => subscriptionProducts(items ?? []), [items]);
  const vendors    = React.useMemo(() => catalogVendors(products), [products]);
  const forVendor  = React.useMemo(() => productsForVendor(products, vendor), [products, vendor]);
  const selected   = itemId ? findProduct(products, itemId) : undefined;

  /* Live check on whatever price is in the field. Every loss-making default this
     replaced was on screen for months with nothing to mark it; a margin that only
     shows up in a report arrives after the quote has gone out. */
  const verdict = judgePrice(pricePerSeatYear, selected?.annualCostPerSeat ?? null);

  /* Seed from the catalog once it arrives. Deliberately does NOT reset a choice the
     operator has already made — refetches would otherwise wipe their work. */
  React.useEffect(() => {
    if (itemId || isCustomPlan || products.length === 0) return;
    const first = productsForVendor(products, vendor)[0] ?? products[0];
    if (!first) return;
    setVendor(first.vendor);
    setItemId(first.id);
    setPlan(first.name);
    setPricePerSeatYear(first.annualSellPerSeat);
  }, [products, vendor, itemId, isCustomPlan]);

  const applyProduct = (p: CatalogProduct) => {
    setIsCustomPlan(false);
    setItemId(p.id);
    setPlan(p.name);
    setPricePerSeatYear(p.annualSellPerSeat);
  };

  const handleVendorChange = (v: Item["vendor"]) => {
    setVendor(v);
    setIsCustomPlan(false);
    const first = productsForVendor(products, v)[0];
    if (first) applyProduct(first);
    else {
      /* A vendor with no catalog rows leaves the fields alone rather than clearing
         them — but item_id must go, or the subscription would be linked to a product
         from the vendor they just navigated away from. */
      setItemId(null);
    }
  };

  /** Values are item IDs now, not names — two catalog rows may share a name. */
  const handlePlanSelect = (val: string) => {
    if (val === "CUSTOM_PLAN") {
      setIsCustomPlan(true);
      setItemId(null);      // nothing in the catalog to point at
      setPlan("");
      return;
    }
    const found = findProduct(products, val);
    if (found) applyProduct(found);
  };

  const handleSelectExistingCustomer = (val: string) => {
    if (val === "NEW_CUSTOMER") {
      handleClearCustomerSelection();
      return;
    }
    const found = existingCustomers.find((c) => c.id === val);
    if (found) {
      setSelectedCustomerId(found.id);
      setCustomerName(found.name);
      if (found.domain) setDomain(found.domain);
    }
  };

  const handleClearCustomerSelection = () => {
    setSelectedCustomerId("");
    setCustomerName("");
    setDomain("");
    setCustomerEmail("");
  };

  const totalAnnualAmount = seats * pricePerSeatYear;
  const mrrAmount = Math.round(totalAnnualAmount / 12);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCustomerName = customerName.trim();
    const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();

    if (!cleanCustomerName) {
      toast.error("Customer name is required");
      return;
    }
    if (!cleanDomain) {
      toast.error("Primary Customer Domain is required (e.g. acme.com)");
      return;
    }
    if (seats <= 0) {
      toast.error("Seats must be at least 1");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      // No hardcoded fallback tenant. It used to default to Anutech Digital's id,
      // so a user from another tenant whose profile hadn't loaded would try to
      // write a subscription into someone else's books. RLS would reject it
      // (`WITH CHECK tenant_id = current_tenant_id()`), but the right answer is to
      // not attempt it — and to say why. Removed 2026-08-13.
      const tenantId = me?.tenantId;
      if (!tenantId) throw new Error("Your workspace is still loading — reopen this dialog and try again.");

      // ── Step 1: Find or Create Customer Record ──────────────────────────
      let customerId = "";
      const existingMatch = existingCustomers.find(
        (c) => c.name.toLowerCase() === cleanCustomerName.toLowerCase() || (c.domain && c.domain.toLowerCase() === cleanDomain)
      );

      if (existingMatch) {
        customerId = existingMatch.id;
      } else {
        const newCustId = crypto.randomUUID();
        const { error: custErr } = await supabase.from("customers").insert({
          id: newCustId,
          tenant_id: tenantId,
          name: cleanCustomerName,
          domain: cleanDomain,
          created_at: new Date().toISOString(),
        } as any);
        if (custErr) throw custErr;
        customerId = newCustId;
      }

      // ── Step 2: Auto-Create Quote & Audit Invoice ─────────────────────────
      const quoteId = `Q-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const isPaid = paymentTerms === "paid";

      const lineItems: QuoteLineItem[] = [
        {
          id: `line-${Date.now()}`,
          name: `${plan} (${seats} seats)`,
          qty: seats,
          rate: pricePerSeatYear,
          /* The real catalog cost when we have it. `× 0.83` — a flat 17% — survives
             only for a custom plan that has no catalog row, and it is the last of the
             three places that guess used to live. */
          cost: selected?.annualCostPerSeat ?? Math.round(pricePerSeatYear * 0.83),
          commitment: "annual_yearly",
        },
      ];

      /* `amount`, NOT `total` — `quotes` has no `total` column (it has amount,
         subtotal and total_cost; amount is the canonical ₹, see quote-builder.tsx).
         The old key silently failed the insert, and because the failure was only
         console.warn'ed the code carried on and stamped quote_id onto the
         subscription, which then died on subscriptions_quote_id_fkey. The user saw
         "Failed creating subscription" — two steps downstream of the real cause. */
      const { error: quoteErr } = await supabase.from("quotes").insert({
        id: quoteId,
        tenant_id: tenantId,
        customer_id: customerId,
        customer_name: cleanCustomerName,
        domain: cleanDomain,
        status: "accepted",
        payment_status: isPaid ? "received" : "awaiting",
        amount: totalAnnualAmount,
        subtotal: totalAnnualAmount,
        /* total_cost was omitted here, so it defaulted to 0 while the line items
           carried the real cost — and every margin read off the column reported 100%
           on a 17.5% deal (Q-2026-9778: column 0, lines ₹19,800). The displays now
           derive margin from the lines, which is the durable fix; writing the column
           too keeps the stored row honest for anything that reads it later. */
        total_cost: lineItems.reduce((s, l) => s + l.qty * l.cost, 0),
        seats,
        plan,
        notes: `Auto-generated from Subscription Onboarding (${plan}) · ${isPaid ? "Paid Upfront" : "Credit Terms / Postpaid"}`,
        line_items: lineItems as unknown as QuoteLineItem[],
      });
      /* THROW, do not warn. The subscription references this quote by foreign key,
         so "proceed without it" was never an option — it just moved the failure
         somewhere it could not be explained. */
      if (quoteErr) throw quoteErr;

      // ── Step 3: Insert Active Subscription ──────────────────────────────
      const { error: subErr } = await supabase.from("subscriptions").insert({
        tenant_id: tenantId,
        customer_id: customerId,
        customer_name: cleanCustomerName,
        plan: plan,
        vendor: vendor,
        seats: seats,
        used: 0,
        mrr: mrrAmount,
        start_date: startDate,
        renewal_date: renewalDate,
        status: "active",
        domain: cleanDomain,
        quote_id: quoteId,
        /* The catalog link, supplied directly now instead of being inferred from the
           plan text by trg_subscriptions_resolve_item (migration 0248). The trigger
           stays as the safety net for the other five write paths. */
        item_id: itemId,
        outstanding_amount: isPaid ? 0 : totalAnnualAmount,
        auto_renew: true,
      });

      if (subErr) throw subErr;

      toast.success(`Subscription & Customer record created for ${cleanCustomerName}!`, {
        description: isPaid
          ? `Paid invoice #${quoteId} & Active subscription created.`
          : `Postpaid credit quote #${quoteId} & Active subscription created.`,
      });

      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["customers"] });

      onSuccess?.();
      onOpenChange(false);
    } catch (err: unknown) {
      /* Supabase errors are PLAIN OBJECTS, not Error instances. `err instanceof
         Error` was therefore false for every database failure here, so the real
         message was thrown away and replaced with "Failed creating subscription" —
         a sentence that tells the operator nothing and cost this bug a debugging
         session. Read the shape Supabase actually returns, and show its code.  */
      const e = err as { message?: string; details?: string; hint?: string; code?: string } | null;
      const detail = e?.message || e?.details || (err instanceof Error ? err.message : "");
      toast.error(detail || "Failed creating subscription", {
        description: [e?.code && `code ${e.code}`, e?.hint].filter(Boolean).join(" · ") || undefined,
      });
      console.error("[add-subscription] failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] p-0 max-h-[92vh] flex flex-col overflow-hidden shadow-2xl z-50">
        <DialogHeader className="p-6 pb-4 border-b border-hairline bg-paper/95 backdrop-blur-xs sticky top-0 z-10 flex-shrink-0">
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="sparkles" size={16} />
            <span>1-Click Subscription Onboarding</span>
          </div>
          <DialogTitle className="text-xl md:text-2xl font-serif">Add / Onboard Subscription</DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Auto-creates or links the <b>Customer CRM record</b>, generates the <b>Audit Quote & Invoice</b>, and activates the <b>Subscription</b> in 1 click!
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Customer Selection or New Input */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Existing Customer (Select or Clear)">
              <Select value={selectedCustomerId} onValueChange={handleSelectExistingCustomer}>
                <SelectTrigger id="existingCustomerSelect">
                  <SelectValue placeholder="-- Select Existing Customer --" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NEW_CUSTOMER">➕ -- Type New Customer / Clear Selection --</SelectItem>
                  {existingCustomers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} {c.domain ? `(${c.domain})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedCustomerId && (
                <button
                  type="button"
                  onClick={handleClearCustomerSelection}
                  className="text-[11px] font-bold text-rose-600 hover:text-rose-700 flex items-center gap-1 mt-1 cursor-pointer"
                >
                  <Icon name="x" size={12} />
                  <span>Clear Selection & Type Brand New Customer</span>
                </button>
              )}
            </FormField>

            <FormField label="Customer Company Name *" required htmlFor="custName">
              <Input
                id="custName"
                placeholder="e.g. Excel Technologies"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Primary Customer Domain *" required htmlFor="subDomain">
              <Input
                id="subDomain"
                placeholder="e.g. exceltechnologies.in"
                className="font-mono text-sm font-semibold"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                required
              />
              <p className="text-[11px] text-ink-3 mt-1">Essential for Google/M365 Console provisioning.</p>
            </FormField>

            <FormField label="Contact Email (Optional)" htmlFor="custEmail">
              <Input
                id="custEmail"
                type="email"
                placeholder="e.g. ranjeet@exceltechnologies.in"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
              />
            </FormField>
          </div>

          {/* Vendor & Plan Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Cloud Vendor *" required htmlFor="vendor">
              <Select value={vendor} onValueChange={(val: any) => handleVendorChange(val)}>
                <SelectTrigger id="vendor">
                  <SelectValue />
                </SelectTrigger>
                {/* Vendors the tenant ACTUALLY sells, from the catalog. The old
                    hardcoded four hid `hosting`, `support` and `domain` — which the
                    DB enum has always allowed and which are 7 of this tenant's 17
                    subscription products. `other` is always offered as the home for
                    a custom plan. */}
                <SelectContent>
                  {(vendors.length ? vendors : (["other"] as Item["vendor"][])).map((v) => (
                    <SelectItem key={v} value={v}>{VENDOR_LABEL[v] ?? v}</SelectItem>
                  ))}
                  {!vendors.includes("other") && (
                    <SelectItem value="other">{VENDOR_LABEL.other}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Plan / SKU Product *" required htmlFor="planSelect">
              {!isCustomPlan ? (
                <Select value={itemId ?? ""} onValueChange={handlePlanSelect}>
                  <SelectTrigger id="planSelect">
                    <SelectValue placeholder={
                      catalogLoading ? "Loading catalogue…"
                      : forVendor.length === 0 ? "No products for this vendor"
                      : "-- Select Vendor Product / SKU --"
                    } />
                  </SelectTrigger>
                  {/* Values are item IDs, not names: two catalog rows can share a name
                      (this tenant has "Standard" under both hosting and support), and
                      the id is what gets stored on the subscription. */}
                  <SelectContent>
                    {forVendor.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({rupee(p.annualSellPerSeat)}/yr)
                      </SelectItem>
                    ))}
                    <SelectItem value="CUSTOM_PLAN">✍️ Custom Product Name / Other SKU...</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}

              {/* An empty catalogue used to be impossible because the list was baked in.
                  Now it is possible, so it has to say what to do — and NOT block: the
                  custom-plan path still works, it just cannot check the margin. */}
              {!catalogLoading && products.length === 0 && !isCustomPlan && (
                <p className="mt-1 text-[11px] leading-snug text-ink-3">
                  Your catalogue is empty. Add products in{" "}
                  <a href="/items" className="font-semibold text-primary hover:underline">
                    Catalog &amp; Products
                  </a>{" "}
                  to get prices and margin checks, or use a custom product name.
                </p>
              )}

              {isCustomPlan && (
                <div className="space-y-1.5">
                  <Input
                    id="planName"
                    placeholder="Type custom plan name (e.g. Acme Custom License)"
                    value={plan}
                    onChange={(e) => setPlan(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setIsCustomPlan(false);
                      const first = productsForVendor(products, vendor)[0] ?? products[0];
                      if (first) applyProduct(first);
                    }}
                    className="text-[11px] font-bold text-amber-ink hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Icon name="arrow_left" size={12} />
                    <span>Back to Product Catalog Dropdown</span>
                  </button>
                </div>
              )}
            </FormField>
          </div>

          {/* Seats, Price & Financial Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="License Seats *" required htmlFor="seats">
              <Input
                id="seats"
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(parseInt(e.target.value, 10) || 1)}
                required
              />
            </FormField>

            <FormField label="Unit Price (₹/yr) *" required htmlFor="pricePerSeat">
              <Input
                id="pricePerSeat"
                type="number"
                min={0}
                value={pricePerSeatYear}
                onChange={(e) => setPricePerSeatYear(parseFloat(e.target.value) || 0)}
                required
              />
              {/* The margin, live, next to the number being typed. The defaults this
                  replaced sat below vendor cost for months with nothing on screen to
                  say so — on M365 Business Standard, ₹7,920 against a ₹9,840 cost. */}
              {verdict.kind === "loss" && (
                <p className="mt-1 flex items-start gap-1 text-[11px] font-semibold leading-snug text-rose">
                  <Icon name="alert" size={12} className="mt-px flex-shrink-0" />
                  <span>
                    Below cost — the vendor charges {rupee(selected!.annualCostPerSeat!)}/yr.
                    Losing {rupee(verdict.shortfallPerSeatYear)} per seat per year.
                  </span>
                </p>
              )}
              {verdict.kind === "thin" && (
                <p className="mt-1 text-[11px] font-semibold leading-snug text-amber-ink">
                  Only {verdict.marginPct.toFixed(1)}% margin — cost is{" "}
                  {rupee(selected!.annualCostPerSeat!)}/yr.
                </p>
              )}
              {verdict.kind === "ok" && (
                <p className="mt-1 text-[11px] leading-snug text-ink-3">
                  {verdict.marginPct.toFixed(1)}% margin over {rupee(selected!.annualCostPerSeat!)}/yr cost.
                </p>
              )}
              {verdict.kind === "unknown" && selected && (
                <p className="mt-1 text-[11px] leading-snug text-ink-3">
                  No vendor cost in the catalogue — margin unknown, not zero.
                </p>
              )}
            </FormField>

            <FormField label="Monthly MRR (Auto)">
              <div className="h-10 px-3 flex items-center bg-paper-2 border border-hairline rounded-lg font-mono font-bold text-sm text-primary">
                {rupee(mrrAmount)} / mo
              </div>
            </FormField>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Start Date *" required htmlFor="startDate">
              <Input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </FormField>

            <FormField label="Renewal / Expiry Date *" required htmlFor="renewalDate">
              <Input
                id="renewalDate"
                type="date"
                value={renewalDate}
                onChange={(e) => setRenewalDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          {/* Payment Status & Terms */}
          <FormField label="Payment & Billing Terms (Special Cases Handling) *">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPaymentTerms("credit")}
                className={`p-3 rounded-lg border text-xs text-left transition-all ${
                  paymentTerms === "credit"
                    ? "bg-amber-soft/60 border-amber text-amber-ink font-bold shadow-xs"
                    : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                }`}
              >
                <div className="font-semibold text-ink flex items-center gap-1.5 mb-0.5">
                  <Icon name="clock" size={14} className="text-amber-ink" />
                  <span>⏳ Postpaid / Credit Terms</span>
                </div>
                <div className="text-[11px] text-ink-3">
                  Activates subscription now without upfront payment. Quote/Invoice tracks pending balance in Debtors Ledger.
                </div>
              </button>

              <button
                type="button"
                onClick={() => setPaymentTerms("paid")}
                className={`p-3 rounded-lg border text-xs text-left transition-all ${
                  paymentTerms === "paid"
                    ? "bg-emerald-soft/60 border-emerald text-emerald-ink font-bold shadow-xs"
                    : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                }`}
              >
                <div className="font-semibold text-ink flex items-center gap-1.5 mb-0.5">
                  <Icon name="check_circle" size={14} className="text-emerald-ink" />
                  <span>💳 Payment Received (Paid)</span>
                </div>
                <div className="text-[11px] text-ink-3">
                  Marks quote/invoice fully paid and activates subscription immediately.
                </div>
              </button>
            </div>
          </FormField>

          {/* Financial Calculation Summary Box */}
          <div className="p-3 bg-primary-soft/30 border border-primary/20 rounded-xl flex items-center justify-between text-xs">
            <div>
              <span className="text-ink-3">Total Annual Contract Value (ARR):</span>
              <div className="font-serif text-lg font-bold text-ink">{rupee(totalAnnualAmount)}</div>
            </div>
            <div className="text-right">
              <span className="text-ink-3">Monthly Recurring Revenue (MRR):</span>
              <div className="font-mono text-base font-bold text-primary">{rupee(mrrAmount)}</div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="bg-primary text-white font-bold px-5">
              {submitting ? "Creating Records..." : "⚡ Activate Subscription & Auto-Sync Ledger"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
