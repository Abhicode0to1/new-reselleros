"use client";

/**
 * A portal customer who lands in the STAFF app gets told so, and gets a way out.
 *
 * ─── THE DEAD END THIS REPLACES, MEASURED ───────────────────────────────────
 * `middleware.ts` gates every staff route on having a SESSION. A signed-in portal
 * customer has one — a perfectly valid Supabase session — so the middleware waves
 * them through. Then `useCurrentUser()` looks them up in `users` (which holds
 * STAFF), finds nothing, and `useIdentity()` reports `stranded`. The result is the
 * whole staff shell rendered around an empty page, with "No workspace yet" in the
 * sidebar corner.
 *
 * Nothing leaks: every RLS policy on the staff side is
 * `tenant_id = current_tenant_id()`, which resolves through `users` and is
 * therefore NULL for a customer, so every query returns zero rows. This is a §24
 * problem, not a security one — but §24 is not a small thing here. The customer
 * sees a broken-looking application, has no idea why, and no way back to the
 * portal except retyping a URL they may never have typed in the first place
 * (they arrive from an emailed link).
 *
 * ─── WHY IT GUARDS ONLY THE ALREADY-BROKEN STATE ────────────────────────────
 * The probe below runs ONLY when identity is `stranded`. That is deliberate and
 * it is the whole safety argument: for staff — every real user of this app — this
 * component makes no query and changes nothing. It cannot slow down or break the
 * staff app, because on the staff path it never does anything.
 *
 * ─── `stranded` HAS TWO CAUSES AND THEY NEED OPPOSITE ANSWERS ───────────────
 * A brand-new staff signup is also stranded, in the seconds before their tenant
 * is provisioned — see `(auth)/signup/page.tsx`, which shows a wait for exactly
 * that. Sending THEM to a customer portal they have no account on would be a
 * worse dead end than the one being fixed. So the probe asks a specific question
 * — "is this auth user a row in `customer_users`?" — and only a yes takes over
 * the screen. A no falls through to the existing behaviour untouched.
 */

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useIdentity } from "@/lib/hooks/useCurrentUser";
import { Button } from "@/components/ui/button";

interface PortalCustomerIdentity {
  email: string | null;
  tenantName: string | null;
}

export function StaffAreaGuard({ children }: { children: React.ReactNode }) {
  const identity = useIdentity();
  const stranded = identity.status === "stranded";

  const probe = useQuery({
    queryKey: ["staff-area-guard", "is-portal-customer"],
    /* The one thing that makes this component free for staff. */
    enabled: stranded,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<PortalCustomerIdentity | null> => {
      const supabase = createClient();
      const { data } = await supabase
        .from("customer_users")
        .select("email, tenants!customer_users_tenant_id_fkey(name)")
        /* No `.eq()` on the id: RLS policy `customer_users_select_self`
           (auth_user_id = auth.uid()) already scopes this to the caller's own
           row, and there is exactly one — `auth_user_id` is UNIQUE.

           The embed names its constraint. Three foreign keys leave this table,
           one of them to `tenants`; a bare `tenants(name)` works today and would
           break with HTTP 300 / PGRST201 the day a second path appears, which is
           precisely how identity broke for every user once before — see the
           comment on USER_WITH_TENANT_SELECT. */
        .maybeSingle();

      if (!data) return null;
      const tenant = Array.isArray(data.tenants) ? data.tenants[0] : data.tenants;
      return { email: data.email ?? null, tenantName: tenant?.name ?? null };
    },
  });

  /* Anything other than a CONFIRMED portal customer renders the app exactly as
     before — including while the probe is in flight, and including a probe that
     failed. A guard that blanks the screen on an inconclusive answer would be a
     worse bug than the one it fixes. */
  if (!stranded || !probe.data) return <>{children}</>;

  const business = probe.data.tenantName;

  return (
    <div className="min-h-screen bg-paper-2/50 grid place-items-center px-6 py-12">
      <div className="max-w-[520px] w-full rounded-lg border border-hairline bg-paper p-8">
        {/* WHAT happened. */}
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">
          This part is for staff
        </h1>

        {/* WHY — named specifically, so it reads as an explanation and not a refusal. */}
        <p className="text-sm text-ink-3 mt-3">
          You are signed in as{" "}
          <span className="font-mono text-ink">{probe.data.email ?? "a customer"}</span>
          {business ? (
            <>
              , which is a customer account with{" "}
              <span className="text-ink font-medium">{business}</span>.
            </>
          ) : (
            <>, which is a customer account.</>
          )}{" "}
          The page you opened belongs to the team&rsquo;s own workspace, so there is nothing
          here for you to see — everything of yours lives in your dashboard.
        </p>

        {/* WHAT TO DO NEXT, with the button. */}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild variant="primary">
            <Link href="/portal/dashboard">Go to your dashboard</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/portal/support">Get help</Link>
          </Button>
        </div>

        <p className="text-2xs text-ink-3 mt-6">
          Nothing is wrong with your account. You most likely followed a link meant for
          {business ? ` the ${business} team` : " the team"}.
        </p>
      </div>
    </div>
  );
}
