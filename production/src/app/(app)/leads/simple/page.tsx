"use client";

/**
 * /leads/simple — the leads page with nothing on it but leads.
 *
 * ─── WHY THIS IS A SECOND ROUTE AND NOT A REWRITE ────────────────────────────
 * `(app)/leads/page.tsx` is 4,166 lines: a kanban board with drag-to-restage, bulk
 * actions, CSV import, the merge dialog, the junk reviewer, a detail sheet and a right
 * rail. Replacing it to try a simpler shape would delete working features to test a
 * hypothesis. This sits beside it, reads the same data through the same hook, and can be
 * deleted in one commit if the shape is wrong.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT HAVE ─────────────────────────────────────
 * Measured on /leads, 25 Aug 2026: six separate ways to narrow one list — 8 folder chips,
 * 2 filter chips, a 9-row Views menu, a Filter dropdown, a Me/Team toggle and a search
 * box — narrowing 2 open leads. Two of those six could show as active at the same time.
 * There are no filters here at all, so that class of bug cannot be written.
 *
 * Stage names do not reach the screen either. `contact` means "we have spoken to them and
 * priced nothing", which nobody says out loud; `nextStep()` turns it into a verb.
 *
 * The arithmetic is printed from the same object the rows were drawn from — see
 * `simple-buckets.ts` for why that is a promise a test can fail rather than a comment.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";

import { useLeads, useUpdateLead } from "@/lib/queries/leads";
import { bucketLeads, nextStep, type DuplicateGroup } from "@/lib/leads/simple-buckets";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, cleanDisplayName } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";

/* ── One row shape, used by every lead and every group ──────────────────────
   Same five things in the same order every time: who · how big · what to do ·
   why · the one button. Nothing to read across, nothing to learn per section. */
function Row({
  who,
  amount,
  amountNote,
  what,
  why,
  action,
  tone = "plain",
}: {
  who: string;
  amount: string;
  amountNote: string;
  what?: string;
  why: string;
  action: React.ReactNode;
  tone?: "plain" | "attention";
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline px-5 py-4",
        tone === "attention" && "bg-amber-soft/40",
      )}
    >
      <span className="w-[168px] shrink-0 text-base font-bold text-ink">{who}</span>
      <div className="w-[148px] shrink-0">
        <div className="font-mono text-sm font-bold tabular-nums text-ink">{amount}</div>
        <div className="text-2xs text-ink-3">{amountNote}</div>
      </div>
      <div className="min-w-0 flex-1">
        {what ? <div className="text-sm font-semibold text-ink">{what}</div> : null}
        <div className="text-2xs leading-relaxed text-ink-3">{why}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function SectionHead({ label, count, note }: { label: string; count?: number; note: string }) {
  return (
    <div className="flex items-baseline gap-2 px-5 pb-3 pt-6">
      <span className="text-2xs font-bold uppercase tracking-widest text-ink-3">{label}</span>
      {count !== undefined ? (
        <span className="font-mono text-xs font-bold tabular-nums text-ink">{count}</span>
      ) : null}
      <div className="flex-1" />
      <span className="text-2xs text-ink-3">{note}</span>
    </div>
  );
}

/* ── The follow-up date, which is the action this workspace actually needs ──
   Test Company's quote went out on 22 Aug with `follow_up_date` NULL, so nothing
   was ever going to chase it. No default day is offered: picking one for the user
   would be inventing a rule nobody has stated. */
function PickADay({ lead }: { lead: Lead }) {
  const [open, setOpen] = React.useState(false);
  const update = useUpdateLead();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-amber px-4 text-sm font-bold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
      >
        <Icon name="calendar" size={16} />
        Pick a day
      </button>
    );
  }

  return (
    <label className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-hairline-strong bg-paper px-3">
      <span className="text-2xs font-semibold text-ink-2">Chase on</span>
      <input
        type="date"
        autoFocus
        className="bg-transparent text-sm text-ink focus:outline-none"
        onChange={(e) => {
          if (!e.target.value) return;
          update.mutate({ id: lead.id, patch: { follow_up_date: e.target.value } });
          setOpen(false);
        }}
      />
    </label>
  );
}

export default function SimpleLeadsPage() {
  const router = useRouter();
  const { data: leads, isLoading, error } = useLeads();
  const [showWon, setShowWon] = React.useState(false);
  const [showDupes, setShowDupes] = React.useState(false);

  const b = React.useMemo(() => bucketLeads(leads ?? []), [leads]);

  /* Same params the big page carries into the quote builder, so a quote started here
     arrives with the lead's context exactly as it does from the board. */
  const sendQuote = (lead: Lead) => {
    const params = new URLSearchParams();
    params.set("leadId", lead.id);
    params.set("company", lead.company);
    if (lead.plan) params.set("plan", lead.plan);
    if (lead.seats != null) params.set("seats", String(lead.seats));
    if (lead.contact_name) params.set("contact", lead.contact_name);
    if (lead.contact_email) params.set("email", lead.contact_email);
    if (lead.contact_phone) params.set("phone", lead.contact_phone);
    router.push(`/quotes/new?${params.toString()}` as never);
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[1000px] p-4 md:p-6">
        <div className="h-8 w-32 animate-pulse rounded bg-paper-2" />
        <div className="mt-6 space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-paper-2" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-[1000px] p-4 md:p-6">
        <EmptyState
          icon="alert"
          title="Could not load your leads"
          body={error instanceof Error ? error.message : "Something went wrong reading the list."}
          action={
            <Link
              href={"/leads" as Route}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-hairline-strong px-4 text-sm font-semibold text-ink"
            >
              Open the full leads page
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1000px] p-4 md:p-6">
      <div className="overflow-hidden rounded-xl border border-hairline bg-paper">
        {/* Header: the name, and the one thing you can start. */}
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <h1 className="font-serif text-2xl font-bold text-ink">Leads</h1>
          <div className="flex-1" />
          <Link
            href={"/leads" as Route}
            className="inline-flex min-h-[38px] items-center px-2 text-2xs font-semibold text-ink-3 underline decoration-hairline-strong underline-offset-2 hover:text-ink-2"
          >
            Full page
          </Link>
          <Link
            href={"/leads?add=1" as Route}
            className="inline-flex min-h-[38px] items-center gap-2 rounded-lg bg-amber px-4 text-xs font-bold text-white transition-opacity hover:opacity-90"
          >
            <Icon name="plus" size={14} />
            Add lead
          </Link>
        </div>

        {b.counts.total === 0 ? (
          <div className="border-t border-hairline px-5 py-10">
            <EmptyState
              icon="inbox"
              title="No leads yet"
              body="Every enquiry that comes in will land here, with the one thing to do about it."
              action={
                <Link
                  href={"/leads?add=1" as Route}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-amber px-4 text-sm font-bold text-white"
                >
                  <Icon name="plus" size={16} />
                  Add the first one
                </Link>
              }
            />
          </div>
        ) : (
          <>
            {/* ── TO DO ─────────────────────────────────────────────────── */}
            <SectionHead
              label="To do"
              count={b.counts.todo}
              note={b.counts.todo === 0 ? "nothing open right now" : `${rupee(b.openValue)} open`}
            />

            {b.counts.todo === 0 ? (
              <div className="border-t border-hairline px-5 py-6 text-sm text-ink-3">
                Nothing is open. Everything you have is won, lost or junk.
              </div>
            ) : (
              b.todo.map((lead) => {
                const step = nextStep(lead);
                return (
                  <Row
                    key={lead.id}
                    tone={step.unscheduled ? "attention" : "plain"}
                    who={cleanDisplayName(lead.company)}
                    amount={lead.value ? rupee(lead.value) : "no price yet"}
                    amountNote={
                      lead.seats ? `${lead.seats} seat${lead.seats === 1 ? "" : "s"} · a year` : "seats not given"
                    }
                    what={step.action === "Pick a day" ? "Pick a day to call them" : step.action}
                    why={step.because}
                    action={
                      step.action === "Pick a day" ? (
                        <PickADay lead={lead} />
                      ) : (
                        <button
                          type="button"
                          onClick={() => sendQuote(lead)}
                          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-amber px-4 text-sm font-bold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                        >
                          <Icon name="file" size={16} />
                          {step.action}
                        </button>
                      )
                    }
                  />
                );
              })
            )}

            {/* ── EVERYTHING ELSE ──────────────────────────────────────── */}
            <SectionHead label="Everything else" note="nothing here needs you today" />

            <Row
              who="Won"
              amount={rupee(b.wonValue)}
              amountNote={`${b.counts.won} deal${b.counts.won === 1 ? "" : "s"}`}
              why="Closed and paid for. Nothing to chase."
              action={
                <button
                  type="button"
                  aria-expanded={showWon}
                  onClick={() => setShowWon((v) => !v)}
                  className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-hairline-strong bg-paper px-4 text-xs font-semibold text-ink hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                >
                  {showWon ? "Hide" : `See the ${b.counts.won}`}
                </button>
              }
            />
            {showWon ? (
              <ul className="border-t border-hairline bg-paper-2/50 px-5 py-2">
                {b.won.map((l) => (
                  <li key={l.id} className="flex items-baseline gap-3 py-1.5 text-xs">
                    <span className="w-[168px] shrink-0 font-semibold text-ink">
                      {cleanDisplayName(l.company)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-2xs text-ink-3">
                      {l.seats ? `${l.seats} seats` : "seats not given"}
                      {l.plan ? ` · ${l.plan}` : ""}
                    </span>
                    <span className="font-mono text-xs font-semibold tabular-nums text-ink">
                      {l.value ? rupee(l.value) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {b.counts.duplicateRecords > 0 ? (
              <>
                <Row
                  who="Duplicates"
                  amount={String(b.counts.duplicatePeople)}
                  amountNote={`${b.counts.duplicatePeople} companies · ${b.counts.duplicateRecords} records`}
                  why={dupeSentence(b.duplicates)}
                  action={
                    <button
                      type="button"
                      aria-expanded={showDupes}
                      onClick={() => setShowDupes((v) => !v)}
                      className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-hairline-strong bg-paper px-4 text-xs font-semibold text-ink hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    >
                      {showDupes ? "Hide" : "See them"}
                    </button>
                  }
                />
                {showDupes ? (
                  <ul className="border-t border-hairline bg-paper-2/50 px-5 py-2">
                    {b.duplicates.map((g) => (
                      <li key={g.company} className="flex items-baseline gap-3 py-1.5 text-xs">
                        <span className="w-[168px] shrink-0 font-semibold text-ink">{g.company}</span>
                        <span className="w-8 shrink-0 font-mono text-xs font-bold tabular-nums text-rose-ink">
                          ×{g.records.length}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-2xs text-ink-3">
                          {g.seats ? `${g.seats} seats` : "seats not given"}
                        </span>
                        <Link
                          href={"/leads?view=junk" as Route}
                          className="text-2xs font-semibold text-amber-ink hover:underline"
                        >
                          Merge on the full page
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}

            {/* Lost-but-not-junk. Zero here today; shown when it is not, so the
                total below can never be short by one without saying so. */}
            {b.counts.closedOther > 0 ? (
              <Row
                who="Lost"
                amount={String(b.counts.closedOther)}
                amountNote="deals"
                why="Marked lost, and not junk. Kept so the count below stays honest."
                action={
                  <Link
                    href={"/leads" as Route}
                    className="inline-flex min-h-[40px] items-center rounded-lg border border-hairline-strong bg-paper px-4 text-xs font-semibold text-ink"
                  >
                    See them
                  </Link>
                }
              />
            ) : null}

            {/* ── THE ARITHMETIC ───────────────────────────────────────────
                Printed from the same object the rows were drawn from. If a lead
                ever went missing, `everyLeadPlaced` says so instead of the page
                quietly showing a total that is short. */}
            <div className="flex flex-wrap items-baseline gap-2 border-t border-hairline bg-paper-2 px-5 py-4">
              {b.everyLeadPlaced ? (
                <>
                  <span className="font-mono text-xs font-bold tabular-nums text-ink">{sumLine(b.counts)}</span>
                  <span className="text-2xs text-ink-3">
                    Every lead you have is on this page. There is no filter, so nothing can be hidden from you.
                  </span>
                </>
              ) : (
                <span className="text-xs font-semibold text-rose-ink">
                  Something is wrong with this count — {b.counts.total} leads, but the rows above only
                  account for{" "}
                  {b.counts.todo + b.counts.won + b.counts.duplicateRecords + b.counts.closedOther}. Use the
                  full leads page until this is fixed.
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** "Kavita Iyer is in four times, Probe Labs three, and 4 others twice each." */
function dupeSentence(groups: readonly DuplicateGroup[]): string {
  if (groups.length === 0) return "";
  const worst = groups[0];
  const rest = groups.length - 1;
  const times = (n: number) => (n === 2 ? "twice" : `${n} times`);
  return (
    `${worst.company} is in ${times(worst.records.length)}` +
    (rest > 0 ? `, and ${rest} other${rest === 1 ? "" : "s"} more than once` : "") +
    ". The full page counts these as junk, which hides that they are the same companies."
  );
}

/** "2 + 12 + 15 = 29", built from the counts that were rendered. */
function sumLine(c: {
  todo: number;
  won: number;
  duplicateRecords: number;
  closedOther: number;
  total: number;
}): string {
  const parts = [c.todo, c.won, c.duplicateRecords];
  if (c.closedOther > 0) parts.push(c.closedOther);
  return `${parts.join(" + ")} = ${c.total}`;
}
