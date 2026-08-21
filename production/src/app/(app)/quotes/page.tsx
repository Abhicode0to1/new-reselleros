/**
 * Quotes — list matching prototype design.
 */
"use client";

import * as React from "react";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { useTeamTree } from "@/lib/queries/team-tree";
import { TeamViewToggle } from "@/components/shared/team-view-toggle";
import { HIERARCHY_ENFORCED_IN_DATABASE } from "@/lib/team/enforcement";
import { idsForMode, type TeamViewMode } from "@/lib/team/visibility";
import { KeyHintBar, ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuotes, useDeleteQuote, quoteDeleteBlockReason } from "@/lib/queries/quotes";
import { useProjectSales, useDeleteProjectSale, type ProjectSaleWithTotals } from "@/lib/queries/projects";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { useCustomer } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { computeMargin } from "@/components/features/margin-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { FAB } from "@/components/ui/fab";
import { rupee, daysBetween, cleanDisplayName, phoneSuffixOf } from "@/lib/utils";
import { unifiedStatus, cashNote } from "@/lib/quotes/status-badge";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import { isForeignCurrency, foreignEquivalent, formatForeign } from "@/lib/currency";
import type { Quote } from "@/lib/supabase/database.types";

/** A quote's total in ITS billing currency (foreign quotes show $/€…; books stay ₹). */
function quoteMoney(q: { amount: number | null; currency?: string | null; exchange_rate?: number | null }): string {
  if (!q.amount) return "—";
  if (isForeignCurrency(q.currency)) {
    return formatForeign(foreignEquivalent(q.amount, q.exchange_rate && q.exchange_rate > 0 ? q.exchange_rate : 1), q.currency ?? "");
  }
  return rupee(q.amount);
}

/**
 * A quote's margin, from its LINE ITEMS.
 *
 * Two things this used to do and no longer does:
 *
 * • It read `quotes.total_cost`, an aggregate column that at least one writer forgot
 *   to set. Q-2026-9778 stores 0 there while its line carries ₹19,800, so this list
 *   showed "Pipeline margin ₹0" on a quote making 17.5%.
 *
 * • When that column was empty it guessed `amount × 0.83` — a flat 17% invented out
 *   of nothing and then summed into a KPI tile that read like a measurement. That was
 *   the fourth copy of the same guess in this codebase.
 *
 * `known: false` means the margin genuinely cannot be worked out, and callers must
 * show that rather than a number. Returning 0 would be indistinguishable from a
 * break-even deal.
 */
function estimateMarginForQuote(q: Quote): ReturnType<typeof computeMargin> & { known: boolean } {
  const lines = Array.isArray(q.line_items) ? q.line_items : [];
  const taxable = q.subtotal
    ? q.subtotal - Math.round(q.subtotal * (q.discount_pct / 100))
    : (q.amount ?? 0);

  if (lines.length === 0) return { ...computeMargin(0, 0), known: false };

  const cost = lines.reduce((s, l) => s + l.qty * l.cost, 0);
  const known = !lines.some((l) => l.cost <= 0 && l.rate > 0);
  return { ...computeMargin(cost, taxable), known };
}

/* unifiedStatus + the cash note now live in lib/quotes/status-badge.ts, with tests.
   They decide what an operator believes about money at a glance, and while they lived
   here nothing could test them — which is how a quote holding ₹20,000 came to display
   "Out for review". */

export default function QuotesPage() {
  const router = useRouter();
  const { data: quotes, isLoading, error, refetch } = useQuotes();
  const { data: projectQuotes } = useProjectSales();
  const deleteQuote = useDeleteQuote();
  const [tab, setTab] = React.useState("all");
  const [search, setSearch] = React.useState("");
  // Clean split — Subscription is the default (most quotes live here); Project
  // is one tab away. No mixed "All" view, no empty default.
  const [view, setView] = React.useState<"subscription" | "project">("subscription");
  const [projectQuoteOpen, setProjectQuoteOpen] = React.useState(false);
  const [editProject, setEditProject] = React.useState<ProjectSaleWithTotals | null>(null);
  const deleteProject = useDeleteProjectSale();
  const [previewing, setPreviewing] = React.useState<Quote | null>(null);
  const [kpiOpen, setKpiOpen] = React.useState(true);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const confirm = useConfirm();

  const handleDelete = async (q: Quote) => {
    // Hard-block quotes that already carry a payment (cascade would wipe the
    // payment ledger). Same guard the mutation enforces — surfaced early here.
    const blocked = quoteDeleteBlockReason(q);
    if (blocked) {
      toast.error(blocked);
      return;
    }
    if (await confirm({
      title: `Permanently delete quote ${q.id}?`,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    })) {
      deleteQuote.mutate(q);
    }
  };

  const handleDuplicate = (q: Quote) => {
    const params = new URLSearchParams();
    params.set("duplicate", q.id);
    if (q.lead_id)       params.set("leadId",  q.lead_id);
    if (q.customer_name) params.set("company", q.customer_name);
    router.push(`/quotes/new?${params.toString()}` as any);
  };

  // Workspace keyword filter removed 2026-08-13 — RLS already scopes to tenant.
  /* ── Whose quotes ─────────────────────────────────────────────────────────
     The tree decides, not the role — see lib/team/visibility.ts. An UNOWNED quote stays
     visible to everybody, and that is not a loophole: all 25 quotes in the live books have
     owner_id NULL, so filtering them out would empty this page while the rows sat safely
     in the database. Company data nobody has claimed is not private data.

     Note what this is: a view. Row-level enforcement ships in
     20260818150000_user_hierarchy_visibility.sql and is not applied yet, which is why the
     toggle carries a caveat rather than implying privacy. */
  const { data: me } = useCurrentUser();
  const { data: teamTree } = useTeamTree();
  const team = React.useMemo(() => teamTree ?? [], [teamTree]);
  const meMember = React.useMemo(
    () => team.find((u) => u.id === me?.userId) ?? null,
    [team, me?.userId],
  );
  const [teamMode, setTeamMode] = React.useState<TeamViewMode>("team");

  const quotesByWorkspace = React.useMemo(() => {
    const rows = quotes ?? [];
    if (!meMember) return rows;
    const ids = idsForMode(meMember, team, teamMode);
    if (ids === null) return rows;
    return rows.filter((q) => !q.owner_id || ids.includes(q.owner_id));
  }, [quotes, meMember, team, teamMode]);

  // Counts per status — adds an "invoiced" bucket on top of the quote.status
  // enum, derived from payment_status. Truly-done deals (accepted + paid +
  // GST invoice issued) get their own tab; the Accepted tab then surfaces
  // only the still-in-flight ones (accepted but money flow incomplete).
  const counts = React.useMemo(() => {
    const map: Record<string, number> = { all: quotesByWorkspace.length, invoiced: 0 };
    for (const q of quotesByWorkspace) {
      if (q.payment_status === "invoiced") {
        map.invoiced += 1;
        // also count under the underlying status (usually 'accepted') for
        // tracking, but the Accepted tab excludes invoiced ones below
        map[q.status] = (map[q.status] ?? 0) + 1;
      } else {
        map[q.status] = (map[q.status] ?? 0) + 1;
      }
    }
    return map;
  }, [quotesByWorkspace]);

  // Accepted-but-not-yet-invoiced count for the tab badge
  const acceptedActive = (counts.accepted ?? 0) - (counts.invoiced ?? 0);

  // Awaiting payment = money expected but not yet fully received. Includes an
  // INVOICED quote that still has a balance due — else real outstanding cash
  // (invoiced-but-part-paid) would hide from the "chase the cash" worklist.
  const isAwaitingCash = (q: Quote) =>
    q.payment_status === "awaiting" ||
    q.payment_status === "partial" ||
    (q.payment_status === "invoiced" && (q.amount ?? 0) - (q.payment_amount ?? 0) > 0);
  const awaitingPayment = quotesByWorkspace.filter(isAwaitingCash).length;

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",      count: counts.all ?? 0 },
    { id: "draft",    label: "Draft",    count: counts.draft ?? 0, dot: "slate" },
    { id: "sent",     label: "Sent",     count: counts.sent ?? 0, dot: "amber" },
    { id: "viewed",   label: "Viewed",   count: counts.viewed ?? 0, dot: "indigo" },
    { id: "accepted", label: "Accepted", count: acceptedActive,        dot: "emerald" },
    { id: "awaiting", label: "Awaiting payment", count: awaitingPayment, dot: "amber" },
    { id: "invoiced", label: "Invoiced", count: counts.invoiced ?? 0,  dot: "emerald" },
    { id: "expired",  label: "Expired",  count: (counts.expired ?? 0) + (counts.rejected ?? 0), dot: "rose" },
  ];

  // Filter
  const filtered = quotesByWorkspace.filter((q) => {
    if (tab === "expired") {
      if (q.status !== "expired" && q.status !== "rejected") return false;
    } else if (tab === "awaiting") {
      // Awaiting-payment bucket: money expected but not fully received.
      if (!isAwaitingCash(q)) return false;
    } else if (tab === "invoiced") {
      // Invoiced bucket is defined by payment_status, not quote.status
      if (q.payment_status !== "invoiced") return false;
    } else if (tab === "accepted") {
      // Accepted tab excludes those that have already graduated to invoiced
      if (q.status !== "accepted" || q.payment_status === "invoiced") return false;
    } else if (tab !== "all" && q.status !== tab) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      q.id.toLowerCase().includes(s) ||
      q.customer_name.toLowerCase().includes(s) ||
      (q.plan?.toLowerCase().includes(s) ?? false)
    );
  });

  /* ── j / k / Enter over this table ────────────────────────────────────────
     `count` is the FILTERED length, so the selection is re-clamped whenever a tab or a
     search changes the list. Without that, Enter after a filter would open whichever row
     had slid into the old index — the wrong quote, confidently. See useListKeys. */
  const keys = useListKeys({
    count: filtered.length,
    onOpen: (i) => {
      const q = filtered[i];
      if (q) router.push(`/quotes/${q.id}` as never);
    },
  });

  /* The selected row scrolls itself into view: driving a long list by keyboard is useless
     if the highlight walks off the bottom of the screen. */
  const selectedRowRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [keys.index]);

  // KPIs
  const totalValue = quotesByWorkspace.reduce((s, q) => s + (q.amount ?? 0), 0);
  const acceptedValue = quotesByWorkspace
    .filter((q) => q.status === "accepted")
    .reduce((s, q) => s + (q.amount ?? 0), 0);
  const sentValue = quotesByWorkspace
    .filter((q) => q.status === "sent" || q.status === "viewed")
    .reduce((s, q) => s + (q.amount ?? 0), 0);
  /* Only quotes whose margin is actually KNOWN are summed, and how many were left
     out is carried alongside — a total that silently drops the unknown ones reads as
     a complete measurement of the pipeline when it is a partial one. */
  const marginablePipeline = quotesByWorkspace
    .filter((q) => q.status === "sent" || q.status === "viewed")
    .map((q) => estimateMarginForQuote(q));
  const pipelineMargin = marginablePipeline.filter((m) => m.known).reduce((s, m) => s + m.margin, 0);
  const pipelineMarginUnknownCount = marginablePipeline.filter((m) => !m.known).length;
  const acceptedCount = counts.accepted ?? 0;
  const sentishCount = (counts.sent ?? 0) + (counts.viewed ?? 0);
  const expiringCount = sentishCount;
  const winRate = quotesByWorkspace.length > 0
    ? Math.round((acceptedCount / Math.max(1, quotesByWorkspace.length - (counts.draft ?? 0))) * 100)
    : 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto flex flex-col min-h-[calc(100vh-56px)]">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Quotes</h1>
          <p className="text-sm text-ink-3 mt-1">All generated quotes · sorted by most recent</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {view === "project" ? (
            <Button variant="primary" icon="plus" onClick={() => setProjectQuoteOpen(true)}>
              New Quote
            </Button>
          ) : (
            <Button asChild variant="primary" icon="plus">
              <Link href={"/quotes/new" as any}>New Quote</Link>
            </Button>
          )}
        </div>
      </div>

      {/* Subscription vs Project quotes toggle */}
      <div className="mb-4">
        <TabBar
          value={view}
          onChange={(v) => setView(v as "subscription" | "project")}
          items={[
            { id: "subscription", label: "Subscription", count: quotes?.length || undefined },
            { id: "project",      label: "Project",      count: projectQuotes?.length || undefined },
          ]}
        />
      </div>

      {/* ─── PROJECT quotes view ─── */}
      {view === "project" && (
        (projectQuotes?.length ?? 0) > 0 ? (
          <Card flush>
            {/* Mobile card list — phones only */}
            <ul className="md:hidden divide-y divide-hairline">
              {(projectQuotes ?? []).map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {p.customer_id ? (
                        <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline block truncate">{p.customer_name}</Link>
                      ) : (
                        <span className="font-medium text-ink block truncate">{p.customer_name}</span>
                      )}
                      <Link href={`/projects/${p.id}` as never} className="text-[11px] text-ink-2 hover:text-amber-ink hover:underline block truncate">{p.title}</Link>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button type="button" aria-label="Actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink shrink-0">
                          <Icon name="more_h" size={18} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[12rem]">
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/projects/${p.id}` as any)}>
                          <Icon name="eye" size={15} /> Open project
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => window.open(`/project-quote/${p.id}`, "_blank", "noopener")}>
                          <Icon name="file" size={15} /> Preview quote (customer view)
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditProject(p)}>
                          <Icon name="edit" size={15} /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={async () => {
                          if (await confirm({ title: `Delete project "${p.title}"?`, body: "This removes the project + its milestone schedule. (Blocked if any milestone is already invoiced — delete that invoice first.)\n\nThis cannot be undone.", confirmLabel: "Delete", danger: true })) {
                            deleteProject.mutate(p.id);
                          }
                        }}>
                          <Icon name="trash" size={15} /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-2">
                    <Badge kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} size="sm" dot>
                      {p.status === "quoted" ? "Quotation" : p.status}
                    </Badge>
                    <div className="text-right">
                      <span className="font-serif text-base tabular-nums text-ink">{rupee(p.total_amount)}</span>
                      {p.receivable > 0 && <span className="block text-[10px] text-rose">{rupee(p.receivable)} due</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="hidden md:block overflow-auto max-h-[calc(100vh-15rem)]">
              <table className="w-full text-sm min-w-[620px]">
                <thead className="sticky top-0 z-10 bg-paper-2 border-b border-hairline text-[10px] uppercase tracking-wider text-ink-3">
                  <tr>
                    <th className="text-left px-4 py-2.5">Customer / Project</th>
                    <th className="text-left px-3 py-2.5">Type</th>
                    <th className="text-right px-3 py-2.5">Amount (incl GST)</th>
                    <th className="text-right px-3 py-2.5">Outstanding</th>
                    <th className="text-left px-4 py-2.5">Status</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {(projectQuotes ?? []).map((p) => (
                    <tr key={p.id} className="hover:bg-paper-2/40">
                      <td className="px-4 py-3">
                        {p.customer_id ? (
                          <Link href={`/customers/${p.customer_id}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline">{p.customer_name}</Link>
                        ) : (
                          <span className="font-medium text-ink">{p.customer_name}</span>
                        )}
                        <span className="text-ink-3"> · </span>
                        <Link href={`/projects/${p.id}` as never} className="text-ink-2 hover:text-amber-ink hover:underline">{p.title}</Link>
                      </td>
                      <td className="px-3 py-3"><Badge kind="info" size="sm">Project</Badge></td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-ink">{rupee(p.total_amount)}</td>
                      <td className="px-3 py-3 text-right tabular-nums"><span className={p.receivable > 0 ? "text-rose" : "text-emerald"}>{rupee(p.receivable)}</span></td>
                      <td className="px-4 py-3">
                        <Badge kind={p.status === "completed" ? "success" : p.status === "cancelled" ? "muted" : p.status === "quoted" ? "info" : "warning"} size="sm" dot>
                          {p.status === "quoted" ? "Quotation" : p.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" aria-label="Actions" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
                              <Icon name="more_h" size={18} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[12rem]">
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/projects/${p.id}` as any)}>
                              <Icon name="eye" size={15} /> Open project
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => window.open(`/project-quote/${p.id}`, "_blank", "noopener")}>
                              <Icon name="file" size={15} /> Preview quote (customer view)
                            </DropdownMenuItem>
                            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditProject(p)}>
                              <Icon name="edit" size={15} /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={async () => {
                              if (await confirm({ title: `Delete project "${p.title}"?`, body: "This removes the project + its milestone schedule. (Blocked if any milestone is already invoiced — delete that invoice first.)\n\nThis cannot be undone.", confirmLabel: "Delete", danger: true })) {
                                deleteProject.mutate(p.id);
                              }
                            }}>
                              <Icon name="trash" size={15} /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <EmptyState icon="package" title="No project quotations yet"
            body="One-time / custom-software project quotes show here. Create one from Project Sales → New quotation."
            action={<Button variant="primary" icon="file" onClick={() => router.push("/projects" as never)}>Project Sales</Button>} />
        )
      )}

      {view === "subscription" && (
        <>
          {/* Collapsible KPI & Quote Intelligence Banner */}
          {!isLoading && quotes && quotes.length > 0 && (
            <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
              <button
                type="button"
                onClick={() => setKpiOpen((o) => !o)}
                className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Icon name="bar_chart" size={15} className="text-amber-ink" />
                  <span className="font-semibold text-ink">Quote Analytics &amp; Intelligence</span>
                  <span className="text-ink-3">·</span>
                  <span className="text-ink-2 font-mono font-medium">Pipeline: <b className="text-amber-ink">{rupee(totalValue, { compact: true })}</b></span>
                  <span className="text-ink-3 font-mono">·</span>
                  <span className="text-ink-2 font-mono font-medium">Out for Review: <b className="text-ink">{rupee(sentValue, { compact: true })}</b> ({sentishCount})</span>
                  <span className="text-ink-3 font-mono">·</span>
                  <span className="text-ink-2 font-mono font-medium">Accepted: <b className="text-emerald">{rupee(acceptedValue, { compact: true })}</b> ({acceptedCount})</span>
                </div>
                <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
                  <span>{kpiOpen ? "Collapse" : "Expand"}</span>
                  <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
                </div>
              </button>

              {kpiOpen && (
                <div className="p-3 border-t border-hairline space-y-3 bg-paper">
                  {/* Interactive KPI Stat Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setTab("all")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Pipeline</p>
                      <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(totalValue, { compact: true })}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab("sent")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-amber/60 transition-all cursor-pointer"
                    >
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Out for review</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{rupee(sentValue, { compact: true })}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab("accepted")}
                      className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left hover:border-emerald/60 transition-all cursor-pointer"
                    >
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Accepted</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(acceptedValue, { compact: true })}</p>
                    </button>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Pipeline Margin</p>
                      <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(pipelineMargin, { compact: true })}</p>
                      {/* A total that silently drops the unknowns reads as a complete
                          measurement of the pipeline when it is a partial one. */}
                      {pipelineMarginUnknownCount > 0 && (
                        <p className="mt-0.5 text-[10px] leading-snug text-amber-ink">
                          {pipelineMarginUnknownCount} quote{pipelineMarginUnknownCount === 1 ? "" : "s"} excluded — no cost
                        </p>
                      )}
                    </div>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Win Rate</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{winRate}%</p>
                    </div>
                    <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                      <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Total Quotes</p>
                      <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{quotes.length}</p>
                    </div>
                  </div>

                  {/* Quote Intelligence */}
                  {expiringCount > 0 && (
                    <GeminiCard
                      title="Quote intelligence"
                      actions={
                        <Button
                          size="sm"
                          variant="primary"
                          icon="mail"
                          onClick={() => {
                            toast.success(`Nudge sent for ${expiringCount} expiring quotes`);
                          }}
                        >
                          Nudge expiring quotes
                        </Button>
                      }
                      compact
                    >
                      <b>{expiringCount} quote{expiringCount === 1 ? "" : "s"} out for review.</b> Expiring within 7 days are highest priority — send a nudge to those customers.
                    </GeminiCard>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Sticky Horizontal TabBar + Date Range + Search */}
          {!isLoading && quotes && quotes.length > 0 && (
            <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
              <TabBar className="overflow-y-hidden" value={tab} onChange={setTab} items={tabs} />
              <div className="flex justify-between items-center gap-3 flex-wrap">
                <div className="text-xs text-ink-3">
                  Showing {filtered.length} of {counts.all ?? 0} quote{counts.all === 1 ? "" : "s"}
                  {/* Beside the count on purpose: the count is the thing the toggle
                      changes, and a filter whose effect is shown somewhere else on the
                      page reads as the list being wrong. */}
                  <TeamViewToggle
                    className="mt-1.5"
                    me={meMember}
                    all={team}
                    mode={teamMode}
                    onChange={setTeamMode}
                    /* False until 20260818150000_user_hierarchy_visibility.sql is applied.
                       One flag, one call site, so the caveat disappears everywhere the day
                       the database actually enforces it. */
                    enforcedInDatabase={HIERARCHY_ENFORCED_IN_DATABASE}
                    /* This page is why the counts exist: every quote in the live books has a
                       NULL owner, so both halves of the toggle show the same rows and the
                       note used to call them "assigned to you". */
                    counts={{
                      total: (quotes ?? []).length,
                      unassigned: (quotes ?? []).filter((q) => !q.owner_id).length,
                    }}
                  />
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <div className="w-full sm:w-64">
                    <Input
                      prefix={<Icon name="search" size={14} />}
                      placeholder="Quote ID, customer, product…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load quotes"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
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
      {!isLoading && !error && quotes && quotes.length === 0 && (
        <EmptyState
          icon="file"
          title="No quotes yet"
          body="Quotes will appear here once you create your first quote for a customer."
          action={
            <Button asChild variant="primary" icon="plus">
              <Link href={"/quotes/new" as any}>Create your first quote</Link>
            </Button>
          }
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && quotes && quotes.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No quotes match"
            body={search ? `No results for "${search}".` : `No quotes in "${tab}" status.`}
            action={<Button icon="x" onClick={() => { setTab("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Adaptive card list — phones, tablets, and medium viewports (< 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="xl:hidden space-y-2 mb-3">
          {filtered.map((q) => {
            const uStatus = unifiedStatus(q);
            const note = cashNote(q);
            const dl = q.expires_date ? daysBetween(new Date(), q.expires_date) : null;
            return (
              <li key={q.id}>
                <Link
                  href={`/quotes/${q.id}` as never}
                  className="block bg-paper border border-hairline rounded-lg p-3.5 active:bg-paper-2/50 hover:border-amber/50 transition-colors"
                >
                  {/* Top row: ID + amount */}
                  <div className="flex items-start justify-between gap-3 mb-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono text-xs font-semibold text-ink">{q.id}</span>
                        {q.is_extension ? (
                          <Badge kind="warning" className="font-sans text-[10px]">
                            Extension · {Math.round((q.extension_months ?? 12) / 12)}yr
                          </Badge>
                        ) : q.is_renewal ? (
                          <Badge kind="info" className="font-sans text-[10px]">Renewal</Badge>
                        ) : q.is_add_seats ? (
                          <Badge kind="info" className="font-sans text-[10px]">Prorata</Badge>
                        ) : q.is_one_off ? (
                          <Badge kind="muted" className="font-sans text-[10px]">Direct invoice</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm font-semibold text-ink mt-1 truncate">
                        {cleanDisplayName(q.customer_name)}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-serif text-base font-bold tabular-nums text-ink">
                        {quoteMoney(q)}
                      </p>
                      <p className="text-[11px] text-ink-3 tabular-nums">
                        {q.seats ?? "—"} seats
                      </p>
                    </div>
                  </div>
                  {/* Bottom row: plan + status badges */}
                  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60">
                    <span className="text-xs text-ink-2 truncate font-medium">
                      {q.plan ?? "—"}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {dl !== null && dl >= 0 && dl <= 7 && q.status === "sent" && (
                        <Badge kind="warning" size="sm">
                          {dl}d left
                        </Badge>
                      )}
                      {/* The cash note never appeared on the card at all — only in the
                          desktop table. So below 1280px, where this card list IS the page,
                          a quote holding ₹20,000 showed a status badge and no money
                          anywhere. Same helper as the table, so the two cannot drift. */}
                      {note && (
                        <span className={cn(
                          "text-[10px] font-semibold tabular-nums",
                          note.tone === "owed" ? "text-rose" : "text-amber-ink",
                        )}>
                          {note.text}
                        </span>
                      )}
                      <Badge kind={uStatus.kind} size="sm" dot>{uStatus.label}</Badge>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
          <li className="pt-2 text-center text-[11px] text-ink-3">
            Showing {filtered.length} of {counts.all ?? 0} · Total {rupee(filtered.reduce((s, q) => s + (q.amount ?? 0), 0), { compact: true })}
          </li>
        </ul>
      )}

      {/* Desktop table — large viewports (>= 1280px) */}
      {!isLoading && !error && filtered.length > 0 && (
        <div className="hidden xl:block">
          <Card flush>
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline-strong">
                <tr>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Quote</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Customer</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider" title="Annual margin">Margin</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Validity</th>
                  <th className="px-2 py-2.5 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((q, rowIndex) => {
                  const margin = estimateMarginForQuote(q);
                  const uStatus = unifiedStatus(q);
                  const dl = q.expires_date ? daysBetween(new Date(), q.expires_date) : null;
                  const expiringSoon = dl !== null && dl >= 0 && dl <= 7;
                  const kbSelected = rowIndex === keys.index;
                  return (
                    <tr
                      key={q.id}
                      ref={kbSelected ? selectedRowRef : undefined}
                      onClick={() => router.push(`/quotes/${q.id}` as any)}
                      /* aria-selected, not only a tint: a screen reader has to know which
                         row Enter will open, and a background colour says nothing to it. */
                      aria-selected={kbSelected}
                      className={cn(
                        "group border-b border-hairline last:border-0 cursor-pointer transition-colors",
                        kbSelected
                          ? "bg-amber-soft/60 ring-1 ring-inset ring-amber/40"
                          : "hover:bg-paper-2/50",
                      )}
                    >
                      {/* Compact ID — the tail number as a chip; full ID on hover. */}
                      <td className="px-3 py-2.5 align-top" title={q.id}>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center rounded-md bg-paper-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
                            #{q.id.split("-").pop()}
                          </span>
                          {q.is_extension ? (
                            <Badge kind="warning" className="font-sans text-[10px]">
                              Ext · {Math.round((q.extension_months ?? 12) / 12)}yr
                            </Badge>
                          ) : q.is_renewal ? (
                            <Badge kind="info" className="font-sans text-[10px]">Renewal</Badge>
                          ) : q.is_add_seats ? (
                            <Badge kind="info" className="font-sans text-[10px]">Prorata</Badge>
                          ) : q.is_one_off ? (
                            <Badge kind="muted" className="font-sans text-[10px]">Direct invoice</Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="font-medium text-ink leading-snug break-words max-w-[220px]" title={cleanDisplayName(q.customer_name)}>{cleanDisplayName(q.customer_name)}</div>
                        {phoneSuffixOf(q.customer_name) && (
                          <div className="text-[10px] text-ink-3 tabular-nums mt-0.5">{phoneSuffixOf(q.customer_name)}</div>
                        )}
                      </td>
                      {/* Plan — wraps to a second line rather than truncating with "…". */}
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-top">
                        <div className="leading-snug break-words max-w-[240px]">{q.plan ?? "—"}</div>
                        {q.seats != null && (
                          <div className="text-[10px] text-ink-3 mt-0.5"><span className="font-semibold text-ink-2 tabular-nums">{q.seats}</span> seats</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right align-top">
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="tabular-nums text-sm font-medium text-ink">
                            {quoteMoney(q)}
                          </span>
                          {/* Foreign quote: show the ₹ base underneath so the amount
                              reconciles with the (all-INR) pipeline totals. */}
                          {isForeignCurrency(q.currency) && q.amount ? (
                            <span className="text-[10px] text-ink-3 tabular-nums">≈ {rupee(q.amount)}</span>
                          ) : null}
                        </div>
                      </td>
                      {/* Margin — colour-coded badge: green = healthy, amber =
                          thin, rose = risky. ₹ amount below for reference. */}
                      <td className="px-3 py-2.5 text-right align-top">
                        {!q.amount ? (
                          <span className="text-ink-3">—</span>
                        ) : !margin.known ? (
                          /* "Unknown" rather than the 100% a ₹0 cost arithmetically
                              produces — a green 100% badge is the most misleading
                              thing this column could show. */
                          <Badge kind="warning" size="sm" title="A line on this quote has no vendor cost.">
                            Unknown
                          </Badge>
                        ) : (
                          <div className="flex flex-col items-end gap-0.5">
                            <Badge
                              kind={margin.marginPct >= 18 ? "success" : margin.marginPct >= 14 ? "warning" : "danger"}
                              size="sm"
                            >
                              {margin.marginPct}%
                            </Badge>
                            <span className="text-[10px] text-ink-3 tabular-nums">{rupee(margin.margin)}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {(() => {
                          /* One call, not three. dueHint(q) was invoked three times per
                             row — once to test, once to compare, once to print — and the
                             comparison was against the literal "Awaiting payment", so
                             rewording that string would silently have turned every
                             outstanding balance the wrong colour. */
                          const note = cashNote(q);
                          return (
                            <div className="flex flex-col items-start gap-0.5">
                              <Badge kind={uStatus.kind} dot>{uStatus.label}</Badge>
                              {note && (
                                <span className={cn(
                                  "text-[10px] font-medium tabular-nums",
                                  note.tone === "owed" ? "text-rose" : "text-amber-ink",
                                )}>
                                  {note.text}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-sm align-top">
                        {q.status === "accepted" || q.status === "rejected" ? (
                          <span className="text-ink-3">—</span>
                        ) : dl === null ? (
                          <span className="text-ink-3">—</span>
                        ) : dl < 0 ? (
                          <Badge kind="danger" dot>Expired {Math.abs(dl)}d</Badge>
                        ) : expiringSoon ? (
                          <Badge kind="warning" dot>{dl}d left</Badge>
                        ) : (
                          <span className="text-xs text-ink-3 tabular-nums">{dl}d left</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          {q.status === "draft" && (
                            <Button asChild size="sm" variant="primary" icon="send">
                              <Link href={`/quotes/${q.id}` as any}>Send</Link>
                            </Button>
                          )}
                          {(q.status === "sent" || q.status === "viewed") && (
                            <div className="flex gap-1">
                              <Button
                                size="sm"
                                variant="primary"
                                icon="whatsapp"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const msg = encodeURIComponent(`Namaste ${q.customer_name},\n\nQuick follow up regarding Quote #${q.id} (${q.plan || "Google Workspace"}) for ₹${(q.amount ?? 0).toLocaleString("en-IN")}.\n\nPlease let us know if you need any clarification.\n\nDhanyavaad`);
                                  window.open(`https://web.whatsapp.com/send?text=${msg}`, "_blank");
                                }}
                              >
                                WhatsApp
                              </Button>
                              <Button asChild size="sm" icon="external">
                                <Link href={`/quotes/${q.id}` as any}>Open</Link>
                              </Button>
                            </div>
                          )}
                          {q.status === "accepted" && (() => {
                            // What happens NEXT on an accepted quote depends on
                            // how far the money flow has progressed. The button
                            // tells the operator exactly which step is pending.
                            const ps = q.payment_status;
                            if (ps === "invoiced") {
                              // Terminal — money flow complete, jump to the
                              // actual invoice (auto-opens that dialog via
                              // ?open=INV-XX deep link on /invoices)
                              return (
                                <Button asChild size="sm" icon="receipt">
                                  <Link
                                    href={
                                      q.invoice_id
                                        ? (`/invoices?open=${q.invoice_id}` as any)
                                        : (`/quotes/${q.id}` as any)
                                    }
                                  >
                                    Invoiced
                                  </Link>
                                </Button>
                              );
                            }
                            if (ps === "received") {
                              return (
                                <Button asChild size="sm" variant="primary" icon="receipt">
                                  <Link href={`/quotes/${q.id}` as any}>Generate invoice</Link>
                                </Button>
                              );
                            }
                            if (ps === "partial") {
                              return (
                                <Button asChild size="sm" icon="rupee">
                                  <Link href={`/quotes/${q.id}` as any}>Continue billing</Link>
                                </Button>
                              );
                            }
                            // 'none' or 'awaiting' — money hasn't started flowing yet
                            return (
                              <Button asChild size="sm" variant="primary" icon="rupee">
                                <Link href={`/quotes/${q.id}` as any}>Record payment</Link>
                              </Button>
                            );
                          })()}
                          {(q.status === "expired" || q.status === "rejected") && (
                            <Button asChild size="sm" icon="copy">
                              <Link href={`/quotes/new` as any}>Re-quote</Link>
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                icon="more_h"
                                size="sm"
                                variant="ghost"
                                aria-label={`Actions for quote ${q.id}`}
                              />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[13rem]">
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setPreviewing(q)}>
                                <Icon name="file" size={15} /> View PDF preview
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="gap-2.5 py-2 cursor-pointer"
                                onClick={() => {
                                  const url = `${window.location.origin}/quotes/${q.id}`;
                                  navigator.clipboard.writeText(url);
                                  toast.success("Quote link copied to clipboard!");
                                }}
                              >
                                <Icon name="link" size={15} /> Copy quote link
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="gap-2.5 py-2 cursor-pointer text-emerald font-medium"
                                onClick={() => {
                                  const msg = encodeURIComponent(`Namaste ${q.customer_name},\n\nQuick follow up regarding Quote #${q.id} (${q.plan || "Google Workspace"}) for ₹${(q.amount ?? 0).toLocaleString("en-IN")}.\n\nPlease let us know if you need any clarification.\n\nDhanyavaad`);
                                  window.open(`https://web.whatsapp.com/send?text=${msg}`, "_blank");
                                }}
                              >
                                <Icon name="whatsapp" size={15} /> Send / nudge on WhatsApp
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/quotes/${q.id}` as any)}>
                                <Icon name="edit" size={15} /> Open / edit
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/quotes/${q.id}?send=1` as any)}>
                                <Icon name="send" size={15} /> Send / nudge
                              </DropdownMenuItem>
                              {(q.status === "accepted" || q.payment_status === "received") && q.payment_status !== "invoiced" && (
                                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/quotes/${q.id}` as any)}>
                                  <Icon name="receipt" size={15} /> Convert to invoice
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => handleDuplicate(q)}>
                                <Icon name="copy" size={15} /> Duplicate &amp; revise
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={() => handleDelete(q)}>
                                <Icon name="trash" size={15} /> Delete
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
            {/* Table footer: closes the empty space visually + summary */}
            <div className="flex items-center justify-between gap-3 flex-wrap border-t border-hairline px-4 py-3 bg-paper-2/30 text-xs text-ink-3">
              <div className="flex items-center gap-2">
                <Icon name="check_circle" size={12} className="text-emerald" />
                <span>End of list · Showing {filtered.length} of {counts.all ?? 0} quotes</span>
              </div>
              <div className="flex items-center gap-3">
                <span>
                  Pipeline value:{" "}
                  <b className="text-ink tabular-nums">
                    {rupee(filtered.reduce((s, q) => s + (q.amount ?? 0), 0), { compact: true })}
                  </b>
                </span>
                <span className="hidden sm:inline">·</span>
                <span className="hidden sm:inline">
                  Renewals:{" "}
                  <b className="text-ink tabular-nums">
                    {filtered.filter((q) => q.is_renewal && !q.is_extension).length}
                  </b>
                </span>
                {filtered.some((q) => q.is_extension) && (
                  <>
                    <span className="hidden sm:inline">·</span>
                    <span className="hidden sm:inline">
                      Extensions:{" "}
                      <b className="text-ink tabular-nums">
                        {filtered.filter((q) => q.is_extension).length}
                      </b>
                    </span>
                  </>
                )}
              </div>
            </div>
          </Card>

          {/* Help text — pushed to bottom via mt-auto when content is short */}
          <div className="flex items-center gap-1.5 text-xs text-ink-3 mt-3">
            <Icon name="info" size={11} />
            Click any row to open the quote. Hit the file icon for a quick PDF preview.
          </div>
          {/* Spacer that pushes everything else up when the page is short */}
          <div className="mt-auto" aria-hidden />
        </div>
      )}

      </>)}

      {/* Quick preview dialog (driven by the row's eye/file icon button).
          Rendered via a small fetching container so it can load the customer's
          state_code and derive the GST head (IGST vs CGST+SGST) accurately —
          the lean list query doesn't carry state_code. (audit #18-20) */}
      {previewing && (
        <QuotePreviewContainer
          quote={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}

      {/* Mobile FAB — primary action in the thumb zone (view-aware) */}
      {view === "project" ? (
        <FAB icon="plus" label="New quote" onClick={() => setProjectQuoteOpen(true)} />
      ) : (
        <FAB icon="plus" label="New quote" href="/quotes/new" />
      )}

      <CreateProjectQuoteDialog open={projectQuoteOpen} onOpenChange={setProjectQuoteOpen} />
      <CreateProjectQuoteDialog
        open={editProject !== null}
        onOpenChange={(o) => { if (!o) setEditProject(null); }}
        editProject={editProject}
      />

      {/* Appears only once a key has actually been pressed. A permanent bar across the
          bottom of every list is chrome an operator stops seeing within a day, and it
          costs 40px of a phone screen for ever. */}
      <KeyHintBar visible={keys.index >= 0} onShowHelp={() => setHelpOpen(true)} />
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

/**
 * QuotePreviewContainer — renders the quick quote preview. Lives in its own
 * component (not an inline IIFE) so it can use hooks: it fetches the quote's
 * customer to read `state_code` and derive the GST head (IGST vs CGST+SGST)
 * via the shared helper, matching the authoritative quote-detail / tax-invoice
 * surfaces. The quotes list query is lean and omits customer state, so the
 * lookup happens here, on demand, only when a preview is open. (audit #18-20)
 */
function QuotePreviewContainer({ quote, onClose }: { quote: Quote; onClose: () => void }) {
  const { data: currentUser } = useCurrentUser();
  const { data: customer }    = useCustomer(quote.customer_id ?? undefined);

  const items: QuoteLineItem[] = Array.isArray(quote.line_items) ? (quote.line_items as QuoteLineItem[]) : [];
  const discount = Math.round(quote.subtotal * (quote.discount_pct / 100));
  const taxable  = quote.subtotal - discount;
  const tax      = Math.round(taxable * (quote.tax_rate / 100));
  const total    = quote.amount ?? taxable + tax;
  const validity = quote.expires_date
    ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
    : 30;
  const interState = isInterStateSupply(customer?.state_code, currentUser?.tenantStateCode, { customerGstin: customer?.gstin, sellerGstin: currentUser?.tenantGstin });

  return (
    <QuotePreviewDialog
      open
      onOpenChange={(o) => !o && onClose()}
      tenantName={currentUser?.tenantName    ?? "Workspace"}
      tenantGstin={currentUser?.tenantGstin}
      tenantEmail={currentUser?.tenantEmail}
      tenantPhone={currentUser?.tenantPhone}
      tenantAddress={currentUser?.tenantAddress}
      quoteId={quote.id}
      customerName={quote.customer_name}
      contactName={null}
      contactEmail={null}
      contactPhone={null}
      lineItems={items}
      subtotal={quote.subtotal}
      discountPct={quote.discount_pct}
      discount={discount}
      taxable={taxable}
      taxRate={quote.tax_rate}
      tax={tax}
      total={total}
      interState={interState}
      validityDays={validity}
      notes={quote.notes ?? ""}
      isProspect={!!quote.lead_id}
    />
  );
}
