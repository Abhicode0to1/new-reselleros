/**
 * /support — reseller-side support & tenant feedback inbox.
 *
 * Platform Admins see ALL tickets and bug reports across all reseller workspaces
 * (including Ranjeet Raj, Pawan, Sales, Hitesh bug reports).
 * regular users see their tenant's tickets.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";
import type { SupportTicketRow, SupportTicketStatus } from "@/lib/supabase/database.types";

export type ViewScope = "tenant_feedback" | "team_testing";

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open:              "Open",
  in_progress:       "In progress",
  awaiting_customer: "Awaiting customer",
  resolved:          "Resolved",
  closed:            "Closed",
};

const STATUSES: ("all" | SupportTicketStatus)[] = ["open", "in_progress", "awaiting_customer", "resolved", "closed", "all"];

function useTickets(scope: ViewScope, statusFilter: "all" | SupportTicketStatus) {
  return useQuery({
    queryKey: ["support_tickets", scope, statusFilter],
    queryFn: async (): Promise<{ tickets: SupportTicketRow[]; counts: Record<string, number>; scopeCounts: Record<string, number> }> => {
      const res = await fetch(`/api/support/tickets?scope=${scope}&status=${statusFilter}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to load tickets");
      return res.json();
    },
  });
}

export default function SupportPage() {
  const [scope, setScope] = React.useState<ViewScope>("tenant_feedback");
  const [statusFilter, setStatusFilter] = React.useState<"all" | SupportTicketStatus>("open");
  const [selected, setSelected] = React.useState<SupportTicketRow | null>(null);

  const { data, isLoading, refetch } = useTickets(scope, statusFilter);
  const tickets = data?.tickets ?? [];
  const counts = data?.counts ?? { all: 0, open: 0, in_progress: 0, awaiting_customer: 0, resolved: 0, closed: 0 };
  const scopeCounts = data?.scopeCounts ?? { tenant_feedback: 0, team_testing: 0 };

  const qc = useQueryClient();

  const updateTicket = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Omit<SupportTicketRow, "id" | "tenant_id" | "created_at" | "updated_at">> }) => {
      const res = await fetch("/api/support/tickets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to update");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["support_tickets"] });
      toast.success("Ticket updated successfully");
      refetch();
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Engage & Feedback Inbox</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Support & Feedback Desk</h1>
          <p className="text-sm text-ink-3 mt-1">
            Manage feedback and support queries from Tenants / Customers + internal employee bug reports across all workspaces.
          </p>
        </div>

        {/* Primary View Switcher: Tenant Feedback vs Team Testing */}
        <div className="flex items-center gap-1.5 p-1 bg-paper-2 border border-hairline rounded-xl shadow-xs">
          <button
            type="button"
            onClick={() => { setScope("tenant_feedback"); setStatusFilter("open"); }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              scope === "tenant_feedback"
                ? "bg-paper text-primary shadow-sm border border-hairline"
                : "text-ink-3 hover:text-ink hover:bg-paper-3"
            }`}
          >
            <Icon name="building" size={15} />
            <span>🏢 Tenant / Customer Feedback</span>
            {scopeCounts.tenant_feedback > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
                {scopeCounts.tenant_feedback}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => { setScope("team_testing"); setStatusFilter("open"); }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              scope === "team_testing"
                ? "bg-rose-soft text-rose-ink shadow-sm border border-rose/30"
                : "text-ink-3 hover:text-ink hover:bg-paper-3"
            }`}
          >
            <Icon name="bug" size={15} />
            <span>🐛 Bug Reports &amp; Testing</span>
            {scopeCounts.team_testing > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose text-white font-bold">
                {scopeCounts.team_testing}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Sub-Status Pills */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => {
            const active = statusFilter === s;
            const count  = counts[s] ?? 0;
            const label = s === "all" ? "All Tickets" : STATUS_LABEL[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-all inline-flex items-center gap-2 ${
                  active
                    ? scope === "team_testing"
                      ? "border-rose bg-rose-soft text-rose-ink font-bold shadow-sm"
                      : "border-primary bg-primary-soft text-primary font-bold shadow-sm"
                    : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                }`}
              >
                <span>{label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${active ? "bg-paper font-bold" : "bg-paper-2 text-ink-3"}`}>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="text-xs text-ink-3 font-medium">
          Showing <span className="font-bold text-ink">{tickets.length}</span> {scope === "tenant_feedback" ? "Tenant/Customer Tickets" : "Bug Reports"}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : tickets.length === 0 ? (
        <Card className="py-10 text-center">
          <EmptyState
            icon={scope === "tenant_feedback" ? "building" : "bug"}
            title={scope === "tenant_feedback" ? "No Customer / Tenant Tickets Found" : "No Team Bug Reports Found"}
            body={
              scope === "tenant_feedback"
                ? "Feedback and support requests submitted by your Tenants & Clients on the portal will appear here."
                : "Bug reports and feature suggestions submitted by employees via the Report Bug button will appear here."
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <Card
              key={t.id}
              className={`p-4 md:p-5 transition-all cursor-pointer border-l-4 hover:shadow-md ${
                selected?.id === t.id
                  ? "border-l-primary bg-primary-soft/10"
                  : t.priority === "urgent" || t.priority === "high"
                  ? "border-l-rose bg-rose-soft/10"
                  : "border-l-amber bg-paper"
              }`}
              onClick={() => setSelected(t)}
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge kind={scope === "team_testing" ? "danger" : "info"} size="sm">
                      {scope === "team_testing" ? "BUG REPORT" : "TENANT FEEDBACK"}
                    </Badge>
                    <span className="font-bold text-sm text-ink truncate">{t.subject}</span>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-ink-3 flex-wrap">
                    <span>
                      Reporter: <strong className="text-ink-2">{t.customer_name || "Unknown"}</strong> ({t.raised_by_email || "no-email"})
                    </span>
                    <span>·</span>
                    <span>{formatDate(t.created_at, "short")}</span>
                    {t.priority && (
                      <>
                        <span>·</span>
                        <span className={`capitalize font-semibold ${t.priority === "urgent" || t.priority === "high" ? "text-rose" : "text-amber-dark"}`}>
                          Priority: {t.priority}
                        </span>
                      </>
                    )}
                  </div>

                  {t.body && (
                    <p className="text-xs text-ink-2 line-clamp-2 pt-1 font-mono bg-paper-2/40 p-2 rounded border border-hairline">
                      {t.body}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Badge kind={t.status === "open" ? "danger" : t.status === "resolved" ? "success" : "warning"}>
                    {STATUS_LABEL[t.status as SupportTicketStatus] ?? t.status}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateTicket.mutate({
                        id: t.id,
                        patch: { status: t.status === "resolved" ? "open" : "resolved" },
                      });
                    }}
                  >
                    {t.status === "resolved" ? "Re-open" : "Mark Resolved"}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Ticket Detail Modal — opens when any bug/ticket card is clicked */}
      {selected && (
        <div
          className="fixed inset-0 z-50 bg-ink/50 flex items-center justify-center p-4 backdrop-blur-xs overflow-y-auto"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-paper w-full max-w-2xl rounded-xl shadow-2xl border border-hairline p-6 max-h-[90vh] overflow-y-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-3 border-b border-hairline pb-4">
              <div className="space-y-1.5 min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge kind={scope === "team_testing" ? "danger" : "info"}>
                    {scope === "team_testing" ? "BUG REPORT" : "TENANT FEEDBACK"}
                  </Badge>
                  <Badge kind={selected.status === "open" ? "danger" : selected.status === "resolved" ? "success" : "warning"}>
                    {STATUS_LABEL[selected.status as SupportTicketStatus] ?? selected.status}
                  </Badge>
                  {selected.priority && (
                    <span className={`text-xs font-semibold capitalize px-2 py-0.5 rounded ${
                      selected.priority === "urgent" || selected.priority === "high" ? "bg-rose-soft text-rose" : "bg-amber-soft text-amber-ink"
                    }`}>
                      Priority: {selected.priority}
                    </span>
                  )}
                </div>
                <h2 className="font-serif text-xl md:text-2xl text-ink leading-snug break-words">
                  {selected.subject}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-ink-3 hover:text-ink p-1.5 rounded-md hover:bg-paper-2 transition-colors shrink-0"
              >
                <Icon name="x" size={20} />
              </button>
            </div>

            {/* Reporter Meta Details */}
            <div className="bg-paper-2/70 rounded-lg p-3.5 text-xs space-y-1.5 font-sans border border-hairline">
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-ink-3 font-medium">Reporter:</span>
                <span className="font-semibold text-ink">
                  {selected.customer_name || "Unknown"} ({selected.raised_by_email || "no-email"})
                </span>
              </div>
              <div className="flex justify-between flex-wrap gap-1">
                <span className="text-ink-3 font-medium">Reported Date:</span>
                <span className="text-ink font-mono">{formatDate(selected.created_at, "short")}</span>
              </div>
              {selected.resolved_at && (
                <div className="flex justify-between flex-wrap gap-1">
                  <span className="text-ink-3 font-medium">Resolved Date:</span>
                  <span className="text-emerald font-semibold font-mono">{formatDate(selected.resolved_at, "short")}</span>
                </div>
              )}
            </div>

            {/* Full Bug Description / Content */}
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-ink-3 uppercase tracking-wider">
                Full Bug Description &amp; Details
              </label>
              <div className="bg-paper-2/50 border border-hairline rounded-lg p-4 font-mono text-xs text-ink leading-relaxed whitespace-pre-wrap break-words max-h-[350px] overflow-y-auto shadow-inner">
                {selected.body || "No detailed description provided."}
              </div>
            </div>

            {/* Resolution Note Input */}
            <div className="space-y-1.5 pt-2 border-t border-hairline">
              <label htmlFor="resNote" className="block text-xs font-bold text-ink-3 uppercase tracking-wider">
                Resolution / Workaround Note
              </label>
              <textarea
                id="resNote"
                rows={3}
                placeholder="Enter details on how this bug was resolved or reply note..."
                defaultValue={(selected as any).resolution_note || ""}
                onChange={(e) => {
                  (selected as any).resolution_note = e.target.value;
                }}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-primary font-sans"
              />
            </div>

            {/* Modal Actions Footer */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-hairline">
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-3 font-medium">Status:</span>
                <select
                  value={selected.status}
                  onChange={(e) => {
                    const newStatus = e.target.value as SupportTicketStatus;
                    setSelected({ ...selected, status: newStatus });
                  }}
                  className="text-xs bg-paper border border-hairline rounded-md px-2.5 py-1.5 font-semibold text-ink focus:outline-none cursor-pointer"
                >
                  {STATUSES.filter((s) => s !== "all").map((s) => (
                    <option key={s} value={s}>{STATUS_LABEL[s as SupportTicketStatus]}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(null)}
                >
                  Close
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    updateTicket.mutate({
                      id: selected.id,
                      patch: {
                        status: selected.status,
                        resolution_note: (selected as any).resolution_note,
                      },
                    });
                    setSelected(null);
                  }}
                >
                  Save &amp; Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
