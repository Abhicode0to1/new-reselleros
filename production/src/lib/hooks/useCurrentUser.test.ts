/**
 * Guards the identity query's embed against silently going ambiguous again.
 *
 * ─── WHY A TEST ON A STRING IS WORTH IT HERE ─────────────────────────────────
 * Normally asserting the contents of a query string is a smell. This one earns
 * its place because of how the failure behaves: on 14 Aug 2026 a bare
 * `tenants(…)` embed made PostgREST answer HTTP 300 / PGRST201, `useCurrentUser`
 * returned null, and the app showed "Loading… / Workspace" forever. Nothing
 * crashed, no test went red, no error reached Sentry — it just looked like a slow
 * network while every signed-in user appeared to have no workspace.
 *
 * The trigger was not a change to this file. It was migration 0235 adding
 * `tenants.gmail_sender_user_id`, which created a SECOND foreign key between
 * `users` and `tenants`. So the code that broke and the change that broke it were
 * in different places, months apart. That is exactly the shape of bug worth
 * pinning down cheaply.
 *
 * The live counterpart — proving the ambiguity is real against the actual
 * database — is `node scripts/check-embed-ambiguity.mjs`. This one runs offline
 * in milliseconds and catches the revert.
 */
import { describe, it, expect } from "vitest";
import { USER_WITH_TENANT_SELECT } from "./useCurrentUser";

describe("USER_WITH_TENANT_SELECT", () => {
  it("names the foreign key, so the users→tenants embed cannot be ambiguous", () => {
    expect(USER_WITH_TENANT_SELECT).toContain("tenants!users_tenant_id_fkey(");
  });

  it("never uses the bare `tenants(` form", () => {
    // The bare form is what returns PGRST201. Match it without matching the
    // pinned form, which contains "tenants!".
    expect(USER_WITH_TENANT_SELECT).not.toMatch(/(^|[\s,])tenants\(/);
  });

  it("still selects the columns the app depends on for identity", () => {
    for (const col of ["id", "tenant_id", "role", "full_name", "initials"]) {
      expect(USER_WITH_TENANT_SELECT).toContain(col);
    }
    // The tenant's display name is what the sidebar shows instead of the generic
    // word "Workspace" — losing it reintroduces the "which company am I in?" gap.
    expect(USER_WITH_TENANT_SELECT).toContain("name");
  });

  it("requests exactly one embedded relation", () => {
    const embeds = USER_WITH_TENANT_SELECT.match(/[A-Za-z_]+(![A-Za-z_]+)?\(/g) ?? [];
    expect(embeds).toHaveLength(1);
  });
});
