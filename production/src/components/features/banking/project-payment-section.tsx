/**
 * ProjectPaymentSection — inside the reconcile dialog: "whose project is this money for?"
 *
 * Existing project → pick the project, then the milestone it pays (the one whose balance
 * equals this receipt is preselected). Naya project → customer, name and the project's
 * total value; it is created with an Advance + Balance split (or one Full payment), and
 * this receipt pays the first. A project already paid in full is offered too: the receipt
 * becomes a new milestone and the project value grows by it (shown before booking). Either way the payment is recorded against the milestone,
 * the bank line is reconciled, and optionally the milestone's tax invoice is raised —
 * all through the project module's own RPCs (lib/queries/project-receipts.ts).
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { useOpenProjects, useBookBankCreditAsProjectPayment, receiptMilestones } from "@/lib/queries/project-receipts";

const NEW_CUSTOMER = "__new_customer__";
/* Milestone picker value: add a new milestone for this receipt (project value grows). */
const NEW_MILESTONE = "__new_milestone__";
const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

interface Props {
  txn: { id: string; txn_date: string; description: string | null; reference?: string | null };
  amount: number;
  customers: readonly { id: string; name: string }[];
  customerId: string;
  onCustomerChange: (id: string) => void;
  onNewCustomer: () => void;
  onCancel: () => void;
  onDone: () => void;
}

export function ProjectPaymentSection({ txn, amount, customers, customerId, onCustomerChange, onNewCustomer, onCancel, onDone }: Props) {
  const { data: projects, isLoading } = useOpenProjects(true);
  const book = useBookBankCreditAsProjectPayment();

  const [mode, setMode] = React.useState<"existing" | "new">("existing");
  const [projectId, setProjectId] = React.useState("");
  const [milestoneId, setMilestoneId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [total, setTotal] = React.useState(String(Math.round(amount)));
  const [raiseInvoice, setRaiseInvoice] = React.useState(true);
  const [newMsLabel, setNewMsLabel] = React.useState("Additional payment");

  /* No open project at all → start on "Naya project" rather than an empty picker. */
  React.useEffect(() => {
    if (!isLoading && (projects ?? []).length === 0) setMode("new");
  }, [isLoading, projects]);

  const project = (projects ?? []).find((p) => p.id === projectId) ?? null;
  const milestone = project?.milestones.find((m) => m.id === milestoneId) ?? null;
  const addingMilestone = !!project && milestoneId === NEW_MILESTONE;

  function pickProject(id: string) {
    setProjectId(id);
    const p = (projects ?? []).find((x) => x.id === id);
    /* The milestone whose balance is exactly this receipt, else the first unpaid one. */
    const exact = p?.milestones.find((m) => m.remaining === Math.round(amount));
    /* Paid in full → the only way in is a new milestone. */
    setMilestoneId(exact?.id ?? p?.milestones[0]?.id ?? NEW_MILESTONE);
  }

  const totalNum = Math.round(Number(total));
  const customerName = customers.find((c) => c.id === customerId)?.name ?? "";
  const split = totalNum > 0 ? receiptMilestones(totalNum, Math.round(amount)) : [];

  const canSubmit = mode === "existing"
    ? !!milestone || (addingMilestone && newMsLabel.trim().length > 0)
    : !!customerId && title.trim().length > 0 && totalNum >= Math.round(amount);

  async function submit() {
    await book.mutateAsync({
      bankTxnId: txn.id,
      amount: Math.round(amount),
      receivedAt: txn.txn_date,
      reference: txn.reference ?? txn.description,
      raiseInvoice,
      target: mode === "existing"
        ? { kind: "existing", projectId, milestoneId: addingMilestone ? null : milestoneId, newMilestoneLabel: newMsLabel.trim() }
        : { kind: "new", customerId, customerName, title: title.trim(), totalInclusive: totalNum, gstRate: 18 },
    });
    onDone();
  }

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border border-hairline p-0.5 text-[12px]" role="tablist">
        {(["existing", "new"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded px-2.5 py-1 ${mode === m ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
          >
            {m === "existing" ? "Existing project" : "＋ Naya project"}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        isLoading ? (
          <p className="text-2xs text-ink-3">Projects load ho rahe hain…</p>
        ) : (projects ?? []).length === 0 ? (
          <p className="text-2xs text-ink-3">Koi open project nahi hai — &quot;Naya project&quot; chuno.</p>
        ) : (
          <>
            <select value={projectId} onChange={(e) => pickProject(e.target.value)} aria-label="Project" className={selectCls}>
              <option value="" disabled>Kis project ka payment hai? Project chuno…</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · {p.customerName} · {p.milestones.length > 0
                    ? `baaki ${rupee(p.milestones.reduce((s, m) => s + m.remaining, 0))}`
                    : p.paid > 0 ? `poora paid (${rupee(p.paid)})` : "koi milestone nahi"}
                </option>
              ))}
            </select>
            {project && (
              <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)} aria-label="Milestone" className={selectCls}>
                {project.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.seq}. {m.label} · baaki {rupee(m.remaining)}{m.invoiceId ? ` · invoice ${m.invoiceId}` : ""}
                  </option>
                ))}
                <option value={NEW_MILESTONE}>＋ Nayi milestone — ye {rupee(amount)} alag payment hai</option>
              </select>
            )}
            {addingMilestone && project && (
              <>
                <Input value={newMsLabel} onChange={(e) => setNewMsLabel(e.target.value)} placeholder="Milestone ka naam (e.g. Phase 2)" aria-label="New milestone name" />
                <p className="text-3xs text-amber-ink">
                  {project.milestones.length === 0 && project.paid > 0 ? "Is project ka poora payment ho chuka hai. " : ""}
                  Ye {rupee(amount)} ek nayi milestone ki tarah judega aur project ki value {rupee(project.total)} → {rupee(project.total + Math.round(amount))} ho jayegi.
                  Agar ye alag kaam hai to &quot;Naya project&quot; chuno.
                </p>
              </>
            )}
            {milestone && Math.round(amount) !== milestone.remaining && (
              <p className="text-3xs text-amber-ink">
                Is milestone ka {rupee(milestone.remaining)} baaki hai, bank mein {rupee(amount)} aaye —
                {Math.round(amount) < milestone.remaining ? " ye part payment ki tarah record hoga." : " milestone se zyada paisa hai, milestone check kar lo."}
              </p>
            )}
          </>
        )
      ) : (
        <>
          <select
            value={customerId}
            onChange={(e) => {
              if (e.target.value === NEW_CUSTOMER) { onNewCustomer(); return; }
              onCustomerChange(e.target.value);
            }}
            aria-label="Customer"
            className={selectCls}
          >
            <option value="" disabled>Customer chuno…</option>
            <option value={NEW_CUSTOMER}>＋ Naya customer banao</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project ka naam (e.g. Accounting software)" aria-label="Project name" />
          <label className="block text-3xs text-ink-3">
            Project ki total value ₹ (GST ke saath) — sirf ye payment hai to jaisa hai waisa chhod do
            <Input value={total} onChange={(e) => setTotal(e.target.value)} type="number" min={0} className="mt-1" aria-label="Project total value" />
          </label>
          {split.length > 0 && totalNum >= Math.round(amount) && (
            <p className="text-3xs text-ink-3">
              Milestones: {split.map((m) => `${m.label} ${rupee(m.total_amount)}`).join(" + ")} (GST 18% ke saath) — ye {rupee(amount)} pehli milestone mein jayega.
              Baad mein project page par milestones badal sakte ho.
            </p>
          )}
          {totalNum > 0 && totalNum < Math.round(amount) && (
            <p className="text-3xs text-rose">Total value bank mein aaye {rupee(amount)} se kam nahi ho sakti.</p>
          )}
        </>
      )}

      <label className="flex items-start gap-2 text-2xs text-ink-2 pt-1">
        <input type="checkbox" checked={raiseInvoice} onChange={(e) => setRaiseInvoice(e.target.checked)} className="mt-0.5" />
        <span>
          Is milestone ki tax invoice bhi bana do
          {mode === "existing" && milestone?.invoiceId ? ` (invoice ${milestone.invoiceId} pehle se hai — nayi nahi banegi)` : ""}
        </span>
      </label>

      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="primary" icon="check" loading={book.isPending} disabled={!canSubmit} onClick={submit}>
          Project payment record karo &amp; reconcile
        </Button>
        <Button size="sm" variant="default" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
