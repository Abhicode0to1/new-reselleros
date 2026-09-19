/**
 * Whose tenant does a newly created row belong to?
 *
 * ─── THE BUG THIS PINS ──────────────────────────────────────────────────────
 * Found 12 Sep 2026 while tracing why /dashboard makes 104 API calls. Every
 * write path that needed a tenant_id opened with this:
 *
 *     let tenantId = "11111111-1111-1111-1111-111111111111"; // default dev/demo tenant
 *     const { data: authData } = await supabase.auth.getUser();
 *     if (authData?.user) { ...look up users.tenant_id, maybe overwrite... }
 *
 * Two separate faults in six lines:
 *
 *   1. A GUESSED TENANT. If `getUser()` returned nothing — expired session,
 *      offline, auth hiccup — the customer or lead was inserted against a
 *      hardcoded UUID instead of being refused. In a multi-tenant product the
 *      tenant_id is the thing that decides who can read a row; guessing it is
 *      the one value that must never have a fallback. `resolveTenantId` throws.
 *
 *   2. A FABRICATED SUCCESS. When the insert then failed, both hooks caught the
 *      error, built a fake row (`id: \`CUST-${Date.now()}\``), pushed it into
 *      the React Query cache and returned it — so `onSuccess` fired and the
 *      operator was told "Customer added". Nothing was saved. The row vanished
 *      on the next reload, and the comment in leads.ts said the quiet part out
 *      loud: "Dev fallback lead object so UI succeeds seamlessly".
 *
 * A write that did not happen must not report success (CLAUDE.md §0.4), and a
 * tenant must never be guessed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { resolveTenantId } from "./tenant-id";

const QUERIES = join(process.cwd(), "src/lib/queries");

/** A stub of the supabase client shaped like the two calls resolveTenantId makes. */
function client({ user, row, rowError }: {
  user?: { id: string } | null;
  row?: { tenant_id: string | null } | null;
  rowError?: { message: string } | null;
}) {
  return {
    auth: { getUser: async () => ({ data: { user: user ?? null }, error: null }) },
    from() {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.single = async () => ({ data: row ?? null, error: rowError ?? null });
      chain.maybeSingle = chain.single;
      return chain;
    },
  } as never;
}

describe("resolveTenantId refuses to guess", () => {
  it("returns the tenant when the session and the user row both have one", async () => {
    const id = await resolveTenantId(client({ user: { id: "u1" }, row: { tenant_id: "t-real" } }));
    expect(id).toBe("t-real");
  });

  it("THROWS when nobody is signed in — it must not fall back to a default tenant", async () => {
    await expect(resolveTenantId(client({ user: null }))).rejects.toThrow(/sign|session/i);
  });

  it("THROWS when the user row carries no tenant", async () => {
    await expect(
      resolveTenantId(client({ user: { id: "u1" }, row: { tenant_id: null } })),
    ).rejects.toThrow(/workspace|tenant/i);
  });

  it("THROWS when the lookup itself errors, rather than returning a guess", async () => {
    await expect(
      resolveTenantId(client({ user: { id: "u1" }, row: null, rowError: { message: "boom" } })),
    ).rejects.toThrow();
  });

  /* The specific constant that was being written into other people's data. */
  it("never returns the hardcoded demo tenant", async () => {
    const DEMO = "11111111-1111-1111-1111-111111111111";
    for (const c of [
      client({ user: null }),
      client({ user: { id: "u1" }, row: { tenant_id: null } }),
      client({ user: { id: "u1" }, row: null, rowError: { message: "boom" } }),
    ]) {
      await expect(resolveTenantId(c)).rejects.toThrow();
    }
    const ok = await resolveTenantId(client({ user: { id: "u1" }, row: { tenant_id: "t-real" } }));
    expect(ok).not.toBe(DEMO);
  });
});

/* ─── SOURCE GUARDS ─────────────────────────────────────────────────────────
   The two faults above were written the same way in two files and would be
   copy-pasted into a third. These read the query modules so a reappearance
   fails here rather than in someone's tenant. */
/**
 * Comments stripped before scanning.
 *
 * Not cosmetic: the first version of these guards failed on tenant-id.ts itself,
 * because its docstring QUOTES the hardcoded uuid while explaining why it was
 * removed. Naming that file as an exception would have blinded the guard to a
 * real reintroduction inside it. Prose about the bug is fine; code is not, so
 * the check reads code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function queryModules(): Array<{ file: string; src: string }> {
  return readdirSync(QUERIES)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => ({ file: f, src: stripComments(readFileSync(join(QUERIES, f), "utf8")) }));
}

describe("no query module guesses a tenant or fakes a save", () => {
  const mods = queryModules();

  /* The denominator, asserted before anything is concluded from it — a glob
     that stopped matching would leave every check below green over nothing. */
  it("actually found the query modules", () => {
    expect(mods.length, "read no files out of src/lib/queries").toBeGreaterThanOrEqual(20);
  });

  it("no module hardcodes a tenant uuid", () => {
    const offenders = mods
      .filter((m) => /["'`]11111111-1111-1111-1111-111111111111["'`]/.test(m.src))
      .map((m) => m.file);
    expect(
      offenders,
      "a hardcoded tenant_id in a write path puts one customer's data in another's workspace",
    ).toEqual([]);
  });

  it("no module answers a failed insert by inventing a row for the cache", () => {
    const offenders = mods
      .filter((m) => /insert warning|UI succeeds seamlessly|Dev fallback/i.test(m.src))
      .map((m) => m.file);
    expect(
      offenders,
      'these caught a failed insert, put a made-up row in the cache and let onSuccess say "added" — ' +
        "the operator is told the save worked and it did not",
    ).toEqual([]);
  });
});
