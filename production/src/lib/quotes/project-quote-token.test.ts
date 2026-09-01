/**
 * Project-quote ka public raasta token ke bina na khule — source par pehra.
 *
 * 1 Sep 2026 ke audit ne pakda tha: accept-route bina token ke chalta tha
 * ("id is the implicit link secret" — jabki id URL/email/log me dikhti hai).
 * Ye test wo darwaza dobara khulne nahi dega: route aur page dono me
 * quoteTokenMatches hona chahiye, aur route me RPC token-jaanch ke BAAD
 * aana chahiye. Link banane wali jagahen ?t= ke saath link banayen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("project-quote public surface demands the token", () => {
  it("accept route verifies public_token BEFORE calling the RPC", () => {
    const src = read("src/app/api/public/project-quote/[id]/accept/route.ts");
    const guard = src.indexOf("quoteTokenMatches");
    const rpc = src.indexOf('rpc("accept_project_quote"');
    expect(guard).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rpc);
    // Row se token select hota hai — bina padhe compare ho hi nahi sakta.
    expect(src).toContain("public_token");
  });

  it("public page notFound()s without a matching token", () => {
    const src = read("src/app/(public)/project-quote/[id]/page.tsx");
    expect(src).toContain("quoteTokenMatches");
    expect(src).toContain("searchParams.t");
  });

  it("har link-builder ?t= ke saath link banata hai", () => {
    const projectDetail = read("src/app/(app)/projects/[id]/page.tsx");
    const quotesList = read("src/app/(app)/quotes/page.tsx");
    for (const src of [projectDetail, quotesList]) {
      const links = src.match(/project-quote\/\$\{[^}]+\}[^`"]*/g) ?? [];
      expect(links.length).toBeGreaterThan(0);
      for (const l of links) expect(l).toContain("?t=");
    }
  });
});
