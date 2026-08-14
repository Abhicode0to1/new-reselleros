/**
 * Membership decision for a first-time sign-in. Pure + testable — this is the
 * security-critical branch of the OAuth callback: a brand-new Google user either
 * JOINS an existing tenant (only when an explicit owner invite matches their
 * email) or gets a fresh tenant of their own. No invite → never joins someone
 * else's tenant (tenant-leak guard, CLAUDE.md §4).
 */
// Was a THIRD copy of the role union ("owner" | "sales" | "accountant" |
// "support"), and the worst-placed one: this types the role an invite hands a
// brand-new user. It could not express manager, billing, delivery, sales_senior
// or partner_agent, so an invite carrying any of those was assigned a role this
// file said was impossible — in the one branch the header calls security
// critical. One source of truth now; see roles.ts.
import type { UserRole, InvitableRole } from "./roles";
export type { UserRole };

export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

export interface InviteMatch {
  tenant_id: string;
  role: InvitableRole;
}

export type MembershipDecision =
  | { mode: "join"; tenantId: string; role: InvitableRole }
  | { mode: "new" };

/**
 * @param invite the invite row matched by the user's (lower-cased) email, or null.
 * Only a non-empty tenant_id on a real invite triggers a join; everything else
 * falls through to creating a new tenant.
 */
export function decideMembership(invite: InviteMatch | null | undefined): MembershipDecision {
  if (invite && invite.tenant_id) {
    return { mode: "join", tenantId: invite.tenant_id, role: invite.role };
  }
  return { mode: "new" };
}
