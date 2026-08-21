/**
 * useNavBadges — fetches live counts for sidebar badges.
 *
 * Returns a map of nav item id → badge string (or undefined if zero).
 * Only shows a badge when count > 0 so the sidebar stays clean.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { tiersApprovableBy } from "@/lib/quotes/awaiting-approval";

interface NavBadges {
  leads?:        string;
  enquiries?:    string;
  deals?:        string;
  tasks?:        string;
  renewals?:     string;
  invoices?:     string;
  payments?:     string;
  quotes?:       string;
  support?:      string;
  whatsapp?:     string;
}

async function fetchNavBadges(): Promise<NavBadges> {
  const supabase = createClient();
  const badges: NavBadges = {};

  /* Who is asking. Every other count in this hook is a tenant fact, but "waiting for YOUR
     approval" is not, and a badge that counted everyone's pending approvals would send
     three owners to look at the same one quote. */
  const { data: auth } = await supabase.auth.getUser();
  const myId = auth.user?.id ?? null;
  const myRole = myId
    ? (await supabase.from("users").select("role").eq("id", myId).maybeSingle()).data?.role ?? null
    : null;

  // End-of-today in IST as UTC ISO — used for "due today or overdue" count.
  // (Replicated from lib/queries/tasks.ts todayBoundariesIST so this hook
  // doesn't depend on the queries module.)
  const now = new Date();
  const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const istMid = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()));
  const startUTC = new Date(istMid.getTime() - (5.5 * 60 * 60 * 1000));
  const endOfTodayISO = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // Run all counts in parallel.
  //
  // Leads vs Deals split (CRITICAL for badge↔page consistency):
  // - /leads page shows only RAW inquiries (plan IS NULL / empty).
  // - /deals page shows only QUALIFIED deals (plan set, stage active).
  // Badges must mirror what the destination page renders, otherwise
  // operator clicks "Leads 14" and sees an empty page (Pardeep dogfood
  // 2026-05-29). So we count them as two separate buckets here.
  const [leadsRes, enquiriesRes, dealsRes, tasksRes, renewalsRes, invoicesRes, paymentsRes] = await Promise.all([
    // RAW leads = pre-quote inbox (stage new/contact). Mirrors isRaw() in
    // src/app/(app)/leads/page.tsx: a lead leaves the inbox only when a quote
    // is sent (stage → quote), which is what makes it a deal.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .in("stage", ["new", "contact"]),

    // Untriaged inbound emails — received but not yet turned into / attached to
    // a lead. Mirrors the Enquiries Inbox "New to triage" count.
    supabase
      .from("inbound_emails")
      .select("id", { count: "exact", head: true })
      .eq("status", "received")
      .is("lead_id", null),

    // ACTIVE deals = post-quote, still open (quote sent / demo / trial). Won and
    // lost are terminal, so excluded. Matches the /deals "active deals" count.
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .in("stage", ["quote", "demo", "trial"]),

    // Pending tasks due by end of today (overdue + today combined — the
    // ones the rep needs to clear before EOD)
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("due_at", endOfTodayISO),

    // Renewals due in next 30 days
    supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .lte("renewal_date", new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]),

    // Unpaid / overdue invoices
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "overdue"]),

    // Payments received but invoice NOT yet generated (operator action needed)
    supabase
      .from("quotes")
      .select("id", { count: "exact", head: true })
      .eq("payment_status", "received"),
  ]);

  const leadsCount     = leadsRes.count     ?? 0;
  const enquiriesCount = enquiriesRes.count ?? 0;
  const dealsCount     = dealsRes.count     ?? 0;
  const tasksCount    = tasksRes.count    ?? 0;
  const renewalsCount = renewalsRes.count ?? 0;
  const invoicesCount = invoicesRes.count ?? 0;
  const paymentsCount = paymentsRes.count ?? 0;

  if (leadsCount     > 0) badges.leads     = String(leadsCount);
  if (enquiriesCount > 0) badges.enquiries = String(enquiriesCount);
  if (dealsCount     > 0) badges.deals     = String(dealsCount);
  if (tasksCount    > 0) badges.tasks    = String(tasksCount);
  if (renewalsCount > 0) badges.renewals = String(renewalsCount);
  if (invoicesCount > 0) badges.invoices = String(invoicesCount);
  if (paymentsCount > 0) badges.payments = String(paymentsCount);

  /* ── Quotes waiting on YOUR approval ───────────────────────────────────────
     The only count in this hook addressed to a person rather than to the tenant, so it
     has to know who is asking — hence the extra round trip, and only for people whose
     role can approve anything at all.

     It exists because the quote page told a rep "it is in their approvals queue" while no
     queue existed: a pending quote was visible only to whoever thought to open it, so the
     owner who had to clear it was never told. This is what turns that sentence true.

     Mirrors /quotes exactly, which is this file's own rule (see the Leads-vs-Deals note
     above). Three parts, all matching `awaitsMyApproval`: pending, not raised by me — a
     person cannot approve their own quote, and Postgres drops NULL rows on `neq`, which is
     also what the predicate wants — and a tier my role may clear, from the shared
     `tiersApprovableBy` so the count and the page cannot drift. The page deliberately
     shows an approval-pending quote even when the team filter would hide it, so this
     count needs no visibility clause to agree with it. */
  const myTiers = tiersApprovableBy(myRole);
  if (myId && myTiers.length > 0) {
    const { count } = await supabase
      .from("quotes")
      .select("id", { count: "exact", head: true })
      .eq("approval_status", "pending")
      .neq("approval_requested_by", myId)
      .in("approval_tier", myTiers);
    if ((count ?? 0) > 0) badges.quotes = String(count);
  }

  return badges;
}

export function useNavBadges(): NavBadges {
  const { data } = useQuery({
    queryKey: ["nav-badges"],
    queryFn:  fetchNavBadges,
    refetchInterval: 60_000,   // refresh every 60 seconds
    staleTime:       30_000,
  });
  return data ?? {};
}
