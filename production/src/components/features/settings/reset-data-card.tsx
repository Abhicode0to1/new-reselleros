"use client";

/**
 * Reset data — the owner-facing door to `reset_tenant_selected_tables` (0241).
 *
 * ─── WHY THIS SCREEN IS SHAPED LIKE A REFUSAL ────────────────────────────────
 * Everything here exists to make an irreversible act deliberate, and to make an
 * accidental one impossible:
 *
 *   · statutory sections are separated, not merely labelled, and need a second
 *     explicit tick — so "clear my demo data" can never quietly also mean
 *     "delete this year's GST invoices";
 *   · the password re-confirms INTENT, not identity (the session already proves
 *     identity) — an open laptop should not be able to empty a workspace;
 *   · the snapshot is announced BEFORE the button, because the single most
 *     useful thing an operator can know here is that this is undoable.
 *
 * No rule is enforced in this file. Every one of them lives in the Postgres
 * function, inside the same transaction as the delete, where a `curl` cannot
 * skip it. This is the polite front door to a lock that is somewhere else.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";

/** Mirrors `backup._resettable()` in 0241. A key absent there cannot be reset,
 *  whatever this list says — the function refuses unknown keys by name. */
const SECTIONS: Array<{ key: string; label: string; blurb: string; statutory: boolean }> = [
  { key: "leads",      label: "Leads",      blurb: "Leads and their activity history", statutory: false },
  { key: "quotes",     label: "Quotes",     blurb: "Quotes (line items live inside them)", statutory: false },
  { key: "tasks",      label: "Tasks",      blurb: "To-dos and follow-ups", statutory: false },
  { key: "expenses",   label: "Expense claims", blurb: "Staff expense claims", statutory: false },
  { key: "invoices",   label: "Invoices",   blurb: "GST tax invoices — the series must have no gaps", statutory: true },
  { key: "attendance", label: "Attendance", blurb: "Attendance records — these back payroll", statutory: true },
];

interface ResetResult {
  backup_id: string;
  backup_bytes: number;
  deleted: Record<string, number>;
}

export function ResetDataCard({ isOwner }: { isOwner: boolean }) {
  const qc = useQueryClient();
  const [picked, setPicked]   = React.useState<Set<string>>(new Set());
  const [statOk, setStatOk]   = React.useState(false);
  const [label, setLabel]     = React.useState("");
  const [password, setPassword] = React.useState("");
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [done, setDone]       = React.useState<ResetResult | null>(null);

  const statutoryPicked = SECTIONS.filter((s) => s.statutory && picked.has(s.key));
  const needsStatutory  = statutoryPicked.length > 0;

  const reset = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/reset-data", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tables:           [...picked],
          label:            label.trim() || "Manual reset",
          confirmStatutory: statOk,
          password,
        }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; result?: ResetResult };
      if (!res.ok || json.error) throw new Error(json.error ?? "Reset failed.");
      return json.result as ResetResult;
    },
    onSuccess: (r) => {
      setBlocked(null);
      setPassword("");
      setPicked(new Set());
      setStatOk(false);
      setDone(r);
      toast.success("Reset done — a restore point was saved first.");
      void qc.invalidateQueries();     // every list on screen may have changed
    },
    // Keep the message on screen: these are multi-sentence explanations with a
    // next step, and a toast that vanishes cannot carry one.
    onError: (e: Error) => setBlocked(e.message),
  });

  if (!isOwner) return null;

  const toggle = (key: string) => {
    setBlocked(null);
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setStatOk(false);   // re-tick required whenever the selection changes
  };

  const canSubmit = picked.size > 0 && password.length > 0 && (!needsStatutory || statOk);

  return (
    <Card className="border-rose/40">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-rose-soft">
          <Icon name="trash" size={16} className="text-rose" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-ink">Reset data</h3>
          <p className="text-xs text-ink-3 leading-relaxed">
            Clears the sections you tick, for this workspace only. A restore point is saved
            <b> before</b> anything is deleted — and if that snapshot fails, nothing is deleted at all.
          </p>
        </div>
      </div>

      <ul className="space-y-1.5">
        {SECTIONS.map((s) => (
          <li key={s.key}>
            <label
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${
                picked.has(s.key) ? "border-rose/50 bg-rose-soft/30" : "border-hairline hover:border-ink-4"
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 rounded border-hairline"
                checked={picked.has(s.key)}
                onChange={() => toggle(s.key)}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm text-ink">{s.label}</span>
                  {s.statutory && <Badge kind="warning" size="sm">Statutory</Badge>}
                </span>
                <span className="block text-2xs text-ink-3 leading-relaxed">{s.blurb}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      {needsStatutory && (
        <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-md border border-amber/50 bg-amber-soft/40 p-3">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-hairline"
            checked={statOk}
            onChange={(e) => { setStatOk(e.target.checked); setBlocked(null); }}
          />
          <span className="text-xs leading-relaxed text-amber-ink">
            I understand <b>{statutoryPicked.map((s) => s.label).join(" and ")}</b>{" "}
            {statutoryPicked.length === 1 ? "is a statutory record" : "are statutory records"} the
            business is required to keep. Deleting {statutoryPicked.length === 1 ? "it" : "them"} can
            break the GST invoice series or the payroll trail.
          </span>
        </label>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FormField label="Label for the restore point" htmlFor="reset-label">
          <Input
            id="reset-label"
            placeholder="e.g. Clearing demo data"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            helper="Shown in the backup list so you can find this point later."
          />
        </FormField>
        <FormField label="Your password" required htmlFor="reset-password">
          <Input
            id="reset-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setBlocked(null); }}
            helper="Confirms you meant this. Nothing is sent until you press the button."
          />
        </FormField>
      </div>

      <Button
        variant="primary"
        className="mt-3 w-full justify-center"
        loading={reset.isPending}
        disabled={!canSubmit}
        onClick={() => reset.mutate()}
      >
        {picked.size === 0
          ? "Tick a section to reset"
          : `Reset ${picked.size} section${picked.size === 1 ? "" : "s"}`}
      </Button>

      {blocked && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber/50 bg-amber-soft/40 p-3">
          <Icon name="alert" size={15} className="mt-0.5 flex-shrink-0 text-amber-ink" />
          <p className="text-xs leading-relaxed text-amber-ink">{blocked}</p>
        </div>
      )}

      {done && (
        <div className="mt-3 rounded-md border border-hairline bg-paper-2 p-3">
          <p className="text-xs text-ink-2">
            Restore point saved before deleting. Rows cleared:
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {Object.entries(done.deleted).map(([tbl, n]) => (
              <li key={tbl} className="font-mono text-2xs text-ink-3">
                {tbl}: {n}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-ink-3">
            Changed your mind? Use <b>Restore</b> on the newest &quot;Pre-Reset Safeguard Snapshot&quot;
            in the list above.
          </p>
        </div>
      )}
    </Card>
  );
}
