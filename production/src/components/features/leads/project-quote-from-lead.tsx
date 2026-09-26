/**
 * ProjectQuoteFromLead — "Send quote" for a custom-software lead.
 *
 * A licence lead goes to the subscription quote builder; a project lead gets a PROJECT
 * quotation: title, scope, price before GST, place of supply and a payment schedule. It is
 * created through create_project_quote_from_lead (migration 20260926110000), which uses the
 * project module's own create_project_quote, links the quotation to the lead and moves the
 * lead to Quote Sent. The quotation then lives in Project Sales, with its customer link.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { rupee } from "@/lib/utils";
import { gstinState, liveMoney, commitMoney, parseMoney } from "@/lib/forms/poka-yoke";
import { MILESTONE_SPLITS, milestonesFor, withGst, interStateFor } from "@/lib/leads/enquiry";
import { amountInIndianWords, magnitudeWarning } from "@/lib/accounting/amount-words";
import { useCreateProjectQuoteFromLead, useSellerState, useCustomerForLead } from "@/lib/queries/leads";
import type { Lead } from "@/lib/supabase/database.types";

const GST_RATE = 18;
const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function ProjectQuoteFromLead({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const router = useRouter();
  const create = useCreateProjectQuoteFromLead();
  const { data: sellerState } = useSellerState(!!lead);
  /* The lead's company may already be a customer — its state is then known. */
  const { data: matchedCustomer } = useCustomerForLead(lead?.company);

  const [title, setTitle] = React.useState("");
  const [scope, setScope] = React.useState("");
  const [priceText, setPriceText] = React.useState("");
  const [splitKey, setSplitKey] = React.useState(MILESTONE_SPLITS[0].key);
  const [placeChoice, setPlaceChoice] = React.useState<"" | "intra" | "inter">("");

  React.useEffect(() => {
    if (!lead) return;
    const req = (lead.requirement ?? "").trim();
    setTitle(req ? req.split(/\n|—|,|\./)[0].trim().slice(0, 80) : "Custom software");
    setScope([req, lead.project_timeline ? `Timeline: ${lead.project_timeline}` : ""].filter(Boolean).join("\n"));
    setPriceText(lead.value ? commitMoney(String(lead.value)) : "");
    setSplitKey(MILESTONE_SPLITS[0].key);
    setPlaceChoice("");
  }, [lead]);

  /* Place of supply from the lead's own state (or its GSTIN) against ours; asked only
     when either is unknown — a guessed CGST+SGST on an out-of-state client is a wrong
     tax head on the quotation and later on the invoice. */
  const clientState = lead?.state_code
    || (lead?.gstin ? gstinState(lead.gstin)?.code ?? null : null)
    || matchedCustomer?.state_code
    || (matchedCustomer?.gstin ? gstinState(matchedCustomer.gstin)?.code ?? null : null)
    || null;
  const derived = interStateFor(sellerState, clientState);
  const interState = derived ?? (placeChoice === "" ? null : placeChoice === "inter");

  const taxable = parseMoney(priceText) ?? 0;
  const priced = withGst(taxable, GST_RATE);
  const split = MILESTONE_SPLITS.find((s) => s.key === splitKey) ?? MILESTONE_SPLITS[0];
  const milestones = taxable > 0 ? milestonesFor(priced.total, split) : [];
  const party = (lead?.company ?? "").trim() || lead?.contact_name || "";

  const canSubmit = !!lead && title.trim().length > 1 && taxable > 0 && interState !== null;

  async function submit() {
    if (!lead || interState === null) return;
    const projectId = await create.mutateAsync({
      leadId: lead.id, title: title.trim(), description: scope.trim() || null,
      taxable, gstRate: GST_RATE, interState, milestones,
    });
    onClose();
    router.push(`/projects/${projectId}` as never);
  }

  return (
    <Sheet open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[520px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Project quotation</SheetTitle>
          <SheetDescription>
            {party ? `${party} ke liye` : ""} — custom software ka quote. Banne ke baad Project Sales mein khulega, wahan se customer ko link bhejo.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <FormField label="Project ka naam" htmlFor="pq_title" required>
            <Input id="pq_title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. School ERP" />
          </FormField>

          <FormField label="Scope (quotation par dikhega)" htmlFor="pq_scope">
            <textarea
              id="pq_scope" rows={4} value={scope} onChange={(e) => setScope(e.target.value)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-y"
            />
          </FormField>

          <FormField label="Price (₹, GST se pehle)" htmlFor="pq_price" required>
            <Input
              id="pq_price" type="text" inputMode="numeric" prefix="₹" value={priceText}
              onChange={(e) => setPriceText(liveMoney(e.target.value))}
              onBlur={() => setPriceText((t) => commitMoney(t))}
            />
            {taxable > 0 && (
              <p className="mt-1 text-2xs text-ink-3 tabular-nums">
                <b className="text-ink">{amountInIndianWords(taxable)}</b> · {rupee(priced.taxable)} + GST {GST_RATE}% {rupee(priced.gst)} = <b className="text-ink">{rupee(priced.total)}</b>
              </p>
            )}
            {/* Once accepted and invoiced a price can only be corrected with a credit / debit
                note — a slipped zero against the lead's own budget is caught here instead. */}
            {magnitudeWarning(taxable, lead?.value, "lead ka budget") && (
              <p className="mt-1 text-2xs text-rose">{magnitudeWarning(taxable, lead?.value, "lead ka budget")}</p>
            )}
          </FormField>

          <FormField label="Place of supply" htmlFor="pq_place">
            {derived !== null ? (
              <p className="text-sm text-ink">
                {derived ? "Inter-state — IGST" : "Intra-state — CGST + SGST"}
                <span className="block text-2xs text-ink-3">
                  client ka state {clientState}{matchedCustomer && !lead?.state_code && !lead?.gstin ? ` (customer "${matchedCustomer.name}" se)` : ""} · aapka {sellerState}
                </span>
              </p>
            ) : (
              <>
                <select id="pq_place" value={placeChoice} onChange={(e) => setPlaceChoice(e.target.value as typeof placeChoice)} className={selectCls}>
                  <option value="" disabled>Client kis state mein hai? chuno…</option>
                  <option value="intra">Aapke hi state mein — CGST + SGST</option>
                  <option value="inter">Doosre state mein — IGST</option>
                </select>
                <p className="mt-1 text-2xs text-amber-ink">
                  Lead mein client ka state / GSTIN nahi hai{sellerState ? "" : " (aur aapki company ka state bhi darj nahi hai)"} — isliye poochh rahe hain.
                </p>
              </>
            )}
          </FormField>

          <FormField label="Payment schedule" htmlFor="pq_split">
            <select id="pq_split" value={splitKey} onChange={(e) => setSplitKey(e.target.value)} className={selectCls}>
              {MILESTONE_SPLITS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            {milestones.length > 0 && (
              <ul className="mt-1.5 text-2xs text-ink-2 tabular-nums space-y-0.5">
                {milestones.map((m) => (
                  <li key={m.label} className="flex justify-between"><span>{m.label}</span><span>{rupee(m.total_amount)}</span></li>
                ))}
              </ul>
            )}
            <p className="mt-1 text-3xs text-ink-3">Baad mein Project Sales mein milestones badal sakte ho.</p>
          </FormField>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" icon="send" loading={create.isPending} disabled={!canSubmit} onClick={submit}>
            Quotation banao
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
