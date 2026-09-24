/**
 * Every "add to cart" on the site produces a line the checkout can actually charge.
 *
 * Found 24 Sep 2026: six of the site's add-to-cart buttons sent lines with no
 * `sku`, and the checkout API (correctly) refuses anything it cannot price on the
 * server — so a visitor could fill a cart that could never be paid. The API was
 * right; the buttons were the bug, and a unit test of the API could not see it.
 * This is a source scan, the shape AGENTS.md L75/L98 recommends for wiring.
 *
 * Rules pinned:
 *  - every `cart.add({...})` carries `sku:`;
 *  - every domain line (`sku: \`domain:...`) also carries `domain:` — the exact
 *    name, which is what gets registered;
 *  - nothing adds a placeholder name ("yourname", "yourbusiness").
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src/site");

/**
 * Two components still hold SKU-less adds, and neither is mounted: they were
 * replaced by the redesigned DomainLanding / HostingLanding on 2-3 Sep 2026
 * (git log -S"<DomainRateCard" / "<HostingPlans"). Listed so the scan stays
 * strict everywhere else — and pinned unmounted below, so mounting one of them
 * again fails here until its adds are fixed.
 */
const UNMOUNTED = ["components/domains/DomainRateCard.tsx", "components/hosting/HostingPlans.tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Each `cart.add(` call's argument text, up to its matching close paren. */
function addCalls(src: string): string[] {
  const calls: string[] = [];
  let i = src.indexOf("cart.add(");
  while (i !== -1) {
    let depth = 0;
    let j = i + "cart.add".length;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(i, j + 1));
    i = src.indexOf("cart.add(", j);
  }
  return calls;
}

const files = walk(ROOT).map((f) => ({ rel: relative(ROOT, f).split("\\").join("/"), src: readFileSync(f, "utf8") }));

describe("site cart lines are chargeable", () => {
  it("the scan found the adders (guard against a moved tree)", () => {
    const withAdds = files.filter((f) => f.src.includes("cart.add("));
    expect(withAdds.length).toBeGreaterThanOrEqual(3);
  });

  for (const f of files.filter((x) => x.src.includes("cart.add(") && !UNMOUNTED.includes(x.rel))) {
    it(`${f.rel}: every add carries a sku, domain lines carry the name, no placeholders`, () => {
      for (const call of addCalls(f.src)) {
        // A ternary add (`cart.add(yearly ? {...} : {...})`) must carry a sku in each branch.
        const objects = call.split(/\?\s*\{|:\s*\{/).length > 2 ? call.split(/(?=\{)/).filter((p) => p.includes("label")) : [call];
        for (const o of objects) {
          expect(o, `no sku in:\n${o}`).toMatch(/\bsku\s*:/);
          if (/sku\s*:\s*`domain:/.test(o)) expect(o, `domain line without its name:\n${o}`).toMatch(/\bdomain\s*:/);
          expect(o).not.toMatch(/your(name|business)/i);
        }
      }
    });
  }

  it("the two components with SKU-less adds are still not mounted anywhere", () => {
    const appSrc = walk(join(process.cwd(), "src"))
      .filter((p) => !p.includes(`${join("src", "site", "components", "domains", "DomainRateCard")}`))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    expect(appSrc).not.toMatch(/import[^\n]*DomainRateCard/);
    expect(appSrc).not.toMatch(/import[^\n]*\bHostingPlans\b/);
  });
});
