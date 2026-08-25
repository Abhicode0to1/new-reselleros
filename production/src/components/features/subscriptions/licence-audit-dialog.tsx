/**
 * The licence auditor — paste or upload a vendor export, see what is not billed.
 *
 * ─── IT READS THE FILE IN THE BROWSER AND SENDS NOTHING ─────────────────────
 * A Google or Microsoft user export is a list of every employee's email address at a
 * customer's company. There is no reason for it to leave the operator's machine: the
 * subscriptions are already loaded on this page, so the whole comparison happens here and
 * no upload endpoint exists to be secured, logged, or breached. The rules are in
 * lib/subscriptions/licence-audit.ts with 19 tests.
 *
 * ─── AND IT CHANGES NOTHING BY ITSELF ───────────────────────────────────────
 * The report is a report. Adjusting a seat count moves money — a renewal price, a vendor
 * bill, a customer's invoice — and doing that from a CSV somebody exported five minutes
 * ago, in bulk, on a screen showing thirty rows, is how a reconciliation becomes an
 * incident. Every row links to the subscription so the change is made where its
 * consequences are visible.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn, rupee } from "@/lib/utils";
import {
  parseVendorCsv, auditLicences, mismatchNote,
  type BilledSub, type Mismatch, type MismatchKind,
} from "@/lib/subscriptions/licence-audit";

export interface LicenceAuditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Every subscription on the page. Scoped by the vendor picker below. */
  subs: readonly BilledSub[];
  /** Each subscription's vendor, so the scope filter needs no string matching. */
  vendorOf: (s: BilledSub) => string;
}

type VendorPick = "google" | "microsoft" | "zoho" | "all";

const TONE: Record<MismatchKind, { kind: "danger" | "warning" | "muted"; label: string }> = {
  unbilled:          { kind: "danger",  label: "Not billed" },
  "no-subscription": { kind: "danger",  label: "No subscription" },
  "over-billed":     { kind: "warning", label: "Over-billed" },
  "not-in-export":   { kind: "muted",   label: "Not in file" },
};

export function LicenceAuditDialog({ open, onOpenChange, subs, vendorOf }: LicenceAuditDialogProps) {
  const [csv, setCsv] = React.useState("");
  const [vendor, setVendor] = React.useState<VendorPick>("google");

  /* A fresh dialog every time. Leaving the last customer's employee list in the box would
     be both confusing and a small privacy leak between sessions on a shared machine. */
  React.useEffect(() => { if (!open) setCsv(""); }, [open]);

  const parsed = React.useMemo(() => (csv.trim() ? parseVendorCsv(csv) : null), [csv]);

  const audit = React.useMemo(() => {
    if (!parsed || parsed.perDomain.length === 0) return null;
    return auditLicences(
      parsed.perDomain,
      subs,
      /* "All" is offered but is NOT the default: a Google export compared against every
         vendor's rows fills the report with "not in file" for Microsoft seats, and a
         report you have to learn to ignore is worse than none. */
      (s) => vendor === "all" || vendorOf(s) === vendor,
    );
  }, [parsed, subs, vendor, vendorOf]);

  const onFile = async (f: File | null) => {
    if (!f) return;
    setCsv(await f.text());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Check vendor licences against your books</DialogTitle>
          <DialogDescription>
            Export the user list from the Google Admin or Microsoft 365 console and drop it
            here. Nothing is uploaded — the file is read in this browser and compared with
            the subscriptions already on screen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {(["google", "microsoft", "zoho", "all"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVendor(v)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[12px] capitalize transition-colors",
                  vendor === v
                    ? "border-amber bg-amber-soft font-semibold text-amber-ink"
                    : "border-hairline text-ink-2 hover:bg-paper-2",
                )}
              >
                {v === "all" ? "All vendors" : v}
              </button>
            ))}
            <label className="ml-auto cursor-pointer text-[12px] text-amber-ink hover:underline">
              Choose a CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <Textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={5}
            placeholder={"Paste the CSV, or use “Choose a CSV file”.\nIt needs a column of email addresses — “Email Address” (Google) or “User principal name” (Microsoft)."}
            className="font-mono text-[12px]"
          />

          {/* What the parser made of the file, BEFORE any conclusion. An operator who
              cannot see which column was read has no way to tell a good report from a
              confident wrong one. */}
          {parsed && (
            <div className="rounded-md border border-hairline bg-paper-2/40 p-2.5 text-[12px] text-ink-2">
              {parsed.emailColumn ? (
                <>
                  Read <span className="font-mono">{parsed.emailColumn}</span> from{" "}
                  {parsed.totalRows} rows
                  {parsed.statusColumn && <> · suspended accounts excluded via <span className="font-mono">{parsed.statusColumn}</span></>}
                  {" · "}{parsed.perDomain.length} domain{parsed.perDomain.length === 1 ? "" : "s"}
                </>
              ) : (
                <span className="text-rose">{parsed.skipped[0]?.reason ?? "Could not read this file."}</span>
              )}
              {parsed.skipped.length > 0 && parsed.emailColumn && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-ink-3">
                    {parsed.skipped.length} row{parsed.skipped.length === 1 ? "" : "s"} not counted
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-2xs text-ink-3">
                    {parsed.skipped.slice(0, 20).map((s) => (
                      <li key={s.row}>Row {s.row}: {s.reason}</li>
                    ))}
                    {parsed.skipped.length > 20 && <li>…and {parsed.skipped.length - 20} more</li>}
                  </ul>
                </details>
              )}
            </div>
          )}

          {audit && (
            <>
              {/* The two figures are NEVER netted off. One is money leaking out of the
                  reseller; the other is money wrongly taken from a customer. A single
                  "net difference" would hide both. */}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Figure
                  label="Not billed"
                  value={rupee(audit.unbilledMonthly)}
                  sub="per month you are paying and not charging"
                  tone={audit.unbilledMonthly > 0 ? "rose" : "muted"}
                />
                <Figure
                  label="Over-billed"
                  value={rupee(audit.overBilledMonthly)}
                  sub="per month a customer is charged too much"
                  tone={audit.overBilledMonthly > 0 ? "amber" : "muted"}
                />
                <Figure label="Matched" value={String(audit.matched)} sub="domains that agree" tone="emerald" />
              </div>

              {audit.mismatches.length === 0 ? (
                <p className="rounded-md border border-emerald/40 bg-emerald-soft/40 px-3 py-2 text-[13px] text-ink">
                  ✓ Every domain in this file matches what you bill. Nothing to fix.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {audit.mismatches.map((m) => <Row key={`${m.kind}-${m.domain}`} m={m} />)}
                </ul>
              )}

              <p className="border-t border-hairline pt-2 text-2xs leading-snug text-ink-3">
                This report changes nothing. Adjusting a seat count moves a renewal price, a
                vendor bill and a customer&apos;s invoice — make each change on the
                subscription itself, where you can see what it does.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Figure({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone: "rose" | "amber" | "emerald" | "muted";
}) {
  return (
    <div className="rounded-lg border border-hairline bg-paper-2/40 p-2.5">
      <p className="text-3xs font-semibold uppercase tracking-wider text-ink-3">{label}</p>
      <p className={cn(
        "font-serif text-lg tabular-nums",
        tone === "rose" && "text-rose",
        tone === "amber" && "text-amber-ink",
        tone === "emerald" && "text-emerald",
        tone === "muted" && "text-ink-3",
      )}>
        {value}
      </p>
      <p className="text-3xs leading-snug text-ink-3">{sub}</p>
    </div>
  );
}

function Row({ m }: { m: Mismatch }) {
  const t = TONE[m.kind];
  return (
    <li className="flex flex-wrap items-start gap-2 rounded-md border border-hairline bg-paper px-2.5 py-2">
      <Badge kind={t.kind} size="sm" dot>{t.label}</Badge>
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">
        {mismatchNote(m, rupee)}
      </span>
      {m.consoleSeats != null && m.billedSeats != null && (
        <span className="shrink-0 font-mono text-2xs text-ink-3">
          {m.consoleSeats} / {m.billedSeats}
          <Icon name="arrow_right" size={10} className="mx-1 inline align-middle" />
          {m.delta != null && m.delta > 0 ? `+${m.delta}` : m.delta}
        </span>
      )}
    </li>
  );
}
