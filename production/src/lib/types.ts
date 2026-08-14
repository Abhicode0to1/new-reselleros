/**
 * Shared TypeScript types across the app.
 * Database row types live in `lib/supabase/database.types.ts` (auto-generated).
 */

// ============================================================
// Branded types — prevent mixing different IDs
// ============================================================
export type Brand<T, B> = T & { __brand: B };

export type TenantId   = Brand<string, "TenantId">;
export type UserId     = Brand<string, "UserId">;
export type CustomerId = Brand<string, "CustomerId">;
export type LeadId     = Brand<string, "LeadId">;
export type QuoteId    = Brand<string, "QuoteId">;
export type InvoiceId  = Brand<string, "InvoiceId">;

// ============================================================
// Common enums (mirror DB enums)
// ============================================================
export type LeadStage =
  | "new"
  | "contacted"
  | "demo"
  | "trial"
  | "quote"
  | "won"
  | "lost";

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "accepted"
  | "rejected"
  | "expired";

export type InvoiceStatus = "draft" | "pending" | "paid" | "overdue" | "void";

export type SubscriptionStatus = "active" | "paused" | "expired" | "cancelled";

export type Vendor = "google" | "microsoft" | "zoho";

export type TierTone = "success" | "warning" | "danger" | "info" | "muted";

// Was a SECOND, disagreeing definition ("owner" | "sales" | "accountant" |
// "support") that nothing imported — which is the only reason it never caused a
// wrong answer. Re-exported from the one source of truth so it cannot drift
// again, and so an accidental import from here is still correct.
export type { UserRole } from "@/lib/auth/roles";

// ============================================================
// UI helpers
// ============================================================
export interface KpiData {
  label: string;
  value: string | number;
  unit?: string;
  trend?: string;
  trendKind?: "up" | "down" | "neutral";
  icon?: string;
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

// ============================================================
// Margin (the reseller moat)
// ============================================================
export interface Margin {
  cost: number;       // what reseller pays vendor (₹)
  price: number;      // what customer pays reseller (₹)
  margin: number;     // price - cost (₹)
  marginPct: number;  // 0-100
}
