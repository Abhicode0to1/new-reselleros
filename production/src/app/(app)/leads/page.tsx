/**
 * Leads + Deals — same component drives BOTH /leads and /deals URLs.
 *
 * Route convention (after split, migration 0045):
 *   /leads  → raw leads inbox (NULL plan) — list view, no Kanban
 *   /deals  → qualified deal pipeline      — Kanban (default) + list toggle
 *
 * The same DB table backs both views — the split is just a filter cut
 * (raw vs qualified). Industry convention (HubSpot / Salesforce / Pipedrive)
 * matches: Leads ≠ Deals, they're distinct UI concepts on shared data.
 *
 * Layout (URL-driven):
 *   - Header: eyebrow "Sales" + page-specific title + subtitle
 *   - Actions: search + view toggle (Deals only) + Filter + advanced + Add
 *   - GeminiCard with AI lead intelligence (Deals page only)
 *   - Kanban (default on /deals): 6 stage columns with drag-drop
 *   - List: sortable table for scanning many at scale
 *   - Detail Sheet on card / row click (shared)
 */
"use client";

import * as React from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { useLeads, useDeleteLead, useSetLeadJunk, useUpdateLead } from "@/lib/queries/leads";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { InlineCell } from "@/components/features/leads/inline-cell";
import { LossReasonsCard } from "@/components/features/leads/loss-reasons-card";
import { parseRupeeInput, parsePriority, parseFollowUpDate, PRIORITIES, type Priority } from "@/lib/leads/inline-edit";
import { looksLikeJunk } from "@/lib/leads/junk";
import { MarkJunkDialog } from "@/components/features/leads/mark-junk-dialog";
import { qualification } from "@/lib/leads/qualification";
import { useLeadActivities, useLogLeadActivity } from "@/lib/queries/lead-activities";
import { LeadsBulkBar } from "@/components/features/leads/leads-bulk-bar";
import { useQuotesByLead } from "@/lib/queries/quotes";
import { QuoteActionBar } from "@/components/features/quotes/quote-action-bar";
import { useTasks, useTasksForLead, useCompleteTask, useSnoozeTask, useDeleteTask } from "@/lib/queries/tasks";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import { LeadCard } from "@/components/features/leads/lead-card";
import { AddLeadForm } from "@/components/features/leads/add-lead-form";
import { QuickAddLeadForm } from "@/components/features/leads/quick-add-lead-form";
import { LeadsSmartViews, type SmartView } from "@/components/features/leads/leads-smart-views";
import { PriorityCallQueue } from "@/components/features/leads/priority-call-queue";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { localDateISO } from "@/lib/leads/outcomes";
import { buildForecast, stageProbability, winRate } from "@/lib/leads/forecast";
import { rowStageOptions, isStageLocked } from "@/lib/leads/stage-options";
import { buildPlanCostIndex, dealMargin, marginBadge } from "@/lib/leads/deal-margin";
import { stageAge, staleDeals } from "@/lib/leads/velocity";
import { dealHealth } from "@/lib/leads/deal-health";
import { DealHealthCard } from "@/components/features/leads/deal-health-card";
import { BattlecardDrawer } from "@/components/features/leads/battlecard-drawer";
import { buildTimeline, timelineMeta } from "@/lib/leads/timeline";
import { PIPELINES, pipelineCounts, type Pipeline } from "@/lib/leads/pipelines";
import { useItems } from "@/lib/queries/items";
import { MergeLeadsDialog } from "@/components/features/leads/merge-leads-dialog";
import { computeDuplicates } from "@/lib/leads/duplicates";
import { isHotLead, isHighValueLead, intentMeta, staleWarning } from "@/lib/leads/heat";
import { SALES_FOLDERS, SALES_FLAGS, inSalesFolder, salesFolderCounts, type SalesFolder } from "@/lib/leads/folders";
import { SwipeLeadCard } from "@/components/features/leads/swipe-lead-card";
import { ImportCsvDialog } from "@/components/features/leads/import-csv-dialog";
import { ShareFormSheet, ENQUIRY_SHARE } from "@/components/features/leads/share-form-sheet";
import StartTrialDialog from "@/components/features/leads/start-trial-dialog";
import CampaignComposerDialog from "@/components/features/campaigns/campaign-composer-dialog";
import GoogleContactsImportDialog from "@/components/features/contacts/google-contacts-import-dialog";
import SendWhatsAppDialog from "@/components/features/whatsapp/send-whatsapp-dialog";
import { GeminiCard } from "@/components/shared/gemini-card";
import { JunkAIReview } from "@/components/features/leads/junk-ai-review";
import { EmptyState } from "@/components/shared/empty-state";
import { AiDraftButton } from "@/components/shared/ai-draft-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Lead } from "@/lib/supabase/database.types";
import { useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { WhatsAppActionDialog } from "@/components/shared/whatsapp-action-dialog";

// ============================================================
// Stage config (matches prototype LEAD_STAGES)
// ============================================================
const LEAD_STAGES: { id: Lead["stage"]; label: string; dot: string }[] = [
  { id: "new",     label: "New",          dot: "bg-slate" },
  { id: "contact", label: "Contacted",    dot: "bg-amber" },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo" },
  { id: "trial",   label: "Trial Active", dot: "bg-rose" },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo" },
  { id: "won",     label: "Won",          dot: "bg-emerald" },
];

/**
 * Kanban columns — EVERY stage the page can show, in funnel order.
 *
 * ─── THIS WAS ["quote","demo","trial","won"] AND IT BROKE THE BOARD ─────────
 * That column set was correct while the board only ever ran on /deals, where New and
 * Contacted genuinely could not appear. When /leads gained the board (same commit
 * that merged the two lists), those two stages became the bulk of the page and had
 * no column to land in — so the board rendered four empty columns while its own
 * footer read "9 total deals visible". Zero cards and a count of nine, on the same
 * screen.
 *
 * The rule that stops it recurring: the board's columns must cover every stage the
 * list can contain. A card with nowhere to go does not error, it silently disappears
 * — and a disappeared deal is indistinguishable from no deal.
 *
 * `won` stays as the finish line. Won leads are filtered out of the working list, so
 * the column is normally empty — but it has to exist as a DROP TARGET, because
 * dragging a card there is how a rep marks a deal won. `lost` is not a column: it
 * needs a reason, which the outcome dialog collects.
 */
const DEAL_STAGES = (["new", "contact", "quote", "demo", "trial", "won"] as const).map(
  (id) => LEAD_STAGES.find((s) => s.id === id)!,
);

// All stage meta including Lost (LEAD_STAGES omits Lost as it's an outcome,
// not a Kanban column). Used to build the page-aware Filter list.
const STAGE_META: { id: Lead["stage"]; label: string; dot: string }[] = [
  ...LEAD_STAGES,
  { id: "lost", label: "Lost", dot: "bg-ink-3" },
];

function LeadsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const pathname     = usePathname();
  const focusLeadId  = searchParams.get("lead");

  const { data: leads, isLoading, error, refetch } = useLeads();
  // Every stage change on this page goes through changeStage — it owns the
  // "why was this lost?" prompt so the seven call sites don't each grow their
  // own version. See lib/leads/use-change-stage.ts.
  const { changeStage } = useChangeLeadStage();
  const { data: currentUser } = useCurrentUser();
  // Sales role gets a simplified UI — no Kanban / campaign / trial buttons.
  const isSales = currentUser?.role === "sales";
  // URL-driven mode (after the /leads + /deals split). /deals shows the
  // qualified pipeline; /leads shows raw inbox. No tab bar — each URL is
  // its own page now.
  const isDealsPage = pathname === "/deals";

  // Filter offers only the stages that can actually appear on THIS page (else
  // filtering e.g. "Won" on the raw Leads inbox always yields 0 rows). Mirrors
  // the inline row dropdown: raw inbox = New/Contacted; deals = the deal stages.
  const filterStages = STAGE_META.filter((s) =>
    isDealsPage
      ? s.id === "quote" || s.id === "demo" || s.id === "trial" || s.id === "won" || s.id === "lost"
      : s.id === "new" || s.id === "contact",
  );

  const [search, setSearch] = React.useState("");
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overStage, setOverStage] = React.useState<Lead["stage"] | null>(null);
  const [addOpen,         setAddOpen]         = React.useState(false);
  const [quickOpen,       setQuickOpen]       = React.useState(false);
  const [shareOpen,       setShareOpen]       = React.useState(false);
  const [trialOpen,       setTrialOpen]       = React.useState(false);
  const [campaignOpen,    setCampaignOpen]    = React.useState(false);
  const [googleImportOpen, setGoogleImportOpen] = React.useState(false);
  const [csvImportOpen,    setCsvImportOpen]    = React.useState(false);
  // Filter state — multi-select stages + priorities. Empty array = no filter
  // (show all). Owner filter intentionally deferred — UI is already busy.
  const [stageFilter,    setStageFilter]    = React.useState<Lead["stage"][]>([]);
  const [priorityFilter, setPriorityFilter] = React.useState<Array<"low"|"medium"|"high">>([]);
  // Due-bucket filter driven by the insight band's KPI pills.
  //   today    → follow_up_date === today
  //   overdue  → follow_up_date < today
  //   hot      → stage in [demo, trial, quote]
  //   all      → no constraint
  // Smart view = saved filter combo (HubSpot/Close/Attio pattern). Each
  // chip in <LeadsSmartViews/> sets this. The `searched` memo below
  // applies the view as an additional filter cut.
  const [smartView, setSmartView] = React.useState<SmartView>("all");
  // Collapsible "Lead intelligence" banner — remembers the choice so it doesn't
  // eat board space every visit.
  const [tipsOpen, setTipsOpen] = React.useState(true);
  React.useEffect(() => {
    try { if (localStorage.getItem("ros_leads_tips") === "0") setTipsOpen(false); } catch {}
  }, []);
  const toggleTips = () => setTipsOpen((v) => {
    const next = !v;
    try { localStorage.setItem("ros_leads_tips", next ? "1" : "0"); } catch {}
    return next;
  });

  // Auto-open Google import dialog when redirected back from OAuth with the contacts scope.
  // The dialog will then auto-call /api/contacts/google-fetch with the new provider_token.
  React.useEffect(() => {
    if (searchParams.get("google-import") === "1") {
      setGoogleImportOpen(true);
      // Clean the URL so refresh doesn't re-trigger
      router.replace("/leads" as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?action=<id> — driven by the global QuickActionsPanel in the topbar.
  // Lets the panel open a page-local dialog (Quick add / Full add / Import /
  // Send campaign / Start trial) by navigating here with a `?action=` query.
  // After we handle it, we router.replace to wipe the param so a refresh
  // doesn't re-trigger it.
  React.useEffect(() => {
    const action = searchParams.get("action");
    if (!action) return;
    switch (action) {
      case "quick-add":     setQuickOpen(true);        break;
      case "add":           setAddOpen(true);          break;
      case "import-csv":    setCsvImportOpen(true);    break;
      case "import-google": setGoogleImportOpen(true); break;
      case "campaign":      setCampaignOpen(true);     break;
      case "trial":         setTrialOpen(true);        break;
      // today / overdue — no dialog; let the user use the on-page KPI pills.
    }
    // Strip the param so refresh / back-button don't re-trigger.
    router.replace(pathname as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  const [selected, setSelected] = React.useState<Lead | null>(null);

  /* Call-queue dependencies. runOutcome performs whatever lib/leads/outcomes.ts says a
     chip does — one entry point, so the chips on the queue, the row and the mobile card
     cannot drift apart (the same reason use-change-stage.ts exists). */
  const runOutcome = useLeadOutcome();
  const queueLog   = useLogLeadActivity();

  /* Which sales motion is being worked. `null` = all of them, which is the default:
     opening the page to a filtered subset would hide deals from someone who does not
     know the filter exists. */
  const [pipelineFilter, setPipelineFilter] = React.useState<Pipeline | null>(null);

  /* Counts from the UNFILTERED set. A badge that shrinks as you filter answers a
     question nobody asked — it should say how much work exists in each motion. */
  const motionCounts = React.useMemo(
    () => pipelineCounts((leads ?? []).filter((l) => !l.is_junk)),
    [leads],
  );

  /* How many follow-ups are not merely due but LATE — the red sub-badge on the Follow-Up
     Needed chip. The due count itself is no longer computed here: it is the `followup`
     folder's own count, so the chip's two numbers cannot disagree.
     `<` and not `<=`: due today is on time. */
  const overdueNowCount = React.useMemo(() => {
    const today = localDateISO(new Date());
    let late = 0;
    for (const l of leads ?? []) {
      if (l.is_junk || l.stage === "won" || l.stage === "lost") continue;
      if (l.follow_up_date && l.follow_up_date < today) late++;
    }
    return late;
  }, [leads]);

  const [editingLead, setEditingLead] = React.useState<Lead | null>(null);
  // Row "Follow-up" quick action → opens AddTaskDialog scoped to this lead.
  const [followUpLead, setFollowUpLead] = React.useState<Lead | null>(null);
  const [waLead, setWaLead] = React.useState<Lead | null>(null);
  // Merge-duplicates dialog — holds the cluster (a lead + its matches) to fold.
  const [mergeCluster, setMergeCluster] = React.useState<Lead[] | null>(null);

  // Kanban is great for stage flow; list view is needed once you have 50+ leads
  // and want to scan by value/age/owner. Persisted in localStorage so the user's
  // preferred view sticks across sessions.
  // User's preferred view for the DEALS tab. Leads tab always forces list
  // view because Kanban is a stage-flow tool and raw leads (no plan picked)
  // can only logically live in 'new' or 'contacted' — the other 4 columns
  // would always be empty and just clutter the screen.
  const [view, setView] = React.useState<"kanban" | "list">(() => {
    if (typeof window === "undefined") return "kanban";
    return (window.localStorage.getItem("leads-view") as "kanban" | "list") ?? "kanban";
  });
  React.useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("leads-view", view);
  }, [view]);
  // Sort state for the list view (kanban ignores this)
  const [sortBy, setSortBy] = React.useState<"created" | "value" | "company" | "stage" | "age">("created");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [kpiOpen, setKpiOpen] = React.useState(false);

  // ── Deep-link: open the drawer for the lead in ?lead=<id> ──
  // Runs once when leads load and the URL param is present.
  const deepLinkHandledRef = React.useRef(false);
  React.useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!focusLeadId || !leads) return;

    const match = leads.find((l) => l.id === focusLeadId);
    if (!match) {
      deepLinkHandledRef.current = true;
      toast.error(`Lead ${focusLeadId} not found`);
      return;
    }
    deepLinkHandledRef.current = true;
    setSelected(match);

    // Scroll the matching card into view so the user can see where it is in the pipeline
    setTimeout(() => {
      document
        .querySelector(`[data-lead-id="${match.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);

    // Clean the param from URL so refresh doesn't re-trigger. Use the CURRENT
    // path (not a hardcoded /leads) so a ?lead= deep-link opened on /deals
    // stays on /deals instead of bouncing the user to /leads.
    router.replace(pathname as never);
  }, [focusLeadId, leads, router, pathname]);

  // Quick "Send quote" from a list row — carries the lead's context into the
  // quote builder. Returning to /leads lands on the list (no auto-opened drawer).
  const goSendQuote = React.useCallback((lead: Lead) => {
    const params = new URLSearchParams();
    params.set("leadId",  lead.id);
    params.set("company", lead.company);
    if (lead.plan)          params.set("plan",  lead.plan);
    if (lead.seats != null) params.set("seats", String(lead.seats));
    if (lead.contact_name)  params.set("contact", lead.contact_name);
    if (lead.contact_email) params.set("email", lead.contact_email);
    if (lead.contact_phone) params.set("phone", lead.contact_phone);
    router.push(`/quotes/new?${params.toString()}` as never);
  }, [router]);

  // ── Leads vs Deals split ────────────────────────────────────────────────
  // Leads = raw inquiries, no plan picked yet (NULL or empty). Awaiting
  //         qualification.
  // Deals = qualified opportunities (plan set) flowing through stages.
  // Same DB table; different filter cut so the two concepts don't mix.
  // Industry convention (HubSpot / Salesforce / Pipedrive) — direct entity
  // naming beats metaphors like "Inbox" / "Pipeline".
  // Tab is purely URL-derived now — no internal state, no setter. /leads
  // gives the raw inbox, /deals gives the qualified pipeline. The legacy
  // tab-bar UI is removed; navigation between the two is via sidebar.
  /* `"due"` is gone from this union. It was a fourth filter dimension that only the
     removed "Today's Follow-Ups" chip could set, duplicating the `followup` folder.
     What remains is purely which page we are on, and it only labels the Add button. */
  const [salesTab] = React.useState<"raw" | "deals" | "all">(
    isDealsPage ? "deals" : "raw"
  );

  /* Which folder is showing. "all" by default — the page opens on "here is your
     pipeline", not on one slice of it. */
  const [folder, setFolder] = React.useState<SalesFolder | "all">("all");
  /* `tab` is gone. It existed to pick which HALF of the pipeline to show, and there
     are no halves any more — /leads and /deals resolve to the same open set. Every
     place that branched on it either disappeared with the cross-over hints or now
     reads the same value both ways. */

  // Workspace keyword filter removed 2026-08-13. It classified rows by company-name
  // keywords ("excel", "vera") against hardcoded tenant UUIDs — one of which was
  // Delfos Technologies, a real separate tenant, badged as "Excel Tech". RLS already
  // scopes every read to the caller's tenant, so the filter only ever hid the
  // tenant's own leads. Name kept: it is referenced throughout this page.
  const workspaceLeads = React.useMemo(() => leads ?? [], [leads]);

  // Duplicate index — computed over workspace leads (dups can span the workspace),
  // surfaced as a per-row "Duplicate?" flag + a "Duplicates" smart view. Declared
  // here (before `searched`) because the Duplicates view filters on dup.flagged.
  // Non-destructive: it only flags; merging is an explicit action in the dialog.
  const dup = React.useMemo(() => computeDuplicates(workspaceLeads), [workspaceLeads]);

  // Junk (spam/fake) — a stored flag. junkCount drives the Junk chip; suspects
  // are non-junk leads the heuristic flags for review (surfaced in the Junk view).
  const junkCount = React.useMemo(() => workspaceLeads.filter((l) => l.is_junk).length, [workspaceLeads]);
  const junkSuspectCount = React.useMemo(
    () => workspaceLeads.filter((l) => !l.is_junk && looksLikeJunk(l).suspect).length,
    [workspaceLeads],
  );

  // Search + filter both apply BEFORE the tab cut so each view respects them.
  const searched = React.useMemo(() => {
    let list = workspaceLeads;
    // 0. Junk cut — confirmed junk is hidden from EVERY working view. The "Junk"
    //    view is the cleanup workspace: confirmed junk + heuristic SUSPECTS (so
    //    you can review + mark them). Suspects still appear in working views
    //    (they're only flagged, not confirmed) until you mark them.
    list = smartView === "junk"
      ? list.filter((l) => l.is_junk || looksLikeJunk(l).suspect)
      : list.filter((l) => !l.is_junk);
    // 1. Text search across company / contact name / email / plan
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(
        (l) =>
          l.company.toLowerCase().includes(s) ||
          (l.contact_name?.toLowerCase().includes(s) ?? false) ||
          (l.contact_email?.toLowerCase().includes(s) ?? false) ||
          (l.contact_phone?.toLowerCase().includes(s) ?? false) ||
          (l.plan?.toLowerCase().includes(s) ?? false)
      );
    }
    // 2. Stage filter (any-of). Empty array = no constraint.
    if (stageFilter.length > 0) {
      list = list.filter((l) => stageFilter.includes(l.stage));
    }
    // 3. Priority filter (any-of). Empty array = no constraint.
    if (priorityFilter.length > 0) {
      list = list.filter((l) => priorityFilter.includes(l.priority as "low"|"medium"|"high"));
    }
    // 4. Single unified view filter (one chip row — All / Today / Overdue /
    //    Hot / New / Won MTD / Mine). Each chip maps to exactly one bucket, so
    //    there's no overlap/duplication (the old separate due-bucket KPI row is
    //    gone). Sits on top of search + stage + priority.
    if (smartView !== "all") {
      /* localDateISO, not toISOString(). IST is UTC+5:30, so before 05:30 the ISO string
         is YESTERDAY's date — "arrived today" showed nothing and "overdue" quietly
         swallowed leads due today, for anyone working early. Same trap documented in
         lib/leads/outcomes.ts for the follow-up writes. */
      const todayStr = localDateISO(new Date());
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      if (smartView === "mine") {
        list = list.filter((l) => currentUser && l.owner_id === currentUser.userId);
      } else if (smartView === "today") {
        // Arrived today (new inbound).
        list = list.filter((l) => l.created_at?.slice(0, 10) === todayStr);
      } else if (smartView === "overdue") {
        // Follow-up overdue + still open — the rep's most actionable bucket.
        list = list.filter((l) => l.follow_up_date && l.follow_up_date < todayStr && l.stage !== "won" && l.stage !== "lost");
      } else if (smartView === "hot") {
        list = list.filter(isHotLead);
      } else if (smartView === "new") {
        list = list.filter((l) => l.stage === "new");
      } else if (smartView === "won-mtd") {
        list = list.filter((l) => l.stage === "won" && l.created_at && new Date(l.created_at) >= monthStart);
      } else if (smartView === "closing") {
        /* Same rule as closingBy() in lib/leads/forecast.ts: open, dated, on or before
           month end. Undated deals are excluded — a deal nobody has put a date on has
           not claimed this month. The KPI strip reports how many those are. */
        const d = new Date();
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const monthEnd = localDateISO(last);
        list = list.filter((l) =>
          l.expected_close_date && l.expected_close_date <= monthEnd &&
          l.stage !== "won" && l.stage !== "lost");
      } else if (smartView === "stalled") {
        /* Past the SLA with no stage movement. staleDeals() already excludes closed
           deals and any whose age is unknown — it will not call a deal stale when it
           cannot say how long it has been sitting. */
        const stalledIds = new Set(staleDeals(list).map((l) => l.id));
        list = list.filter((l) => stalledIds.has(l.id));
      } else if (smartView === "duplicates") {
        list = list.filter((l) => dup.flagged.has(l.id));
      }
    }

    /* The "Today's Follow-Ups" pill — a TAB cut, so it composes with whichever smart
       view is active instead of replacing it.
       `<= today` deliberately: overdue is MORE urgent than due-today, and a pill showing
       only exactly-today would hide the promises broken last week. */
    /* Sales-motion cut. Applies to Kanban and list alike, because they read the same
       `filtered` array — one filter, not two implementations that drift. */
    if (pipelineFilter) {
      list = list.filter((l) => (l.pipeline ?? "new_logo") === pipelineFilter);
    }

    /* No follow-up cut here any more — that is the `followup` FOLDER's job, applied once
       where every other folder is applied. It used to be filtered in this memo as well,
       so a follow-up chip and a folder chip could both be narrowing the same list from
       two different places. */
    return list;
    // pipelineFilter joins the deps — without it the list keeps the previous motion's
    // rows until some other input happens to change.
  }, [workspaceLeads, search, stageFilter, priorityFilter, smartView, pipelineFilter, currentUser, dup]);
  const activeFilterCount = stageFilter.length + priorityFilter.length;

  // A lead is "raw" (Leads inbox) only while it's early — New or Contacted with
  // no plan yet. The moment it advances (Demo / Trial / Quote) OR gets a plan,
  // it's an active opportunity and belongs in Deals. Won/Lost are deal outcomes,
  // so they're never raw either.
  // A lead stays in the Leads inbox until a quotation is sent. Sending a quote
  // moves its stage to 'quote' (and only then can it go to demo/trial/won) —
  // that's the single gate out of the inbox. So raw = still pre-quote (new/contact).
  /* ── ONE WORKING LIST: every OPEN lead, whatever stage it reached ───────────
     This used to be `stage === "new" || stage === "contact"`, with everything
     further along served only on /deals. The effect was that a lead VANISHED from
     the list the moment somebody made progress on it: move it to `demo` and it left
     /leads entirely. The rep did the right thing and lost sight of the deal as the
     reward.

     Won, lost and junk are still out — those are finished, not work. Folders
     (lib/leads/folders.ts) are how the list gets narrowed now; a stage is no longer
     a reason to be on a different page. */
  const isOpenLead = (l: Lead) =>
    l.stage !== "won" && l.stage !== "lost" && !l.is_junk;
  const openLeads = React.useMemo(() => searched.filter(isOpenLead), [searched]);

  /* ── The folder chips are the filter ──────────────────────────────────────
     "Inbox" and "Qualified Deals" used to switch between the two halves of the old
     /leads-vs-/deals split. After the merge both resolved to the same open set, so
     clicking either changed nothing — and "Qualified Deals 1" sat above a list of 9.
     A control that looks like a filter and filters nothing is worse than no control:
     the rep believes the list in front of them has been narrowed.

     The chip counts and the list BOTH call inSalesFolder() from lib/leads/folders.ts
     (21 tests), so a chip can never advertise a number the list contradicts. */
  const folderToday = React.useMemo(() => localDateISO(new Date()), []);
  /* Counted over `searched`, NOT over `openLeads`. Won and Lost are folders too, and a
     base that had already dropped closed leads would have reported both as 0 forever —
     a chip that can only ever say zero is a chip nobody clicks twice.
     The working folders are unaffected: inSalesFolder() applies its own isClosed() cut. */
  const folderCounts = React.useMemo(
    () => salesFolderCounts(searched, folderToday),
    [searched, folderToday],
  );
  const filtered = smartView === "junk"
    ? searched
    : folder === "all"
    ? openLeads
    : searched.filter((l) => inSalesFolder(l, folder, folderToday));

  /* ── ONE SELECTION AT A TIME ────────────────────────────────────────────────
     The chip row drove THREE independent pieces of state — `folder`, `smartView` and
     `salesTab` — and no chip cleared the others. Picking Hot Deals and then Junk left
     both lit, over a list of junk; picking Today's Follow-Ups and then Inbox left the
     follow-up cut silently applied underneath a chip that said Inbox. Two highlighted
     chips is not a cosmetic problem: the rep believes the list has been narrowed one way
     when it has been narrowed another.

     Every chip now goes through one of these two, so a chip added later cannot forget a
     dimension. */
  const selectFolder = React.useCallback((f: SalesFolder | "all") => {
    setFolder(f);
    setSmartView("all");
  }, []);
  const selectJunk = React.useCallback(() => {
    setSmartView("junk");
    setFolder("all");
  }, []);
  /* The Smart Views dropdown is the OTHER filter surface, and it used to stack on top of
     whatever chip was lit. Selecting from it now releases the folder, so exactly one of
     the two is ever in force. */
  const selectSmartView = React.useCallback((v: SmartView) => {
    setSmartView(v);
    setFolder("all");
  }, []);

  // Tab-scoped UNFILTERED subset for the insight band, Smart Views chips,
  // Today strip, and right rail. Derived from `workspaceLeads` so counts stay
  // accurate per active workspace while the user is searching / filtering.
  const leadsForTab = React.useMemo(
    () => workspaceLeads.filter(isOpenLead),
    [workspaceLeads],
  );

  // Per-tab duplicate count + merge opener (the `dup` index itself is computed
  // higher up, before `searched`, since the Duplicates smart view filters on it).
  const duplicateCountForTab = React.useMemo(
    () => leadsForTab.filter((l) => dup.flagged.has(l.id)).length,
    [leadsForTab, dup],
  );
  /** Open the merge dialog for a lead: cluster = the lead + everything it dups. */
  const openMergeFor = React.useCallback((lead: Lead) => {
    const matches = dup.matchesOf.get(lead.id) ?? [];
    if (matches.length === 0) return;
    setMergeCluster([lead, ...matches.map((m) => m.lead)]);
  }, [dup]);

  // Force list view on mobile (Kanban with 6 vertical stage columns is
  // unusable on phones — each empty stage takes a screen-full).
  // Leads tab always renders as a list (raw leads only live in 'new' /
  // 'contacted', so 4 of 6 Kanban columns would always be empty).
  // Deals tab respects the user's saved preference, EXCEPT on mobile.
  const { isMobile } = useBreakpoint();
  /* Board is now available on /leads too. It used to be forced to list because raw
     leads only ever sat in `new` / `contact`, so four of the six Kanban columns were
     always empty. Now that every open stage is on this page the board is the whole
     pipeline again — and drag-drop between stages is how a rep advances a deal, which
     is exactly what the folder model cannot do and must not replace. */
  const effectiveView = isMobile ? "list" : view;

  /* ── EVERY NON-JUNK LEAD IS A DEAL ─────────────────────────────────────────
     This set used to start at `isPastInbox` — stage past new/contact — a leftover from
     when /deals was its own page. The stated reason was that value is only entered once
     a lead is past first contact. The data says otherwise: six of this tenant's seven
     `new` leads carry one, ₹16,320 through ₹1,65,600.

     So the band read "Open Pipeline ₹0 · Active Deals: 0" three inches from
     "Open leads: 8" — ₹5,59,584 of live pipeline reported as nothing, beside the count
     that disproved it. A zero is not read as a missing number; it is read as a fact,
     and this one said "you have no pipeline" to a rep who had eight deals.

     Junk is the only exclusion now. A stage is no longer a reason to be left out of the
     totals, for the same reason it is no longer a reason to be on a different page.

     Derived from `workspaceLeads`, never from `searched`, so the totals answer "how much
     is there" rather than "how much survives what I typed". */
  const dealUniverse = React.useMemo(
    () => workspaceLeads.filter((l) => !l.is_junk),
    [workspaceLeads]
  );
  const openDeals = React.useMemo(
    () => dealUniverse.filter((l) => l.stage !== "won" && l.stage !== "lost"),
    [dealUniverse]
  );
  const totalValue = React.useMemo(
    () => openDeals.reduce((s, l) => s + (l.value ?? 0), 0),
    [openDeals]
  );
  /* Weighted forecast — the same open deals, each multiplied by what its stage has
     earned. Built from dealUniverse rather than openDeals so buildForecast applies its
     own open/closed rule in one place; feeding it a pre-filtered list would mean two
     definitions of "open" that can drift. */
  const forecast = React.useMemo(() => buildForecast(dealUniverse), [dealUniverse]);
  /* Win rate over DECIDED deals only — won ÷ (won + lost). It used to divide by every
     deal including the open ones, which counts "not finished yet" as "not won"; the rule
     and the reasoning now live in lib/leads/forecast.ts with its tests. */
  const rate = React.useMemo(() => winRate(dealUniverse), [dealUniverse]);
  const { won: wonCount, lost: lostCount, decided: decidedCount, pct: conversion } = rate;

  // Drag handlers
  const handleDrop = async (toStage: Lead["stage"]) => {
    if (dragId) {
      const lead = filtered.find((l) => l.id === dragId);
      if (lead && lead.stage !== toStage) {
        // Dropping onto Lost opens the reason prompt first; if it's dismissed
        // changeStage returns false and the card stays where it was.
        const moved = await changeStage(lead, toStage);
        if (moved) {
          const stageLabel = LEAD_STAGES.find((s) => s.id === toStage)?.label;
          toast.success(`${lead.company} → ${stageLabel}`);
        }
      }
    }
    setDragId(null);
    setOverStage(null);
  };

  return (
    <div className="h-[calc(100vh-3.5rem-4rem)] md:h-[calc(100vh-3.5rem)] max-w-[1800px] mx-auto p-3 sm:p-4 flex flex-col overflow-hidden min-w-0">
      {/* Top App Bar — sticky, so the primary action never scrolls away.
          TWO rows on purpose. It used to be one `flex-wrap` row holding title +
          switcher + CTA; below ~640px the CTA wrapped onto a line of its own and
          landed bottom-LEFT, which is the opposite of a primary action. Pinning
          the title and the CTA together in row 1 keeps "Add Lead" in the
          top-right corner at every width.

          `top-14` and `z-20` are BOTH load-bearing. The app's own TopBar is
          `sticky top-0 z-30 h-14` (components/layout/topbar.tsx). A first attempt
          used `top-0 z-30` here — the same offset and the same z-index — so this
          bar stuck to the viewport top ON TOP OF the TopBar (equal z-index, and
          this element comes later in the DOM, so it won). `top-14` parks it flush
          under the 56px TopBar; `z-20` guarantees it can never paint over it even
          if the offsets are edited again later. */}
      {/* Two things above are load-bearing together; changing either alone
          breaks this header.

          1. The wrapper's height subtracts the TopBar (3.5rem) AND, below md,
             the 4rem `pb-16` that (app)/layout.tsx puts on <main> for the mobile
             bottom nav. Without that second term the page is 4rem taller than
             the space it was given, so the DOCUMENT scrolls even though this
             page is meant to be contained. Fixed here, not in the layout,
             because pb-16 is right for every page that genuinely scrolls.

          2. top-0, not top-14. `overflow-hidden` on that wrapper makes IT the
             sticky containing block, not the viewport — so this offset is
             measured from the wrapper's top edge, which already sits below the
             TopBar. top-14 added the TopBar's 56px a second time and pinned
             this header 56px below its own content: the empty band under the
             TopBar. top-14 only looked necessary while the document was
             scrolling, which (1) stops. */}
      <div className="sticky top-0 z-20 shrink-0 mb-2.5 -mx-3 sm:-mx-4 px-3 sm:px-4 pt-1.5 pb-1.5 bg-paper/95 backdrop-blur-sm border-b border-hairline/60">
        {/* Row 1 — title, opposite the primary action */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="font-serif text-xl sm:text-2xl font-bold leading-none text-ink truncate">
              Sales & Pipeline
            </h1>
            <span className="text-xs text-ink-3 hidden md:inline-block">· Unified inquiry queue & deal stage pipeline</span>
          </div>

          {/* Primary action — top-right, and sticky with this bar. */}
          <Button
            variant="primary"
            icon="plus"
            size="sm"
            className="shrink-0"
            onClick={() => setAddOpen(true)}
          >
            {salesTab === "raw" ? "Add Lead" : "Add Deal"}
          </Button>
        </div>

        {/* Row 2 — 1-Click Segmented View Switcher. Scrolls sideways rather
            than wrapping, so it can never push the CTA out of the corner. */}
        <div className="flex items-center gap-1 bg-paper-2 p-1 rounded-lg border border-hairline w-fit max-w-full overflow-x-auto">
          {/* "All open" plus one chip per folder. Every count comes from the same
              inSalesFolder() the list filters with, so a chip can never advertise a
              number the list then contradicts — which is exactly what the old
              "Qualified Deals 1" did above a list of 9. Empty folders stay visible,
              greyed: their absence would read as a missing feature, and "0 overdue"
              is worth knowing. */}
          {/* Junk sits FIRST so the row reads the funnel in order: Junk → Inbox →
              Hot → Quote Sent. It is a smart view rather than a folder because junk
              is the one bucket deliberately excluded from every working list — the
              folders filter WITHIN the open pipeline, and junk is outside it. */}
          <button
            type="button"
            onClick={selectJunk}
            title="Binned as spam, fake or non-commercial — kept, never deleted"
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap",
              smartView === "junk"
                ? "bg-paper text-ink shadow-xs border border-hairline font-bold"
                : junkCount === 0
                ? "text-ink-3 hover:text-ink-2 hover:bg-paper/50"
                : "text-ink-2 hover:text-ink hover:bg-paper/50"
            )}
          >
            <span aria-hidden>🚫</span>
            <span>Junk</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-paper-2 text-ink-2 font-mono tabular-nums">
              {junkCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => selectFolder("all")}
            title="Inbox + In Talks + Quote Sent + Demo/Trial. Every open lead is in exactly one of those four."
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap",
              /* `folder` alone is not enough: the Junk view leaves folder at "all", and
                 checking only folder lit this chip AND Junk together — two highlighted
                 chips over one list. Browser-caught, not reasoned. */
              folder === "all" && smartView !== "junk"
                ? "bg-paper text-ink shadow-xs border border-hairline font-bold"
                : "text-ink-2 hover:text-ink hover:bg-paper/50"
            )}
          >
            <Icon name="inbox" size={13} className={folder === "all" && smartView !== "junk" ? "text-amber-ink" : "text-ink-3"} />
            <span>All open</span>
            <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-paper-2 text-ink-2 font-mono tabular-nums">
              {openLeads.length}
            </span>
          </button>

          {/* ── THE FOLDERS — every open lead in exactly ONE, so the numbers ADD UP ──
              Redesigned 17 Aug 2026 after Pardeep read "All open 8 · Inbox 7 · Hot 2",
              added 7+2, got 9, and asked how that could be right. The overlap was
              defensible and it does not matter: numbers sitting side by side WILL be
              added, and a row the owner has to ask three questions about has failed.
              Inbox + In Talks + Quote Sent + Demo/Trial = All open, visibly. */}
          {SALES_FOLDERS.map((f) => {
            const count = folderCounts[f.id];
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFolder(f.id)}
                title={count === 0 ? f.hint : undefined}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap",
                  folder === f.id
                    ? "bg-paper text-ink shadow-xs border border-hairline font-bold"
                    : count === 0
                    ? "text-ink-3 hover:text-ink-2 hover:bg-paper/50"
                    : "text-ink-2 hover:text-ink hover:bg-paper/50"
                )}
              >
                <span aria-hidden>{f.icon}</span>
                <span>{f.label}</span>
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-paper-2 text-ink-2 font-mono tabular-nums">
                  {count}
                </span>
              </button>
            );
          })}

          {/* ── THE FLAGS — a different KIND of chip, and dressed as one ────────────
              ⚡ Hot and ⏰ Due overlap the folders on purpose: a hot lead is still in
              Inbox — that is the whole point of a flag. The divider, the "FILTER"
              label and the amber tint all say the same thing three ways: these are
              lenses over the folders above, not places beside them. Do not add them
              to anything. */}
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-hairline" />
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-ink-4 select-none">
            Filter
          </span>
          {SALES_FLAGS.map((f) => {
            const count = folderCounts[f.id];
            /* Only ⏰ Due carries a second badge, and only when something is genuinely
               LATE — nine days late is a different problem from due at 4pm. */
            const late = f.id === "followup" ? overdueNowCount : 0;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFolder(f.id)}
                title={count === 0
                  ? f.hint
                  : "A filter, not a folder — these leads also sit in one of the folders on the left."}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap border",
                  /* Amber ONLY when selected. The first cut tinted unselected flags too,
                     to say "different species" — and Pardeep read both as permanently
                     highlighted, because a fill means "chosen" everywhere else on the
                     page. The species distinction is already carried by the divider and
                     the FILTER label; highlight keeps its one meaning. */
                  folder === f.id
                    ? "bg-amber-soft text-amber-ink shadow-xs border-amber/50 font-bold"
                    : count === 0
                    ? "text-ink-3 border-transparent hover:text-ink-2 hover:bg-paper/50"
                    : "text-ink-2 border-transparent hover:text-ink hover:bg-paper/50"
                )}
              >
                <span aria-hidden>{f.icon}</span>
                <span>{f.label}</span>
                {late > 0 && (
                  <span
                    title={`${late} already overdue, not just due today`}
                    className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-soft text-rose font-mono tabular-nums font-bold"
                  >
                    {late} late
                  </span>
                )}
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-paper-2 text-ink-2 font-mono tabular-nums">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

      </div>

      {/* Revenue Intelligence Pill Strip */}
      {!isLoading && leads && leads.length > 0 && (
        <div className="shrink-0 mb-2.5 bg-paper-2/60 border border-hairline rounded-lg px-3 py-1 flex items-center justify-between gap-3 text-xs overflow-x-auto">
          <div className="flex items-center gap-2.5 text-ink-2 shrink-0">
            <span className="flex items-center gap-1 font-semibold text-ink">
              <Icon name="bar_chart" size={14} className="text-amber-ink" />
              <span>Pipeline Intelligence:</span>
            </span>
            <span className="font-mono">Open Pipeline: <b className="text-amber-ink">{rupee(totalValue, { compact: true })}</b></span>
            <span className="text-ink-3 font-mono">·</span>
            {/* Weighted sits next to Open on purpose. Open Pipeline answers "how much is
                in play"; on its own it flatters, because a ₹5L deal at `new` counts the
                same as a ₹5L deal at `quote`. Weighted is what those stages have earned.
                The tooltip carries the undated count — a forecast missing dates is still
                a forecast, but the reader should know how much of it has no timing. */}
            <span
              className="font-mono"
              title={
                `Each open deal × its stage's win probability (new 10% → quote 80%).\n` +
                `Won and lost are excluded — a forecast is what is still to come.` +
                (forecast.confidencePct !== null ? `\nConfidence: ${forecast.confidencePct}% of open pipeline.` : "") +
                (forecast.undatedCount > 0
                  ? `\n\n${forecast.undatedCount} open deal${forecast.undatedCount === 1 ? "" : "s"} (${rupee(forecast.undatedValue, { compact: true })}) have no expected close date, so they cannot be placed in a month.`
                  : "")
              }
            >
              Weighted: <b className="text-emerald">{rupee(forecast.weighted, { compact: true })}</b>
              {forecast.undatedCount > 0 && (
                <span className="text-ink-3"> ({forecast.undatedCount} undated)</span>
              )}
            </span>
            <span className="text-ink-3 font-mono">·</span>
            {/* ONE count, not two. "Active Deals" and "Open leads" used to sit side by
                side; after the merge they describe the same thing, and two labels for
                one number invite the reader to hunt for the difference. */}
            <span
              className="font-mono"
              title="Every lead that is neither won, lost nor junk — whatever stage it reached."
            >
              Open deals: <b className="text-ink">{openDeals.length}</b>
            </span>
            <span className="text-ink-3 font-mono">·</span>
            <span
              className="font-mono"
              title={
                decidedCount > 0
                  ? `${wonCount} won and ${lostCount} lost — ${wonCount} of ${decidedCount} decided.\n` +
                    `${openDeals.length} still open and NOT counted: undecided is not lost.`
                  : `Nothing has closed either way yet, so there is no rate to show.\n` +
                    `${openDeals.length} deals are still open.`
              }
            >
              Win Rate: <b className="text-emerald">{conversion === null ? "—" : `${conversion}%`}</b>
              {decidedCount > 0 && (
                <span className="text-ink-3"> ({wonCount}/{decidedCount})</span>
              )}
            </span>
          </div>

          {/* Sales-motion switcher. "All" is first and is the default — opening the page
              already filtered would hide deals from anyone who does not know the filter
              exists. Counts come from the UNFILTERED set so they answer "how much is
              there", not "how much survives what I already picked". */}
          <div className="ml-3 flex shrink-0 items-center gap-1">
            {([null, ...PIPELINES.map((p) => p.id)] as (Pipeline | null)[]).map((id) => {
              const def = id ? PIPELINES.find((p) => p.id === id)! : null;
              const n = id ? motionCounts[id] : workspaceLeads.filter((l) => !l.is_junk).length;
              const active = pipelineFilter === id;
              return (
                <button
                  key={id ?? "all"}
                  type="button"
                  onClick={() => setPipelineFilter(id)}
                  title={def?.hint ?? "Every sales motion"}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors",
                    active ? "bg-paper text-ink shadow-xs border border-hairline"
                           : "text-ink-2 hover:bg-paper/60",
                  )}
                >
                  {def?.label ?? "All motions"}
                  <span className="ml-1 font-mono tabular-nums text-ink-3">{n}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="text-[11px] font-semibold text-amber-ink hover:underline shrink-0 ml-auto"
          >
            {kpiOpen ? "Hide Breakdown" : "View Breakdown"}
          </button>
        </div>
      )}

      {/* Expanded Intelligence Drawer */}
      {kpiOpen && !isLoading && leads && leads.length > 0 && (
        <div className="mb-2.5 p-2.5 border border-hairline rounded-lg bg-paper shrink-0">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
              <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Open Pipeline</p>
              <p className="font-serif text-base font-bold text-amber-ink tabular-nums mt-0.5">{rupee(totalValue, { compact: true })}</p>
            </div>
            <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
              <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Open deals</p>
              <p className="font-serif text-base font-bold text-ink tabular-nums mt-0.5">{openDeals.length}</p>
            </div>
            <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
              <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Won</p>
              <p className="font-serif text-base font-bold text-ink tabular-nums mt-0.5">{wonCount}</p>
            </div>
            <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
              <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Win Rate</p>
              <p className="font-serif text-base font-bold text-emerald tabular-nums mt-0.5">
                {conversion === null ? "—" : `${conversion}%`}
              </p>
              {/* The sample, under the number. "100%" off two closed deals and "100%" off
                  two hundred are the same three characters and not the same claim. */}
              <p className="text-[10px] text-ink-3 tabular-nums">
                {decidedCount > 0 ? `${wonCount} of ${decidedCount} decided` : "nothing closed yet"}
              </p>
            </div>
            <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
              <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">High Priority</p>
              <p className="font-serif text-base font-bold text-rose-600 tabular-nums mt-0.5">{leads.filter((l) => l.priority === "high").length}</p>
            </div>
            <div className="bg-paper-2/40 border border-hairline rounded-md p-2 text-left">
              <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Total Inquiries</p>
              <p className="font-serif text-base font-bold text-ink tabular-nums mt-0.5">{leads.length}</p>
            </div>
          </div>
        </div>
      )}

      {/* Search + Views dropdown + Filter buttons.
          The Views control used to be a chip strip in a flex-1 overflow-x-auto
          box here. Eight chips in the space left over between the search box and
          the buttons meant one visible chip and two scroll arrows. It is a
          dropdown now, so the row no longer needs a scrolling middle section —
          and the width it was hogging goes to the search box, which was the
          other cramped control on this row. */}
      {!isLoading && leads && (
        <div className="shrink-0 mb-3 flex items-center gap-2 flex-wrap">
          <div className="w-full sm:w-auto sm:flex-1 sm:min-w-[180px] sm:max-w-sm">
            <Input
              prefix={<Icon name="search" size={14} />}
              placeholder="Search leads & deals…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <LeadsSmartViews
            leads={leadsForTab}
            currentUserId={currentUser?.userId}
            duplicateCount={duplicateCountForTab}
            junkCount={junkCount}
            junkSuspectCount={junkSuspectCount}
            active={smartView}
            onChange={selectSmartView}
          />

          <div className="flex items-center gap-2 shrink-0">
            {/* View Switcher: Kanban vs List */}
            <div className="inline-flex rounded-md border border-hairline overflow-hidden">
              <button
                type="button"
                onClick={() => setView("kanban")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors cursor-pointer",
                  effectiveView === "kanban" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2"
                )}
                title="Kanban view — best for stage flow"
              >
                <Icon name="layout" size={13} /> Kanban
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors border-l border-hairline cursor-pointer",
                  effectiveView === "list" ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2"
                )}
                title="List view — best for scanning many leads"
              >
                <Icon name="more_h" size={13} /> List
              </button>
            </div>

            {/* Filter Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button icon="filter" size="sm">
                  Filter
                  {activeFilterCount > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-amber text-paper text-[10px] font-semibold px-1">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">Stage</DropdownMenuLabel>
                {filterStages.map((s) => (
                  <DropdownMenuCheckboxItem
                    key={s.id}
                    checked={stageFilter.includes(s.id)}
                    onCheckedChange={(checked) => {
                      setStageFilter((prev) =>
                        checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)
                      );
                    }}
                    className="text-sm"
                  >
                    <span className={cn("inline-block w-2 h-2 rounded-full mr-2", s.dot)} />
                    {s.label}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-ink-3">Priority</DropdownMenuLabel>
                {(["high","medium","low"] as const).map((p) => (
                  <DropdownMenuCheckboxItem
                    key={p}
                    checked={priorityFilter.includes(p)}
                    onCheckedChange={(checked) => {
                      setPriorityFilter((prev) =>
                        checked ? [...prev, p] : prev.filter((x) => x !== p)
                      );
                    }}
                    className="text-sm capitalize"
                  >
                    <span className={cn("inline-block w-2 h-2 rounded-full mr-2",
                      p === "high"   && "bg-rose",
                      p === "medium" && "bg-amber",
                      p === "low"    && "bg-slate"
                    )} />
                    {p}
                  </DropdownMenuCheckboxItem>
                ))}
                {activeFilterCount > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => { setStageFilter([]); setPriorityFilter([]); }}
                      className="text-sm text-rose"
                    >
                      Clear all filters
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {!isSales && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="default" size="sm" icon="more_h">More</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCsvImportOpen(true)}>
                    <Icon name="download" size={14} className="text-ink-3" /> Import CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setCampaignOpen(true)}>
                    <Icon name="send" size={14} className="text-ink-3" /> Send campaign
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setGoogleImportOpen(true)}>
                    <Icon name="globe" size={14} className="text-ink-3" /> Import from Google
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="gap-2 cursor-pointer" onSelect={() => setShareOpen(true)}>
                    <Icon name="link" size={14} className="text-ink-3" /> Share enquiry form
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}


      {/* ─── Main content + right rail split.
          flex-1 + min-h-0 makes this section take up all remaining
          vertical space in the page wrapper (so the table area can
          stretch even with only one row of data). Below xl (≤1279px)
          this is a single column — the rail's own visibility class
          keeps it dormant. On xl+ the rail appears (320px) and the
          main column flexes to fill the remainder.
          Drawer / FAB / modals live OUTSIDE this flex (position:fixed),
          so they aren't constrained by the split. */}
      <div className="flex gap-6 flex-1 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
      {/* AI junk review — only in the Junk view. Lets the operator ask AI to
          decide across the spam pile (verdict + reason + confidence), then
          confirm with one tap. Reversible, human-in-the-loop. */}
      {smartView === "junk" && filtered.length > 0 && (
        <JunkAIReview leads={filtered} />
      )}

      {/* AI lead intelligence
          "Hot leads" = highest-value rows in quote/trial stages — these
          convert at the highest rate per the prototype-era data, and they're
          the ones a rep should actually touch today. The two action buttons
          target the single TOP hot lead (highest value) — Call opens the
          phone dialer; Send nudge opens the mail client with a pre-written
          follow-up. Both gracefully degrade if the contact info is missing. */}
      {!isLoading && leads && leads.length > 0 && !isSales && search.trim() === "" && (() => {
        const hotLeads = filtered
          .filter((l) => l.stage === "quote" || l.stage === "trial")
          .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
        const topHot = hotLeads[0] ?? null;
        // The new Insight band (KPI pills + pulse) already surfaces "Hot"
        // count at the top of the page. Showing this card with a "0 hot
        // leads" empty state is just noise. Render only when there's
        // actually a hot lead to act on. Sales role gets the band only —
        // this card is owner/manager territory (it surfaces aggregate
        // tenant info beyond the rep's individual book).
        if (hotLeads.length === 0) return null;

        const handleCallTop = () => {
          if (!topHot) { toast.info("No hot leads right now"); return; }
          if (!topHot.contact_phone) {
            toast.error(`${topHot.company} has no phone on record · open the lead to add one`);
            return;
          }
          // tel: schemes ignore spaces but be defensive
          window.location.href = `tel:${topHot.contact_phone.replace(/\s+/g, "")}`;
        };

        const handleSendNudge = () => {
          if (!topHot) { toast.info("No hot leads right now"); return; }
          if (!topHot.contact_email) {
            toast.error(`${topHot.company} has no email on record · open the lead to add one`);
            return;
          }
          const signoff = currentUser?.tenantName ?? "your team";
          const subject = `Following up · ${topHot.company}`;
          const body =
            `Hi ${topHot.contact_name ?? "there"},\n\n` +
            `Just checking in on ${topHot.plan ? `the ${topHot.plan} discussion` : "your inquiry"}. ` +
            `Let me know if you have any questions or want to set up a quick call.\n\n` +
            `— ${signoff}`;
          window.location.href = `mailto:${topHot.contact_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        };

        return (
          // Hidden on mobile — eats vertical real estate that sales reps need
          // for the actual lead list. Desktop keeps it visible since there's
          // plenty of width.
          <div className="mb-4 hidden md:block">
            {tipsOpen ? (
              <GeminiCard
                title="Lead intelligence · Today"
                actions={
                  <>
                    <Button size="sm" variant="primary" icon="phone" disabled={!topHot} onClick={handleCallTop}>
                      {topHot ? `Call ${topHot.company.split(/\s+/)[0]}` : "Call top lead"}
                    </Button>
                    <Button size="sm" icon="mail" disabled={!topHot} onClick={handleSendNudge}>Send nudge</Button>
                    <Button size="sm" variant="ghost" icon="chevron_up" aria-label="Hide tips" onClick={toggleTips} />
                  </>
                }
              >
                <b className="text-ink">{hotLeads.length} hot lead{hotLeads.length === 1 ? "" : "s"} worth focusing today.</b>{" "}
                {topHot
                  ? <>Top: <b>{topHot.company}</b> ({topHot.plan ?? "—"}, {topHot.value ? rupee(topHot.value, { compact: true }) : "value pending"}). Quote/Trial stages convert highest — prioritize today.</>
                  : <>No leads in Quote Sent or Trial Active right now. Move some forward to surface hot opportunities.</>}
              </GeminiCard>
            ) : (
              <button
                type="button"
                onClick={toggleTips}
                className="w-full flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper-2/40 px-3 py-1.5 text-xs text-ink-2 hover:bg-paper-2"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="sparkles" size={13} className="text-amber-ink" />
                  Lead intelligence · <b className="text-ink">{hotLeads.length}</b> hot lead{hotLeads.length === 1 ? "" : "s"} today
                </span>
                <span className="inline-flex items-center gap-1 text-ink-3"><Icon name="chevron_down" size={13} /> Show</span>
              </button>
            )}
          </div>
        );
      })()}

      {/* Tab bar removed after the /leads + /deals split — navigation between
          the two views is now via sidebar entries. The single-page tab UI
          confused sales reps and added a click for owner/manager too. */}

      {/* 🔥 Today's priority call queue — replaces the read-only "Today's follow-ups"
          widget that used to sit here. Same source data (follow_up_date <= today, with
          overdue included), but each row now dials, WhatsApps and records the outcome
          without leaving the bar. The old widget could only tell a rep WHO to call and
          then made them go and find the lead to do anything about it.

          It also self-hides, states how many due leads it is NOT showing, and names the
          ones with no phone number — see priority-call-queue.tsx for why each of those
          matters more than it sounds. */}
      {!isLoading && leads && leads.length > 0 && search.trim() === "" && (
        <PriorityCallQueue
          leads={workspaceLeads}
          tenantName={currentUser?.tenantName}
          onOutcome={(o, l) => { void runOutcome(o, l); }}
          onOpen={(l) => setSelected(l)}
          onLogCall={(l) => queueLog.mutate({ leadId: l.id, kind: "call", detail: `Called ${l.contact_phone ?? ""}` })}
          onLogWhatsApp={(l) => queueLog.mutate({ leadId: l.id, kind: "whatsapp", detail: `WhatsApp to ${l.contact_phone ?? ""}` })}
        />
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load leads"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 flex-1 min-h-0">
          {LEAD_STAGES.map((s) => (
            <div key={s.id} className="bg-paper-2 border-2 border-dashed border-hairline rounded-lg p-2.5 min-h-[400px]">
              <div className="flex items-center gap-1.5 mb-3 px-1">
                <span className={cn("w-1.5 h-1.5 rounded-full", s.dot)} />
                <span className="text-xs font-semibold">{s.label}</span>
              </div>
              <div className="space-y-2">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty — copy + CTAs swap based on which page we're on. Import CSV
          stays a secondary action for owner/manager only (sales role has it
          hidden from the toolbar above; keeping it consistent here). */}
      {!isLoading && !error && leads && leads.length === 0 && (
        <EmptyState
          icon="target"
          title={isDealsPage ? "No deals yet" : "No leads yet"}
          body={
            isDealsPage
              ? "Qualified deals will appear here once a lead picks a plan. You can also add deals manually with a known seat count + value."
              : "Leads will appear here when customers fill the contact form, or you can add them manually."
          }
          action={
            <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              {isDealsPage ? "Add your first deal" : "Add your first lead"}
            </Button>
          }
          secondary={!isSales ? <Button icon="download" onClick={() => setCsvImportOpen(true)}>Import CSV</Button> : undefined}
        />
      )}

      {/* Per-view empty — tenant HAS leads but the active smart view filter
          hides all of them. Purpose-specific message per view (research
          finding: generic "no results" loses users; targeted copy with a
          relevant action recovers them). */}
      {!isLoading && !error && leads && leads.length > 0 && filtered.length === 0 && smartView !== "all" && (
        <EmptyState
          icon={
            smartView === "today"   ? "clock" :
            smartView === "hot"     ? "zap" :
            smartView === "new"     ? "inbox" :
            smartView === "won-mtd" ? "trending_up" :
            smartView === "mine"    ? "user" : "target"
          }
          title={
            smartView === "today"   ? "No new leads today" :
            smartView === "hot"     ? "No hot leads right now" :
            smartView === "new"     ? "No new leads" :
            smartView === "won-mtd" ? "No wins this month yet" :
            smartView === "mine"    ? "You don't own any leads yet" :
            "No leads match this view"
          }
          body={
            smartView === "today"   ? "No new leads came in today. Use the Add Lead button to add one manually — new inbound leads will show up here." :
            smartView === "hot"     ? "No leads in Demo / Trial / Quote stage. Move qualified leads forward to surface hot opportunities." :
            smartView === "new"     ? "Inbox is clear. Switch to Hot or Won MTD to see what's moving." :
            smartView === "won-mtd" ? "Close your first deal this month — it'll show up here." :
            smartView === "mine"    ? "Leads assigned to you will appear here. Switch to All to see everyone's." :
            "Try a different view or clear filters."
          }
          action={
            <Button variant="primary" icon="eye" onClick={() => setSmartView("all")}>
              Show all leads
            </Button>
          }
        />
      )}

      {/* Loss analytics — owner-level "why are we losing?", in money. Deals tab
          only: the raw-inquiry tab has no stage flow, so losses aren't its story.
          The card handles its own empty state and hides nothing. */}
      {!isLoading && !error && isDealsPage && workspaceLeads.length > 0 && (
        <div className="mb-3">
          <LossReasonsCard leads={workspaceLeads} />
        </div>
      )}

      {/* Kanban — only shows on Deals tab (raw leads in the Leads tab have
          no meaningful stage flow, so we force list view there).
          flex-1 + min-h-0 lets the grid stretch to fill remaining viewport
          height (page wrapper is min-h-[calc(100vh-3.5rem)] flex-col), so
          columns visually fill instead of bottom cream area showing. */}
      {!isLoading && !error && leads && leads.length > 0 && effectiveView === "kanban" && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Auto-fit Kanban grid stretching 100% of remaining viewport height */}
          <div className="flex-1 min-h-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-flow-col lg:auto-cols-[minmax(220px,1fr)] lg:grid-rows-1 gap-3 overflow-x-auto overflow-y-hidden pb-1">
            {DEAL_STAGES.map((stage) => {
              const stageLeads = filtered.filter((l) => l.stage === stage.id);
              const stageValue = stageLeads.reduce((s, l) => s + (l.value ?? 0), 0);
              const isOver = overStage === stage.id;

              return (
                <div
                  key={stage.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverStage(stage.id);
                  }}
                  onDragLeave={() => setOverStage(null)}
                  onDrop={() => handleDrop(stage.id)}
                  className={cn(
                    "rounded-xl p-2.5 flex flex-col min-h-0 h-full overflow-hidden transition-colors bg-paper-2/70 border-2",
                    isOver ? "border-solid border-amber" : "border-dashed border-hairline"
                  )}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-hairline shrink-0">
                    <div className="flex items-center gap-1.5">
                      <span className={cn("w-2 h-2 rounded-full", stage.dot)} />
                      <span className="text-xs font-bold text-ink">{stage.label}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-paper text-ink-2 font-mono tabular-nums border border-hairline">
                        {stageLeads.length}
                      </span>
                    </div>
                    <span className="font-serif text-xs font-bold text-amber-ink tabular-nums">
                      {stageValue > 0 ? rupee(stageValue, { compact: true }) : ""}
                    </span>
                  </div>

                  {/* Cards container — per-column independent vertical scroll */}
                  <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5 custom-scrollbar">
                    {stageLeads.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        isDragging={dragId === lead.id}
                        onDragStart={setDragId}
                        onDragEnd={() => {
                          setDragId(null);
                          setOverStage(null);
                        }}
                        onClick={(l) => setSelected(l)}
                      />
                    ))}

                    {stageLeads.length === 0 && (
                      <div className="h-20 flex items-center justify-center border border-dashed border-hairline/60 rounded-md text-[11px] text-ink-3">
                        No deals in {stage.label.toLowerCase()}
                      </div>
                    )}
                  </div>

                  {/* Quick Add Deal in column */}
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className="mt-2 shrink-0 border border-dashed border-hairline hover:border-hairline-strong rounded-md py-1.5 text-[11px] font-medium text-ink-3 hover:text-ink flex items-center justify-center gap-1 transition-colors cursor-pointer bg-paper/50 hover:bg-paper"
                  >
                    <Icon name="plus" size={12} /> Add deal
                  </button>
                </div>
              );
            })}
          </div>

          {/* Footer status bar */}
          <div className="shrink-0 flex items-center justify-between text-[11px] text-ink-3 pt-1.5 px-1">
            <span className="flex items-center gap-1">
              <Icon name="info" size={12} /> Drag cards across columns to update pipeline stage instantly
            </span>
            <span className="font-mono">{filtered.length} total deal{filtered.length === 1 ? "" : "s"} visible</span>
          </div>
        </div>
      )}

      {/* List view — sortable table, designed for scanning at 50+ leads.
          Also the only view available on the Leads tab (triage queue).
          Only render when there ARE rows to show — otherwise the table's
          internal "No leads match." row appears AND the smart empty state
          below also fires, creating a duplicate. Skipping the table here
          lets the smart empty state below own the empty-screen real estate. */}
      {!isLoading && !error && leads && leads.length > 0 && effectiveView === "list" && filtered.length > 0 && (
        <LeadListView
          leads={filtered}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={(col) => {
            if (sortBy === col) setSortDir(sortDir === "asc" ? "desc" : "asc");
            else { setSortBy(col); setSortDir(col === "company" ? "asc" : "desc"); }
          }}
          // Both Leads + Deals rows open the rich drawer now (consistency): a
          // raw lead's first move is to CONTACT (call/WhatsApp/email/follow-up/
          // send-quote) — all live in the drawer. Qualifying is still one click
          // away via the drawer's "Edit" button, so nothing is lost.
          onRowClick={(l) => setSelected(l)}
          onSendQuote={goSendQuote}
          onFollowUp={setFollowUpLead}
          onWhatsApp={(l) => setWaLead(l)}
          onMerge={openMergeFor}
          dupIds={dup.flagged}
        />
      )}

      {/* No results from search OR tab cross-over hint.
          The split is BY STAGE, not by plan — see isRaw() above. /leads is stage
          `new` or `contact`; /deals is demo / trial / quote / won / lost. The old
          wording here ("no plan picked" / "plan set") was wrong and misled a reader
          into an inverted picture of where the pipeline actually sits.
          When the tenant has plenty of data but the current tab is empty, point the
          operator at the right place instead of a generic "no results". */}
      {!isLoading && !error && leads && leads.length > 0 && filtered.length === 0 && smartView === "all" && (
        <div className="mt-6">
          {search.trim() ? (
            <EmptyState
              icon="search"
              title="No leads match"
              body={`No results for "${search}". Try a different search term.`}
              action={<Button icon="x" onClick={() => setSearch("")}>Clear search</Button>}
              compact
            />
          ) : (
            <EmptyState
              icon="search"
              title="No leads match"
              body="No results match the active filters. Try clearing filters or stage selection."
              action={<Button icon="x" onClick={() => { setStageFilter([]); setPriorityFilter([]); }}>Clear filters</Button>}
              compact
            />
          )}
        </div>
      )}

        </div>{/* /flex-1 main column */}

      </div>{/* /flex split */}

      {/* Detail drawer */}
      <LeadDetailSheet
        lead={selected}
        onClose={() => setSelected(null)}
        onEdit={(l) => {
          setSelected(null);
          setEditingLead(l);
          setAddOpen(true);
        }}
      />

      {/* Row "Follow-up" quick action → schedule a task linked to this lead */}
      {followUpLead && (
        <AddTaskDialog
          open
          onOpenChange={(o) => { if (!o) setFollowUpLead(null); }}
          linkLabel={followUpLead.company}
          linkTo={{ lead_id: followUpLead.id }}
        />
      )}

      {/* WhatsApp Action & Templates Dialog */}
      {waLead && (
        <WhatsAppActionDialog
          open
          onOpenChange={(o) => { if (!o) setWaLead(null); }}
          phone={waLead.contact_phone}
          recipientName={waLead.contact_name}
          companyName={waLead.company}
          category="quote"
          vars={{
            productName: waLead.plan || "Cloud Service",
            seats: waLead.seats || 10,
            amount: waLead.value ? rupee(waLead.value) : undefined,
          }}
        />
      )}

      {/* Merge duplicates — opened from a row's "Duplicate?" flag */}
      {mergeCluster && mergeCluster.length > 1 && (
        <MergeLeadsDialog cluster={mergeCluster} onClose={() => setMergeCluster(null)} />
      )}

      {/* Add / Edit lead modal */}
      <AddLeadForm
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setEditingLead(null);
        }}
        editingLead={editingLead}
        // On the Deal Pipeline, "Add Deal" creates a NEW record straight in the
        // pipeline (stage "quote") so it actually shows up here.
        defaultStage={isDealsPage ? "quote" : undefined}
      />

      {/* Quick add — 4-field minimal lead capture (company + contact only). */}
      <QuickAddLeadForm
        open={quickOpen}
        onOpenChange={setQuickOpen}
      />

      <StartTrialDialog open={trialOpen} onOpenChange={setTrialOpen} />

      <CampaignComposerDialog open={campaignOpen} onOpenChange={setCampaignOpen} />

      <GoogleContactsImportDialog open={googleImportOpen} onOpenChange={setGoogleImportOpen} />

      {/* CSV bulk upload — 4-field minimal capture, matches Quick form. */}
      <ImportCsvDialog
        open={csvImportOpen}
        onOpenChange={setCsvImportOpen}
        onImportComplete={() => refetch()}
      />

      {/* Share the public enquiry form — collect a prospect's details, auto-creates a lead. */}
      {shareOpen && <ShareFormSheet target={ENQUIRY_SHARE} onClose={() => setShareOpen(false)} />}

      {/* NO FAB HERE, deliberately (removed 13 Aug 2026 at Pardeep's request).
          The primary action lives in the sticky header instead, so it is visible
          at every scroll position without covering the last row of the list —
          which is what the bottom-right FAB was doing over the card grid.

          §20 asks for a FAB on mobile for thumb reach, and this does trade that
          away: the top-right corner is a longer stretch one-handed than the
          bottom-right. Noted as a deliberate deviation, not an oversight.

          The "⚡ Quick" mini-FAB went with it. The 4-field quick-capture form is
          NOT orphaned — it is still reachable from the top-bar quick-actions
          panel (quick-actions-panel.tsx) and from Ctrl+K → "Open the quick-add
          form" (command-palette.tsx), both of which route here via
          ?action=quick-add. */}
    </div>
  );
}

// ============================================================
// Lead detail Sheet (slide-out drawer on card click)
// ============================================================
const ACTIVITY_META: Record<string, { icon: React.ComponentProps<typeof Icon>["name"]; label: string }> = {
  email:    { icon: "mail",    label: "Email sent" },
  email_in: { icon: "inbox",   label: "Reply received" },
  call:     { icon: "phone",   label: "Call" },
  whatsapp: { icon: "whatsapp", label: "WhatsApp" },
  note:     { icon: "edit",    label: "Note" },
  quote:    { icon: "file",    label: "Quote" },
  stage:    { icon: "refresh", label: "Stage change" },
};
function fmtActTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

/** Open a WhatsApp chat — WhatsApp Web on desktop, the app on mobile. */
function openWhatsApp(rawNumber: string, text?: string) {
  const num = (rawNumber || "").replace(/\D/g, "");
  if (!num) return;
  const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const q = text ? `${isMobile ? "?" : "&"}text=${encodeURIComponent(text)}` : "";
  const url = isMobile
    ? `https://wa.me/${num}${q}`
    : `https://web.whatsapp.com/send?phone=${num}${q}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function LeadDetailSheet({
  lead,
  onClose,
  onEdit,
}: {
  lead: Lead | null;
  onClose: () => void;
  onEdit: (lead: Lead) => void;
}) {
  const router      = useRouter();
  const { changeStage } = useChangeLeadStage();
  const deleteLead  = useDeleteLead();
  const confirm     = useConfirm();
  const { data: currentUser } = useCurrentUser();
  const logActivity = useLogLeadActivity();
  /* Catalog costs for this drawer's margin figure. Same index the list builds — one
     source, so the pill on the row and the number in the drawer can never disagree. */
  const { data: drawerCatalog } = useItems();
  const drawerPlanCosts = React.useMemo(() => buildPlanCostIndex(drawerCatalog ?? []), [drawerCatalog]);
  const { data: activities = [] } = useLeadActivities(lead?.id);
  const [drawerTab, setDrawerTab] = React.useState<"details" | "followups" | "activity">("details");
  React.useEffect(() => { setDrawerTab("details"); }, [lead?.id]);

  // Drag-to-resize the drawer (desktop only): the left edge is a grab handle;
  // the chosen width is remembered per browser. Mobile stays full-width.
  const [panelWidth, setPanelWidth] = React.useState<number | null>(null);
  const widthRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const saved = Number(localStorage.getItem("lead_drawer_w"));
    if (saved >= 360) { setPanelWidth(saved); widthRef.current = saved; }
  }, []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(360, Math.min(window.innerWidth - ev.clientX, window.innerWidth * 0.95));
      widthRef.current = w;
      setPanelWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      if (widthRef.current) localStorage.setItem("lead_drawer_w", String(Math.round(widthRef.current)));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // History: every quote that's been sent to this lead
  const { data: quotesForLead = [] } = useQuotesByLead(lead?.id);

  // Follow-up tasks linked to this lead — drives the "Follow-ups" drawer section
  const { data: tasksForLead = [] } = useTasksForLead(lead?.id);

  /* The unified stream. Built from sources this drawer already loads — merging is a
     view concern, so no new fetch. Payments are not passed yet: they link to a lead
     only through a quote, and buildTimeline accepts them the day that query exists
     rather than pretending the gap is not there. */
  /** Inline note composer state. Local to the drawer — a note is not worth a dialog. */
  const [noteDraft, setNoteDraft] = React.useState("");

  const timeline = React.useMemo(
    () => buildTimeline({ activities, quotes: quotesForLead, tasks: tasksForLead }),
    [activities, quotesForLead, tasksForLead],
  );
  const completeTask = useCompleteTask();
  const snoozeTask   = useSnoozeTask();
  const deleteTask   = useDeleteTask();
  const [addTaskOpen, setAddTaskOpen] = React.useState(false);
  const [whatsOpen,   setWhatsOpen]   = React.useState(false);
  const [cardsOpen,   setCardsOpen]   = React.useState(false);

  /* Deal health. Built from what this drawer already loads — activities give both the
     last touch and whether the customer ever replied, so no extra query. `email_in` is
     the only inbound kind today; a reply logged any other way is invisible here, which
     under-scores the deal rather than over-scoring it. That direction is deliberate: a
     health score that flatters a neglected deal is worse than one that nags. */
  const health = React.useMemo(() => {
    if (!lead) return null;
    const sorted = [...activities].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return dealHealth({
      lead,
      lastActivityAt: sorted[0]?.created_at ?? null,
      customerResponded: activities.some((a) => a.kind === "email_in"),
      today: localDateISO(new Date()),
    });
  }, [lead, activities]);

  if (!lead) return null;
  const hasQuotes = quotesForLead.length > 0;
  const openTasks = tasksForLead.filter((t) => t.status === "pending" || t.status === "snoozed");
  const doneTasks = tasksForLead.filter((t) => t.status === "done");

  const handleDelete = async () => {
    const confirmed = await confirm({
      title: `Permanently delete lead "${lead.company}"?`,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    deleteLead.mutate(lead.id, {
      onSuccess: () => onClose(),
    });
  };

  const handleSendQuote = () => {
    // Pass lead context to QuoteBuilder via URL params
    const params = new URLSearchParams();
    params.set("leadId",  lead.id);
    params.set("company", lead.company);
    if (lead.plan)            params.set("plan",  lead.plan);
    if (lead.seats != null)   params.set("seats", String(lead.seats));
    if (lead.contact_name)    params.set("contact", lead.contact_name);
    if (lead.contact_email)   params.set("email", lead.contact_email);
    if (lead.contact_phone)   params.set("phone", lead.contact_phone);
    onClose();
    router.push(`/quotes/new?${params.toString()}` as any);
  };

  // If lead already has a quote, default the primary CTA to "Revise & resend"
  // (duplicate the latest quote, edit, resend). This avoids accidental duplicates
  // and keeps audit history clean.
  const latestQuote = quotesForLead[0]; // sorted by created_date desc
  const handleReviseQuote = () => {
    if (!latestQuote) return handleSendQuote();
    const params = new URLSearchParams();
    params.set("duplicate", latestQuote.id);
    params.set("leadId",    lead.id);
    params.set("company",   lead.company);
    if (lead.contact_name)  params.set("contact", lead.contact_name);
    if (lead.contact_email) params.set("email",   lead.contact_email);
    if (lead.contact_phone) params.set("phone",   lead.contact_phone);
    onClose();
    router.push(`/quotes/new?${params.toString()}` as any);
  };

  const handleEmail = () => {
    if (!lead.contact_email) {
      toast.error("No email on this lead");
      return;
    }
    const subject = `About your inquiry · ${lead.company}`;
    const signoff = currentUser?.tenantName ?? "your team";
    const body    = `Hi ${lead.contact_name ?? "there"},\n\nThanks for your interest in ${lead.plan ?? "our services"}. Let me know a good time to connect.\n\n— ${signoff}`;
    // Open Gmail compose in a new tab — reliable across machines (a raw mailto:
    // does nothing when no desktop mail client is configured).
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    logActivity.mutate({ leadId: lead.id, kind: "email", detail: `Emailed ${lead.contact_email} · ${subject}` });
    toast.success("Logged on the lead's timeline");
  };

  const handleArchive = () => {
    void changeStage(lead, "lost");
    toast.success(`${lead.company} archived`);
    onClose();
  };

  // Smart "next action" suggestion — tells the rep THE one thing to do next
  // instead of making them stare at 10 buttons trying to decide. Pattern from
  // Linear / Notion: cut decision fatigue by surfacing the most likely next
  // move, ranked by lead state + quote age + payment status.
  // Must be declared AFTER handleSendQuote / handleReviseQuote since it
  // closes over them.
  const latestQuoteForAction = quotesForLead[0]; // sorted desc by created_date
  const quoteAgeDays = latestQuoteForAction
    ? Math.floor((Date.now() - new Date(latestQuoteForAction.created_date).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  type NextAction = {
    label: string;
    icon: string;
    tone: "amber" | "rose" | "emerald" | "indigo";
    onClick: () => void;
    hint?: string;
    help?: string;
  };
  const nextAction: NextAction | null = (() => {
    // 1. Paid quote → issue invoice / view invoice / record remainder
    if (latestQuoteForAction?.payment_status === "received") {
      return {
        label: "Issue GST invoice",
        icon: "receipt",
        tone: "emerald",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: `Paid · ₹${(latestQuoteForAction.payment_amount ?? 0).toLocaleString("en-IN")}`,
      };
    }
    if (latestQuoteForAction?.payment_status === "invoiced") {
      return {
        label: "View invoice",
        icon: "receipt",
        tone: "emerald",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: "Already invoiced",
      };
    }
    if (latestQuoteForAction?.payment_status === "partial") {
      return {
        label: "Record remaining payment",
        icon: "rupee",
        tone: "amber",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: "Partial received",
      };
    }
    // 2. Draft quote exists but was never sent → prompt to SEND it (open the
    //    draft), not "revise & resend / chase". A draft has no sent-date, so the
    //    age-based "Sent today / Nd ago" copy below would be misleading.
    if (latestQuoteForAction?.status === "draft") {
      return {
        label: "Send draft quote",
        icon: "send",
        tone: "amber",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: "Not sent yet",
      };
    }
    // 3. Quote SENT but not yet paid → the goal now is getting PAID, so the
    //    primary action is "Record payment" (→ the quote hub, where you can also
    //    preview / resend). Chasing is the header WhatsApp/Call buttons; revising
    //    is the footer "Revise & resend" — so the big CTA drives the money moment,
    //    NOT the edit builder (which is what it wrongly used to open).
    if (latestQuoteForAction && quoteAgeDays !== null) {
      const overdue = quoteAgeDays > 7;
      const ageText = quoteAgeDays === 0 ? "Sent today" : `Sent ${quoteAgeDays}d ago`;
      return {
        label: "Record payment",
        icon: "rupee",
        tone: overdue ? "rose" : "amber",
        onClick: () => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); },
        hint: overdue ? `${ageText} · overdue — chase them` : ageText,
        help: "Quote is sent. Record the payment here the moment it lands. To chase, use the WhatsApp/Call buttons above; to change the quote, use Revise & resend below.",
      };
    }
    // 4. No quote yet → by stage
    if (lead.stage === "lost") {
      return { label: "Re-engage · send new quote", icon: "send", tone: "indigo", onClick: handleSendQuote };
    }
    if (lead.stage === "won") {
      return { label: "Upsell · new quote", icon: "send", tone: "indigo", onClick: handleSendQuote };
    }
    if (lead.stage === "new" && lead.contact_phone) {
      return { label: "Call now · first contact", icon: "mobile", tone: "amber", onClick: () => { window.location.href = `tel:${lead.contact_phone}`; }, hint: lead.contact_phone ?? undefined };
    }
    if (lead.stage === "trial") {
      return { label: "Convert trial · send quote", icon: "send", tone: "amber", onClick: handleSendQuote };
    }
    // Default: send quote (covers contact/demo stages with no quote yet)
    return { label: "Send Quote", icon: "send", tone: "amber", onClick: handleSendQuote };
  })();

  const stageLabel = LEAD_STAGES.find((s) => s.id === lead.stage)?.label ?? lead.stage;

  return (
    <Sheet open={!!lead} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:w-[var(--lead-w)] sm:max-w-[95vw] p-0 flex flex-col"
        style={{ ["--lead-w" as string]: panelWidth ? `${panelWidth}px` : "28rem" } as React.CSSProperties}
        hideClose
      >
        {/* Drag handle on the left edge — grab to widen/narrow the panel (desktop). */}
        <div
          onMouseDown={startResize}
          className="hidden sm:block absolute inset-y-0 left-0 z-30 w-2 -ml-1 cursor-ew-resize group"
          title="Drag to resize"
          aria-hidden
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-hairline group-hover:bg-amber group-hover:w-1 transition-all" />
        </div>
        <SheetHeader className="!p-5 flex flex-row items-start justify-between gap-3 border-b border-hairline">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Lead detail</p>
            <SheetTitle className="text-xl mt-1">{lead.company}</SheetTitle>
            <SheetDescription className="text-xs mt-1">
              {lead.id} · Stage: <b className="text-ink">{stageLabel}</b>
            </SheetDescription>
          </div>
          <IconButton icon="x" aria-label="Close" onClick={onClose} />
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Contact action card — first thing in the drawer per research
              (Close.com / Folk pattern). Shows the rep's three primary
              reach-out actions as big tap targets + a GST badge for B2B
              context. Replaces the need to scroll for contact info. */}
          {(lead.contact_phone || lead.contact_email || lead.gstin) && (
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
              {/* Top row — contact name + GST badge if present */}
              <div className="flex items-center justify-between gap-2 mb-3 min-w-0">
                <div className="min-w-0 flex-1">
                  {lead.contact_name && (
                    <p className="font-medium text-ink text-sm truncate">{lead.contact_name}</p>
                  )}
                  {(lead.contact_phone || lead.contact_email) && (
                    <p className="text-[11px] text-ink-3 font-mono truncate">
                      {lead.contact_phone}
                      {lead.contact_phone && lead.contact_email && " · "}
                      {lead.contact_email}
                    </p>
                  )}
                </div>
                {lead.gstin && (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono font-semibold uppercase px-1.5 py-0.5 rounded bg-indigo-soft text-indigo-ink border border-indigo/20"
                    title="GST Identification Number"
                  >
                    GST {lead.gstin.slice(0, 2)}…
                  </span>
                )}
              </div>

              {/* Action row — Call / WhatsApp / Email as big buttons.
                  These are the rep's bread-and-butter — surface them
                  prominently so 1 tap = action, no scrolling needed. */}
              <div className="grid grid-cols-3 gap-2">
                {lead.contact_phone ? (
                  <a
                    href={`tel:${lead.contact_phone.replace(/\s+/g, "")}`}
                    className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper border border-hairline hover:bg-emerald-soft/40 text-emerald text-xs font-semibold transition-colors"
                  >
                    <Icon name="mobile" size={13} /> Call
                  </a>
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper-2 border border-hairline text-ink-3 text-xs">
                    <Icon name="mobile" size={13} /> —
                  </div>
                )}
                {lead.contact_phone ? (
                  (() => {
                    const phoneDigits = lead.contact_phone.replace(/\D/g, "");
                    const waNumber = phoneDigits.startsWith("91") ? phoneDigits : (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits);
                    const greeting = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
                    const ref = lead.plan ? `about ${lead.plan} for ${lead.company}` : `regarding ${lead.company}`;
                    const waMsg = `${greeting} Following up ${ref}. When's a good time for a quick call?`;
                    return (
                      <a
                        href={`https://wa.me/${waNumber}?text=${encodeURIComponent(waMsg)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                          e.preventDefault();
                          openWhatsApp(waNumber, waMsg);
                          logActivity.mutate({ leadId: lead.id, kind: "whatsapp", detail: `WhatsApp to ${lead.contact_phone}` });
                        }}
                        className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper border border-hairline hover:bg-emerald-soft/40 text-emerald text-xs font-semibold transition-colors"
                      >
                        <Icon name="whatsapp" size={13} /> WhatsApp
                      </a>
                    );
                  })()
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper-2 border border-hairline text-ink-3 text-xs">
                    <Icon name="whatsapp" size={13} /> —
                  </div>
                )}
                {lead.contact_email ? (
                  <a
                    href={`mailto:${lead.contact_email}`}
                    onClick={(e) => { e.preventDefault(); handleEmail(); }}
                    className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper border border-hairline hover:bg-indigo-50 text-indigo text-xs font-semibold transition-colors"
                  >
                    <Icon name="mail" size={13} /> Email
                  </a>
                ) : (
                  <div className="inline-flex items-center justify-center gap-1.5 py-2 rounded-md bg-paper-2 border border-hairline text-ink-3 text-xs">
                    <Icon name="mail" size={13} /> —
                  </div>
                )}
              </div>

              {/* Second action row — recording what happened, as opposed to the row above
                  which starts a conversation. Both matter: a call that is made and never
                  logged is invisible to the timeline, the stage-age badge and every
                  forecast built on them. */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    logActivity.mutate({ leadId: lead.id, kind: "call",
                      detail: `Call logged${lead.contact_phone ? ` · ${lead.contact_phone}` : ""}` });
                    toast.success("Call logged");
                  }}
                  title="Record a call you made elsewhere — from your phone, or before this lead existed here"
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-hairline bg-paper py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-2"
                >
                  <Icon name="mobile" size={13} /> Log call
                </button>
                <button
                  type="button"
                  onClick={handleSendQuote}
                  title="Open the quote builder with this lead's details. The stage moves when the quote actually exists."
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber/50 bg-amber-soft/40 py-2 text-xs font-semibold text-amber-ink transition-colors hover:bg-amber-soft/70"
                >
                  <Icon name="send" size={13} /> Generate quote
                </button>
              </div>

              {/* Note composer, inline rather than behind a dialog — a note nobody can
                  write in two seconds is a note nobody writes. */}
              <div className="flex items-start gap-2">
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  rows={2}
                  placeholder="Add a note — what was said, what they asked for…"
                  aria-label={`Add a note about ${lead.company}`}
                  className="min-w-0 flex-1 resize-y rounded-md border border-hairline bg-paper px-2 py-1.5 text-xs text-ink placeholder:text-ink-4 focus:border-amber focus:outline-none focus:ring-1 focus:ring-amber"
                />
                <button
                  type="button"
                  disabled={!noteDraft.trim()}
                  onClick={() => {
                    logActivity.mutate({ leadId: lead.id, kind: "note", detail: noteDraft.trim() });
                    setNoteDraft("");
                    toast.success("Note added");
                  }}
                  className={cn(
                    "shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors",
                    noteDraft.trim()
                      ? "border-hairline-strong bg-paper text-ink-2 hover:bg-paper-2"
                      : "cursor-not-allowed border-hairline text-ink-4",
                  )}
                >
                  Save
                </button>
              </div>

              {/* AI draft — the "what do I say?" moat. One tap = a Gemini-drafted
                  WhatsApp/email follow-up tailored to THIS lead (plan, seats,
                  stage, notes). Human-in-the-loop: the draft is editable and never
                  sends itself — the rep copies it or opens WhatsApp. Falls back to
                  a solid template if no Gemini key is set. */}
              {(lead.contact_phone || lead.contact_email) && (
                <AiDraftButton
                  leadId={lead.id}
                  channel={lead.contact_phone ? "whatsapp" : "email"}
                  purpose="followup"
                  phone={lead.contact_phone}
                  label="✨ Draft follow-up with AI"
                  variant="outline"
                  className="mt-2 w-full justify-center"
                />
              )}

              {/* Smart Next-Action CTA — surfaces THE one thing to do based on
                  lead state + quote age + payment status. Replaces decision
                  fatigue ("which of these 10 buttons?") with a single ranked
                  suggestion. Logic in `nextAction` above; color-coded by
                  urgency (rose = overdue, amber = pending, emerald = success,
                  indigo = informational). */}
              {/* When a quote already exists, surface the FULL status-aware quote
                  action bar right here (Record payment · Mark accepted · Mark
                  rejected · Open full quote) — the rep never has to leave the
                  drawer to move the quote forward. Falls back to the single smart
                  next-action CTA only when there's no quote yet. */}
              {latestQuoteForAction ? (
                <div className="mt-3 space-y-1.5">
                  <QuoteActionBar
                    quote={latestQuoteForAction}
                    onOpenFullQuote={() => { onClose(); router.push(`/quotes/${latestQuoteForAction.id}` as any); }}
                  />
                  {(() => {
                    const q = latestQuoteForAction;
                    const nothingReceivedYet =
                      !q.payment_status || q.payment_status === "none" || q.payment_status === "awaiting";
                    const unpaidSent =
                      (q.status === "sent" || q.status === "viewed") && nothingReceivedYet;
                    if (!unpaidSent) return null;
                    const overdue = quoteAgeDays !== null && quoteAgeDays > 7;
                    const ageText =
                      quoteAgeDays === null ? "" : quoteAgeDays === 0 ? "Sent today" : `Sent ${quoteAgeDays}d ago`;
                    return (
                      <p className="flex items-start gap-1 text-[11px] leading-snug text-ink-3">
                        <Icon name="info" size={11} className="mt-0.5 shrink-0" />
                        <span>
                          {ageText}
                          {overdue && <span className="text-rose font-medium"> · overdue — chase them</span>}
                          {ageText && ". "}
                          Record payment when it lands, or mark accepted to convert the lead into a customer now
                          (payment can follow). Chase via Call/WhatsApp above.
                        </span>
                      </p>
                    );
                  })()}
                </div>
              ) : nextAction ? (
                <>
                <button
                  type="button"
                  onClick={nextAction.onClick}
                  className={cn(
                    "mt-3 w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-semibold transition-colors",
                    nextAction.tone === "amber"   && "bg-amber text-white hover:bg-amber/90",
                    nextAction.tone === "rose"    && "bg-rose text-white hover:bg-rose/90",
                    nextAction.tone === "emerald" && "bg-emerald text-white hover:bg-emerald/90",
                    nextAction.tone === "indigo"  && "bg-indigo text-white hover:bg-indigo/90",
                  )}
                >
                  <Icon name={nextAction.icon} size={14} />
                  {nextAction.label}
                  {nextAction.hint && (
                    <span className="text-[11px] opacity-90 ml-1">
                      · {nextAction.hint}
                    </span>
                  )}
                </button>
                {nextAction.help && (
                  <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-ink-3">
                    <Icon name="info" size={11} className="mt-0.5 shrink-0" />
                    {nextAction.help}
                  </p>
                )}
                </>
              ) : null}
            </div>
          )}

          {/* Tabs — keep the ever-growing Activity log out of the main detail view */}
          <div className="flex gap-1 border-b border-hairline">
            {(["details", "followups", "activity"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setDrawerTab(t)}
                className={cn(
                  "px-3 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors",
                  drawerTab === t ? "border-amber text-amber-ink" : "border-transparent text-ink-3 hover:text-ink",
                )}
              >
                {t === "activity"
                  ? `Activity${activities.length ? ` (${activities.length})` : ""}`
                  : t === "followups"
                    ? `Follow-ups${openTasks.length ? ` (${openTasks.length})` : ""}`
                    : "Details"}
              </button>
            ))}
          </div>

          {drawerTab === "details" && (
          <>
          {/* Is this deal being WORKED well? Sits above the facts because the facts
              describe the customer and this describes what the rep has (not) done —
              and only the second one is actionable this minute. */}
          {health && <DealHealthCard health={health} onBookFollowUp={() => setAddTaskOpen(true)} />}

          {/* Objection handling. Next to health rather than buried in a menu: the moment
              a rep needs these words is the moment they are looking at this drawer with
              the customer still on the line. */}
          <button
            type="button"
            onClick={() => setCardsOpen(true)}
            /* Explicit name: the label is two nested spans, and a screen reader that
               concatenates them reads the example objections as the button's own words. */
            aria-label="Open objection battlecards"
            className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-paper-2/40 px-3 py-2.5 text-left hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
          >
            <Icon name="shield" size={15} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">Objection battlecards</span>
              <span className="block text-[11px] text-ink-3">
                &ldquo;Microsoft is cheaper&rdquo;, &ldquo;nobody has heard of Zoho&rdquo; — what to say.
              </span>
            </span>
            <Icon name="chevron-right" size={14} className="shrink-0 text-ink-3" />
          </button>

          {/* Grid of facts */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Fact label="Plan" value={lead.plan} />
            <Fact label="Seats" value={lead.seats?.toString()} mono />
            <Fact label="Deal value" value={lead.value ? rupee(lead.value) : "—"} big />
            {/* Gross margin, from the catalogue's real vendor cost. Shown even when it
                cannot be worked out, with the REASON — "unknown" is a fact the rep can
                act on ("this plan has no catalogue row"), whereas a hidden field is a
                question nobody knows to ask. */}
            {(() => {
              const m = dealMargin(lead, drawerPlanCosts);
              const b = marginBadge(m);
              return (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-ink-3">Gross margin</p>
                  <p
                    title={b.title}
                    className={cn(
                      "mt-0.5 font-serif text-[17px] font-semibold",
                      b.kind === "danger"  && "text-rose",
                      b.kind === "warning" && "text-amber-ink",
                      b.kind === "success" && "text-emerald",
                      b.kind === "muted"   && "text-ink-3",
                    )}
                  >
                    {b.label}
                    {m.grossAnnual !== null && (
                      <span className="ml-1.5 font-sans text-xs font-normal text-ink-3">
                        {rupee(m.grossAnnual)}/yr
                      </span>
                    )}
                  </p>
                  {m.band === "loss" && (
                    <p className="mt-0.5 text-[11px] font-semibold leading-snug text-rose">
                      Below the vendor&apos;s own cost — reprice before quoting.
                    </p>
                  )}
                  {m.band === "unknown" && (
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-3">{b.title}</p>
                  )}
                </div>
              );
            })()}
            <Fact label="Source" value={lead.source} mono />
            <Fact label="New / switching" value={lead.subscription_type === "fresh" ? "Fresh subscription" : lead.subscription_type === "switch" ? "Switching vendor" : "—"} />
            <Fact label="Contact name" value={lead.contact_name} />
            <Fact label="Email" value={lead.contact_email} mono />
            <Fact label="Phone" value={lead.contact_phone} mono />
            <Fact label="Created" value={formatDate(lead.created_at)} />
          </div>

          {/* Recent communication — surfaced right here on the main Details view
              (not hidden in the Activity tab) so every call / WhatsApp / email /
              inbound reply is visible the moment you open the lead. Shows the
              latest 3; "See all" opens the full timeline. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Recent communication</div>
              {activities.length > 3 && (
                <button
                  type="button"
                  onClick={() => setDrawerTab("activity")}
                  className="text-[11px] font-medium text-amber-ink hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
                >
                  See all ({activities.length})
                </button>
              )}
            </div>
            {activities.length === 0 ? (
              <div className="text-sm text-ink-3 italic p-3 bg-paper-2 rounded-md">
                No communication yet. Call / WhatsApp / Email from here — it logs automatically.
              </div>
            ) : (
              <ul className="space-y-2">
                {[...activities]
                  .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
                  .slice(0, 3)
                  .map((a) => {
                    const meta = ACTIVITY_META[a.kind] ?? { icon: "clock" as const, label: a.kind };
                    return (
                      <li key={a.id} className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                          <Icon name={meta.icon} size={12} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-ink truncate">{a.detail || meta.label}</div>
                          <div className="text-[11px] text-ink-3">
                            {meta.label} · {formatDate(a.created_at)} {fmtActTime(a.created_at)}
                          </div>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>

          {/* Notes */}
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Notes</div>
            <div className="text-sm text-ink-2 whitespace-pre-wrap p-3 bg-paper-2 rounded-md min-h-[80px]">
              {lead.notes || <span className="italic text-ink-3">No notes yet.</span>}
            </div>
          </div>
          </>
          )}

          {/* Activity timeline — outbound touches + inbound emails — its own tab */}
          {drawerTab === "activity" && (
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">
              Everything that has happened
            </div>
            {/* One stream, not three lists. The drawer already loaded activities, quotes
                and tasks; showing them separately made the rep do the interleaving in
                their head, and get it wrong — each list sorts alone, so a quote sent on
                the 3rd rendered above a call made on the 5th. */}
            {timeline.entries.length === 0 ? (
              <div className="text-sm text-ink-3 italic p-3 bg-paper-2 rounded-md">
                Nothing recorded yet. Calls, WhatsApps, quotes, tasks and payments all
                appear here once they happen.
              </div>
            ) : (
              <ul className="space-y-2">
                {timeline.entries.map((e) => {
                  const meta = timelineMeta(e);
                  return (
                    <li key={e.id} className="flex items-start gap-2.5">
                      <div className={cn(
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2",
                        meta.tone,
                      )}>
                        <Icon name={meta.icon} size={12} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm text-ink">{e.title}</span>
                          {typeof e.amount === "number" && e.amount > 0 && (
                            <span className="shrink-0 font-mono text-xs font-semibold text-ink-2">
                              {rupee(e.amount)}
                            </span>
                          )}
                        </div>
                        {e.detail && <div className="truncate text-xs text-ink-2">{e.detail}</div>}
                        <div className="text-[11px] text-ink-3">
                          {formatDate(e.at)} {fmtActTime(e.at)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* The gap, stated. An entry with no usable date is dropped rather than
                placed at a guessed position — a wrongly-ordered event invents a history
                that never happened. */}
            {timeline.undated > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                {timeline.undated} record{timeline.undated === 1 ? " has" : "s have"} no
                usable date and {timeline.undated === 1 ? "is" : "are"} not shown — placing
                {timeline.undated === 1 ? " it" : " them"} anywhere in this list would
                invent an order that never happened.
              </p>
            )}
          </div>
          )}

          {drawerTab === "details" && (
          <>
          {/* ── Quotes history (only when this lead has received at least one quote) ── */}
          {hasQuotes && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                  Quotes ({quotesForLead.length})
                </div>
              </div>
              <div className="rounded-md border border-hairline divide-y divide-hairline overflow-hidden">
                {quotesForLead.map((q) => {
                  const statusKind: "muted" | "warning" | "success" | "info" | "danger" =
                    q.status === "draft"    ? "muted" :
                    q.status === "sent"     ? "warning" :
                    q.status === "viewed"   ? "info" :
                    q.status === "accepted" ? "success" :
                    "danger";
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => {
                        onClose();
                        router.push(`/quotes/${q.id}` as any);
                      }}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-paper-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-ink truncate">
                            {q.id}
                          </span>
                          <Badge kind={statusKind} dot>{q.status}</Badge>
                        </div>
                        <div className="text-[11px] text-ink-3 mt-0.5">
                          {formatDate(q.created_at)} · {q.line_items && Array.isArray(q.line_items) ? q.line_items.length : 0} item
                          {Array.isArray(q.line_items) && q.line_items.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-serif text-sm tabular-nums text-ink">
                          {rupee(q.amount ?? 0)}
                        </div>
                        <Icon name="arrow_right" size={11} className="text-ink-3 ml-auto" />
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-ink-3 mt-1.5 flex items-center gap-1">
                <Icon name="info" size={11} />
                {lead.stage === "won"
                  ? "Click any quote to view · upsell with a new quote below"
                  : lead.stage === "lost"
                  ? "Click any quote to view · re-engage with a fresh quote below"
                  : latestQuote?.status === "draft"
                  ? "Click the draft to review & send it below"
                  : "Click any quote to view · or send a revised quote below"}
              </p>
            </div>
          )}
          </>
          )}

          {/* ── Follow-ups — its own tab ────────────────────────────────
              Sales rep talks to the lead → captures next-action with date.
              List is split: open (pending/snoozed) shown prominently, done
              tucked away as a collapsed audit trail. Overdue rows tinted
              rose so they pull the eye. */}
          {drawerTab === "followups" && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold inline-flex items-center gap-2">
                <Icon name="clock" size={12} />
                Follow-ups
                {openTasks.length > 0 && (
                  <span className="text-[10px] tabular-nums bg-amber-soft text-amber-ink px-1.5 py-0.5 rounded-full">
                    {openTasks.length} open
                  </span>
                )}
              </div>
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddTaskOpen(true)}>
                Add
              </Button>
            </div>

            {openTasks.length === 0 && doneTasks.length === 0 ? (
              <p className="text-[12px] text-ink-3 italic">
                No follow-ups scheduled. Click <b>+ Add</b> to set a reminder.
              </p>
            ) : (
              <div className="space-y-1.5">
                {openTasks.map((t) => {
                  const due = new Date(t.due_at);
                  const isOverdue = due.getTime() < Date.now();
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "rounded-md border px-3 py-2 text-sm flex items-start gap-2",
                        isOverdue
                          ? "border-rose/40 bg-rose-soft/40"
                          : "border-hairline bg-paper-2/30",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => completeTask.mutate(t.id)}
                        className="mt-0.5 w-4 h-4 rounded-full border border-hairline-strong hover:bg-emerald hover:border-emerald transition-colors shrink-0"
                        title="Mark done"
                        aria-label="Mark done"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-ink leading-tight">{t.title}</p>
                        <p className={cn(
                          "text-[11px] mt-0.5 tabular-nums",
                          isOverdue ? "text-rose font-medium" : "text-ink-3",
                        )}>
                          {isOverdue ? "Overdue · " : ""}
                          {due.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          {t.snooze_count > 0 && ` · snoozed ${t.snooze_count}×`}
                        </p>
                        {t.notes && (
                          <p className="text-[11px] text-ink-3 mt-1 line-clamp-2">{t.notes}</p>
                        )}
                      </div>
                      <div className="flex gap-0.5 shrink-0">
                        <IconButton
                          icon="clock"
                          size="sm"
                          variant="ghost"
                          aria-label="Snooze 1 day"
                          title="Snooze 1 day"
                          onClick={() => snoozeTask.mutate({ id: t.id })}
                        />
                        <IconButton
                          icon="trash"
                          size="sm"
                          variant="ghost"
                          aria-label="Delete task"
                          title="Delete task"
                          onClick={() => deleteTask.mutate(t.id)}
                        />
                      </div>
                    </div>
                  );
                })}
                {doneTasks.length > 0 && (
                  <details className="text-[11px] text-ink-3 mt-2">
                    <summary className="cursor-pointer select-none hover:text-ink">
                      {doneTasks.length} completed
                    </summary>
                    <ul className="mt-1.5 space-y-1 pl-3">
                      {doneTasks.map((t) => (
                        <li key={t.id} className="line-through opacity-70">
                          {t.title} ·{" "}
                          {t.completed_at &&
                            new Date(t.completed_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
          )}

          {drawerTab === "details" && (
          <>
          {/* Quick stage change
              For a raw lead (no plan picked yet), only "new" / "contact" are
              logically valid — demo/trial/quote/won all require a plan to
              make sense. Show only the relevant chips + a hint to qualify
              first if the user wants to progress further. */}
          {(() => {
            // Quote-first funnel: pre-quote leads (new/contact) can only stay
            // pre-quote or be Lost — Demo/Trial/Won unlock only after a quote is
            // sent. Post-quote deals get the deal-stage chips (no going back to
            // the inbox stages).
            const isPreQuote = lead.stage === "new" || lead.stage === "contact";
            const visibleStages = isPreQuote
              ? LEAD_STAGES.filter((s) => s.id === "new" || s.id === "contact" || s.id === "lost")
              : LEAD_STAGES.filter((s) => s.id !== "new" && s.id !== "contact");
            return (
              <div>
                <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Move to stage</div>
                <div className="flex flex-wrap gap-1.5">
                  {visibleStages.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        if (s.id !== lead.stage) {
                          void changeStage(lead, s.id);
                          toast.success(`${lead.company} → ${s.label}`);
                          onClose();
                        }
                      }}
                      disabled={s.id === lead.stage}
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-full border transition-colors",
                        s.id === lead.stage
                          ? "bg-amber-soft border-amber text-amber-ink font-medium cursor-default"
                          : "border-hairline text-ink-2 hover:bg-paper-2"
                      )}
                    >
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1.5", s.dot)} />
                      {s.label}
                    </button>
                  ))}
                </div>
                {isPreQuote && (() => {
                  /* ── The three gates out of the raw inbox ──────────────────
                     Placed HERE, immediately above the button that sends the
                     quote, because that is the moment the answer matters. On a
                     tab of its own it would be a report; here it is the thing
                     the rep reads before deciding whether to spend an hour on
                     a proposal.

                     Derived from the row (lib/leads/qualification.ts, 19 tests),
                     never ticked — a checkbox that disagreed with the data under
                     it would be the one the rep believed. Nothing is BLOCKED: a
                     rep who knows better than the data can still send. Refusing
                     would just teach them to fake a phone number to get past it. */
                  const q = qualification(lead);
                  return (
                    <div className={cn(
                      "mt-3 rounded-md border px-3 py-2",
                      q.qualified ? "border-emerald/40 bg-emerald-soft" : "border-hairline bg-paper-2/60",
                    )}>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                        Ready to quote · {q.passedCount} of 3
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {q.checks.map((c) => (
                          <li key={c.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                            <span aria-hidden className={c.passed ? "text-emerald" : "text-ink-3"}>
                              {c.passed ? "✓" : "○"}
                            </span>
                            <span className={c.passed ? "text-ink-2" : "text-ink-3"}>
                              {c.passed ? c.label : c.missing}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
                {isPreQuote && (
                  // Quote-first funnel: the only way forward from a pre-quote
                  // lead is to send a quote — that moves it into Deals and
                  // unlocks Demo / Trial / Won. One click starts the quote.
                  <button
                    type="button"
                    onClick={handleSendQuote}
                    className={cn(
                      "mt-3 w-full text-left text-xs px-3 py-2 rounded-md",
                      "bg-amber-soft hover:bg-amber/15 border border-amber/40",
                      "text-amber-ink font-medium",
                      "inline-flex items-center justify-between gap-2 transition-colors",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="send" size={13} />
                      Send a quote to move into Deals · unlocks Demo / Trial / Won
                    </span>
                    <Icon name="arrow_right" size={13} />
                  </button>
                )}
              </div>
            );
          })()}
          </>
          )}
        </div>

        <SheetFooter className="!p-4 border-t border-hairline !flex-col !items-stretch gap-2">
          {/* Secondary row — edit / archive / delete */}
          <div className="flex justify-between items-center gap-2">
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                icon="edit"
                onClick={() => onEdit(lead)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleArchive}
              >
                Archive
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={handleDelete}
              loading={deleteLead.isPending}
              className="!text-rose hover:!bg-rose/10"
            >
              Delete
            </Button>
          </div>

          {/* Primary row — communication actions
              Stage-aware so the primary CTA always reflects the actual next
              step a sales person would take with this lead. Call button
              is first because that's the most common mobile action. */}
          <div className="flex justify-end gap-2 pt-2 border-t border-hairline flex-wrap">
            {lead.contact_phone && (
              <Button
                icon="mobile"
                onClick={() => { window.location.href = `tel:${lead.contact_phone}`; }}
                title="Native dialer"
              >
                Call
              </Button>
            )}
            <Button icon="mail" onClick={handleEmail}>Email</Button>
            {lead.contact_phone && (
              <Button
                icon="whatsapp"
                onClick={() => setWhatsOpen(true)}
                title="Send a WhatsApp message via Meta Cloud API"
              >
                WhatsApp
              </Button>
            )}

            {lead.stage === "won" ? (
              <>
                {/* Deal done — money flowed, customer record was auto-created
                    during record_payment. Natural next moves are upsell (a
                    fresh quote tied back to this lead) or open the customer
                    record / accepted quote for context. */}
                <Button icon="send" onClick={handleSendQuote}>
                  Upsell · New quote
                </Button>
                {latestQuote && (
                  <Button
                    variant="primary"
                    icon="receipt"
                    onClick={() => {
                      onClose();
                      router.push(`/quotes/${latestQuote.id}` as any);
                    }}
                  >
                    Open accepted quote
                  </Button>
                )}
              </>
            ) : lead.stage === "lost" ? (
              <>
                {/* Deal lost — only sensible action is to re-engage with a
                    fresh quote (potentially with different pricing). The
                    earlier "revise" of a rejected quote rarely lands. */}
                <Button variant="primary" icon="send" onClick={handleSendQuote}>
                  Re-engage · Send new quote
                </Button>
              </>
            ) : hasQuotes ? (
              latestQuote?.status === "draft" ? (
                /* Draft quote never sent → the one action is to open & send it. */
                <Button
                  variant="primary"
                  icon="send"
                  onClick={() => { onClose(); router.push(`/quotes/${latestQuote.id}` as any); }}
                >
                  Send draft quote
                </Button>
              ) : (
                <>
                  <Button icon="send" onClick={handleSendQuote}>
                    New quote
                  </Button>
                  <Button variant="primary" icon="copy" onClick={handleReviseQuote}>
                    Revise & resend
                  </Button>
                </>
              )
            ) : (
              <Button variant="primary" icon="send" onClick={handleSendQuote}>
                Send Quote
              </Button>
            )}
          </div>
        </SheetFooter>
      </SheetContent>

      {/* Add Follow-up dialog — mounted as a sibling of the Sheet so its
          own modal stacking doesn't fight the drawer. */}
      <AddTaskDialog
        open={addTaskOpen}
        onOpenChange={setAddTaskOpen}
        linkLabel={lead.company}
        linkTo={{ lead_id: lead.id }}
      />

      {/* Send-via-WhatsApp — pre-fills contact phone and an opening line
          using the lead's plan/seats context. */}
      {whatsOpen && lead.contact_phone && (
        <SendWhatsAppDialog
          open={whatsOpen}
          onOpenChange={setWhatsOpen}
          defaultTo={lead.contact_phone}
          defaultText={
            `Hi ${lead.contact_name ?? "there"},\n\n` +
            `Thanks for your interest in ${lead.plan ?? "our cloud services"}` +
            (lead.seats ? ` for ${lead.seats} users.` : ".") +
            `\n\nLet me know if you'd like to schedule a quick call or get a tailored quote.\n\n` +
            `— ${currentUser?.tenantName ?? "your team"}`
          }
          title={`WhatsApp · ${lead.company}`}
          related={{ leadId: lead.id }}
        />
      )}

      {/* Battlecards — sibling of the Sheet for the same stacking reason. */}
      <BattlecardDrawer open={cardsOpen} onClose={() => setCardsOpen(false)} plan={lead.plan} />
    </Sheet>
  );
}

// ============================================================
// RowActions — the sticky trailing cell for a lead row. A persistent ⋯ that
// opens a clean, LABELLED action menu (coloured icon + name), so every action
// is unambiguous — no colour-guessing, the two green actions read clearly as
// "Call" vs "WhatsApp". Radix renders it in a portal, so it's never clipped by
// the cell (which is why the old hover-slide panel needed a JS hover-intent).
// ============================================================
function RowActions({
  lead, isSelected, onSendQuote, onFollowUp, onWhatsApp,
}: {
  lead: Lead;
  isSelected: boolean;
  onSendQuote: (l: Lead) => void;
  onFollowUp: (l: Lead) => void;
  onWhatsApp?: (l: Lead) => void;
}) {
  const phoneDigits = (lead.contact_phone ?? "").replace(/\D/g, "");
  const waNumber = phoneDigits.startsWith("91")
    ? phoneDigits
    : (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits);
  const hasPhone = phoneDigits.length >= 10;
  const hasEmail = Boolean(lead.contact_email);
  const logActivity = useLogLeadActivity();
  const setJunk = useSetLeadJunk();
  const [junkOpen, setJunkOpen] = React.useState(false);

  const itemCls = "gap-2.5 py-2 cursor-pointer";
  // Primary quick actions inline (Call · WhatsApp · Quote) — ALWAYS fully visible
  // (not faint / hover-only) so they read as tappable buttons at a glance and stay
  // reachable on touch tablets (no hover). Each has a subtle bordered chip so the
  // hit-area is obvious; colour brightens on hover.
  const iconBtn = "flex h-7 w-7 items-center justify-center rounded-md border border-hairline bg-paper text-ink-2 transition-colors hover:bg-paper-2 hover:border-hairline-strong";

  return (
    <td
      className={cn("p-2", isSelected ? "bg-amber-soft" : "")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-end gap-0.5">
        {hasPhone && (
          <a
            href={`tel:${lead.contact_phone}`}
            title={`Call ${lead.contact_phone}`}
            aria-label={`Call ${lead.company}`}
            className={cn(iconBtn, "hover:text-emerald")}
            onClick={() => logActivity.mutate({ leadId: lead.id, kind: "call", detail: `Called ${lead.contact_phone}` })}
          >
            <Icon name="call" size={16} />
          </a>
        )}
        {hasPhone && (
          <button
            type="button"
            title="WhatsApp"
            aria-label={`WhatsApp ${lead.company}`}
            className={cn(iconBtn, "hover:text-emerald")}
            onClick={() => {
              if (onWhatsApp) {
                onWhatsApp(lead);
              } else {
                openWhatsApp(waNumber);
              }
              logActivity.mutate({ leadId: lead.id, kind: "whatsapp", detail: `WhatsApp to ${lead.contact_phone}` });
            }}
          >
            <Icon name="whatsapp" size={16} />
          </button>
        )}
        <button
          type="button"
          title="Send quote"
          aria-label={`Send quote to ${lead.company}`}
          className={cn(iconBtn, "hover:text-amber")}
          onClick={() => onSendQuote(lead)}
        >
          <Icon name="quote" size={16} />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
            >
              <Icon name="more_h" size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[13rem]">
            <DropdownMenuLabel>More actions</DropdownMenuLabel>
            <DropdownMenuItem className={itemCls} onClick={() => onFollowUp(lead)}>
            <Icon name="reminder" size={20} /> Schedule follow-up
          </DropdownMenuItem>
          <DropdownMenuItem
            className={itemCls}
            onClick={() => {
              const url  = `${window.location.origin}/enquiry`;
              const hi   = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
              const text =
                `${hi}\n\n` +
                `Thanks for your interest. To prepare an accurate quote, please fill this short 1-minute form with your requirement (product, number of users, and any notes):\n\n` +
                `${url}\n\n` +
                `Once you submit it, we'll review and send you a price quote with GST. Thank you!`;
              if (hasPhone) {
                // wa.me/<number>?text= reliably opens THIS number's chat (desktop
                // app OR web) with the link pre-filled — not the "new chat" picker.
                window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
              } else if (hasEmail) {
                window.location.href = `mailto:${encodeURIComponent(lead.contact_email ?? "")}?subject=${encodeURIComponent("Please share your requirement for a quote")}&body=${encodeURIComponent(text)}`;
              }
              logActivity.mutate({ leadId: lead.id, kind: "email", detail: "Sent enquiry form link" });
            }}
          >
            <Icon name="link" size={20} /> Send enquiry form
          </DropdownMenuItem>

          {hasEmail && <DropdownMenuSeparator />}
          {hasEmail && (
            <DropdownMenuItem asChild className={itemCls}>
              <a
                href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email ?? "")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => logActivity.mutate({ leadId: lead.id, kind: "email", detail: `Emailed ${lead.contact_email}` })}
              >
                <Icon name="email" size={20} /> Email
                <span className="ml-auto max-w-[9rem] truncate text-[11px] text-ink-3">{lead.contact_email}</span>
              </a>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {lead.is_junk ? (
            <DropdownMenuItem className={itemCls} onClick={() => setJunk.mutate({ ids: [lead.id], isJunk: false })}>
              <Icon name="check_circle" size={20} /> Restore from junk
            </DropdownMenuItem>
          ) : (
            /* Opens the dialog instead of binning on the click. One tap is faster and
               it throws away the only fact that makes the decision reversible — see
               MarkJunkDialog. */
            <DropdownMenuItem className={cn(itemCls, "text-rose")} onClick={() => setJunkOpen(true)}>
              <Icon name="alert" size={20} /> Mark as junk…
            </DropdownMenuItem>
          )}
          </DropdownMenuContent>
        </DropdownMenu>

        <MarkJunkDialog
          open={junkOpen}
          onOpenChange={setJunkOpen}
          leadName={lead.company}
          busy={setJunk.isPending}
          onConfirm={({ reasonId, note }) => {
            setJunk.mutate({ ids: [lead.id], isJunk: true, reason: reasonId, note });
            setJunkOpen(false);
          }}
        />
      </div>
    </td>
  );
}

// ============================================================
// LeadListView — table view for scanning leads at scale (50+).
// Same data source + same row-click drawer as Kanban; just a different lens.
// ============================================================

type SortCol = "created" | "value" | "company" | "stage" | "age";

const STAGE_DOT: Record<Lead["stage"], string> = {
  new:     "bg-slate",
  contact: "bg-amber",
  demo:    "bg-indigo",
  trial:   "bg-rose",
  quote:   "bg-indigo",
  won:     "bg-emerald",
  lost:    "bg-ink-3",
};
const STAGE_LABEL: Record<Lead["stage"], string> = {
  new: "New", contact: "Contacted", demo: "Demo Done", trial: "Trial Active",
  quote: "Quote Sent", won: "Won", lost: "Lost",
};

/** Days since `updated_at`. >14 means stale. */
function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// Spreadsheet mode: Stage / Value / Priority / Follow-up are all editable in
// place, so the four fields a rep changes most never need the drawer. Widths
// still sum to 100% — Contact and Plan gave up room for the two new columns
// rather than introducing a horizontal scrollbar.
const LEADLIST_COL_ORDER = ["select", "company", "stage", "contact", "plan", "value", "priority", "followup", "closedate", "lastupdate", "actions"];
const LEADLIST_COL_WIDTHS: Record<string, string> = {
  select: "3%", company: "18%", stage: "10%", contact: "14%", plan: "11%",
  value: "9%", priority: "7%", followup: "8%", closedate: "9%", lastupdate: "7%", actions: "9%",
};

function LeadListView({
  leads,
  sortBy,
  sortDir,
  onSort,
  onRowClick,
  onSendQuote,
  onFollowUp,
  onWhatsApp,
  onMerge,
  dupIds,
}: {
  leads: Lead[];
  sortBy: SortCol;
  sortDir: "asc" | "desc";
  onSort: (col: SortCol) => void;
  onRowClick: (l: Lead) => void;
  onSendQuote: (l: Lead) => void;
  onFollowUp: (l: Lead) => void;
  onWhatsApp?: (l: Lead) => void;
  onMerge: (l: Lead) => void;
  dupIds: Set<string>;
}) {
  /* Stage options now come from the LEAD, not from the page — rowStageOptions() in
     lib/leads/stage-options.ts (17 tests), which is where the quote-first gate and the
     reason for it are written down. Choosing by page was correct while /leads and /deals
     held two halves of the pipeline; after the merge it rendered a `won` deal inside a
     select of new/contact/lost, and the browser showed the first option. */
  // Stage-mutation hook for quick-change chips on cards. Tapping the stage
  // badge on a mobile card opens a dropdown to flip the stage without
  // needing to open the full detail drawer.
  const { changeStage, changeStageBulk } = useChangeLeadStage();
  // quiet: the saved value is visible in the cell itself, so a toast per edit
  // would just be noise while working down a 50-row list.
  const updateLead = useUpdateLead({ quiet: true });
  const deleteLead  = useDeleteLead();
  const setJunkBulk = useSetLeadJunk();
  /* Same entry point the call queue uses, so the mobile card's chips and swipes behave
     identically to the queue's. Declared here rather than threaded down as a prop — the
     rules live in lib/leads/outcomes.ts, so there is nothing for two call sites to
     disagree about. */
  const runOutcome  = useLeadOutcome();

  /* Catalog costs for the margin pill. Built once per render of the whole list rather
     than per row — the index is a Map over ~19 products, and rebuilding it 200 times
     would be the kind of quiet waste nobody profiles until the list is long. */
  const { data: catalogItems } = useItems();
  const planCosts = React.useMemo(
    () => buildPlanCostIndex(catalogItems ?? []),
    [catalogItems],
  );

  // Open follow-up tasks per lead — surfaced as a chip on the row so the rep
  // sees at a glance which leads have a pending task (earliest/most-overdue).
  const { data: allTasks = [] } = useTasks("all");
  const openTaskByLead = React.useMemo(() => {
    const m = new Map<string, { due: string; overdue: boolean; count: number }>();
    const now = Date.now();
    for (const t of allTasks) {
      if (!t.lead_id || (t.status !== "pending" && t.status !== "snoozed")) continue;
      const prev = m.get(t.lead_id);
      if (!prev) m.set(t.lead_id, { due: t.due_at, overdue: new Date(t.due_at).getTime() < now, count: 1 });
      else {
        prev.count += 1;
        if (new Date(t.due_at).getTime() < new Date(prev.due).getTime()) {
          prev.due = t.due_at; prev.overdue = new Date(t.due_at).getTime() < now;
        }
      }
    }
    return m;
  }, [allTasks]);

  // Bulk-select state — desktop power-table only. A Set of lead IDs makes
  // toggle / has() / size O(1). Resets on the leads array changing
  // identity (e.g. after a refetch) to avoid keeping stale IDs.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  /** Bulk-mutate stage on all selected leads. Routed through changeStageBulk so
   *  a bulk move to Lost asks for the reason ONCE, not once per row. */
  const bulkChangeStage = async (stage: Lead["stage"]) => {
    const picked = sorted.filter((l) => selectedIds.has(l.id));
    try {
      const moved = await changeStageBulk(picked, stage);
      if (moved === 0) return;                      // dismissed, or nothing to do
      toast.success(`Moved ${moved} lead${moved === 1 ? "" : "s"} to ${STAGE_LABEL[stage]}`);
    } catch {
      toast.error("Some leads failed to update");
    }
    clearSelection();
  };

  /** Bulk-delete selected leads. The LeadsBulkBar already has a two-step
   *  confirm, so we proceed without an additional prompt. */
  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    try {
      await Promise.all(ids.map((id) => deleteLead.mutateAsync(id)));
      toast.success(`Deleted ${ids.length} lead${ids.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Some leads failed to delete");
    }
    clearSelection();
  };

  /** Bulk-mark selected leads as junk — one update, they leave the working views. */
  const bulkMarkJunk = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try { await setJunkBulk.mutateAsync({ ids, isJunk: true }); } catch { /* hook toasts */ }
    clearSelection();
  };
  // Apply sort (memo so we don't resort on every render).
  // Pre-sort layer (always wins): leads with follow_up_date <= today get
  // hoisted to the top regardless of the user's chosen column sort. Within
  // that group, overdue (older follow_up_date) comes first. After due-today,
  // the user's sort applies normally. This makes the "morning worklist"
  // mental model match the visual order without a separate filter.
  const sorted = React.useMemo(() => {
    const out = [...leads];
    const dir = sortDir === "asc" ? 1 : -1;
    // Sort strictly by the chosen column — default is "created" desc, so the
    // newest lead is always on top. (Due/overdue follow-ups are surfaced by the
    // banner + the Today/Overdue filter chips, so we don't secretly re-pin them
    // here — a sortable table should obey its sort.)
    out.sort((a, b) => {
      switch (sortBy) {
        case "value":   return ((a.value ?? 0) - (b.value ?? 0)) * dir;
        case "company": return a.company.localeCompare(b.company) * dir;
        case "stage":   return a.stage.localeCompare(b.stage) * dir;
        case "age":     return (daysSince(a.updated_at) - daysSince(b.updated_at)) * dir;
        case "created":
        default:        return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
      }
    });
    return out;
  }, [leads, sortBy, sortDir]);

  // NOTE: buildWaMessage / followUpLabel / priorityDot helpers used to live
  // here for the inline mobile card. They've been lifted into SwipeLeadCard
  // (the new component handles its own formatting). Desktop / tablet table
  // doesn't need them so they're gone from this file.

  const SortHeader = ({ col, label, align = "left" }: { col: SortCol; label: string; align?: "left" | "right" }) => (
    <th
      onClick={() => onSort(col)}
      className={cn(
        "sticky top-0 z-10 bg-paper-2 p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider cursor-pointer select-none hover:text-ink",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortBy === col && (
          <Icon name={sortDir === "asc" ? "chevron_up" : "chevron_down"} size={11} />
        )}
      </span>
    </th>
  );

  return (
    <>
    {/* Adaptive card list — viewports < 1280px */}
    <ul className="xl:hidden space-y-3 pb-2">
      {sorted.map((lead) => {
        // `stale` used to be computed here on a >14-day rule and passed in. The
        // card now derives it from lib/leads/heat itself, so phone and desktop
        // can't disagree — see SwipeLeadCard.
        return (
          <SwipeLeadCard
            key={lead.id}
            lead={lead}
            task={openTaskByLead.get(lead.id)}
            onTap={onRowClick}
            onChangeStage={(s) => void changeStage(lead, s)}
            onSendQuote={onSendQuote}
            onOutcome={(o, l) => { void runOutcome(o, l); }}
          />
        );
      })}
      {sorted.length === 0 && (
        <li className="py-8 text-center text-sm text-ink-3">No leads match.</li>
      )}
    </ul>
    {/* ─── End of mobile list — old inline card markup retired ─── */}

    {/* Desktop / tablet power table — viewports >= 1280px */}
    <div className="hidden xl:block w-full max-w-full border border-hairline rounded-md overflow-auto bg-paper flex-1 min-h-0">
      {/* Fluid percentage columns — the table fills the container width with no
          horizontal scrollbar at desktop widths. */}
      <table className="w-full table-fixed">
        <colgroup>
          {LEADLIST_COL_ORDER.map((id) => <col key={id} style={{ width: LEADLIST_COL_WIDTHS[id] }} />)}
        </colgroup>
        <thead className="bg-paper-2 border-b border-hairline">
          <tr>
            {/* Select-all checkbox — checked when every row is selected,
                indeterminate when only some are. */}
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2">
              <input
                type="checkbox"
                aria-label="Select all leads"
                checked={sorted.length > 0 && selectedIds.size === sorted.length}
                ref={(el) => {
                  if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < sorted.length;
                }}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(sorted.map((l) => l.id)));
                  else clearSelection();
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 accent-amber cursor-pointer"
              />
            </th>
            <SortHeader col="company" label="Company" />
            <SortHeader col="stage" label="Stage" />
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left">Contact</th>
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left">Plan</th>
            <SortHeader col="value" label="Value" align="right" />
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left">Priority</th>
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left">Follow-up</th>
            {/* Close date is a SEPARATE column from Follow-up, not a rename of it. A deal
                can be followed up weekly for two months and still be expected to close in
                March; one column for both makes both unreadable. */}
            <th
              className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-left"
              title="When the rep expects this deal to close. Drives the weighted forecast."
            >
              Close date
            </th>
            <SortHeader col="age" label="Last update" />
            {/* Actions column — quick action icons on row hover. */}
            <th className="sticky top-0 z-10 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-right">
              <span className="sr-only">Quick actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead) => {
            const age         = daysSince(lead.updated_at);
            const isSelected  = selectedIds.has(lead.id);
            // Heat → visual hierarchy. High-value (big money) wins the emerald
            // treatment; else a hot lead (priority high OR late-funnel stage)
            // gets a rose accent. Same isHotLead/isHighValueLead helpers drive
            // the Hot chip + filter, so counts and tags never disagree.
            const isHighValue = isHighValueLead(lead);
            const isHot       = isHotLead(lead);
            // Intent tier (Hot / Warm / Cold) + the stale nudge. Both come from
            // lib/leads/heat so the badge, the warning and the smart-view chips
            // can never disagree about the same lead.
            const intent = intentMeta(lead);
            const stale7 = staleWarning(lead);
            const railCls     = isHighValue ? "border-l-2 border-emerald"
                              : isHot       ? "border-l-2 border-rose"
                              :               "border-l-2 border-transparent";
            const isDup       = dupIds.has(lead.id);
            // Phone/email affordances now live inside <RowActions/>.
            return (
              <tr
                key={lead.id}
                data-lead-id={lead.id}
                onClick={() => onRowClick(lead)}
                tabIndex={0}
                aria-label={`Open ${lead.company}`}
                onKeyDown={(e) => {
                  // Keyboard parity with the mouse row-click (WCAG AA). Ignore
                  // when focus is on an inner control (checkbox / stage select /
                  // action link) so their own keys aren't hijacked.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onRowClick(lead);
                  }
                }}
                className={cn(
                  "border-b border-hairline last:border-0 cursor-pointer transition-colors group",
                  // Selected rows pick up the brand accent. Hover state
                  // layered on top so it still reacts to mouse-over.
                  isSelected
                    ? "bg-amber-soft/60 hover:bg-amber-soft"
                    : "hover:bg-paper-2/40",
                )}
              >
                <td className={cn("p-3", railCls)} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${lead.company}`}
                    checked={isSelected}
                    onChange={() => toggleId(lead.id)}
                    className="w-4 h-4 accent-amber cursor-pointer"
                  />
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    {/* The stale signal now rides as a labelled badge next to the
                        company name (with the day count), so this second, unlabelled
                        rose dot on its own >14-day rule is gone. */}
                    {isHighValue ? (
                      <span className="shrink-0 inline-flex" title="High-value lead (≥ ₹1L)">
                        <Icon name="star" size={13} className="text-emerald" />
                      </span>
                    ) : null}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-ink truncate">{lead.company}</span>
                        {/* Intent tier — replaces the old binary "Hot" pill.
                            Cold deliberately outranks Hot (see heat.ts): a big
                            deal nobody has touched in 10 days is at risk, not
                            on fire. */}
                        <span
                          title={`${intent.label} — ${intent.reason}`}
                          className={cn(
                            "shrink-0 inline-flex items-center gap-0.5 rounded-full text-[10px] font-semibold px-1.5 py-0.5 leading-none cursor-help",
                            intent.tier === "hot"  && "bg-rose-soft text-rose",
                            intent.tier === "warm" && "bg-amber-soft text-amber-ink",
                            intent.tier === "cold" && "bg-paper-3 text-ink-3 border border-hairline",
                          )}
                        >
                          {intent.tier === "hot" ? "🔥" : intent.tier === "warm" ? "⚡" : "❄️"} {intent.label}
                        </span>
                        {/* Stale nudge — fires at 7 days, BEFORE Cold at 10, so
                            there is still a window to save the deal. */}
                        {stale7 && (
                          <span
                            title={stale7.message}
                            className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-soft/70 text-amber-ink text-[10px] font-semibold px-1.5 py-0.5 leading-none border border-amber/30 cursor-help"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                            {stale7.days}d
                          </span>
                        )}
                        {isDup && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onMerge(lead); }}
                            title="Possible duplicate — click to review & merge"
                            className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-soft text-amber-ink text-[10px] font-semibold px-1.5 py-0.5 leading-none border border-amber/30 hover:bg-amber-soft/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber"
                          >
                            <Icon name="copy" size={9} /> Duplicate?
                          </button>
                        )}
                      </div>
                      <div className="text-[10px] text-ink-3 font-mono">{lead.id}</div>
                      {(() => {
                        const tk = openTaskByLead.get(lead.id);
                        if (!tk) return null;
                        return (
                          <span className={cn(
                            "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            tk.overdue ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber-ink",
                          )}>
                            <Icon name="clock" size={10} />
                            {tk.overdue ? "Task overdue" : "Task"} · {formatDate(tk.due)}
                            {tk.count > 1 ? ` (+${tk.count - 1})` : ""}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </td>
                {/* Stage — 2nd column so pipeline status reads at a glance. Editable
                    inline; stopPropagation so the select doesn't trigger the row click. */}
                <td className="p-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1.5 flex-nowrap">
                    <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", STAGE_DOT[lead.stage])} />
                    {isStageLocked(lead.stage) ? (
                      /* Won renders as text, not a control. Un-winning a deal means money
                         already recorded against it — that is a deliberate act with a
                         confirmation, not a table cell one row from the scrollbar. */
                      <span
                        className="text-xs px-1 py-0.5 font-medium"
                        title="Closed. Reopening a won deal touches recorded money, so it cannot be done from this cell."
                      >
                        {STAGE_LABEL[lead.stage]}
                      </span>
                    ) : (
                      <select
                        value={lead.stage}
                        onChange={(e) => {
                          const stage = e.target.value as Lead["stage"];
                          void changeStage(lead, stage);
                          if (stage === "lost") {
                            toast.success(`${lead.company} marked Lost`);
                          }
                        }}
                        title="Change stage"
                        aria-label={`Stage for ${lead.company}`}
                        className="text-xs bg-transparent -ml-1 px-1 py-0.5 rounded border border-transparent hover:border-hairline cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                      >
                        {rowStageOptions(lead.stage).map((s) => (
                          <option key={s} value={s}>{STAGE_LABEL[s]}</option>
                        ))}
                      </select>
                    )}
                    {/* How long it has sat here. Beside the stage, because "Quote Sent"
                        and "Quote Sent for 20 days" are different facts and only the
                        second one asks for action. Unknown ages render as nothing at all
                        rather than as "0d" — see lib/leads/velocity.ts. */}
                    {(() => {
                      const a = stageAge(lead);
                      if (a.days === null) return null;
                      return (
                        <span
                          title={a.title}
                          className={cn(
                            "shrink-0 rounded px-1 py-px text-[10px] font-semibold tabular-nums leading-none",
                            a.stale ? "bg-rose-soft text-rose" : "text-ink-4",
                          )}
                        >
                          {a.days}d
                        </span>
                      );
                    })()}
                  </div>
                </td>
                {/* Email is kept off the row to keep it tight — it shows on hover
                    (title) with a small mail glyph as the cue. Phone stays visible
                    as it's the primary call-to-action in the pipeline. */}
                <td className="px-3 py-2 text-sm" title={lead.contact_email ? `Email: ${lead.contact_email}` : undefined}>
                  <div className="flex items-center gap-1 text-ink">
                    <span className="truncate max-w-[170px]">{lead.contact_name ?? "—"}</span>
                    {lead.contact_email && <Icon name="mail" size={11} className="shrink-0 text-ink-3" />}
                  </div>
                  {lead.contact_phone && (
                    <div className="text-[11px] text-ink-3 font-mono truncate max-w-[180px]">
                      {lead.contact_phone}
                    </div>
                  )}
                </td>
                {/* Plan + seats folded together — saves a column, keeps both
                    facts. Seats bold so quantity reads at a glance. */}
                <td className="px-3 py-2 text-sm text-ink-2">
                  <span className="block truncate" title={lead.plan ?? undefined}>{lead.plan ?? "—"}</span>
                  {lead.seats != null && (
                    <span className="text-[11px] text-ink-3"><span className="font-semibold text-ink-2 tabular-nums">{lead.seats}</span> seats</span>
                  )}
                </td>
                {/* Value — the money, given visual precedence (serif, bold), and
                    editable in place. Parsing lives in lib/leads/inline-edit.ts:
                    this figure feeds the Open Pipeline KPI, so an unparseable
                    entry is refused rather than coerced. */}
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <InlineCell<number | null>
                    value={lead.value ?? null}
                    ariaLabel={`Deal value for ${lead.company}`}
                    className="text-right"
                    toInput={(v) => (v == null ? "" : String(v))}
                    parse={parseRupeeInput}
                    onSave={(v) => updateLead.mutate({ id: lead.id, patch: { value: v } })}
                    display={
                      lead.value
                        ? <span className="inline-flex items-baseline gap-1.5">
                            <span className={cn("font-serif text-[15px] font-semibold", isHighValue ? "text-emerald" : "text-ink")}>{rupee(lead.value)}</span>
                            {/* Gross margin, right beside the value it is a margin ON.
                                A separate column would let a rep read the deal size
                                without ever meeting the number that says whether it is
                                worth having. Cost comes from the catalogue — never a
                                percentage assumed off the sell price. */}
                            {(() => {
                              const m = dealMargin(lead, planCosts);
                              const b = marginBadge(m);
                              if (m.band === "unknown") return null;
                              return (
                                <span
                                  title={b.title}
                                  className={cn(
                                    "shrink-0 rounded px-1 py-px text-[10px] font-semibold tabular-nums leading-none",
                                    b.kind === "danger"  && "bg-rose-soft text-rose",
                                    b.kind === "warning" && "bg-amber-soft text-amber-ink",
                                    b.kind === "success" && "bg-paper-2 text-ink-3",
                                  )}
                                >
                                  {b.label}
                                </span>
                              );
                            })()}
                          </span>
                        : <span className="text-ink-3">—</span>
                    }
                  />
                </td>
                {/* Priority — inline select. */}
                <td className="px-3 py-2 text-sm" onClick={(e) => e.stopPropagation()}>
                  <InlineCell<Priority>
                    value={(lead.priority ?? "medium") as Priority}
                    ariaLabel={`Priority for ${lead.company}`}
                    toInput={(v) => v}
                    parse={parsePriority}
                    options={PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
                    onSave={(v) => updateLead.mutate({ id: lead.id, patch: { priority: v } })}
                    display={
                      <span className={cn(
                        "inline-flex items-center gap-1 text-xs",
                        lead.priority === "high" ? "text-rose font-semibold"
                        : lead.priority === "low" ? "text-ink-3"
                        : "text-ink-2",
                      )}>
                        <span className={cn(
                          "w-1.5 h-1.5 rounded-full",
                          lead.priority === "high" ? "bg-rose" : lead.priority === "low" ? "bg-slate" : "bg-amber",
                        )} />
                        {(lead.priority ?? "medium").replace(/^./, (c) => c.toUpperCase())}
                      </span>
                    }
                  />
                </td>
                {/* Follow-up date — inline date picker. Overdue reads rose so the
                    column doubles as a "who needs chasing today" scan. */}
                <td className="px-3 py-2 text-sm" onClick={(e) => e.stopPropagation()}>
                  <InlineCell<string | null>
                    value={lead.follow_up_date ?? null}
                    ariaLabel={`Follow-up date for ${lead.company}`}
                    inputType="date"
                    toInput={(v) => v ?? ""}
                    parse={parseFollowUpDate}
                    onSave={(v) => updateLead.mutate({ id: lead.id, patch: { follow_up_date: v } })}
                    display={
                      lead.follow_up_date
                        ? <span className={cn(
                            "text-xs tabular-nums",
                            daysSince(lead.follow_up_date) > 0 ? "text-rose font-medium" : "text-ink-2",
                          )}>
                            {formatDate(lead.follow_up_date)}
                          </span>
                        : <span className="text-ink-4 text-xs">—</span>
                    }
                  />
                </td>
                {/* Expected close date. An empty one is not styled as an error — most
                    leads legitimately have none — but the forecast counts it as undated
                    and says so, so the gap is visible somewhere rather than nowhere. */}
                <td className="px-3 py-2 text-sm" onClick={(e) => e.stopPropagation()}>
                  <InlineCell<string | null>
                    value={lead.expected_close_date ?? null}
                    ariaLabel={`Expected close date for ${lead.company}`}
                    inputType="date"
                    toInput={(v) => v ?? ""}
                    parse={parseFollowUpDate}
                    onSave={(v) => updateLead.mutate({ id: lead.id, patch: { expected_close_date: v } })}
                    display={
                      lead.expected_close_date
                        ? <span className="text-xs tabular-nums text-ink-2">
                            {formatDate(lead.expected_close_date)}
                            <span className="ml-1 text-ink-4">· {stageProbability(lead.stage)}%</span>
                          </span>
                        : <span className="text-ink-4 text-xs" title="No date set — counted as undated in the forecast">—</span>
                    }
                  />
                </td>
                <td className="px-3 py-2 text-sm">
                  <span className={cn(
                    "tabular-nums block",
                    // Same threshold as the badge (heat.ts), not a local >14 rule.
                    stale7 ? "text-rose font-medium" : "text-ink-3",
                  )}>
                    {age === 0 ? "today" : age === 1 ? "1d ago" : `${age}d ago`}
                  </span>
                  <span className="block text-[10px] text-ink-4 tabular-nums">
                    {formatDate(lead.updated_at)} · {fmtActTime(lead.updated_at)}
                  </span>
                </td>
                {/* Quick actions — dark panel that opens from the ⋯ (hover/click/
                    focus) and stays open while the panel itself is hovered. */}
                <RowActions lead={lead} isSelected={isSelected} onSendQuote={onSendQuote} onFollowUp={onFollowUp} onWhatsApp={onWhatsApp} />
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="p-8 text-center text-sm text-ink-3 italic">No leads match.</div>
      )}
      <div className="px-3 py-2 border-t border-hairline bg-paper-2/40 text-[11px] text-ink-3 flex items-center gap-2">
        <Icon name="info" size={11} />
        Click any row to open the drawer · Tick a checkbox to enable bulk actions · Quick actions (Call / WhatsApp / Send quote / ⋯) sit at the end of each row · ★ = high-value, Hot = priority lead
      </div>
    </div>

    {/* Floating bulk action toolbar — only renders when ≥1 row selected. */}
    <LeadsBulkBar
      count={selectedIds.size}
      onChangeStage={bulkChangeStage}
      onDeselectAll={clearSelection}
      onDelete={bulkDelete}
      onMarkJunk={bulkMarkJunk}
    />
    </>
  );
}

// ============================================================
// Fact row helper for detail drawer
// ============================================================
function Fact({ label, value, mono, big }: { label: string; value: string | null | undefined; mono?: boolean; big?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-3 mb-0.5">{label}</div>
      <div className={cn(
        "text-ink",
        mono && "font-mono",
        big && "font-serif text-xl",
        !value && "italic text-ink-3 text-sm"
      )}>
        {value || "—"}
      </div>
    </div>
  );
}

// LeadsPageInner uses useSearchParams() — Next.js requires that to live under
// a Suspense boundary so static prerender can bail out gracefully.
export default function LeadsPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading deals…</div>}>
      <LeadsPageInner />
    </React.Suspense>
  );
}
