/**
 * requireTenantId — the guard that replaced a hardcoded demo tenant (R-001).
 *
 * The case that matters is not the happy one. It is that EVERY way of failing to
 * identify the operator now refuses, because the bug being fixed was a failure that
 * resolved to a real, wrong company and looked like a success.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireTenantId, NoTenantError } from "./require-tenant";

type Db = Pick<SupabaseClient, "from" | "auth">;

function makeDb(opts: {
  userId?: string | null;
  tenantId?: string | null;
  readError?: boolean;
}): Db {
  const auth = {
    getUser: vi.fn(async () => ({
      data: { user: opts.userId ? { id: opts.userId } : null },
    })),
  };
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        single: async () => ({
          data: opts.tenantId ? { tenant_id: opts.tenantId } : null,
          error: opts.readError ? { message: "network" } : null,
        }),
      }),
    }),
  }));
  return { auth, from } as unknown as Db;
}

describe("requireTenantId", () => {
  it("returns the signed-in user's tenant", async () => {
    await expect(requireTenantId(makeDb({ userId: "u1", tenantId: "t-real" })))
      .resolves.toBe("t-real");
  });

  it("refuses when nobody is signed in", async () => {
    await expect(requireTenantId(makeDb({ userId: null }))).rejects.toBeInstanceOf(NoTenantError);
  });

  it("refuses when the user has no company row", async () => {
    await expect(requireTenantId(makeDb({ userId: "u1", tenantId: null })))
      .rejects.toMatchObject({ reason: "no_company" });
  });

  it("refuses when the lookup itself errors — a blip is not a company", async () => {
    /* THE ORIGINAL BUG. `if (me?.tenant_id)` treated a failed read as "keep the
       default", and the default was the seed tenant. */
    await expect(requireTenantId(makeDb({ userId: "u1", tenantId: null, readError: true })))
      .rejects.toBeInstanceOf(NoTenantError);
  });

  it("never yields the seed tenant on any failure path", async () => {
    const cases = [
      makeDb({ userId: null }),
      makeDb({ userId: "u1", tenantId: null }),
      makeDb({ userId: "u1", tenantId: null, readError: true }),
    ];
    for (const db of cases) {
      const got = await requireTenantId(db).catch((e: unknown) => e);
      expect(got).toBeInstanceOf(Error);
      expect(String(got)).not.toContain("11111111-1111-1111-1111-111111111111");
    }
  });

  it("says what to do next, not just that it failed (§24)", async () => {
    const signedOut = await requireTenantId(makeDb({ userId: null })).catch((e: Error) => e.message);
    expect(signedOut).toMatch(/sign in again/i);
    const noCompany = await requireTenantId(makeDb({ userId: "u1", tenantId: null })).catch((e: Error) => e.message);
    expect(noCompany).toMatch(/workspace owner/i);
  });
});
