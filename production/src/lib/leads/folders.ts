/**
 * The pipeline as folders a salesperson can act on.
 *
 * ─── WHY NOT STAGE TABS ─────────────────────────────────────────────────────
 * `new / contact / demo / trial / quote / won / lost` describes where a deal sits in
 * a process. It does not answer the question a rep opens this page with, which is
 * "what do I do next?" — a ₹4L deal going cold and a ₹5k deal going cold are the same
 * tab, and a lead whose follow-up was due yesterday is in whichever stage it happened
 * to be parked in.
 *
 * ─── THE MONEY THRESHOLD IS IMPORTED; THE "HOT" RULE IS DELIBERATELY NARROWER ─
 * HIGH_VALUE (₹1,00,000) comes from heat.ts and is not re-typed here — a second copy
 * would drift from the heat badge the same rep is looking at three inches away.
 *
 * `isHotLead` is NOT used wholesale, and that is a decision worth arguing with. It
 * counts demo, trial AND quote as hot, which is right for a badge meaning "advanced
 * in the funnel". As a FOLDER rule it would make Hot Deals a superset of Quote Sent —
 * every quoted lead in both — and two folders where one is entirely inside the other
 * teaches a rep that the folders do not mean anything.
 *
 * So Hot Deals is the two signals that actually say "this one, today": a human
 * flagged it high priority, or it is worth ₹1,00,000 or more. The badge keeps its own
 * broader meaning and the two are not in conflict; they answer different questions.
 *
 * ─── JUNK AND LOST ARE NOT WORK ─────────────────────────────────────────────
 * Both are kept out of every working folder. A junk lead in Hot Deals because someone
 * typed ₹5,00,000 into a spam enquiry is exactly the sort of thing that teaches a rep
 * to stop trusting the folder counts.
 *
 * ─── JUNK IS NOT A FOLDER AT ALL ────────────────────────────────────────────
 * There used to be an "archived" folder holding `lost` OR `is_junk`, next to a Junk chip
 * of its own — so every binned lead sat in two places under two names, and neither chip
 * could be described in one sentence. "We competed and lost" and "this was never a real
 * enquiry" are different facts that lead to different actions: one is win/loss analysis,
 * the other is a lead-source problem.
 *
 * So `lost` means lost, junk belongs to the Junk view, and no lead is ever in both.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { isHighValueLead } from "./heat";

export type SalesFolder =
  | "inbox" | "hot" | "quoted" | "followup" | "won" | "lost";

export interface SalesFolderMeta {
  id:    SalesFolder;
  label: string;
  icon:  string;
  /** Plain English for when it is empty. */
  hint:  string;
}

export const SALES_FOLDERS: readonly SalesFolderMeta[] = [
  { id: "inbox",    label: "Inbox",           icon: "📥", hint: "New enquiries nobody has picked up yet." },
  { id: "hot",      label: "Hot Deals",       icon: "⚡", hint: "Nothing marked high priority or worth ₹1,00,000 or more." },
  { id: "quoted",   label: "Quote Sent",      icon: "📄", hint: "No proposals waiting on a customer's answer." },
  { id: "followup", label: "Follow-Up Needed",icon: "⏰", hint: "Nothing overdue — every follow-up date is still ahead." },
  { id: "won",      label: "Won",             icon: "🏆", hint: "No deals closed yet — won leads collect here." },
  { id: "lost",     label: "Lost",            icon: "📁", hint: "No deals lost yet. Junk is separate — that is the 🚫 view." },
] as const;

/** The fields the folder rules read. Structural so tests need no DB row. */
export type FolderLead = Pick<Lead, "stage" | "value" | "priority"> & {
  is_junk:        boolean | null;
  follow_up_date: string | null;
};

/** Lost, won or junk — closed one way or another, and not today's work. */
export function isClosed(l: FolderLead): boolean {
  return l.stage === "won" || l.stage === "lost" || l.is_junk === true;
}

/**
 * A follow-up that has come due.
 *
 * `<=` and not `<`: a follow-up dated today IS due today. Comparing dates as ISO
 * strings works because both sides are YYYY-MM-DD, and `todayISO` is the caller's
 * IST date (localDateISO) — using the browser's local date would move the boundary
 * for anyone travelling.
 */
export function isFollowUpDue(l: FolderLead, todayISO: string): boolean {
  if (isClosed(l)) return false;
  if (!l.follow_up_date) return false;
  return l.follow_up_date.slice(0, 10) <= todayISO;
}

export function inSalesFolder(l: FolderLead, folder: SalesFolder, todayISO: string): boolean {
  switch (folder) {
    case "inbox":
      /* Untouched. Once someone has made contact it is no longer an inbox item, even
         if nothing has been agreed. */
      return !isClosed(l) && l.stage === "new";

    case "hot":
      /* Read as OR: a ₹4,00,000 deal nobody flagged is still the biggest thing on the
         page, and a flagged ₹20,000 deal is still what the rep said to chase.
         Deliberately NOT isHotLead — see the header. */
      return !isClosed(l) && (l.priority === "high" || isHighValueLead(l));

    case "quoted":
      return !isClosed(l) && l.stage === "quote";

    case "followup":
      return isFollowUpDue(l, todayISO);

    case "won":
      /* Junk is NOT excluded by an `isClosed` check here, deliberately: a lead marked
         both won and junk is a data contradiction, and it should show up in Won where
         somebody will notice it rather than be filtered into silence. */
      return l.stage === "won";

    case "lost":
      /* Lost only. Junk has its own view — see the header. */
      return l.stage === "lost";
  }
}

export function salesFolderCounts(
  leads: readonly FolderLead[],
  todayISO: string,
): Record<SalesFolder, number> {
  const counts = { inbox: 0, hot: 0, quoted: 0, followup: 0, won: 0, lost: 0 } as Record<SalesFolder, number>;
  for (const l of leads) {
    for (const f of SALES_FOLDERS) if (inSalesFolder(l, f.id, todayISO)) counts[f.id] += 1;
  }
  return counts;
}

/**
 * ₹ of open pipeline in a folder.
 *
 * Won and lost return 0 even when the folder IS won or lost: a "total" beside a folder
 * name reads as pipeline, and putting closed money in it inflates the number a rep
 * reports upward.
 */
export function salesFolderValue(
  leads: readonly FolderLead[],
  folder: SalesFolder,
  todayISO: string,
): number {
  if (folder === "won" || folder === "lost") return 0;
  return leads
    .filter((l) => inSalesFolder(l, folder, todayISO))
    .reduce((sum, l) => sum + (l.value ?? 0), 0);
}
