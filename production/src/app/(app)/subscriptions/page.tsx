/**
 * Subscriptions — list matching prototype design.
 */
"use client";

import * as React from "react";
import { SUB_FOLDERS, folderOf, folderCounts } from "@/lib/subscriptions/folders";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import { useRouter } from "next/navigation";
import { useSubscriptions, useSetSubscriptionDomain, useDeleteSubscription } from "@/lib/queries/subscriptions";
import { useContactSearchIndex } from "@/lib/queries/contacts";
import { customerMatchesContact } from "@/lib/contacts/search-index";
import { newestFirst } from "@/lib/sort/newest-first";
import { useActiveTrials } from "@/lib/queries/trials";
import ExtendSubscriptionDialog from "@/components/features/subscriptions/extend-subscription-dialog";
import AddSeatsDialog            from "@/components/features/subscriptions/add-seats-dialog";
import { AddSubscriptionDialog } from "@/components/features/subscriptions/add-subscription-dialog";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import type { QuoteLine } from "@/lib/subscriptions/orphan-quote";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/client";
/* One countdown, shared with /payments and with the onboarding dialog's hint, so the
   three cannot disagree about whether the same customer is late. */
/* Only the row HIGHLIGHT is decided here — the chip itself moved into
   subscriptionExceptions() on 11 Sep 2026 so the mobile card gets it too. */
import { paymentDueState, todayIST } from "@/lib/subscriptions/payment-due";
import type { Route } from "next";

/** What onboarding hands over when the operator says the money has arrived. */
interface PendingPaymentHandoff {
  quoteId: string;
  customerId: string;
  customerName: string;
  expectedAmount: number;
  lineItems: QuoteLineItem[];
  domain: string;
}
import { EditSubscriptionDialog } from "@/components/features/subscriptions/edit-subscription-dialog";
import { BillingScheduleCard } from "@/components/features/subscriptions/billing-schedule-card";
import { useItems } from "@/lib/queries/items";
import { subscriptionCogs, cogsBadge, cogsTotals } from "@/lib/vendor/cogs";
import { LicenseLeakageCard } from "@/components/features/subscriptions/license-leakage-card";
import { SeatRequestsCard } from "@/components/features/subscriptions/seat-requests-card";
import { useSeatRequests, useAmendments } from "@/lib/queries/seat-requests";
import { AmendmentHistory } from "@/components/features/subscriptions/amendment-history";
import { assessUtilisation } from "@/lib/subscriptions/utilisation";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { localDateISO } from "@/lib/leads/outcomes";
import { ImportSubscriptionsDialog } from "@/components/features/subscriptions/import-subscriptions-dialog";
import { ReconcileGoogleDialog } from "@/components/features/subscriptions/reconcile-google-dialog";
import { LicenceAuditDialog } from "@/components/features/subscriptions/licence-audit-dialog";
import { ImportGoogleSubsDialog } from "@/components/features/subscriptions/import-google-subs-dialog";
import { MarginAlertsCard } from "@/components/features/subscriptions/margin-alerts-card";
import Link from "next/link";
import { toast } from "sonner";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { downloadCSV } from "@/lib/csv";
import { SUBSCRIPTIONS_CSV_HEADERS, subscriptionsCsvRows } from "@/lib/export/crm-csv";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate, daysBetween, cleanDisplayName } from "@/lib/utils";
import { subscriptionExceptions } from "@/lib/subscriptions/exceptions";
import { term, renewalDistance, termValue, termValueLabel } from "@/lib/subscriptions/renewal-display";
import { useQuotes } from "@/lib/queries/quotes";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Subscription } from "@/lib/supabase/database.types";

// Vendor pill — capitalised label + a stable colour per vendor (Google/Microsoft
// blue, Zoho green) so the vendor reads at a glance.
function vendorMeta(v: string): { label: string; kind: "info" | "success" | "muted" } {
  const s = (v ?? "").toLowerCase();
  if (s === "google")    return { label: "Google",    kind: "info" };
  if (s === "microsoft") return { label: "Microsoft", kind: "info" };
  if (s === "zoho")      return { label: "Zoho",      kind: "success" };
  return { label: v ? v.charAt(0).toUpperCase() + v.slice(1) : "—", kind: "muted" };
}

/* The margin heuristic that used to live here — `cost = mrr × 0.83`, commented
   "Heuristic: ~17% margin on typical reseller subs" — is gone. It returned 17% for
   every subscription in the app, not because they earned 17% but because the number
   was defined to be 17%, and it sorted a column, coloured a badge and fed a KPI tile.
   Cost now comes from lib/vendor/cogs.ts: the vendor's own bill where one has been
   recorded, the catalogue otherwise, and "Unknown" when neither exists. */

/**
 * The facts about a subscription that stay invisible until they matter —
 * auto-renew off, cadence position, money owed, idle seats, suspension,
 * write-off. Every one of these fields was previously unreachable from this
 * page, on mobile and on desktop alike.
 *
 * The decision lives in `lib/subscriptions/exceptions.ts` and is tested there,
 * because none of these branches fire against today's production data — a bug
 * in any of them would look exactly like silence on screen.
 */
function SubExceptions({ sub, size = "sm" }: { sub: Subscription; size?: "sm" | "md" }) {
  const flags = subscriptionExceptions(sub);
  if (flags.length === 0) return null;
  return (
    <>
      {flags.map((f) => (
        <Badge key={f.key} kind={f.tone} size={size} dot title={f.title}>
          {f.label}
        </Badge>
      ))}
    </>
  );
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const { data: subs, isLoading, error, refetch } = useSubscriptions();
  /* The catalogue is what makes a margin real rather than a multiplier — see
     lib/vendor/cogs.ts. Empty while it loads, which resolves to "Unknown" rather
     than to a wrong number. */
  const { data: catalogItems } = useItems();
  const catalog = React.useMemo(() => catalogItems ?? [], [catalogItems]);
  const { data: seatRequestRows, refetch: refetchRequests } = useSeatRequests({ pendingOnly: true });
  const seatRequests = React.useMemo(() => seatRequestRows ?? [], [seatRequestRows]);
  const { data: trials } = useActiveTrials();
  /* ─── THE CONTRACTED ANNUAL, SO THE SCREEN STOPS INVENTING RUPEES ──────────
     `subscriptions` stores only a MONTHLY figure, so this page was rebuilding the annual
     as mrr × 12 — and a support plan quoted at ₹2,000/yr came back as ₹2,004, because
     round(2000 / 12) × 12 = 2004. Reported live by Pardeep. It is invisible on ₹45,360,
     which divides evenly by 12, and wrong on anything that does not — so the Google line
     was right while the support line beside it was not.

     The originating quote still holds the negotiated annual rate and the subscription
     carries `quote_id`. Keyed by quote AND plan name, because one quote routinely carries
     a licence line and a support line at completely different prices. */
  const { data: allQuotes } = useQuotes();
  const contractedAnnual = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const q of allQuotes ?? []) {
      const lines = Array.isArray(q.line_items) ? q.line_items : [];
      for (const l of lines as { name?: string | null; qty?: number | null; rate?: number | null }[]) {
        const name = (l.name ?? "").trim().toLowerCase();
        const amt  = (l.rate ?? 0) * (l.qty ?? 0);
        if (name && amt > 0) m.set(`${q.id}|${name}`, amt);
      }
    }
    return m;
  }, [allQuotes]);
  const annualFor = React.useCallback(
    (sub: { quote_id?: string | null; plan: string }) =>
      sub.quote_id
        ? contractedAnnual.get(`${sub.quote_id}|${sub.plan.trim().toLowerCase()}`) ?? null
        : null,
    [contractedAnnual],
  );
  const [tab, setTab] = React.useState("all");
  const [vendor, setVendor] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [extendSub,   setExtendSub]   = React.useState<Subscription | null>(null);
  const [scheduleSub, setScheduleSub] = React.useState<Subscription | null>(null);
  const [addSeatsSub, setAddSeatsSub] = React.useState<Subscription | null>(null);
  const [editSub,     setEditSub]     = React.useState<Subscription | null>(null);
  const delSub = useDeleteSubscription();
  const confirm = useConfirm();
  const handleDeleteSub = async (s: Subscription) => {
    const body = `This removes the subscription (and any draft purchase order for it). `
      + `It's for correcting a wrong / duplicate entry.\n\n`
      + `Blocked if it came from a paid quote — in that case delete the payment in Payments instead (that unwinds it cleanly).`;
    if (await confirm({
      title: `Delete ${s.customer_name}'s "${s.plan}" subscription?`,
      body,
      confirmLabel: "Delete",
      danger: true,
    })) delSub.mutate(s.id);
  };
  const [importOpen,     setImportOpen]     = React.useState(false);
  const [addDirectOpen,  setAddDirectOpen]  = React.useState(false);
  /** Set when onboarding chose "Payment Received" — carries what Record payment needs. */
  const [pendingPayment, setPendingPayment] =
    React.useState<PendingPaymentHandoff | null>(null);

  /**
   * Raise the GST invoice once the money is genuinely recorded.
   *
   * ─── WHY IT IS HERE AND NOT INSIDE THE PAYMENT SHEET ────────────────────────
   * RecordPaymentDialog is opened from several screens. Making it issue a GST document
   * on every success would change all of them at once — including the ones where an
   * invoice already exists. This runs only on the onboarding path that asked for it.
   *
   * ─── ONLY WHEN FULLY PAID ───────────────────────────────────────────────────
   * A part payment must not produce a tax invoice: the receipt voucher record_payment
   * already issued is the correct document for an advance (CGST §31(3)(d)). Invoicing
   * the whole amount against a partial receipt would overstate output GST for the
   * period.
   *
   * ─── AND IT DOES NOT SEND ───────────────────────────────────────────────────
   * Generated, not emailed — Abhishek's instruction, 9 Sep 2026. An invoice that leaves
   * automatically is in the customer's inbox before anyone can notice a wrong amount,
   * and a GST document cannot be recalled. Sending stays a deliberate click.
   */
  /**
   * The payment sheet was closed WITHOUT recording anything.
   *
   * ─── WHY THIS HAS TO SAY SOMETHING ─────────────────────────────────────────
   * The quote has to exist before the sheet opens — record_payment is given a quote id.
   * So dismissing the sheet leaves an accepted quote awaiting payment with no payment
   * and no subscription: a half-finished sale.
   *
   * Measured 9 Sep 2026 on real data: Q-2026-2884 (5 seats, ₹18,691) sat exactly like
   * that for ten minutes while a second attempt was made, and NOTHING on any screen
   * mentioned it. The quote is perfectly usable — recording the payment on it still
   * creates the subscription — but only if the operator knows it is there.
   *
   * Deliberately does NOT delete it (§24 gives a way forward, not a cleanup): deleting
   * a quote somebody may have already sent is worse than naming it.
   */
  /* The sheet calls onRecorded and THEN onOpenChange(false), so a successful payment
     closes it too. Without this flag the close would be read as an abandonment and the
     operator would get "no payment recorded" immediately after paying. A ref, not
     state: it has to be true before the very next call in the same tick. */
  const recordedRef = React.useRef(false);

  const abandonPendingPayment = React.useCallback(() => {
    const p = pendingPayment;
    setPendingPayment(null);
    if (recordedRef.current) { recordedRef.current = false; return; }
    if (!p) return;
    toast.warning(`No payment recorded — ${p.quoteId} is waiting, and no subscription was created yet`, {
      description: `${p.customerName} · ${rupee(p.expectedAmount)} due. Record the payment on the quote to activate the subscription, or delete the quote if it was a mistake.`,
      duration: 12000,
      action: { label: "Open quote", onClick: () => router.push(`/quotes/${p.quoteId}` as Route) },
    });
    refetch();
  }, [pendingPayment, refetch, router]);

  const raiseInvoiceFor = React.useCallback(async (
    quoteId: string,
    res: { isFullyPaid: boolean },
  ) => {
    /* Set BEFORE anything else: the sheet closes right after this returns, and the
       close handler must not mistake a completed payment for an abandoned one. */
    recordedRef.current = true;
    setPendingPayment(null);
    if (!res.isFullyPaid) {
      toast.info("Part payment recorded — the GST invoice is raised once the quote is fully paid.", {
        duration: 7000,
      });
      refetch();
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.rpc("generate_invoice", { p_quote_id: quoteId });
    if (error) {
      /* §24: say what happened, why, and where to finish it by hand. The money is
         already safely recorded — only the document is missing, and the quote page can
         raise it. Never a bare "failed". */
      toast.error("Payment saved, but the GST invoice could not be raised", {
        description: error.message,
        action: { label: "Open quote", onClick: () => router.push(`/quotes/${quoteId}` as Route) },
      });
    } else {
      toast.success(`GST invoice ${String(data ?? "")} raised · subscription is live 🎉`, {
        description: "Not sent yet — open it to email or download the PDF.",
        duration: 8000,
        action: { label: "Open invoice", onClick: () => router.push("/invoices" as Route) },
      });
    }
    refetch();
  }, [refetch, router]);
  const [reconcileOpen,  setReconcileOpen]  = React.useState(false);
  const [auditOpen,      setAuditOpen]      = React.useState(false);
  const [helpOpen,       setHelpOpen]       = React.useState(false);
  const [addGoogleOpen,  setAddGoogleOpen]  = React.useState(false);
  /* Both analytics cards start CLOSED (Abhishek, 12 Sep 2026). They are reference, not
     the day's work: this page is opened to act on a subscription, and two tall panels
     above the list pushed the table itself below the fold. Each collapsed header still
     carries its own headline numbers, so nothing is hidden — only unstacked. */
  const [kpiOpen, setKpiOpen] = React.useState(false);
  const [visible, setVisible] = React.useState(60);  // render cap — paginates large lists
  const today = new Date();
  /* One "today" for every folder decision on this page, in IST — a date derived per call
     would let two rows disagree about which day it is across a midnight render. */
  const todayISO = localDateISO(today);
  const daysUntil = (renewal: string | null) =>
    renewal ? daysBetween(today, renewal) : null;

  // Workspace keyword filter removed 2026-08-13 — RLS already scopes to tenant.
  const subsByWorkspace = React.useMemo(() => subs ?? [], [subs]);

  /* ── Folder membership comes from ONE tested rule ────────────────────────
     These used to be three inline predicates, and they OVERLAPPED: an active
     subscription renewing in twenty days matched both `active` and `expiring`, so the
     two counts beside each other could not be added. Numbers side by side get added —
     the same arithmetic that made the leads chips unreadable.

     SUB_FOLDERS is a partition now: active | expiring | suspended | ended, every row in
     exactly one, summing to the total. See lib/subscriptions/folders.ts. */
  /* Who serves which customers — lets the search box find a subscription by the person
     you deal with. Shared with the Customers page through the query cache. */
  const { data: contactIndex } = useContactSearchIndex();

  const filtered = subsByWorkspace.filter((s) => {
    if (tab === "trials") return false;  // trials handled in separate table below
    if (tab !== "all" && folderOf(s, todayISO) !== tab) return false;
    if (vendor !== "all" && s.vendor !== vendor) return false;
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      if (
        !s.customer_name.toLowerCase().includes(q) &&
        !(s.domain?.toLowerCase().includes(q) ?? false) &&
        !s.plan.toLowerCase().includes(q) &&
        /* ── SEARCH BY THE PERSON, NOT ONLY THE COMPANY ────────────────────
           Abhishek, 18 Sep 2026: "filter customer and subscription who attached with
           single contact". This page knew nothing about contacts at all, so the only
           way to see everything one person looks after was to remember every company
           they are on — which is exactly the thing a person cannot do, and the reason
           a contact may now serve several customers in the first place.

           Matched through the customer, because a subscription belongs to a company
           and the person is attached to the company, not to the plan. */
        !(contactIndex && s.customer_id ? customerMatchesContact(contactIndex, s.customer_id, q) : false)
      ) {
        return false;
      }
    }
    return true;
  });

  /* ── Newest first, except in Expiring ─────────────────────────────────────
     `useSubscriptions` fetches in renewal-date order, which is right for the dashboard
     and for anything asking "what is coming up". On this table the question is usually
     "where is the one I just created", so the default is creation order — Abhishek,
     18 Sep 2026, for every table in the app.

     The Expiring folder keeps renewal order, because that folder IS the deadline view:
     its whole reason to exist is what runs out soonest, and burying next week's renewal
     under a subscription created this morning would defeat it. */
  const ordered = React.useMemo(
    () => (tab === "expiring" ? filtered : newestFirst(filtered)),
    [filtered, tab],
  );

  // Render only the first `visible` rows — avoids hanging on 800+ subscriptions.
  const shown = ordered.slice(0, visible);
  const hasMore = ordered.length > shown.length;
  React.useEffect(() => { setVisible(60); }, [tab, vendor, search]);

  // Trial-specific filter (for the Trials tab)
  const filteredTrials = (trials ?? []).filter((t) => {
    if (vendor !== "all") {
      // Derive vendor from plan label (trials don't have explicit vendor column)
      const pl = (t.plan ?? "").toLowerCase();
      const v  = pl.includes("google") ? "google"
              : pl.includes("microsoft") || pl.includes("m365") || pl.includes("365") ? "microsoft"
              : pl.includes("zoho") ? "zoho" : "other";
      if (v !== vendor) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !t.company.toLowerCase().includes(q) &&
        !(t.domain?.toLowerCase().includes(q) ?? false) &&
        !(t.plan?.toLowerCase().includes(q) ?? false)
      ) {
        return false;
      }
    }
    return true;
  });
  /* ── j / k over the table ─────────────────────────────────────────────────
     `count` is `shown`, the RENDERED slice — not `filtered`. This list paginates at 60
     rows, and keying against the full filtered length would let j walk the selection into
     rows that are not on the page, where Enter opens a subscription the operator never
     saw highlighted. */
  const subKeys = useListKeys({
    count: shown.length,
    onOpen: (i) => {
      const s = shown[i];
      if (s?.customer_id) router.push(`/customers/${s.customer_id}` as never);
    },
  });
  const selectedSubRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedSubRef.current?.scrollIntoView({ block: "nearest" });
  }, [subKeys.index]);

  const folderCount = folderCounts(subsByWorkspace, todayISO);

  /* All + the four lifecycle folders, then Trials LAST and visibly apart.
     Trials are a different table entirely — they are not subscriptions — so putting
     them in the middle of a partition invited exactly the addition the partition
     exists to prevent. */
  const tabs: TabBarItem[] = [
    { id: "all", label: "All", count: subsByWorkspace.length },
    ...SUB_FOLDERS.map((f) => ({
      id: f.id,
      label: f.label,
      count: folderCount[f.id],
      dot: f.dot,
    })),
    { id: "trials", label: "Trials (separate)", count: trials?.length ?? 0, dot: "amber" as const },
  ];

  // KPIs
  const activeSubs = subsByWorkspace.filter((s) => s.status === "active");
  const activeMRR = activeSubs.reduce((s, x) => s + x.mrr, 0);
  const activeARR = activeMRR * 12;
  const totalSeats = activeSubs.reduce((s, x) => s + x.seats, 0);
  const usedSeats = activeSubs.reduce((s, x) => s + x.used, 0);
  /* Margin from real cost. Subscriptions whose cost is unknown are EXCLUDED from the
     total rather than counted as free — including them would inflate the margin by
     exactly the amount nobody has measured. `marginUnknownCount` puts that on screen
     so the tile is not read as covering everything. */
  const cogsRows = activeSubs.map((s) => subscriptionCogs(s, catalog));
  const cogsRollup = cogsTotals(cogsRows);
  const monthlyMargin = cogsRollup.marginMonthly;
  const annualMargin = monthlyMargin * 12;
  const marginUnknownCount = cogsRollup.unknownCount;
  const marginEstimatedCount = cogsRollup.estimatedCount;
  /* Weighted by revenue, not a mean of percentages: averaging percentages lets a
     ₹500 subscription move the figure as much as a ₹5,00,000 one. */
  const knownMrr = cogsRows.reduce((a, c, i) => a + (c.monthlyCost == null ? 0 : activeSubs[i].mrr), 0);
  const avgMarginPct = knownMrr > 0 ? Math.round((monthlyMargin / knownMrr) * 100) : 0;
  const atRiskCount = subsByWorkspace.filter((s) => {
    const dl = daysUntil(s.renewal_date);
    return s.status === "active" && dl !== null && dl >= 0 && dl <= 30;
  }).length;
  const atRiskMRR = subsByWorkspace.filter((s) => {
    const dl = daysUntil(s.renewal_date);
    return s.status === "active" && dl !== null && dl >= 0 && dl <= 30;
  }).reduce((s, x) => s + x.mrr, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Subscriptions</h1>
          <p className="text-sm text-ink-3 mt-1">All active + expired across vendors</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setAddDirectOpen(true)}
            title="1-Click Onboard Subscription: Auto-syncs Customer CRM, Quote/Invoice & Active Subscription"
          >
            Add Subscription
          </Button>
          <Button icon="refresh" onClick={() => setReconcileOpen(true)}>Reconcile Google</Button>
          {/* The vendor-console audit. Distinct from "Reconcile Google", which pulls seats
              from the CSP API for the accounts it can reach — this reads an export of the
              WHOLE console, so it also finds domains the app has never heard of, which is
              where the unbilled seats hide. */}
          <Button
            icon="alert"
            onClick={() => setAuditOpen(true)}
            title="Compare a Google or Microsoft user export against what you bill — finds seats you pay for and do not charge."
          >
            Check licences vs books
          </Button>
          <Button icon="upload" onClick={() => setImportOpen(true)}>Import CSV</Button>
        </div>
      </div>

      {/* Collapsible Subscriptions Analytics Banner */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Subscriptions Revenue Analytics</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-2 font-mono font-medium">MRR: <b className="text-amber-ink">{rupee(activeMRR, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">ARR: <b className="text-emerald">{rupee(activeARR, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Seats: <b className="text-ink">{usedSeats}/{totalSeats}</b></span>
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline space-y-3 bg-paper">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Active MRR</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(activeMRR, { compact: true })}</p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Active ARR</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(activeARR, { compact: true })}</p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Margin (ARR)</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(annualMargin, { compact: true })} <span className="text-xs text-ink-3 font-normal">({avgMarginPct}%)</span></p>
                  {/* A total that silently drops the unmeasured rows reads as covering
                      everything. Both counts are stated so it cannot. */}
                  {marginUnknownCount > 0 && (
                    <p className="mt-0.5 text-3xs leading-snug text-amber-ink">
                      {marginUnknownCount} excluded — no cost
                    </p>
                  )}
                  {marginEstimatedCount > 0 && (
                    <p className="mt-0.5 text-3xs leading-snug text-ink-3">
                      {marginEstimatedCount} from catalogue, not vendor bills
                    </p>
                  )}
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Total Subscriptions</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{subsByWorkspace.length} <span className="text-xs text-emerald font-normal">({folderCount.active + folderCount.expiring} live)</span></p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Seats In Use</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{usedSeats} <span className="text-xs text-ink-3 font-normal">/ {totalSeats}</span></p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-3xs uppercase font-semibold text-ink-3 tracking-wider">Active Trials</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{trials?.length ?? 0}</p>
                </div>
              </div>

              {/* Renewal intelligence */}
              {atRiskCount > 0 && (
                <GeminiCard
                  title="Renewal intelligence"
                  actions={
                    <Button size="sm" variant="primary" icon="mail" onClick={() => router.push("/renewals" as never)}>Bulk renewal email</Button>
                  }
                  compact
                >
                  <b>{atRiskCount} subscription{atRiskCount === 1 ? "" : "s"} expiring in next 30 days.</b>{" "}
                  Worth {rupee(atRiskMRR, { compact: true })} MRR — start renewal conversations now.
                </GeminiCard>
              )}
            </div>
          )}
        </div>
      )}

      {/* Margin at risk — losses / thin margins at today's vendor cost, plus the
          subscriptions whose cost we cannot look up at all. Self-hiding when there
          is nothing to say, so it costs no vertical space on a good day. */}
      {!isLoading && <MarginAlertsCard />}

      {/* Customers asking for seats. Approving applies them and raises the quote. */}
      {!isLoading && (
        <SeatRequestsCard
          requests={seatRequests}
          subscriptions={subsByWorkspace}
          onDecided={() => { void refetchRequests(); void refetch(); }}
        />
      )}

      {/* Revenue retention MOVED to Accounting → SaaS Metrics on 12 Sep 2026. That page
          already carries the same six-part decomposition in its MRR waterfall and can only
          print "Not tracked" for Expansion and Contraction; this card supplies both, so the
          two belong together. Subscriptions is an operating list — a period-over-period
          revenue comparison is not something anybody acts on here. */}

      {/* Seats the vendor bills us for vs seats we bill the customer. */}
      {!isLoading && subsByWorkspace.length > 0 && (
        <LicenseLeakageCard
          subscriptions={subsByWorkspace}
          catalog={catalog}
          onReconcile={() => setReconcileOpen(true)}
        />
      )}

      {/* Trials in progress — virtual subs */}
      {!isLoading && trials && trials.length > 0 && tab !== "trials" && (
        <Card
          title="Trials in progress"
          sub={`${trials.length} trial${trials.length === 1 ? "" : "s"} active · seats provisioned, billing pending`}
          className="mb-4"
        >
          <ul className="divide-y divide-hairline -my-1">
            {trials.map((t) => {
              const dr = t.days_remaining ?? 0;
              return (
                <li key={t.id} className="py-2">
                  <Link
                    href={`/leads?lead=${t.id}` as never}
                    className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 hover:bg-paper-2/40 -mx-2 px-2 py-1.5 rounded transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{t.company}</p>
                      <p className="text-2xs text-ink-3 truncate flex items-center gap-2">
                        {t.domain && <span className="font-mono">{t.domain}</span>}
                        <span>·</span>
                        <span>{t.plan?.replace(/^google-workspace-/, "Google Workspace ").replace(/-/g, " ")}</span>
                        <span>·</span>
                        <span className="tabular-nums">{t.seats ?? 0} seats</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Trial ends</p>
                      <p className="text-xs tabular-nums text-ink-2">
                        {t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}
                      </p>
                    </div>
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : dr === 1 ? "1d" : `${dr}d left`}
                    </Badge>
                    <Button size="sm" variant="primary" icon="check_circle">
                      Convert
                    </Button>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Sticky Horizontal TabBar + Vendor Filter + Search */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
          <TabBar className="overflow-y-hidden" value={tab} onChange={setTab} items={tabs} />
          <div className="flex justify-between items-center gap-3 flex-wrap">
            {/* Vendor pills and search sit TOGETHER on the left — they are one act
                ("narrow the list"), and `justify-between` across three children used to
                strand the search box alone in the middle of the bar. Export stays right:
                it acts on the result, not on the filtering. */}
            <div className="flex items-center gap-3 flex-wrap flex-1 min-w-0">
            <div className="inline-flex gap-1 bg-paper-2 rounded-md p-0.5">
              {[
                { value: "all", label: "All Vendors" },
                { value: "google", label: "Google" },
                { value: "microsoft", label: "Microsoft" },
                { value: "zoho", label: "Zoho" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setVendor(opt.value)}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer",
                    vendor === opt.value ? "bg-paper text-ink shadow-xs font-semibold" : "text-ink-3 hover:text-ink"
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="w-full sm:w-64">
              <Input
                prefix={<Icon name="search" size={14} />}
                placeholder="Customer, contact, plan, domain…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            </div>
            {/* Data-portability (audit B7). */}
            <Button
              variant="outline"
              icon="download"
              onClick={() => {
                downloadCSV(`subscriptions-${new Date().toISOString().slice(0, 10)}.csv`, [...SUBSCRIPTIONS_CSV_HEADERS], subscriptionsCsvRows(subs ?? []));
                toast.success(`Exported ${(subs ?? []).length} subscriptions to CSV`);
              }}
            >
              <span className="hidden md:inline">Export</span>
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load subscriptions"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5, 6].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty */}
      {!isLoading && !error && subs && subs.length === 0 && (
        <EmptyState
          icon="refresh"
          title="No subscriptions yet"
          body="Subscriptions are created automatically when an accepted quote moves to provisioning. Start by creating a quote."
          action={
            <Button asChild variant="primary" icon="file">
              <a href="/quotes/new">Create a quote</a>
            </Button>
          }
        />
      )}

      {/* Adaptive card list — phones, tablets, and medium viewports (< 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="xl:hidden space-y-2 mb-3">
          {shown.map((s) => {
            const dl = daysUntil(s.renewal_date);
            const t  = term(s.start_date, s.renewal_date);
            const vm = vendorMeta(s.vendor);
            return (
              <li key={s.id} className="bg-paper border border-hairline rounded-lg p-3">
                {/* Who they are, and what they pay */}
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">{cleanDisplayName(s.customer_name)}</p>
                    <DomainCell sub={s} compact />
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">{rupee(s.mrr)}</p>
                    <p className="text-3xs text-ink-3">/mo · {s.seats} seats</p>
                  </div>
                </div>

                {/* Plan wraps rather than truncates — on a phone this is the
                    only place the plan name appears (§20: don't hide data). */}
                <p className="text-xs text-ink-2 mb-2 break-words leading-snug">{s.plan}</p>

                {/* Vendor, and the term with what renewal actually bills —
                    both desktop-only until now.

                    NO MARGIN BADGE HERE, deliberately. The heuristic this
                    rules out was `cost = mrr × 0.83` — a flat 17% for every
                    subscription that has ever existed — and it has since been
                    removed from this file (see the note at the top). The rule
                    outlives it: do not add one back. Putting it on the
                    card would place a fabricated constant next to real numbers
                    and imply cost data is tracked. Same rule as the seat-
                    utilisation gate: don't assert what isn't measured. */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge kind={vm.kind} size="sm" dot>{vm.label}</Badge>
                  {t && (
                    <Badge kind="muted" size="sm"
                           title={`${t.label} term — ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)} invoiced at each renewal`}>
                      {t.label}{t.months > 1 ? ` · ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)}` : ""}
                    </Badge>
                  )}
                </div>

                {/* Status, anything abnormal, and the renewal clock. The day
                    count is always shown — see renewalDistance() for why. */}
                <div className="flex items-end justify-between gap-2 mt-2 pt-2 border-t border-hairline/60">
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <Badge
                      kind={
                        s.status === "active"    ? "success" :
                        s.status === "paused"    ? "warning" :
                        s.status === "cancelled" ? "danger"  : "muted"
                      }
                      size="sm"
                      dot
                    >
                      {s.status}
                    </Badge>
                    <SubExceptions sub={s} />
                  </div>
                  <div className="text-right shrink-0">
                    {/* The date needs saying what it IS. On desktop the column
                        header does that job; the card has no header, so a bare
                        date could read as "started", "paid" or "expires". */}
                    <p className="text-3xs uppercase tracking-wider text-ink-3 leading-none mb-0.5">Renewal</p>
                    <p className="text-xs text-ink-2 tabular-nums">
                      {s.renewal_date ? formatDate(s.renewal_date) : "—"}
                    </p>
                    {dl !== null && (
                      <p className={cn(
                        "text-3xs tabular-nums",
                        dl <= 7  ? "text-rose font-medium"     :
                        dl <= 30 ? "text-amber-ink font-medium" : "text-ink-3"
                      )}>
                        {renewalDistance(dl)}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Desktop table — viewports >= 1280px */}
      {!isLoading && !error && filtered.length > 0 && (
        <Card flush className="hidden xl:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline-strong">
                <tr>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Customer · Domain</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                  <th className="text-right px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider" title="Seats in use / licensed">Seats</th>
                  <th className="text-right px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">MRR</th>
                  <th className="text-right px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider" title="Monthly margin">Margin</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Started</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Renewal</th>
                  <th className="text-left px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="px-2 py-2.5 text-right w-28"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s, rowIndex) => {
                  const cogs = subscriptionCogs(s, catalog);
                  const mb = cogsBadge(cogs);
                  const util = assessUtilisation({ seats: s.seats, used: s.used, usedSyncedAt: s.used_synced_at });
                  const dl = daysUntil(s.renewal_date);
                  const t  = term(s.start_date, s.renewal_date);
                  const isUrgent = dl !== null && dl >= 0 && dl <= 30;
                  /* Postpaid credit clock. `none` for everything else, so prepaid rows
                     and pre-10-Sep-2026 rows look exactly as they did. */
                  const due = paymentDueState(s.payment_due_date, todayIST(), s.outstanding_amount ?? 0);
                  const kbSelected = rowIndex === subKeys.index;
                  return (
                    <tr
                      key={s.id}
                      ref={kbSelected ? selectedSubRef : undefined}
                      /* aria-selected as well as the tint: a screen reader has to know
                         which row Enter will open.

                         This row used to also carry role="button", which is what
                         stopped that working. `aria-selected` is valid on a row
                         and NOT on a button, so it was being dropped — the very
                         announcement this line exists to make. Overriding the
                         role also took the row out of the table, so its cells
                         lost their column headers. The row keeps its native role
                         now; tabIndex and onKeyDown still make it operable.
                         Same change at seven other tables. */
                      aria-selected={kbSelected}
                      className={cn(
                        "group border-b border-hairline last:border-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                        kbSelected
                          ? "bg-amber-soft/60 ring-1 ring-inset ring-amber/40"
                          /* Overdue postpaid stays lit for as long as the balance is
                             owed. A row that fades back into the list is the exact
                             problem this feature exists to fix. Keyboard selection
                             still wins, so the operator never loses their place. */
                          : due.highlight
                            ? "bg-rose-soft/40 hover:bg-rose-soft/60"
                            : "hover:bg-paper-2/50",
                      )}
                      tabIndex={0}
                      aria-label={`Open ${cleanDisplayName(s.customer_name)}`}
                      onClick={() => s.customer_id && router.push(`/customers/${s.customer_id}` as never)}
                      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && s.customer_id) { e.preventDefault(); router.push(`/customers/${s.customer_id}` as never); } }}
                    >
                      {/* align-middle on EVERY cell in this row, not align-top.
                          A postpaid subscription stacks three badges in the Status
                          column — Active · ₹ due · Pay by — which makes the row taller
                          than its neighbours. With align-top the customer name, plan,
                          seats, MRR and dates all clung to the top of that taller row
                          and left a band of empty space beneath them (reported 11 Sep
                          2026). Centring them vertically makes a tall row read as one
                          line of information rather than a half-filled box. */}
                      <td className="px-3 py-2.5 align-middle" onClick={(e) => e.stopPropagation()}>
                        <div className="font-medium text-sm text-ink break-words leading-snug flex items-center gap-2 flex-wrap">
                          <span>{cleanDisplayName(s.customer_name)}</span>
                        </div>
                        <DomainCell sub={s} />
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-middle">
                        <div className="break-words leading-snug">{s.plan}</div>
                        {t && (
                          <Badge kind="muted" size="sm" className="mt-1"
                                 title={`${t.label} term — ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)} invoiced at each renewal`}>
                            {t.label}{t.months > 1 ? ` · ${termValueLabel(termValue(s.mrr, t.months, annualFor(s)), rupee)}` : ""}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-middle">
                        {(() => { const vm = vendorMeta(s.vendor); return <Badge kind={vm.kind} dot>{vm.label}</Badge>; })()}
                      </td>
                      {/* Seats — used / licensed; flag low utilisation (unused
                          licences = churn risk at renewal OR a missed upsell). */}
                      {/* `used` is 0 on every row in this database and nothing writes
                          it, so colouring the count as "low usage" asserts idle
                          licences that are almost certainly in use. assessUtilisation()
                          treats an unsynced zero as UNKNOWN and says so in the tooltip
                          — see lib/subscriptions/utilisation.ts. */}
                      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-middle" title={util.message}>
                        <span className={cn(
                          util.level === "idle" ? "text-rose font-medium"
                            : util.level === "low" ? "text-amber-ink font-medium"
                            : util.level === "unknown" ? "text-ink-3"
                            : "text-ink",
                        )}>
                          {util.level === "unknown" ? "—" : s.used}
                        </span>
                        <span className="text-ink-3"> / {s.seats}</span>
                        {util.level === "unknown" && (
                          <span className="block text-3xs uppercase tracking-wider text-ink-3">not tracked</span>
                        )}
                      </td>
                      {/* MRR — the money, given weight. */}
                      <td className="px-3 py-2.5 text-right tabular-nums align-middle">
                        <span className="font-serif text-[15px] font-semibold text-ink">{rupee(s.mrr)}</span>
                      </td>
                      {/* Margin — colour-coded badge. */}
                      <td className="px-3 py-2.5 text-right align-middle">
                        <div className="flex flex-col items-end gap-0.5">
                          {/* The tooltip carries the SOURCE. A catalogue estimate and a
                              vendor-billed figure look identical on screen and are not
                              equally trustworthy. */}
                          <Badge kind={mb.kind} size="sm" title={mb.title}>{mb.label}</Badge>
                          {cogs.marginMonthly != null && (
                            <span className="text-3xs text-ink-2 tabular-nums font-medium">{rupee(cogs.marginMonthly)}</span>
                          )}
                          {cogs.source === "catalog" && (
                            <span className="text-3xs uppercase tracking-wider text-ink-3">est.</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-middle whitespace-nowrap">{s.start_date ? formatDate(s.start_date) : "—"}</td>
                      <td className="px-3 py-2.5 text-sm align-middle whitespace-nowrap">
                        <div className="text-ink-2">{s.renewal_date ? formatDate(s.renewal_date) : "—"}</div>
                        {dl !== null && s.status !== "expired" && dl >= 0 && dl <= 30 ? (
                          <div className="mt-0.5"><Badge kind={dl <= 7 ? "danger" : "warning"} dot>{dl === 0 ? "Due today" : `In ${dl}d`}</Badge></div>
                        ) : dl !== null && s.status !== "expired" ? (
                          // Beyond 30 days the badge would be alarmist, but the
                          // distance still beats making the reader subtract dates.
                          <div className="mt-0.5 text-2xs text-ink-3 tabular-nums">{renewalDistance(dl)}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 align-middle">
                        {s.status === "expired" && dl !== null ? (
                          <Badge kind="danger" dot>Expired {Math.abs(dl)}d</Badge>
                        ) : s.status === "active" ? (
                          <Badge kind="success" dot>Active</Badge>
                        ) : (
                          <Badge kind="muted">{s.status}</Badge>
                        )}
                        {/* Outstanding, auto-renew off, cadence position,
                            suspension, write-off — one shared component so the
                            table and the mobile card can never drift apart. */}
                        <div className="flex flex-col items-start gap-1 mt-1 empty:mt-0">
                          <SubExceptions sub={s} size="md" />
                        </div>
                      </td>
                      <td className="px-2 py-2.5 text-right align-middle" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {(s.status === "expired" || isUrgent) && (
                            <Button size="sm" variant={s.status === "expired" ? "danger" : "primary"} icon="refresh" title="Send the renewal quote" onClick={() => router.push("/renewals" as never)}>Renew</Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label="Subscription actions"
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
                              >
                                <Icon name="more_h" size={20} />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[13rem]">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setAddSeatsSub(s)}>
                                <Icon name="plus" size={16} /> Manage seats
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setExtendSub(s)}>
                                <Icon name="clock" size={16} /> Extend term
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setScheduleSub(s)}>
                                <Icon name="calendar" size={16} /> Billing schedule
                              </DropdownMenuItem>
                              {s.customer_id && (
                                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/customers/${s.customer_id}` as never)}>
                                  <Icon name="receipt" size={16} /> View invoices
                                </DropdownMenuItem>
                              )}
                              {/* The statement, one click from here. A renewal conversation
                                  is exactly when somebody asks "and what do they actually
                                  owe us?", and the answer used to be four clicks away
                                  through Accounting with the customer picked by hand.
                                  ?customer= seeds the picker; the Tally XML and CSV exports
                                  on that page are the ones a CA imports. */}
                              {s.customer_id && (
                                <DropdownMenuItem
                                  className="gap-2.5 py-2 cursor-pointer"
                                  onClick={() => router.push(`/accounting/ledger?customer=${s.customer_id}` as never)}
                                >
                                  <Icon name="book" size={16} /> Statement / Tally ledger
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditSub(s)}>
                                <Icon name="edit" size={16} /> Correct details
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer text-rose" onClick={() => handleDeleteSub(s)}>
                                <Icon name="trash" size={16} /> Cancel / delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}
      {!isLoading && !error && tab !== "trials" && hasMore && (
        <div className="flex justify-center py-3">
          <Button variant="default" size="sm" onClick={() => setVisible((v) => v + 100)}>
            Show more ({filtered.length - shown.length} left)
          </Button>
        </div>
      )}

      {/* Trials tab — same column layout, virtual-sub rows */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length > 0 && (
        <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Customer · Domain</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider" title="Licensed seats · seats in use">Seats</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">MRR</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Margin</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Started</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Trial ends</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {filteredTrials.map((t) => {
                  const dr = t.days_remaining ?? 0;
                  const planLabel = (t.plan ?? "")
                    .replace(/^google-workspace-/, "Google Workspace ")
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                  const pl = (t.plan ?? "").toLowerCase();
                  const v  = pl.includes("google") ? "google"
                          : pl.includes("microsoft") || pl.includes("m365") || pl.includes("365") ? "microsoft"
                          : pl.includes("zoho") ? "zoho" : "other";
                  return (
                    <tr
                      key={t.id}
                      onClick={() => router.push(`/leads?lead=${t.id}` as never)}
                      className="border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer"
                    >
                      <td className="p-3">
                        <div className="font-medium text-sm text-ink">{t.company}</div>
                        {t.domain && <div className="text-2xs text-ink-3 font-mono">{t.domain}</div>}
                      </td>
                      <td className="p-3 text-sm text-ink-2">{planLabel}</td>
                      <td className="p-3">
                        <Badge kind={v === "zoho" ? "success" : "info"}>{v}</Badge>
                      </td>
                      <td className="p-3 text-right tabular-nums text-sm">{t.seats ?? 0}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-ink-3">—</td>
                      <td className="p-3 text-right tabular-nums text-xs text-ink-3">—</td>
                      <td className="p-3 text-sm text-ink-2">
                        {t.trial_started_at ? formatDate(t.trial_started_at) : "—"}
                      </td>
                      <td className="p-3 text-sm">
                        <div>{t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}</div>
                        <div className="mt-0.5">
                          <Badge
                            kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                            size="sm"
                            dot
                          >
                            {dr === 0 ? "today" : dr === 1 ? "1d" : `${dr}d left`}
                          </Badge>
                        </div>
                      </td>
                      <td className="p-3">
                        <Badge kind="warning" dot>Trial</Badge>
                      </td>
                      <td className="p-3">
                        <Button size="sm" variant="primary" icon="check_circle" onClick={(e) => { e.stopPropagation(); router.push(`/leads?lead=${t.id}` as never); }}>
                          Convert
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}

      {/* Trials tab — mobile card list (phones only). Without this the Trials
          tab was fully BLANK on mobile — the table is `hidden md:block` and the
          main mobile card `<ul>` excludes trials. */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length > 0 && (
        <ul className="md:hidden space-y-2">
          {filteredTrials.map((t) => {
            const dr = t.days_remaining ?? 0;
            const planLabel = (t.plan ?? "")
              .replace(/^google-workspace-/, "Google Workspace ")
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/leads?lead=${t.id}` as never)}
                  className="w-full text-left bg-paper border border-hairline rounded-lg p-3"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink truncate">{t.company}</p>
                      {t.domain && <p className="text-2xs text-ink-3 font-mono truncate">{t.domain}</p>}
                      <p className="text-2xs text-ink-3 truncate mt-0.5">{planLabel} · {t.seats ?? 0} seats</p>
                    </div>
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : dr === 1 ? "1d left" : `${dr}d left`}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline/60">
                    <span className="text-2xs text-ink-3">
                      Trial ends {t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}
                    </span>
                    <Button size="sm" variant="primary" icon="check_circle" onClick={(e) => { e.stopPropagation(); router.push(`/leads?lead=${t.id}` as never); }}>
                      Convert
                    </Button>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Trials tab — empty state */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="clock"
            title="No active trials"
            body="Trials start at /buy/workspace or via the Start Trial button on the Deal Pipeline page."
            compact
          />
        </div>
      )}

      {/* Filtered empty */}
      {!isLoading && !error && tab !== "trials" && subs && subs.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No subscriptions match"
            body="Try changing tab, vendor filter, or search term."
            action={<Button icon="x" onClick={() => { setTab("all"); setVendor("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Extend dialog */}
      {extendSub && (
        <ExtendSubscriptionDialog
          sub={extendSub}
          open={!!extendSub}
          onOpenChange={(v) => { if (!v) setExtendSub(null); }}
        />
      )}

      {/* Add seats dialog */}
      {addSeatsSub && (
        <AddSeatsDialog
          sub={addSeatsSub}
          open={!!addSeatsSub}
          onOpenChange={(v) => { if (!v) setAddSeatsSub(null); }}
        />
      )}

      {/* Billing schedule — a forecast, not documents. See the card's header. */}
      {scheduleSub && (
        <Sheet open={!!scheduleSub} onOpenChange={(v) => { if (!v) setScheduleSub(null); }}>
          <SheetContent side="right" className="w-full sm:w-[30rem] sm:max-w-[95vw] overflow-y-auto">
            <SheetHeader className="mb-4">
              <SheetTitle>{scheduleSub.customer_name}</SheetTitle>
              <SheetDescription>
                {scheduleSub.plan}{scheduleSub.domain ? ` · ${scheduleSub.domain}` : ""}
              </SheetDescription>
            </SheetHeader>
            {/* ── The body carries its own padding ──────────────────────────────
                SheetContent has NO horizontal padding — SheetHeader brings its own p-6
                and BillingScheduleCard is a Card, so both looked fine while the
                amendment list, which is neither, ran flush into the right edge and
                clipped "1 recorded · cannot be edited". Reported 11 Sep 2026.
                Padded here rather than on the shared primitive: other sheets lay out
                their own edge-to-edge content and would gain an indent nobody asked
                for. */}
            <div className="px-6 pb-6">
              <BillingScheduleCard subscription={scheduleSub} todayISO={localDateISO(new Date())} />
              {/* The contract's own history, next to its schedule — the two questions a
                  rep opens this drawer with are "what will they be billed?" and "what
                  changed?". */}
              <AmendmentHistorySection subscription={scheduleSub} />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Correct subscription details */}
      {editSub && (
        <EditSubscriptionDialog
          sub={editSub}
          open={!!editSub}
          onOpenChange={(v) => { if (!v) setEditSub(null); }}
        />
      )}

      {/* Import subscriptions (CSV migration) */}
      <ImportSubscriptionsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImportComplete={() => refetch()}
      />

      {/* The vendor-console licence audit. Reads the CSV in the browser and sends nothing —
          a user export is a list of every employee's address at a customer's company, and
          there is no reason for it to leave this machine. */}
      <LicenceAuditDialog
        open={auditOpen}
        onOpenChange={setAuditOpen}
        subs={subsByWorkspace.map((s) => ({
          id: s.id,
          customerName: s.customer_name,
          plan: s.plan,
          domain: s.domain,
          seats: s.seats ?? 0,
          mrr: s.mrr ?? 0,
          status: s.status,
        }))}
        /* The vendor comes off the row, so the scope filter needs no string matching on a
           plan name — the thing that makes a licence comparison go quietly wrong. */
        vendorOf={(s) => subsByWorkspace.find((x) => x.id === s.id)?.vendor ?? "other"}
      />

      {/* Reconcile vs Google reseller panel (read-only report) → Phase 2 matcher */}
      <ReconcileGoogleDialog
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
        onAddMissing={() => setAddGoogleOpen(true)}
      />

      {/* Phase 2 — add the missing Google subscriptions (match by customer number) */}
      <ImportGoogleSubsDialog
        open={addGoogleOpen}
        onOpenChange={setAddGoogleOpen}
        onComplete={() => refetch()}
      />

      {/* Shown only once a key has actually been used — see the note on KeyHintBar. */}
      <KeyHintBar visible={subKeys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />

      {/* "Subscriptions by Plan" was REMOVED here on 12 Sep 2026 — not moved.
          Accounting → SaaS Metrics already carries "MRR by tier", which is the same
          breakdown done properly: it normalises the plan text through tierFromPlan, so
          Workspace Starter is ONE row. This card grouped on the raw `plan` string, and
          because the seat count is baked into that string it split a single product four
          ways — "Google Workspace Starter", "… (1 seats)", "… (2 seats)", "… (5 seats)" —
          making the catalogue look like seven products when it is about four, and hiding
          that Starter is the biggest line by customer count. A breakdown that
          miscounts is worse than no breakdown. */}

      {/* 1-Click Onboard Subscription Modal */}
      <AddSubscriptionDialog
        open={addDirectOpen}
        onOpenChange={setAddDirectOpen}
        onSuccess={refetch}
        /* "Payment Received" hands off here instead of creating the subscription
           itself — record_payment does that, atomically, along with the receipt
           voucher and the ledger entries. See Step 3a in the dialog. */
        onNeedsPayment={setPendingPayment}
      />

      {/* Record payment — opened by the onboarding dialog's "Payment Received" path. */}
      {pendingPayment && (
        <RecordPaymentDialog
          open
          onOpenChange={(o) => { if (!o) abandonPendingPayment(); }}
          quoteId={pendingPayment.quoteId}
          customerId={pendingPayment.customerId}
          customerName={pendingPayment.customerName}
          expectedAmount={pendingPayment.expectedAmount}
          lineItems={pendingPayment.lineItems as unknown as QuoteLine[]}
          askDomain
          defaultDomain={pendingPayment.domain}
          onRecorded={(res) => raiseInvoiceFor(pendingPayment.quoteId, res)}
        />
      )}

      {/* Mobile primary FAB */}
      <FAB icon="plus" label="Add Subscription" onClick={() => setAddDirectOpen(true)} />
    </div>
  );
}

// ============================================================
// Domain cell — read-only when populated, inline editor when missing.
// Subs created before migration 0018 (or via manual paths that skip the
// lead/quote flow) can lack a domain — operator can fix it without leaving
// the list.
// ============================================================
function DomainCell({ sub, compact = false }: { sub: Subscription; compact?: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue]     = React.useState("");
  const mut                   = useSetSubscriptionDomain();

  if (sub.domain && !editing) {
    return (
      <button
        type="button"
        onClick={() => { setValue(sub.domain ?? ""); setEditing(true); }}
        className={cn(
          "font-mono text-2xs text-ink-3 hover:text-ink truncate text-left transition-colors",
          compact && "mt-0.5",
        )}
        title="Click to edit domain"
      >
        {sub.domain}
      </button>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setValue(""); setEditing(true); }}
        className={cn(
          "inline-flex items-center gap-1 text-2xs text-amber-ink hover:underline",
          compact && "mt-0.5",
        )}
      >
        <Icon name="plus" size={11} />
        Add domain
      </button>
    );
  }

  const submit = () => {
    const v = value.trim();
    if (!v) {
      toast.error("Domain can't be blank");
      return;
    }
    mut.mutate(
      { id: sub.id, domain: v },
      {
        onSuccess: () => { toast.success("Domain saved"); setEditing(false); },
        onError:   (e) => { toast.error(e instanceof Error ? e.message : "Could not save"); },
      },
    );
  };

  return (
    <div className={cn("flex items-center gap-1", compact && "mt-1")}>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. acme.in"
        className="h-7 text-2xs font-mono py-0"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <IconButton
        icon="check"
        size="sm"
        aria-label="Save domain"
        onClick={submit}
        disabled={mut.isPending}
      />
      <IconButton
        icon="x"
        size="sm"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
        disabled={mut.isPending}
      />
    </div>
  );
}

/**
 * The amendment ledger for one subscription.
 *
 * Its own component so the query is scoped to whichever subscription the drawer has
 * open, rather than fetching every subscription's history to render one.
 */
function AmendmentHistorySection({ subscription }: { subscription: Subscription }) {
  const { data: amendments } = useAmendments(subscription.id);
  return <AmendmentHistory amendments={amendments ?? []} currentSeats={subscription.seats} />;
}
