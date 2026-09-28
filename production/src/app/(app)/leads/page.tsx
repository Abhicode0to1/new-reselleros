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
import { useTeamTree } from "@/lib/queries/team-tree";
import { idsForMode, type TeamViewMode } from "@/lib/team/visibility";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { pipelineSplit } from "@/lib/leads/enquiry";
import { toast } from "sonner";
import { useLeads } from "@/lib/queries/leads";
import { LossReasonsCard } from "@/components/features/leads/loss-reasons-card";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { SmartView } from "@/components/features/leads/leads-smart-views";
import { PriorityCallQueue } from "@/components/features/leads/priority-call-queue";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import { localDateISO } from "@/lib/leads/outcomes";
import { winRate } from "@/lib/leads/forecast";
import { computeDuplicates } from "@/lib/leads/duplicates";
import { SALES_FOLDERS, salesFolderCounts, type SalesFolder } from "@/lib/leads/folders";
import { JunkAIReview } from "@/components/features/leads/junk-ai-review";
import type { Lead } from "@/lib/supabase/database.types";
import { useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { filterStagesFor } from "@/lib/leads/stage-meta";
import {
  boardCut, inWorkspace, isOpenLead, junkCounts, listCut, pipelineTotals, searchLeads, type SortCol,
} from "@/lib/leads/list-selectors";
import { LeadListView } from "@/components/features/leads/lead-list-view";
import { LeadDetailSheet } from "@/components/features/leads/lead-detail-sheet";
import { LeadsToolbar } from "@/components/features/leads/leads-toolbar";
import { LeadsKpiDrawer } from "@/components/features/leads/leads-kpi-drawer";
import { LeadsHotCard } from "@/components/features/leads/leads-hot-card";
import { LeadsKanbanBoard } from "@/components/features/leads/leads-kanban-board";
import { LeadsNoResults, LeadsStatusStates } from "@/components/features/leads/leads-empty-states";
import { LeadsHeaderBar } from "@/components/features/leads/leads-header-bar";
import { LeadsPageDialogs } from "@/components/features/leads/leads-page-dialogs";

/* Page parts live in components/features/leads/ and the rules that pick rows in
   lib/leads/list-selectors.ts (S35, 28 Sep 2026 — this file was 5,125 lines). */

function LeadsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const pathname     = usePathname();
  const focusLeadId  = searchParams.get("lead");
  /* ?projectQuote=<leadId> opens the project quotation sheet — the one route both the row
     and the drawer use, since the drawer is a separate component. */
  const projectQuoteId = searchParams.get("projectQuote");

  const { data: leads, isLoading, error, refetch } = useLeads();
  const projectQuoteLead = React.useMemo(
    () => (projectQuoteId ? (leads ?? []).find((l) => l.id === projectQuoteId) ?? null : null),
    [projectQuoteId, leads],
  );
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

  /* Filter offers only the stages that can actually appear on THIS page (else
     filtering e.g. "Won" on the raw Leads inbox always yields 0 rows) — lib/leads/stage-meta.ts. */
  const filterStages = filterStagesFor(isDealsPage);


  const [search, setSearch] = React.useState("");
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
  /* Opens on every lead (won and lost included) — see the "All leads" view. */
  const [smartView, setSmartView] = React.useState<SmartView>("everything");
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

  /* WHICH lead the drawer is on stays in `selected`; WHAT that lead currently says comes
     from the query. Two different questions, and conflating them is what let the drawer
     show "Stage: New" seconds after moving the same lead to Contacted on the board behind
     it — see the comment at <LeadDetailSheet>. Resolved by id on every render, so any
     invalidation of ["leads"] reaches the drawer the same way it reaches the list. */
  const selectedLive = React.useMemo(
    () => (selected ? (leads?.find((l) => l.id === selected.id) ?? selected) : null),
    [selected, leads],
  );

  /* Call-queue dependencies. runOutcome performs whatever lib/leads/outcomes.ts says a
     chip does — one entry point, so the chips on the queue, the row and the mobile card
     cannot drift apart (the same reason use-change-stage.ts exists). */
  const runOutcome = useLeadOutcome();
  /* Aur `callLog` wo doosra darwaza hai jo isi baat ko poora karta hai: chips ek jaise
     chalein, aur "Call log" har jagah popup khole. */
  const callLog    = useCallLog(runOutcome);
  const queueLog   = useLogLeadActivity();





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
  /* Default `wait` — "jise action chahiye pehle". Pehle `created` tha (sabse nayi lead
     upar), jiska nateeja ye tha ki teen din se ruki hui lead teesre panne par chali jati
     thi. Research isi ko galat kehti hai: default order me wo cheez pehle honi chahiye
     jispar kaam BAAKI hai. */
  const [sortBy, setSortBy] = React.useState<SortCol>("wait");
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
    /* A custom-software lead gets a PROJECT quotation, not a licence quote — and once it
       has one, "Send quote" opens that quotation instead of making a second. */
    if (lead.enquiry_type === "project") {
      router.push((lead.project_id ? `/projects/${lead.project_id}` : `${pathname}?projectQuote=${lead.id}`) as never);
      return;
    }
    const params = new URLSearchParams();
    params.set("leadId",  lead.id);
    params.set("company", lead.company);
    if (lead.plan)          params.set("plan",  lead.plan);
    if (lead.seats != null) params.set("seats", String(lead.seats));
    if (lead.contact_name)  params.set("contact", lead.contact_name);
    if (lead.contact_email) params.set("email", lead.contact_email);
    if (lead.contact_phone) params.set("phone", lead.contact_phone);
    router.push(`/quotes/new?${params.toString()}` as never);
  }, [router, pathname]);

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
  /* ── Whose leads ──────────────────────────────────────────────────────────
     The reporting tree decides, not the role — lib/team/visibility.ts. Unlike quotes, all
     14 live leads DO carry an owner_id, so this filter actually bites here, which makes the
     unowned-stays-visible branch the safety net rather than the main path.

     A view, not a wall: row-level enforcement ships in
     20260818150000_user_hierarchy_visibility.sql and is not applied yet. */
  const { data: leadTeamTree } = useTeamTree();
  const leadTeam = React.useMemo(() => leadTeamTree ?? [], [leadTeamTree]);
  const leadMeMember = React.useMemo(
    () => leadTeam.find((u) => u.id === currentUser?.userId) ?? null,
    [leadTeam, currentUser?.userId],
  );
  const [leadTeamMode, setLeadTeamMode] = React.useState<TeamViewMode>("team");

  const workspaceLeads = React.useMemo(() => {
    const rows = leads ?? [];
    if (!leadMeMember) return rows;
    const ids = idsForMode(leadMeMember, leadTeam, leadTeamMode);
    if (ids === null) return rows;
    return inWorkspace(rows, ids);
  }, [leads, leadMeMember, leadTeam, leadTeamMode]);


  // Duplicate index — computed over workspace leads (dups can span the workspace),
  // surfaced as a per-row "Duplicate?" flag + a "Duplicates" smart view. Declared
  // here (before `searched`) because the Duplicates view filters on dup.flagged.
  // Non-destructive: it only flags; merging is an explicit action in the dialog.
  const dup = React.useMemo(() => computeDuplicates(workspaceLeads), [workspaceLeads]);

  // Junk (spam/fake) — a stored flag. junkCount drives the Junk chip; suspects
  // are non-junk leads the heuristic flags for review (surfaced in the Junk view).
  const { junk: junkCount, everything: everythingCount, suspects: junkSuspectCount } = React.useMemo(
    () => junkCounts(workspaceLeads),
    [workspaceLeads],
  );

  // Search + filter both apply BEFORE the folder cut so each view respects them. The rules
  // (junk cut, text search, stage/priority any-of, the smart view) are
  // lib/leads/list-selectors.ts#searchLeads, characterised in its tests.
  const searched = React.useMemo(
    () => searchLeads(workspaceLeads, {
      search, stageFilter, priorityFilter, smartView, currentUser, dupFlagged: dup.flagged, now: new Date(),
    }),
    [workspaceLeads, search, stageFilter, priorityFilter, smartView, currentUser, dup],
  );
  const activeFilterCount = stageFilter.length + priorityFilter.length;

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

  /* ─── THE SIX FOLDERS THE VIEW MENU DID NOT ALREADY HAVE ────────────────
     The chip strip is gone; these move into <LeadsSmartViews/> so there is ONE place
     a list gets narrowed. All open and Junk are deliberately absent — the menu already
     carries both, and repeating them here would move the duplication instead of
     removing it. */
  const folderRows = React.useMemo(
    () =>
      SALES_FOLDERS.map((f) => ({
        id: f.id as string,
        label: f.label,
        count: folderCounts[f.id],
        /* Only when it IS empty — see the note above the memo. */
        hint: folderCounts[f.id] === 0 ? f.hint : "",
      })),
    [folderCounts],
  );
  const filtered = listCut(searched, folder, smartView, folderToday);

  /* ── THE BOARD MUST CONTAIN ITS OWN LAST COLUMN ─────────────────────────────
     `filtered` is open-only when no folder is picked, and the board's stages end at
     `won` — so the Won column read 0 cards and "No deals in won" three inches below a
     chip saying 🏆 Won 2. Two numbers about the same two deals, disagreeing on screen.

     Worse than the wrong count: Won is the board's DROP TARGET. Dragging a deal into an
     empty column that never shows a result reads as "the drag did not work", and the rep
     stops using the one gesture the board exists for.

     So the board's base is every non-junk, non-lost lead. Lost is deliberately absent —
     it is not a column here, and losing a deal goes through the reason prompt, not a
     drag. Picking a folder hands control back to `filtered`, unchanged. */
  const boardLeads = React.useMemo(
    () => boardCut(searched, filtered, folder, smartView),
    [folder, smartView, searched, filtered],
  );

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
    setSmartView("everything");
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
  const { dealUniverse, openDeals, totalValue } = React.useMemo(
    () => pipelineTotals(workspaceLeads),
    [workspaceLeads],
  );
  const pipelineByType = React.useMemo(() => pipelineSplit(openDeals), [openDeals]);
  /* Kept when the metrics band went: the breakdown tiles read wonCount, decidedCount
     and conversion out of this. Only `lost` was band-only. */
  const rate = React.useMemo(() => winRate(dealUniverse), [dealUniverse]);
  /* Win rate over DECIDED deals only — won ÷ (won + lost). It used to divide by every
     deal including the open ones, which counts "not finished yet" as "not won"; the rule
     and the reasoning now live in lib/leads/forecast.ts with its tests. */
  const { won: wonCount, decided: decidedCount, pct: conversion } = rate;

  return (
    <div className="h-[calc(100vh-3.5rem-4rem)] md:h-[calc(100vh-3.5rem)] max-w-[1800px] mx-auto p-3 sm:p-4 flex flex-col overflow-hidden min-w-0">
      {/* The sticky title bar, and why its offsets and this wrapper's height are what they
          are — see leads-header-bar.tsx. */}
      <LeadsHeaderBar salesTab={salesTab} setAddOpen={setAddOpen} />


      {/* Expanded Intelligence Drawer */}
      {kpiOpen && !isLoading && leads && leads.length > 0 && (
        <LeadsKpiDrawer
          leads={leads}
          totalValue={totalValue}
          pipelineByType={pipelineByType}
          openDeals={openDeals}
          wonCount={wonCount}
          decidedCount={decidedCount}
          conversion={conversion}
        />
      )}

      {/* Search + Views dropdown + Filter buttons.
          The Views control used to be a chip strip in a flex-1 overflow-x-auto
          box here. Eight chips in the space left over between the search box and
          the buttons meant one visible chip and two scroll arrows. It is a
          dropdown now, so the row no longer needs a scrolling middle section —
          and the width it was hogging goes to the search box, which was the
          other cramped control on this row. */}
      {!isLoading && leads && (
        <LeadsToolbar
          leads={leads}
          leadMeMember={leadMeMember}
          leadTeam={leadTeam}
          leadTeamMode={leadTeamMode}
          setLeadTeamMode={setLeadTeamMode}
          search={search}
          setSearch={setSearch}
          leadsForTab={leadsForTab}
          everythingCount={everythingCount}
          currentUser={currentUser}
          duplicateCountForTab={duplicateCountForTab}
          junkCount={junkCount}
          junkSuspectCount={junkSuspectCount}
          smartView={smartView}
          selectSmartView={selectSmartView}
          folderRows={folderRows}
          folder={folder}
          selectFolder={selectFolder}
          effectiveView={effectiveView}
          setView={setView}
          activeFilterCount={activeFilterCount}
          filterStages={filterStages}
          stageFilter={stageFilter}
          setStageFilter={setStageFilter}
          priorityFilter={priorityFilter}
          setPriorityFilter={setPriorityFilter}
          isSales={isSales}
          kpiOpen={kpiOpen}
          setKpiOpen={setKpiOpen}
          setCsvImportOpen={setCsvImportOpen}
          setCampaignOpen={setCampaignOpen}
          setGoogleImportOpen={setGoogleImportOpen}
          setShareOpen={setShareOpen}
        />
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
      {!isLoading && leads && leads.length > 0 && !isSales && search.trim() === "" && (
        <LeadsHotCard filtered={filtered} currentUser={currentUser} tipsOpen={tipsOpen} toggleTips={toggleTips} />
      )}


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
      {/* `mb-3`: band aur table ke beech saans. Bina iske dono chipke hue the aur band
          table ka hi ek header jaisa lagta tha — jabki wo alag cheez hai. */}
      {!isLoading && leads && leads.length > 0 && search.trim() === "" && (
        <div className="mb-3">
        <PriorityCallQueue
          leads={workspaceLeads}
          tenantName={currentUser?.tenantName}
          onOutcome={(o, l) => callLog.run(o, l)}
          onOpen={(l) => setSelected(l)}
          onLogCall={(l) => queueLog.mutate({ leadId: l.id, kind: "call", detail: `Called ${l.contact_phone ?? ""}` })}
          onLogWhatsApp={(l) => queueLog.mutate({ leadId: l.id, kind: "whatsapp", detail: `WhatsApp to ${l.contact_phone ?? ""}` })}
        />
        </div>
      )}

      <LeadsStatusStates
        error={error}
        refetch={refetch}
        isLoading={isLoading}
        leads={leads}
        isDealsPage={isDealsPage}
        isSales={isSales}
        filtered={filtered}
        smartView={smartView}
        setAddOpen={setAddOpen}
        setCsvImportOpen={setCsvImportOpen}
        setSmartView={setSmartView}
      />

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
        <LeadsKanbanBoard
          boardLeads={boardLeads}
          changeStage={changeStage}
          setSelected={setSelected}
          setAddOpen={setAddOpen}
        />
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

      <LeadsNoResults
        isLoading={isLoading}
        error={error}
        leads={leads}
        filtered={filtered}
        smartView={smartView}
        search={search}
        setSearch={setSearch}
        setStageFilter={setStageFilter}
        setPriorityFilter={setPriorityFilter}
      />

        </div>{/* /flex-1 main column */}

      </div>{/* /flex split */}

      {/* Detail drawer.

          `selectedLive`, NOT `selected`. Reported 23 Aug 2026: tapping the drawer's "Move
          to Contacted" nudge moved the card on the board behind it — New went to 0,
          Contacted to 1, so the write plainly succeeded — while the drawer kept saying
          "Stage: New" and kept showing the nudge that had just done its job.

          `selected` is a Lead OBJECT captured in state when the row was clicked, so it is
          a snapshot frozen at open time. Every mutation in here invalidates ["leads"] and
          the list re-renders correctly; the drawer alone was reading a copy nobody
          refreshes. Resolving the row by id on each render means one source of truth for
          both, which is what made the board and the drawer disagree in the first place.

          This was never specific to the nudge — the in-drawer stage dropdown had the same
          staleness and nobody had noticed, because it sits next to a stage label it also
          failed to update. The nudge only made the disagreement loud enough to see.

          Falls back to the snapshot when the id is missing from the list rather than
          rendering nothing: a deleted row already closes the drawer through its own
          handler, and a blank drawer mid-refetch would be a worse bug than a stale one. */}
      <LeadDetailSheet
        lead={selectedLive}
        onClose={() => setSelected(null)}
        onEdit={(l) => {
          setSelected(null);
          setEditingLead(l);
          setAddOpen(true);
        }}
      />

      <LeadsPageDialogs
        followUpLead={followUpLead}
        setFollowUpLead={setFollowUpLead}
        waLead={waLead}
        setWaLead={setWaLead}
        mergeCluster={mergeCluster}
        setMergeCluster={setMergeCluster}
        projectQuoteLead={projectQuoteLead}
        closeProjectQuote={() => router.replace(pathname as never)}
        addOpen={addOpen}
        setAddOpen={setAddOpen}
        editingLead={editingLead}
        setEditingLead={setEditingLead}
        isDealsPage={isDealsPage}
        quickOpen={quickOpen}
        setQuickOpen={setQuickOpen}
        trialOpen={trialOpen}
        setTrialOpen={setTrialOpen}
        callLog={callLog}
        campaignOpen={campaignOpen}
        setCampaignOpen={setCampaignOpen}
        googleImportOpen={googleImportOpen}
        setGoogleImportOpen={setGoogleImportOpen}
        csvImportOpen={csvImportOpen}
        setCsvImportOpen={setCsvImportOpen}
        refetch={refetch}
        shareOpen={shareOpen}
        setShareOpen={setShareOpen}
      />

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

// LeadsPageInner uses useSearchParams() — Next.js requires that to live under
// a Suspense boundary so static prerender can bail out gracefully.
export default function LeadsPage() {
  return (
    <React.Suspense fallback={<div className="p-8 text-sm text-ink-3">Loading deals…</div>}>
      <LeadsPageInner />
    </React.Suspense>
  );
}