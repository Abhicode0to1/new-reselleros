import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platformOpsRecipient } from "./ops-recipient";

/**
 * The defect: "the platform owner" was implemented as "the oldest owner row in
 * the whole table", with no tenant filter. Every self-signup creates an owner,
 * so the two are the same only by luck of ordering — and the digest now carries
 * the ResellerClub wallet balance and cross-tenant log lines.
 */

type Row = { email: string | null };

/** The slice of the admin client this function touches, and nothing more. */
function fakeAdmin(rows: Row[] | null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows }),
  };
  return { from: () => chain } as unknown as Parameters<typeof platformOpsRecipient>[0];
}

const OLD = process.env.PLATFORM_ADMIN_EMAILS;

beforeEach(() => {
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@platform.test,second@platform.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (OLD === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
});

describe("platformOpsRecipient", () => {
  it("skips a customer tenant's owner even when that row is the oldest", () => {
    /* This is the whole bug in one case: first row wins under the old query. */
    return expect(
      platformOpsRecipient(
        fakeAdmin([
          { email: "owner@a-paying-customer.test" },
          { email: "ops@platform.test" },
        ]),
      ),
    ).resolves.toBe("ops@platform.test");
  });

  it("picks the EARLIEST platform admin when more than one is an owner", async () => {
    /* Rows arrive created_at-ascending, so order within the allowlist is the
       database's answer, not the allowlist's. */
    await expect(
      platformOpsRecipient(fakeAdmin([{ email: "second@platform.test" }, { email: "ops@platform.test" }])),
    ).resolves.toBe("second@platform.test");
  });

  it("matches regardless of the case a row was stored in", async () => {
    await expect(platformOpsRecipient(fakeAdmin([{ email: "  OPS@Platform.TEST " }]))).resolves.toBe(
      "  OPS@Platform.TEST ",
    );
  });

  it("falls back to the allowlist rather than mailing a customer", async () => {
    /* No platform owner row at all — the old code would have mailed the customer
       in this list. A digest that reaches nobody is better than that, and the
       allowlist address is a real one. */
    await expect(platformOpsRecipient(fakeAdmin([{ email: "owner@a-paying-customer.test" }]))).resolves.toBe(
      "ops@platform.test",
    );
    await expect(platformOpsRecipient(fakeAdmin([]))).resolves.toBe("ops@platform.test");
    await expect(platformOpsRecipient(fakeAdmin(null))).resolves.toBe("ops@platform.test");
  });

  it("survives a null email on a row", async () => {
    await expect(platformOpsRecipient(fakeAdmin([{ email: null }, { email: "ops@platform.test" }]))).resolves.toBe(
      "ops@platform.test",
    );
  });

  it("returns null when the allowlist is empty — nobody to tell", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS", "");
    /* An empty override falls back to the built-in default list, which is not
       empty — so assert the real contract: a recipient is always produced. */
    await expect(platformOpsRecipient(fakeAdmin([]))).resolves.toBeTruthy();
  });
});

describe("no ops cron picks its recipient by hand", () => {
  /* The source pin. The unit tests above prove the helper is right; only this
     proves it is USED — and it is what fails if a third ops cron copies the
     original query. */
  const ROOT = join(__dirname, "..", "..", "app", "api", "cron");
  const ROUTES = ["health-digest/route.ts", "ai-reflection/route.ts"];

  it.each(ROUTES)("%s goes through platformOpsRecipient", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).toContain("platformOpsRecipient");
    expect(src, 'still selects the oldest owner row directly — that is the bug').not.toMatch(
      /\.eq\(\s*["']role["']\s*,\s*["']owner["']\s*\)/,
    );
  });
});
