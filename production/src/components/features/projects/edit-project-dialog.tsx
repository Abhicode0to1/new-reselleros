/**
 * EditProjectDialog — change an active project's value, title and customer.
 *
 * ─── WHY (R-004, Pardeep, 25 Sep 2026) ──────────────────────────────────────
 * Once a project was Active, nothing on its page could change the contract value, the
 * title or the customer — only dates, costs and labour. Scope gets added, a discount
 * gets agreed, or the wrong value is typed while booking a bank receipt, and the only
 * remedy was a hand edit in the database. That value drives the Project margin card
 * and the P&L's project revenue, so a wrong one stays wrong in the books.
 *
 * ─── WHAT THIS SCREEN WILL NOT LET YOU DO, AND SAYS SO ──────────────────────
 * The rules live in `update_project_details` (migration 20260926150000) — that is the
 * authority, and it is the same shape as `update_project_future_milestones` on purpose.
 * This dialog mirrors them so the operator meets a sentence instead of a rejection:
 *
 *   • milestones already invoiced or paid are shown LOCKED and are never re-planned
 *   • the remaining milestones must add up to the new total minus the locked part
 *   • the customer is frozen once a tax invoice exists — that invoice was issued to
 *     them, and re-pointing the project would leave the two disagreeing
 *
 * Invoices already raised are never touched by any of this. A change after invoicing
 * is a credit or debit note, not an edit.
 */
"use client";

import * as React from "react";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";
import { AddCustomerForm } from "@/components/features/customers/add-customer-form";
import { useCustomers } from "@/lib/queries/customers";
import {
  useUpdateProjectDetails,
  type MilestoneInput,
  type ProjectMilestoneRow,
} from "@/lib/queries/projects";
import type { ProjectSaleRow, ProjectPaymentRow } from "@/lib/supabase/database.types";
import { rupee } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectSaleRow;
  milestones: readonly ProjectMilestoneRow[];
  payments: readonly ProjectPaymentRow[];
}

type Row = { label: string; amount: string; due: string };

export function EditProjectDialog({ open, onOpenChange, project, milestones, payments }: Props) {
  const update = useUpdateProjectDetails();
  const { data: customers } = useCustomers();

  /* Locked = invoiced OR paid, the same definition the RPC uses. Two definitions of
     "locked" is how a screen ends up offering an edit the database then refuses. */
  const paidMilestoneIds = React.useMemo(
    () => new Set(payments.map((p) => p.milestone_id).filter(Boolean) as string[]),
    [payments],
  );
  const isLocked = React.useCallback(
    (m: ProjectMilestoneRow) => Boolean(m.invoice_id) || paidMilestoneIds.has(m.id),
    [paidMilestoneIds],
  );
  const lockedMilestones = milestones.filter(isLocked);
  const lockedSum = lockedMilestones.reduce((s, m) => s + (m.total_amount ?? 0), 0);
  const hasInvoice = milestones.some((m) => Boolean(m.invoice_id));

  const [customerId, setCustomerId]   = React.useState(project.customer_id ?? "");
  const [addCustomerOpen, setAddCustomerOpen] = React.useState(false);
  const [title, setTitle]             = React.useState(project.title ?? "");
  const [description, setDescription] = React.useState(project.description ?? "");
  const [total, setTotal]             = React.useState(String(project.total_amount ?? 0));
  const [gstRate, setGstRate]         = React.useState(String(project.gst_rate ?? 18));
  const [interState, setInterState]   = React.useState(Boolean(project.inter_state));
  const [rows, setRows]               = React.useState<Row[]>([]);

  /* Re-seed from the project every time it opens. Holding edits across a cancel would
     silently re-apply a change the operator backed out of. */
  React.useEffect(() => {
    if (!open) return;
    setCustomerId(project.customer_id ?? "");
    setTitle(project.title ?? "");
    setDescription(project.description ?? "");
    setTotal(String(project.total_amount ?? 0));
    setGstRate(String(project.gst_rate ?? 18));
    setInterState(Boolean(project.inter_state));
    setRows(
      milestones.filter((m) => !isLocked(m)).map((m) => ({
        label:  m.label ?? "",
        amount: String(m.total_amount ?? 0),
        due:    m.due_date ?? "",
      })),
    );
  }, [open, project, milestones, isLocked]);

  const totalNum   = Math.max(0, Math.round(Number(total) || 0));
  const rateNum    = Math.max(0, Math.round(Number(gstRate) || 0));
  const taxableNum = totalNum > 0 ? Math.round((totalNum * 100) / (100 + rateNum)) : 0;
  const gstNum     = totalNum - taxableNum;

  const plannedSum = rows.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount) || 0)), 0);
  const targetSum  = totalNum - lockedSum;
  const scheduleOk = plannedSum === targetSum;

  /* The one number that can make the save impossible. Shown before they press Save,
     because meeting it as a database error after typing a schedule is a wasted trip. */
  const belowCommitted = totalNum < lockedSum;

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => {
    const sum = rs.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount) || 0)), 0);
    const remaining = Math.max(0, targetSum - sum);
    return [...rs, { label: `Milestone ${lockedMilestones.length + rs.length + 1}`, amount: remaining > 0 ? String(remaining) : "", due: "" }];
  });
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  const customerChanged = customerId !== (project.customer_id ?? "");
  const scheduleChanged =
    totalNum !== (project.total_amount ?? 0) ||
    rows.length !== milestones.filter((m) => !isLocked(m)).length ||
    rows.some((r, i) => {
      const src = milestones.filter((m) => !isLocked(m))[i];
      return !src
        || (r.label ?? "") !== (src.label ?? "")
        || Math.round(Number(r.amount) || 0) !== (src.total_amount ?? 0)
        || (r.due || "") !== (src.due_date || "");
    });

  const canSubmit =
    title.trim().length >= 2 &&
    totalNum > 0 &&
    !belowCommitted &&
    scheduleOk &&
    !update.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const chosen = customers?.find((c) => c.id === customerId);
    const milestonePayload: MilestoneInput[] = rows
      .filter((r) => Math.round(Number(r.amount) || 0) > 0)
      .map((r, i) => ({
        label:        r.label.trim() || `Milestone ${lockedMilestones.length + i + 1}`,
        total_amount: Math.round(Number(r.amount) || 0),
        due_date:     r.due || null,
      }));
    try {
      await update.mutateAsync({
        projectId:   project.id,
        title:       title.trim(),
        description: description.trim(),
        /* Only sent when it actually moved — the RPC refuses a customer change once an
           invoice exists, and sending the unchanged id would trip that on every save. */
        ...(customerChanged && chosen ? { customerId, customerName: chosen.name } : {}),
        totalAmount: totalNum,
        gstRate:     rateNum,
        interState,
        /* Omitted when nothing about the money moved, so a title-only edit leaves the
           schedule exactly as it is rather than deleting and re-inserting it. */
        ...(scheduleChanged ? { milestones: milestonePayload } : {}),
      });
      onOpenChange(false);
    } catch { /* the hook toasts the RPC's own message, which names the next step */ }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[600px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Edit project</SheetTitle>
          <SheetDescription>
            Change the deal. Invoices already raised are never touched — to change those, raise a
            credit note.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <FormField label="Customer" required htmlFor="e_customer">
            <CustomerCombobox
              id="e_customer"
              value={customerId}
              onChange={setCustomerId}
              onCreateNew={() => setAddCustomerOpen(true)}
              disabled={hasInvoice}
              placeholder="Search customers…"
            />
            {hasInvoice && (
              <p className="text-3xs text-ink-3 mt-1">
                A tax invoice has been issued to {project.customer_name ?? "this customer"}, so the
                customer is fixed. Credit-note the invoice first to bill somebody else.
              </p>
            )}
          </FormField>

          <FormField label="Project title" required htmlFor="e_title">
            <Input id="e_title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>

          <FormField label="Description" htmlFor="e_desc">
            <textarea
              id="e_desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Scope / notes (optional)"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Contract value (incl. GST ₹)" required htmlFor="e_total">
              <Input id="e_total" inputMode="numeric" prefix="₹" value={total} onChange={(e) => setTotal(e.target.value)} />
            </FormField>
            <FormField label="GST rate %" htmlFor="e_gst">
              <Input id="e_gst" inputMode="numeric" value={gstRate} onChange={(e) => setGstRate(e.target.value)} />
            </FormField>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={interState} onChange={(e) => setInterState(e.target.checked)} className="rounded border-hairline" />
            Inter-state supply (IGST instead of CGST + SGST)
          </label>

          <div className="rounded-md border border-hairline bg-paper-2/40 p-3 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-ink-3">Taxable value</span><span className="tabular-nums">{rupee(taxableNum)}</span></div>
            <div className="flex justify-between"><span className="text-ink-3">GST @ {rateNum}%</span><span className="tabular-nums">{rupee(gstNum)}</span></div>
            <div className="flex justify-between border-t border-hairline pt-1 mt-1 font-semibold"><span>Total</span><span className="tabular-nums">{rupee(totalNum)}</span></div>
          </div>

          {belowCommitted && (
            <div className="rounded-md border border-rose/40 bg-rose-soft/30 p-3">
              <p className="text-sm font-semibold text-rose-ink">
                {rupee(totalNum)} is below the {rupee(lockedSum)} already invoiced or paid.
              </p>
              <p className="text-xs text-ink-3 mt-1">
                Set it to {rupee(lockedSum)} or more. To go lower, raise a credit note against those
                invoices first — the customer has already claimed against the copies they hold.
              </p>
            </div>
          )}

          {/* ── Locked milestones, shown and not editable ────────────────── */}
          {lockedMilestones.length > 0 && (
            <div>
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">
                Already invoiced or paid — fixed
              </p>
              <ul className="space-y-1">
                {lockedMilestones.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-paper-2/30 px-3 py-2 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <Icon name="lock" size={12} className="text-ink-3 shrink-0" />
                      <span className="truncate text-ink-2">{m.label}</span>
                      {m.invoice_id && <Badge kind="info" size="sm">{m.invoice_id}</Badge>}
                    </span>
                    <span className="tabular-nums text-ink shrink-0">{rupee(m.total_amount ?? 0)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── The re-plannable part ────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                Remaining milestones
              </p>
              <Button size="sm" variant="ghost" icon="plus" onClick={addRow}>Add</Button>
            </div>
            {rows.length === 0 && (
              <p className="text-xs text-ink-3">
                Nothing left to plan. Add a milestone if the value went up.
              </p>
            )}
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input
                    aria-label={`Milestone ${i + 1} label`}
                    placeholder="Label" value={r.label}
                    onChange={(e) => setRow(i, { label: e.target.value })}
                    className="flex-1"
                  />
                  <Input
                    aria-label={`Milestone ${i + 1} amount`}
                    inputMode="numeric" prefix="₹" placeholder="Amount" value={r.amount}
                    onChange={(e) => setRow(i, { amount: e.target.value })}
                    className="w-32"
                  />
                  <Input
                    aria-label={`Milestone ${i + 1} due date`}
                    type="date" value={r.due}
                    onChange={(e) => setRow(i, { due: e.target.value })}
                    className="w-40"
                  />
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove milestone ${i + 1}`} onClick={() => removeRow(i)} />
                </div>
              ))}
            </div>
            <div className={`mt-2 text-2xs ${scheduleOk ? "text-emerald" : "text-rose"}`}>
              Remaining milestones total {rupee(plannedSum)} · {scheduleOk
                ? "matches what is left to bill ✓"
                : `should equal ${rupee(targetSum)} (${rupee(totalNum)} less the ${rupee(lockedSum)} already committed) — off by ${rupee(Math.abs(targetSum - plannedSum))}`}
            </div>
          </div>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" loading={update.isPending} disabled={!canSubmit} onClick={handleSubmit}>
            Save changes
          </Button>
        </SheetFooter>
      </SheetContent>

      <AddCustomerForm
        open={addCustomerOpen}
        onOpenChange={setAddCustomerOpen}
        onCreated={(newId) => setCustomerId(newId)}
      />
    </Sheet>
  );
}
