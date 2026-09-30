/**
 * Who sees deal money outside /deals (dashboard strip, Reports Deals card, /today rows).
 *
 * Exactly the roles the nav lets open /deals — read from nav.ts, not copied, so the strip
 * can never show a role a number whose screen it cannot open.
 */
import { allowedRoutesForRole, type UserRole } from "@/lib/nav";

export function canSeeDeals(role: string | null | undefined): boolean {
  if (!role) return false;
  return allowedRoutesForRole(role as UserRole).includes("/deals");
}
