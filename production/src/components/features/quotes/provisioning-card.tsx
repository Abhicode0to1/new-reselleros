"use client";

/**
 * What still has to be set up at the vendor, and a way to mark it done.
 *
 * ─── IT SAYS OUT LOUD THAT NOTHING IS AUTOMATIC ─────────────────────────────
 * The brief calls for "zero-touch provisioning". No Google CSP or Microsoft Partner
 * Center credential exists on this project, so nothing here calls a vendor. This card
 * says that in the first line rather than presenting manual work as an integration —
 * a rep who believes seats were created automatically will not create them, and the
 * customer finds out.
 *
 * The completion buttons are therefore real: a human did the work, a human records it,
 * and the name and timestamp are stored. When a vendor API is connected, the same rows
 * flow through it and this card starts showing progress instead of buttons.
 */
import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ProvisioningTask, QuoteLineItem } from "@/lib/supabase/database.types";
import { planProvisioning, provisionTaskTitle, vendorLabel, type ProvisionVendor } from "@/lib/provisioning/plan";
import { useExpandProvisioning, useUpdateProvisioning } from "@/lib/queries/provisioning";

export function ProvisioningCard({ tasks, quoteId, tenantId, lines, quoteDomain, userId }: {
  tasks: ProvisioningTask[];
  quoteId: string;
  tenantId: string;
  lines: QuoteLineItem[];
  quoteDomain: string | null;
  userId?: string;
}) {
  const expand = useExpandProvisioning();
  const update = useUpdateProvisioning();

  /* The trigger's unresolved row: raised on payment, not yet turned into per-line
     work. Recognised by having no vendor. */
  const placeholder = tasks.find((t) => !t.vendor && t.status === "pending");
  const real = tasks.filter((t) => t.vendor);
  const plan = React.useMemo(
    () => planProvisioning({ lines, fallbackDomain: quoteDomain }),
    [lines, quoteDomain],
  );

  if (tasks.length === 0) return null;

  const notRequired = tasks.every((t) => t.status === "not_required");

  return (
    <Card title="Setting up" sub="Seats to create at the vendor">
      {/* The honesty line. First thing, every time. */}
      <p className="mb-3 flex items-start gap-1.5 rounded-md bg-paper-2/60 px-2.5 py-2 text-[11px] leading-snug text-ink-2">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-ink-3" />
        <span>
          No reseller API is connected on this account, so these seats are created by hand.
          Nothing below happens automatically.
        </span>
      </p>

      {notRequired && (
        <p className="text-sm text-ink-3">Nothing on this quote needs setting up.</p>
      )}

      {placeholder && (
        <div className="rounded-lg border border-hairline bg-paper p-3">
          <p className="text-sm text-ink">
            This quote is paid. {plan.items.length > 0
              ? `${plan.items.length} ${plan.items.length === 1 ? "product" : "products"} to set up.`
              : "Nothing on it looks like a product that needs setting up."}
          </p>
          {plan.skipped.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {plan.skipped.map((s) => (
                <li key={s.name} className="text-[11px] leading-snug text-ink-3">
                  · <b className="text-ink-2">{s.name}</b> — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            className="mt-3"
            loading={expand.isPending}
            onClick={() =>
              expand.mutate(
                {
                  placeholderId: placeholder.id,
                  tenantId,
                  quoteId,
                  items: plan.items.map((i) => ({
                    vendor: i.vendor, plan: i.plan, seats: i.seats, domain: i.domain, mode: i.mode,
                  })),
                },
                { onSuccess: () => toast.success(plan.items.length ? "Set-up list ready." : "Marked as nothing to set up.") },
              )
            }
          >
            {plan.items.length > 0 ? "Build the set-up list" : "Mark as nothing to set up"}
          </Button>
        </div>
      )}

      {real.length > 0 && (
        <ul className="space-y-2">
          {real.map((t) => {
            const done = t.status === "done" || t.status === "not_required";
            return (
              <li
                key={t.id}
                className={cn(
                  "rounded-lg border p-3",
                  t.status === "failed" ? "border-rose/40 bg-rose-soft/30" : "border-hairline bg-paper",
                  done && "opacity-70",
                )}
              >
                <div className="flex items-start gap-2">
                  <Icon
                    name={done ? "check_circle" : t.status === "failed" ? "alert" : "clock"}
                    size={14}
                    className={cn("mt-0.5 shrink-0", done ? "text-emerald" : t.status === "failed" ? "text-rose" : "text-ink-3")}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm text-ink", done && "line-through")}>
                      {provisionTaskTitle({
                        vendor: (t.vendor ?? "other") as ProvisionVendor,
                        plan: t.plan ?? "—",
                        seats: t.seats ?? 0,
                        domain: t.domain,
                        mode: "manual",
                      })}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {vendorLabel((t.vendor ?? "other") as ProvisionVendor)}
                      {t.completed_at && ` · done ${new Date(t.completed_at).toLocaleDateString("en-IN")}`}
                    </p>
                    {t.error_message && (
                      <p className="mt-1 text-[11px] leading-snug text-rose">{t.error_message}</p>
                    )}
                  </div>
                </div>

                {!done && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: t.id, status: "done", userId })}
                    >
                      Mark created
                    </Button>
                    {t.status !== "in_progress" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: t.id, status: "in_progress", userId })}
                      >
                        Started
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: t.id, status: "not_required", userId })}
                    >
                      Not needed
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
