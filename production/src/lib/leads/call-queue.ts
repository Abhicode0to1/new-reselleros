/**
 * Today's Priority Call Queue — who the rep should ring next, and in what order.
 *
 * ─── WHAT COUNTS AS "DUE TODAY" ─────────────────────────────────────────────
 * `follow_up_date <= today`, so OVERDUE leads are in the queue, not excluded from it.
 * A queue that showed only exactly-today would put the most neglected leads — the ones
 * a rep promised to call last Tuesday — behind the ones they promised to call this
 * morning. Overdue sorts first, most overdue at the top.
 *
 * ─── WHY A PHONE NUMBER IS REQUIRED ────────────────────────────────────────
 * This is a CALL queue and its primary button dials. A row with no number would be a
 * button that cannot work. But those leads are not dropped silently: the queue reports
 * `dueWithoutPhone`, and the bar says so with a link to fix it. A missing number is a
 * two-second fix that nobody will ever make if nothing mentions it.
 *
 * ─── ORDERING ──────────────────────────────────────────────────────────────
 *   1. days overdue, descending  — promises broken longest ago first
 *   2. heat score, descending    — then by how good the lead actually is
 *   3. value, descending         — then by money
 *   4. company, A→Z              — a total order, so the list does not reshuffle
 *                                  between renders and move the button under a thumb
 * That last one matters more than it looks: an unstable sort in a 1-tap call bar means
 * the rep taps Call on the lead that was there a moment ago.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { heatScore, type HeatScoreBreakdown } from "./heat-score";
import { localDateISO } from "./outcomes";

/** Stages that are finished. Nobody needs a reminder to call a won or lost deal. */
const TERMINAL_STAGES: ReadonlySet<string> = new Set(["won", "lost"]);

export interface QueueEntry {
  lead: Lead;
  heat: HeatScoreBreakdown;
  /** 0 = due today, positive = that many days late. */
  daysOverdue: number;
}

export interface CallQueue {
  /** The top N, worst first. */
  entries: QueueEntry[];
  /** Everything due, before the top-N cut — so the bar can say "3 of 11". */
  dueCount: number;
  /** Due today but unreachable: no phone number on record. Reported, never hidden. */
  dueWithoutPhone: Lead[];
  /** How many of `entries` are actually late rather than due today. */
  overdueCount: number;
}

function daysBetweenISO(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  if ([fy, fm, fd, ty, tm, td].some((n) => !Number.isFinite(n))) return 0;
  const from = Date.UTC(fy, fm - 1, fd);
  const to   = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

export function buildCallQueue(
  leads: readonly Lead[],
  limit = 3,
  now: Date = new Date(),
): CallQueue {
  const today = localDateISO(now);

  const due: QueueEntry[] = [];
  const dueWithoutPhone: Lead[] = [];

  for (const l of leads) {
    if (l.is_junk) continue;
    if (TERMINAL_STAGES.has(l.stage ?? "")) continue;
    if (!l.follow_up_date) continue;

    const daysOverdue = daysBetweenISO(l.follow_up_date, today);
    if (daysOverdue < 0) continue;               // scheduled for the future

    const phone = (l.contact_phone ?? "").trim();
    if (!phone) { dueWithoutPhone.push(l); continue; }

    due.push({ lead: l, heat: heatScore(l, null, now), daysOverdue });
  }

  due.sort((a, b) =>
    b.daysOverdue - a.daysOverdue ||
    b.heat.score - a.heat.score ||
    (b.lead.value ?? 0) - (a.lead.value ?? 0) ||
    (a.lead.company ?? "").localeCompare(b.lead.company ?? ""));

  return {
    entries: due.slice(0, Math.max(0, limit)),
    dueCount: due.length,
    dueWithoutPhone,
    overdueCount: due.filter((e) => e.daysOverdue > 0).length,
  };
}

/**
 * The WhatsApp text for a queue lead. Deliberately plain and un-templated: a rep can
 * see the whole message before it sends, and there is no placeholder left to leak
 * ("Hi {{name}}") if a field is missing.
 */
export function queueWhatsAppMessage(
  lead: Pick<Lead, "company" | "contact_name" | "plan">,
  fromTenant?: string | null,
): string {
  const hi = lead.contact_name?.trim() ? `Hi ${lead.contact_name.trim()}` : "Hello";
  const about = lead.plan?.trim() ? ` about ${lead.plan.trim()}` : "";
  const from = fromTenant?.trim() ? ` — ${fromTenant.trim()}` : "";
  return `${hi}, following up${about} for ${lead.company}. Is now a good time for a quick call?${from}`;
}

/**
 * Digits-only number for a wa.me / tel: link, with India's country code assumed.
 *
 * The leading-zero case is not academic: Indian landlines are written domestically as
 * "(011) 4567-8901", and passing that straight through yields 01145678901, which wa.me
 * silently fails on. A test with a deliberately awkward expectation is what surfaced
 * it — the ISD prefix has to be dropped before 91 is added.
 */
export function dialable(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  if (digits.length === 10) return `91${digits}`;
  // Domestic trunk prefix: 0 + 10 digits.
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  // Already international, or something we should not second-guess.
  return digits;
}
