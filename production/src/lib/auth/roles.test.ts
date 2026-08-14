/**
 * The role matrix, and the two invariants that make it safe to change.
 *
 * The interesting tests here are not "does owner get true" — they are the ones
 * that fail when somebody adds a role and forgets a second place: a role with no
 * reachable home (login loop), or a permission that quietly defaults to allowed.
 */
import { describe, it, expect } from "vitest";
import {
  USER_ROLES, PERMISSIONS, can, isUserRole, maskContact,
  type UserRole, type Permissions,
} from "./roles";
import { ROLE_HOME, allowedRoutesForRole } from "@/lib/nav";

const FLAGS: (keyof Permissions)[] = [
  "can_export_data", "can_view_contact_details", "can_reveal_vault",
  "can_view_financials", "can_manage_team", "can_manage_secrets",
];

describe("every role can actually reach its own home page", () => {
  // This is the login-loop guard. middleware redirects a disallowed route to
  // ROLE_HOME[role]; if that home is not in the role's allowed set it redirects
  // again, forever. Adding a role to USER_ROLES without a nav entry that admits
  // it produces exactly that, and it only shows up when a real person logs in.
  it.each(USER_ROLES)("%s has a home it is allowed to visit", (role) => {
    const home = ROLE_HOME[role as UserRole];
    expect(home, `${role} has no ROLE_HOME`).toBeTruthy();

    const allowed = allowedRoutesForRole(role as UserRole, { canViewDeals: true });
    const reachable = allowed.some((a) => home === a || home.startsWith(a + "/"));
    expect(reachable, `${role} would be redirected to ${home}, which it may not open — login loops`).toBe(true);
  });
});

describe("the matrix is complete and closed", () => {
  it("gives every role an explicit entry for every flag", () => {
    // Guards against a role inheriting permissions by omission.
    for (const role of USER_ROLES) {
      for (const flag of FLAGS) {
        expect(typeof PERMISSIONS[role as UserRole][flag], `${role}.${flag}`).toBe("boolean");
      }
    }
  });

  it("keeps bulk export to owner and manager only", () => {
    // Directive: one click on "Export CSV" is the whole customer book. If this
    // test starts failing, somebody widened the blast radius of a leaving laptop.
    const exporters = USER_ROLES.filter((r) => PERMISSIONS[r as UserRole].can_export_data);
    expect([...exporters].sort()).toEqual(["manager", "owner"]);
  });

  it("never lets a junior sales role read raw contact details", () => {
    expect(can("sales", "can_view_contact_details")).toBe(false);
    expect(can("partner_agent", "can_view_contact_details")).toBe(false);
  });

  it("lets delivery open the vault page but never reveal a secret", () => {
    // Route access is not data access — the whole reason permissions live apart
    // from nav.
    expect(can("delivery", "can_reveal_vault")).toBe(false);
  });

  it("keeps secrets to the owner alone", () => {
    const holders = USER_ROLES.filter((r) => PERMISSIONS[r as UserRole].can_manage_secrets);
    expect(holders).toEqual(["owner"]);
  });
});

describe("can() fails closed", () => {
  it("says no for unknown, null, and stale role strings", () => {
    // users.role is free text in Postgres, so these are real inputs, not theory.
    for (const bad of [null, undefined, "", "admin", "superuser", "OWNER", "customer_admin"]) {
      for (const flag of FLAGS) {
        expect(can(bad as string, flag), `${String(bad)}.${flag}`).toBe(false);
      }
    }
  });

  it("does not treat customer_admin as an internal role", () => {
    // It is a portal session, not a users.role value. If this ever passes,
    // someone has given portal customers a foothold in the internal app.
    expect(isUserRole("customer_admin")).toBe(false);
  });
});

describe("maskContact keeps enough to identify, not enough to contact", () => {
  it("leaves the last 4 digits of a phone", () => {
    expect(maskContact("+91 98765 43210")).toBe("••••••••3210");
  });

  it("keeps the domain of an email but hides the mailbox", () => {
    expect(maskContact("pardeep@anutech.in")).toBe("pa•••••@anutech.in");
  });

  it("never returns the original value for a real contact", () => {
    for (const v of ["+91 98765 43210", "pardeep@anutech.in", "9876543210"]) {
      expect(maskContact(v)).not.toBe(v);
    }
  });

  it("renders empty values as an em dash rather than a fake mask", () => {
    expect(maskContact(null)).toBe("—");
    expect(maskContact("   ")).toBe("—");
  });
});
