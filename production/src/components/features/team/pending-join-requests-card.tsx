"use client";

/**
 * Pending join requests — the owner-facing half of the domain-match fix.
 *
 * ─── WHY THIS SITS ON THE DASHBOARD AND NOT ONLY ON /team ────────────────────
 * A join request is time-sensitive in a way most settings are not: until it is
 * approved, a colleague is locked out and their obvious workaround is to create a
 * company of their own — the exact failure the request exists to prevent. Waiting
 * for someone to wander into Settings would reintroduce it at one remove.
 *
 * It renders nothing at all when there is nothing pending, so it costs an
 * uncluttered dashboard only on the days it matters.
 *
 * The card reads `join_requests` directly under RLS, which is deliberate: the
 * WhatsApp and email alerts are how an owner finds out FAST, this is how they find
 * out AT ALL. A request is never lost because a notification failed to send.
 */

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { INVITABLE_ROLES, ROLE_LABEL } from "@/lib/auth/roles";
import type { JoinRequestRow } from "@/lib/supabase/database.types";

type PendingRow = Pick<
  JoinRequestRow,
  "id" | "email" | "full_name" | "requested_role" | "matched_by" | "note" | "created_at"
>;

export function usePendingJoinRequests() {
  return useQuery({
    queryKey: ["join-requests", "pending"],
    queryFn: async (): Promise<PendingRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("join_requests")
        .select("id, email, full_name, requested_role, matched_by, note, created_at")
        .eq("status", "pending_approval")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PendingRow[];
    },
  });
}

export function PendingJoinRequestsCard({ isOwner }: { isOwner: boolean }) {
  const { data, isLoading } = usePendingJoinRequests();
  const qc = useQueryClient();
  const [roles, setRoles] = React.useState<Record<string, string>>({});

  const decide = useMutation({
    mutationFn: async (vars: { id: string; action: "approve" | "reject"; role?: string }) => {
      const res = await fetch(`/api/team/join-requests/${vars.id}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ action: vars.action, role: vars.role }),
      });
      const json = await res.json() as {
        ok?: boolean; error?: string; email?: string; role?: string;
        action?: "approved" | "rejected";
      };
      if (!res.ok || json.error) throw new Error(json.error ?? "Could not save that.");
      return json;
    },
    onSuccess: (json) => {
      toast.success(
        json.action === "approved"
          ? `${json.email} added as ${json.role}`
          : `${json.email} was not added`,
      );
      void qc.invalidateQueries({ queryKey: ["join-requests"] });
      void qc.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (e: Error) => {
      // Guard messages already state the next step (CLAUDE.md §24); surface them
      // whole rather than replacing them with something generic.
      toast.error(e.message);
    },
  });

  // Nothing pending, still loading, or not the owner → render nothing. An
  // approve button that 403s is worse than no button.
  if (isLoading || !isOwner || !data || data.length === 0) return null;

  return (
    <Card className="border-amber/40">
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-soft">
          <Icon name="users" size={16} className="text-amber-ink" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-ink">
            {data.length === 1 ? "Someone is waiting to join" : `${data.length} people are waiting to join`}
          </h3>
          <p className="text-xs text-ink-3 leading-relaxed">
            They have no access until you approve. Until then they may create a separate
            workspace of their own by mistake.
          </p>
        </div>
      </div>

      <ul className="space-y-2">
        {data.map((r) => {
          const chosen = roles[r.id] ?? r.requested_role;
          return (
            <li
              key={r.id}
              className="rounded-md border border-hairline p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="text-sm text-ink truncate">
                  {r.full_name || r.email.split("@")[0]}
                </div>
                <div className="text-xs text-ink-3 font-mono truncate">{r.email}</div>
                <div className="text-2xs text-ink-3 mt-0.5">
                  {r.matched_by === "domain"
                    ? "Matched by your company's email domain"
                    : "Asked to join by name"}
                  {r.note ? ` · ${r.note}` : ""}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`role-${r.id}`}>Role</label>
                <select
                  id={`role-${r.id}`}
                  value={chosen}
                  onChange={(e) => setRoles((m) => ({ ...m, [r.id]: e.target.value }))}
                  className="h-9 rounded-md border border-hairline bg-paper px-2 text-xs text-ink"
                >
                  {INVITABLE_ROLES.map((role) => (
                    <option key={role} value={role}>{ROLE_LABEL[role]}</option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  className="h-9"
                  loading={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, action: "approve", role: chosen })}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  className="h-9"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: r.id, action: "reject" })}
                >
                  Not now
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
