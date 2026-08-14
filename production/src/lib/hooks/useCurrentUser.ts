/**
 * useCurrentUser — fetches the logged-in user + their tenant name.
 * Used by Sidebar and TopBar to show real names instead of hardcoded "Excel Technologies".
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { GstinVerification } from "@/lib/supabase/database.types";
import { isPlatformAdmin } from "@/lib/platform";

export interface CurrentUserInfo {
  userId:        string;
  authEmail:     string;
  /** ResellerOS founder (cross-tenant signups panel). Server re-checks too. */
  isPlatformAdmin: boolean;
  fullName:      string | null;
  initials:      string | null;
  color:         string | null;
  role:          string | null;
  /** Migration 0045 — sales-role extension flag. Owner/manager ignore this. */
  canViewDeals:  boolean;
  tenantId:      string;
  tenantName:    string;
  tenantLogoUrl: string | null;
  /** Tenant billing identity — used by Receipt Voucher / Invoice PDFs */
  tenantGstin:   string | null;
  tenantEmail:   string | null;
  tenantPhone:   string | null;
  tenantAddress: string | null;
  tenantPinCode: string | null;
  tenantState:   string | null;
  tenantStateCode: string | null;
  /** Owner / signing person on the GST invoice */
  tenantContactName: string | null;
  /** LUT number + validity for zero-rated exports (CGST Rule 96A). */
  tenantLutNumber: string | null;
  tenantLutValidUpto: string | null;
  tenantUpiVpa: string | null;
  tenantUpiPayeeName: string | null;
  /** Days of buffer between renewal_date and auto-suspend (0–30). */
  tenantGracePeriodDays: number;
  /** When Setup Wizard's final step ran. NULL = wizard never completed. */
  tenantSetupCompletedAt: string | null;
  /** When the GSTIN was last verified against GSTN via 3rd-party API. */
  tenantGstinVerifiedAt: string | null;
  /** Cached verification payload (legal name, status, registration type, …). */
  tenantGstinVerification: GstinVerification | null;
}

/**
 * Who is at the keyboard — and, when nobody useful is, WHY.
 *
 * ─── WHY THIS EXISTS SEPARATELY FROM useCurrentUser ──────────────────────────
 * `useCurrentUser` returns `null` for three completely different situations: no
 * session, a session whose account has no `public.users` row, and a failed query.
 * Every consumer then renders the same `?? "Loading…"` fallback, so all three look
 * identical and look temporary — a spinner that never resolves.
 *
 * The second case is not hypothetical. On 14 Aug 2026 twelve auth accounts could
 * sign in and had no profile. Every one of them would land in the app, see
 * "Loading… / Workspace" forever, and have no way to learn that the fix is for an
 * owner to claim them on /team. An app that cannot say "I don't know who you are"
 * cannot tell you what to do about it.
 *
 * Kept as its own hook so `useCurrentUser`'s return type is unchanged and no
 * existing caller has to be touched.
 */
export type IdentityStatus = "loading" | "anonymous" | "stranded" | "member";

export function useIdentity(): { status: IdentityStatus; email: string | null } {
  const { data, isLoading } = useCurrentUser();
  const auth = useQuery({
    queryKey: ["current-user", "auth-only"],
    queryFn: async (): Promise<{ email: string | null } | null> => {
      const { data: authData } = await createClient().auth.getUser();
      return authData?.user ? { email: authData.user.email ?? null } : null;
    },
    staleTime: 5 * 60_000,
  });

  if (isLoading || auth.isLoading) return { status: "loading", email: null };
  if (data) return { status: "member", email: data.authEmail };
  // Authenticated, but `useCurrentUser` found no profile → stranded, not anonymous.
  if (auth.data) return { status: "stranded", email: auth.data.email };
  return { status: "anonymous", email: null };
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async (): Promise<CurrentUserInfo | null> => {
      const supabase = createClient();

      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) return null;

      const { data: me, error } = await supabase
        .from("users")
        .select("id, tenant_id, full_name, initials, color, role, can_view_deals, tenants(name, logo_url, gstin, email, phone, address, pin_code, contact_name, state, state_code, lut_number, lut_valid_upto, upi_vpa, upi_payee_name, grace_period_days, setup_completed_at, gstin_verified_at, gstin_verification)")
        .eq("id", authData.user.id)
        .single();

      if (error || !me) return null;

      const tenant = Array.isArray(me.tenants) ? me.tenants[0] : me.tenants;

      return {
        userId:          me.id,
        authEmail:       authData.user.email ?? "",
        isPlatformAdmin: isPlatformAdmin(authData.user.email),
        fullName:        me.full_name,
        initials:        me.initials,
        color:           me.color,
        role:            me.role,
        canViewDeals:    Boolean(me.can_view_deals),
        tenantId:        me.tenant_id,
        tenantName:      tenant?.name ?? "Workspace",
        tenantLogoUrl:   (tenant as { logo_url?: string | null } | null)?.logo_url ?? null,
        tenantGstin:     tenant?.gstin     ?? null,
        tenantEmail:     tenant?.email     ?? null,
        tenantPhone:     tenant?.phone     ?? null,
        tenantAddress:   tenant?.address   ?? null,
        tenantPinCode:   tenant?.pin_code  ?? null,
        tenantState:     tenant?.state     ?? null,
        tenantStateCode: tenant?.state_code ?? null,
        tenantContactName: tenant?.contact_name ?? null,
        tenantLutNumber:    (tenant as { lut_number?: string | null } | null)?.lut_number ?? null,
        tenantLutValidUpto: (tenant as { lut_valid_upto?: string | null } | null)?.lut_valid_upto ?? null,
        tenantUpiVpa:       (tenant as { upi_vpa?: string | null } | null)?.upi_vpa ?? null,
        tenantUpiPayeeName: (tenant as { upi_payee_name?: string | null } | null)?.upi_payee_name ?? null,
        tenantGracePeriodDays: tenant?.grace_period_days ?? 0,
        tenantSetupCompletedAt: tenant?.setup_completed_at ?? null,
        tenantGstinVerifiedAt:  tenant?.gstin_verified_at  ?? null,
        tenantGstinVerification: (tenant?.gstin_verification as GstinVerification | null) ?? null,
      };
    },
    staleTime: 5 * 60_000,  // 5 min — identity rarely changes
  });
}
