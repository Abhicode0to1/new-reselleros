/**
 * Project (custom-software) enquiries — the pure parts: the plan label a qualified project
 * lead carries, the payment schedules a project quotation offers, and the pipeline split.
 *
 * A licence enquiry is plan × seats; a project enquiry is a requirement, a budget and a
 * timeline (migration 20260926110000). Its quotation is a PROJECT quotation, with milestones.
 */

/** What a qualified project lead carries in `plan` — the pipeline's "qualified" signal. */
export const PROJECT_PLAN_LABEL = "Custom software project";

export interface MilestoneSplit { key: string; label: string; parts: readonly { label: string; pct: number }[] }

/** The schedules a software house actually quotes. Percentages of the GST-inclusive total. */
export const MILESTONE_SPLITS: readonly MilestoneSplit[] = [
  { key: "50-50",    label: "50% advance · 50% on delivery", parts: [{ label: "Advance", pct: 50 }, { label: "On delivery", pct: 50 }] },
  { key: "30-40-30", label: "30% advance · 40% midway · 30% on delivery",
    parts: [{ label: "Advance", pct: 30 }, { label: "Midway", pct: 40 }, { label: "On delivery", pct: 30 }] },
  { key: "100",      label: "100% advance", parts: [{ label: "Full payment", pct: 100 }] },
];

/**
 * Milestones for a GST-inclusive total. Whole rupees; the last milestone takes the rounding
 * remainder so they add up to the total exactly — a schedule that is ₹1 off its quotation is
 * refused by update_project_future_milestones, and rightly.
 */
export function milestonesFor(totalInclusive: number, split: MilestoneSplit) {
  let used = 0;
  return split.parts.map((p, i) => {
    const amount = i === split.parts.length - 1 ? totalInclusive - used : Math.round((totalInclusive * p.pct) / 100);
    used += amount;
    return { label: p.label, total_amount: amount, due_date: null as string | null };
  });
}

/** GST on a pre-GST amount, the way create_project_quote computes it (so the preview matches). */
export function withGst(taxable: number, gstRatePct: number) {
  const gst = Math.round((taxable * gstRatePct) / 100);
  return { taxable, gst, total: taxable + gst };
}

/**
 * Place of supply: inter-state (IGST) when the client's state differs from ours. Null when
 * either is unknown — the operator is then asked, never guessed for.
 */
export function interStateFor(sellerState: string | null | undefined, clientState: string | null | undefined): boolean | null {
  const a = (sellerState ?? "").trim(), b = (clientState ?? "").trim();
  if (!a || !b) return null;
  return a !== b;
}

/** Open pipeline value split by enquiry type — licences and projects are different businesses. */
export function pipelineSplit(leads: readonly { enquiry_type?: string | null; value: number | null }[]) {
  let subscription = 0, project = 0;
  for (const l of leads) {
    if (l.enquiry_type === "project") project += l.value ?? 0;
    else subscription += l.value ?? 0;
  }
  return { subscription, project };
}
