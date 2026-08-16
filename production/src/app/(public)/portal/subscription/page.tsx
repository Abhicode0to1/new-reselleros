"use client";

/**
 * /portal/subscription — view + manage active subscription.
 *
 * Customer can:
 *   • See plan, seats, MRR, next renewal
 *   • Toggle auto-renewal on/off
 *   • Request a seat change (creates a support ticket of type 'plan_change')
 *
 * RLS scopes everything to their own customer_id.
 */
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee, formatDate, daysBetween } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { SeatUsage } from "../_components/seat-usage";

interface Sub {
  id:                 string;
  tenant_id:          string;
  customer_id:        string | null;
  customer_name:      string;
  plan:               string;
  vendor:             string;
  seats:              number;
  used:               number;
  mrr:                number;
  start_date:         string | null;
  renewal_date:       string | null;
  status:             string;
  outstanding_amount: number;
  auto_renew:         boolean;
}

const changeSchema = z.object({
  newSeats:    z.coerce.number().int().min(1).max(10000),
  effectiveOn: z.string().min(1, "When?"),
  note:        z.string().optional(),
});
type ChangeData = z.infer<typeof changeSchema>;

/* newTicketId() lived here to mint a support-ticket id for seat changes. Seat
   changes are structured rows now (seat_requests) whose id Postgres generates, so
   the helper is gone rather than left as dead code someone reuses later — its
   Date.now()+random scheme is not the id format anything else here uses. */

export default function PortalSubscriptionPage() {
  const [subs, setSubs]               = React.useState<Sub[] | null>(null);
  const [changeOpen, setChangeOpen]   = React.useState(false);
  const [activeForChange, setActiveForChange] = React.useState<Sub | null>(null);

  // Fetch on mount
  React.useEffect(() => {
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("subscriptions")
        .select("id, tenant_id, customer_id, customer_name, plan, vendor, seats, used, mrr, start_date, renewal_date, status, outstanding_amount, auto_renew")
        .order("renewal_date", { ascending: true });
      if (error) {
        toast.error(error.message);
        return;
      }
      setSubs((data ?? []) as Sub[]);
    })();
  }, []);

  // NOTE: auto-renew is intentionally NOT a customer-facing toggle. In a
  // manual-pay model (no stored-card autopay) "auto-renew" would falsely imply
  // auto-charge, and a silent customer toggle to OFF = silent churn the reseller
  // never sees. Renewal mode is shown read-only; stopping a renewal is an
  // explicit request (ticket) so the operator is looped in. (See the matrix
  // auto-renew analysis.)
  function openChange(sub: Sub) {
    setActiveForChange(sub);
    setChangeOpen(true);
  }

  if (!subs) {
    return (
      <div className="max-w-[1080px] mx-auto px-6 py-8">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const activeSubs = subs.filter((s) => s.status === "active");

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Your subscription</h1>
        <p className="text-sm text-ink-3 mt-1">
          Manage your plan, seats, and renewal settings.
        </p>
      </div>

      {activeSubs.length === 0 ? (
        <Card className="p-8 text-center text-sm text-ink-3">
          No active subscription on file. Raise a request on the{" "}
          <Link href="/portal/support" className="text-amber-ink underline">Support</Link>{" "}
          tab if you expect one to be here.
        </Card>
      ) : (
        <div className="space-y-4">
          {activeSubs.map((sub) => {
            const today = new Date().toISOString().slice(0, 10);
            const daysToRenewal = sub.renewal_date ? daysBetween(today, sub.renewal_date) : null;
            return (
              <Card key={sub.id} className="p-6">
                <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1">
                      {sub.vendor === "google" ? "Google Workspace" :
                       sub.vendor === "microsoft" ? "Microsoft 365" :
                       sub.vendor === "zoho" ? "Zoho" : "Subscription"}
                    </div>
                    <h2 className="font-serif text-2xl text-ink leading-tight">{sub.plan}</h2>
                    <div className="text-xs text-ink-3 mt-1">
                      {sub.seats} {sub.seats === 1 ? "user" : "users"} ·{" "}
                      Started {sub.start_date ? formatDate(sub.start_date) : "—"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-serif text-2xl text-ink leading-none">{rupee(sub.mrr)}</div>
                    <div className="text-[11px] text-ink-3 mt-1">/month equivalent</div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-hairline text-sm mb-5">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Next renewal</div>
                    <div className="font-medium text-ink">
                      {sub.renewal_date ? formatDate(sub.renewal_date) : "—"}
                    </div>
                    {daysToRenewal !== null && (
                      <div className={`text-[11px] mt-0.5 ${daysToRenewal <= 30 ? "text-amber-ink" : "text-ink-3"}`}>
                        {daysToRenewal <= 0
                          ? "Overdue"
                          : `In ${daysToRenewal} ${daysToRenewal === 1 ? "day" : "days"}`}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Outstanding</div>
                    <div className={`font-medium ${sub.outstanding_amount > 0 ? "text-rose" : "text-emerald"}`}>
                      {sub.outstanding_amount > 0 ? rupee(sub.outstanding_amount) : "Nil"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Renewal</div>
                    {sub.auto_renew ? (
                      <>
                        <div className="font-medium text-emerald">On track</div>
                        <div className="text-[10px] text-ink-3 mt-0.5 leading-snug">
                          We&apos;ll prepare your renewal quote + remind you before the date.
                          You pay each renewal — <b className="text-ink-2">we never auto-charge</b>.
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-medium text-amber-ink">Not renewing</div>
                        <div className="text-[10px] text-ink-3 mt-0.5 leading-snug">
                          Will lapse on the renewal date. Want to continue? Raise a request below.
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {sub.seats > 0 && (
                  <div className="mb-5">
                    <SeatUsage used={sub.used ?? 0} seats={sub.seats} />
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => openChange(sub)}>
                    <Icon name="users" size={14} className="mr-1.5" />
                    Request seat change
                  </Button>
                  <Button asChild variant="default">
                    <Link href="/portal/support/new">
                      <Icon name="ticket" size={14} className="mr-1.5" />
                      Cancel / other request
                    </Link>
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Seat change form (renders inline as modal-ish card) */}
      {changeOpen && activeForChange && (
        <SeatChangeForm
          sub={activeForChange}
          onClose={() => { setChangeOpen(false); setActiveForChange(null); }}
        />
      )}

      <div className="mt-6 p-4 bg-paper-2/40 rounded-md text-xs text-ink-3 leading-relaxed">
        <Icon name="info" size={12} className="text-indigo inline mr-1 align-text-bottom" />
        <b className="text-ink">How renewals &amp; changes work:</b> Renewals are manual — we prepare
        your renewal quote and remind you before each cycle; you pay then (we never auto-charge a
        card). Seat / plan changes and cancellations go through us as a ticket — we&apos;ll
        WhatsApp / email within 4 business hours.
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Seat change form — fixed-position modal-like card
// ────────────────────────────────────────────────────────────────

function SeatChangeForm({ sub, onClose }: { sub: Sub; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ChangeData>({
    resolver: zodResolver(changeSchema),
    defaultValues: { newSeats: sub.seats, effectiveOn: today },
  });

  /**
   * Raise the request as STRUCTURED DATA.
   *
   * This used to write a support_tickets row whose body said "Requested: 30 users
   * (+20)" in English. Every number a rep needed was in there as prose, so acting on
   * it meant re-reading it and re-keying the seat count into the Add Seats dialog —
   * and nothing linked the request to the quote that eventually came out of it. It
   * now goes to `seat_requests`, where approval is one click and the quote id is
   * written back. See migration 20260816150000.
   *
   * Through the server: the portal session has no `users` row, so the table has no
   * anon insert policy, and tenant/customer/current-seats are read from the
   * subscription rather than trusted from here.
   */
  async function onSubmit(values: ChangeData) {
    try {
      const res = await fetch("/api/portal/seat-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription_id: sub.id,
          requested_seats: values.newSeats,
          effective_on: values.effectiveOn,
          note: values.note || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not raise the request");
        return;
      }
      const delta = values.newSeats - sub.seats;
      toast.success(
        delta > 0
          ? `Request sent — ${delta} more ${delta === 1 ? "seat" : "seats"}.`
          : "Request sent.",
        {
          description: delta > 0
            ? "We will confirm the pro-rata amount and add them. The price depends on how much of your term is left, so it is worked out when we approve."
            : "Seat reductions are handled by a person — we will call you.",
          duration: 8000,
        },
      );
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink/40 z-40 grid place-items-center p-4" onClick={onClose}>
      <Card className="max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4">
          <h2 className="font-serif text-xl text-ink leading-tight">Request seat change</h2>
          <p className="text-xs text-ink-3 mt-1">
            Currently: <b>{sub.seats} users</b> on {sub.plan}
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="New seat count" required htmlFor="newSeats">
            <Input
              id="newSeats"
              type="number"
              min={1}
              max={10000}
              error={errors.newSeats?.message}
              {...register("newSeats")}
            />
          </FormField>

          <FormField label="Effective from" required htmlFor="effectiveOn">
            <Input
              id="effectiveOn"
              type="date"
              error={errors.effectiveOn?.message}
              {...register("effectiveOn")}
            />
          </FormField>

          <FormField label="Anything else?" htmlFor="note">
            <Textarea
              id="note"
              rows={3}
              placeholder="e.g., adding 5 marketing users, removing 2 ex-employees..."
              {...register("note")}
            />
          </FormField>

          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              Submit request
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
