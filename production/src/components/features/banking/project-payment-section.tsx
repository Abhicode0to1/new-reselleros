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
 *
 * "TDS kata hai?" — when the customer withheld TDS, the bank amount is not the invoice:
 * ₹5,40,000 at 10% TDS settles a ₹5,90,000 invoice (₹5,00,000 + GST). The milestone, the new
 * project's value and the invoice are sized on what the receipt SETTLES, and the TDS is
 * recorded as a receivable to claim (lib/accounting/tds-split.ts).
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { useOpenProjects, useBookBankCreditAsProjectPayment, receiptMilestones } from "@/lib/queries/project-receipts";
import { TDS_SECTIONS, tdsSplitFromNet } from "@/lib/accounting/tds-split";

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
  const [tdsOn, setTdsOn] = React.useState(false);
  const [tdsKey, setTdsKey] = React.useState(TDS_SECTIONS[0].key);

  /* No open project at all → start on "Naya project" rather than an empty picker. */
  React.useEffect(() => {
    if (!isLoading && (projects ?? []).length === 0) setMode("new");
  }, [isLoading, projects]);

  const project = (projects ?? []).find((p) => p.id === projectId) ?? null;
  const milestone = project?.milestones.find((m) => m.id === milestoneId) ?? null;
  const addingMilestone = !!project && milestoneId === NEW_MILESTONE;

  const net = Math.round(amount);
  const tdsSection = TDS_SECTIONS.find((t) => t.key === tdsKey) ?? TDS_SECTIONS[0];
  const gstRate = mode === "existing" && project ? project.gstRate : 18;
  const tds = tdsOn ? tdsSplitFromNet(net, gstRate, tdsSection.ratePct) : null;
  /* What this receipt settles: the bank amount, plus the TDS the customer paid for us. */
  const settled = tds ? tds.gross : net;

  /* A new project's value follows what the receipt settles until the operator types one. */
  const [totalEdited, setTotalEdited] = React.useState(false);
  React.useEffect(() => { if (!totalEdited) setTotal(String(settled)); }, [settled, totalEdited]);

  function pickProject(id: string) {
    setProjectId(id);
    const p = (projects ?? []).find((x) => x.id === id);
    /* The milestone whose balance is exactly this receipt, else the first unpaid one. */
    const exact = p?.milestones.find((m) => m.remaining === settled);
    /* Paid in full → the only way in is a new milestone. */
    setMilestoneId(exact?.id ?? p?.milestones[0]?.id ?? NEW_MILESTONE);
  }

  const totalNum = Math.round(Number(total));
  const customerName = customers.find((c) => c.id === customerId)?.name ?? "";
  /* Open projects of the customer picked under "Naya project" — see the warning below it. */
  const customerProjects = customerId ? (projects ?? []).filter((p) => p.customerId === customerId) : [];
  const split = totalNum > 0 ? receiptMilestones(totalNum, settled) : [];

  const canSubmit = mode === "existing"
    ? !!milestone || (addingMilestone && newMsLabel.trim().length > 0)
    : !!customerId && title.trim().length > 0 && totalNum >= settled;

  async function submit() {
    await book.mutateAsync({
      bankTxnId: txn.id,
      amount: net,
      tds: tds ? { amount: tds.tds, section: tdsSection.section, ratePct: tdsSection.ratePct, base: tds.taxable } : null,
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
                <option value={NEW_MILESTONE}>＋ Nayi milestone — ye {rupee(settled)} alag payment hai</option>
              </select>
            )}
            {addingMilestone && project && (
              <>
                <Input value={newMsLabel} onChange={(e) => setNewMsLabel(e.target.value)} placeholder="Milestone ka naam (e.g. Phase 2)" aria-label="New milestone name" />
                <p className="text-3xs text-amber-ink">
                  {project.milestones.length === 0 && project.paid > 0 ? "Is project ka poora payment ho chuka hai. " : ""}
                  Ye {rupee(settled)} ek nayi milestone ki tarah judega aur project ki value {rupee(project.total)} → {rupee(project.total + settled)} ho jayegi.
                  Agar ye alag kaam hai to &quot;Naya project&quot; chuno.
                </p>
              </>
            )}
            {milestone && settled !== milestone.remaining && (
              <p className="text-3xs text-amber-ink">
                Is milestone ka {rupee(milestone.remaining)} baaki hai, ye payment {rupee(settled)} chukata hai{tds ? " (bank + TDS)" : ""} —
                {settled < milestone.remaining ? " ye part payment ki tarah record hoga." : " milestone se zyada hai, milestone check kar lo."}
                {!tds && milestone.remaining > net && " Agar customer ne TDS kaata hai to neeche \"TDS kata hai?\" tick karo."}
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
          {/* This customer already has an open project — the usual case is an instalment on
              it, not a new deal. Booking it as "Naya project" split a ₹50L contract into a
              ₹5L duplicate (26 Sep 2026), so it is said before anything is created. */}
          {customerProjects.length > 0 && (
            <div className="rounded-md border border-amber/50 bg-amber-soft/30 p-2.5 text-2xs text-ink-2 space-y-1.5">
              <p>
                <b>{customerName}</b> ka project pehle se khula hai. Agar ye paisa usi ki kist hai to naya project mat banao —
                existing project chuno.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {customerProjects.map((p) => (
                  <Button key={p.id} type="button" size="sm" variant="default" onClick={() => { setMode("existing"); pickProject(p.id); }}>
                    {p.title} · {rupee(p.total)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project ka naam (e.g. Accounting software)" aria-label="Project name" />
          <label className="block text-3xs text-ink-3">
            Project ki total value ₹ (GST ke saath) — sirf ye payment hai to jaisa hai waisa chhod do
            <Input value={total} onChange={(e) => { setTotal(e.target.value); setTotalEdited(true); }} type="number" min={0} className="mt-1" aria-label="Project total value" />
          </label>
          {split.length > 0 && totalNum >= settled && (
            <p className="text-3xs text-ink-3">
              Milestones: {split.map((m) => `${m.label} ${rupee(m.total_amount)}`).join(" + ")} (GST 18% ke saath) — ye {rupee(settled)} pehli milestone mein jayega.
              Baad mein project page par milestones badal sakte ho.
            </p>
          )}
          {totalNum > 0 && totalNum < settled && (
            <p className="text-3xs text-rose">Total value is payment ({rupee(settled)}) se kam nahi ho sakti.</p>
          )}
        </>
      )}

      {/* TDS the customer withheld: the receipt then settles more than reached the bank. */}
      <div className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
        <label className="flex items-start gap-2 text-2xs text-ink-2">
          <input type="checkbox" checked={tdsOn} onChange={(e) => setTdsOn(e.target.checked)} className="mt-0.5" />
          <span><b>TDS kata hai?</b> Customer ne TDS kaat kar {rupee(net)} bheja</span>
        </label>
        {tdsOn && tds && (
          <>
            <select value={tdsKey} onChange={(e) => setTdsKey(e.target.value)} aria-label="TDS section" className={selectCls}>
              {TDS_SECTIONS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs tabular-nums">
              <span className="text-ink-3">Kaam ki value (taxable)</span><span className="text-right text-ink">{rupee(tds.taxable)}</span>
              <span className="text-ink-3">+ GST {gstRate}%</span><span className="text-right text-ink">{rupee(tds.gst)}</span>
              <span className="text-ink-3 font-semibold">= Invoice</span><span className="text-right text-ink font-semibold">{rupee(tds.gross)}</span>
              <span className="text-ink-3">− TDS {tdsSection.ratePct}% on {rupee(tds.taxable)}</span><span className="text-right text-rose">− {rupee(tds.tds)}</span>
              <span className="text-ink-3">= Bank mein aaya</span><span className="text-right text-emerald">{rupee(tds.net)}</span>
            </div>
            <p className="text-3xs text-ink-3">
              {rupee(tds.tds)} TDS Receivable mein jayega (Form 16A pending) — ITR mein claim hoga.
            </p>
          </>
        )}
      </div>

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
