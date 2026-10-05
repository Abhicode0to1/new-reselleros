/**
 * The "forgetting is impossible" rules, enforced in the normal unit suite (and so in the
 * deploy gate). Lint says the same thing, but lint is not in the Cloud Build gate — this is.
 *
 *  1. The generated Prisma client, @prisma/*, and the context setter are imported only
 *     inside src/server/db.
 *  2. Cross-tenant job access (src/server/db/jobs) is imported only by src/app/api/cron/**.
 *  3. `new PrismaClient` exists only in src/server/db/index.ts and jobs.ts.
 *  4. The tenant context is written only in src/server/db/{context,index}.ts, and always
 *     transaction-local: set_config(…, true). A session-level SET would survive COMMIT and
 *     ride the pooled connection into the next request — another tenant's, possibly.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(__dirname, "..", "..");
const rel = (p: string) => relative(SRC, p).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || rel(p) === "server/db/generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ path: rel(p), code: readFileSync(p, "utf8") }));
const inDb = (p: string) => p.startsWith("server/db/");
const isTest = (p: string) => /\.test\.(ts|tsx)$/.test(p);

describe("database import boundary", () => {
  test("the raw client and the context setter stay inside src/server/db", () => {
    const bad = FILES.filter((f) => !inDb(f.path)).filter((f) =>
      /from\s+["'](@prisma\/client[^"']*|@prisma\/adapter-pg|@\/server\/db\/generated[^"']*|@\/server\/db\/context|[./]+\/server\/db\/(generated|context)[^"']*)["']/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("cross-tenant job access is imported only by cron routes", () => {
    const bad = FILES.filter((f) => !inDb(f.path) && !f.path.startsWith("app/api/cron/"))
      .filter((f) => /from\s+["'](@\/server\/db\/jobs|[./]+\/server\/db\/jobs)["']/.test(f.code));
    expect(bad.map((f) => f.path)).toEqual([]);
  });

  test("new PrismaClient appears only in src/server/db/index.ts and jobs.ts", () => {
    const where = FILES.filter((f) => !isTest(f.path) && /new\s+PrismaClient\s*\(/.test(f.code)).map((f) => f.path).sort();
    expect(where).toEqual(["server/db/index.ts", "server/db/jobs.ts"]);
  });

  test("the tenant context is set only by src/server/db, and only transaction-locally", () => {
    const where = FILES.filter((f) => !isTest(f.path) && /set_config\s*\(\s*'app\./.test(f.code)).map((f) => f.path).sort();
    expect(where).toEqual(["server/db/context.ts", "server/db/index.ts"]);
    for (const f of FILES.filter((x) => where.includes(x.path))) {
      const calls = f.code.match(/set_config\(\s*'app\.[a-z_]+',[^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c, `${f.path}: ${c}`).toMatch(/,\s*true\s*\)$/);
    }
    const sessionSet = FILES.filter((f) => !isTest(f.path) && /\bset\s+(session\s+)?app\.(tenant_id|user_id)\b/i.test(f.code));
    expect(sessionSet.map((f) => f.path)).toEqual([]);
  });
});
