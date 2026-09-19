import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redactQueryString, redactBreadcrumb } from "./sentry-redact";

/**
 * The leak this guards was measured, not theorised: Sentry's fetch
 * instrumentation strips the query from `url` and then restores it verbatim in
 * `http.query`, and ResellerClub's credentials ride in the query string because
 * that API has no header auth.
 *
 * Two halves. The first pins the redaction itself. The second pins that every
 * `Sentry.init` in the repo actually uses it — which is the half that fails if
 * somebody adds a sixth init, and the half that was failing before this file
 * existed.
 */
describe("redactQueryString", () => {
  it("redacts the ResellerClub credential pair and keeps what is useful", () => {
    const out = redactQueryString("?auth-userid=1299294&api-key=abc123DEF456&domain-name=acme&tlds=in");
    expect(out).toBe("?auth-userid=[redacted]&api-key=[redacted]&domain-name=acme&tlds=in");
    expect(out).not.toContain("1299294");
    expect(out).not.toContain("abc123DEF456");
  });

  it("redacts an unknown key — the list names what is SAFE, not what is secret", () => {
    /* The point of the inversion: an upstream that invents a new credential
       parameter is covered without anyone remembering to add it. */
    expect(redactQueryString("?some-new-upstream-token=xyz")).toBe("?some-new-upstream-token=[redacted]");
  });

  it("is case-insensitive about the key and survives encoding", () => {
    expect(redactQueryString("?DOMAIN-NAME=acme&API-KEY=s3cret")).toBe("?DOMAIN-NAME=acme&API-KEY=[redacted]");
    expect(redactQueryString("?domain%2Dname=acme")).toBe("?domain%2Dname=acme");
  });

  it("leaves a bare flag alone — there is no value to leak", () => {
    expect(redactQueryString("?verbose&api-key=s3cret")).toBe("?verbose&api-key=[redacted]");
  });

  it("redacts a key whose percent-encoding is malformed rather than trusting it", () => {
    expect(redactQueryString("?%E0%A4=s3cret")).toBe("?%E0%A4=[redacted]");
  });

  it("does nothing to an empty or absent query", () => {
    expect(redactQueryString("")).toBe("");
    expect(redactQueryString("?")).toBe("?");
  });

  it("rewrites the breadcrumb in place and leaves other fields alone", () => {
    const crumb = {
      category: "http",
      data: {
        status_code: 200,
        url: "https://httpapi.com/api/domains/available.json",
        "http.method": "GET",
        "http.query": "?auth-userid=1299294&api-key=live-key-here&domain-name=acme",
      },
    };
    const out = redactBreadcrumb(crumb);
    expect(out.data["http.query"]).toBe("?auth-userid=[redacted]&api-key=[redacted]&domain-name=acme");
    expect(out.data.url).toBe("https://httpapi.com/api/domains/available.json");
    expect(out.data.status_code).toBe(200);
  });

  it("passes through a breadcrumb that carries no query", () => {
    const crumb = { category: "console", data: { message: "hello" } };
    expect(redactBreadcrumb(crumb).data.message).toBe("hello");
    expect(() => redactBreadcrumb({} as { data?: Record<string, unknown> })).not.toThrow();
  });
});

describe("every Sentry.init in the repo redacts breadcrumbs", () => {
  /* A source pin, deliberately. The unit tests above prove the function is
     correct; only this proves it is CONNECTED — and an init added later with
     the hook forgotten is exactly how the leak would come back. */
  const ROOT = join(__dirname, "..", "..");

  function initFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".git")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          const src = readFileSync(full, "utf8");
          if (src.includes("Sentry.init(")) found.push(full);
        }
      }
    };
    walk(join(ROOT, "src"));
    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|mjs)$/.test(entry.name)) continue;
      const full = join(ROOT, entry.name);
      if (readFileSync(full, "utf8").includes("Sentry.init(")) found.push(full);
    }
    return found;
  }

  it("finds the init sites at all — a zero here would make the next assertion vacuous", () => {
    expect(initFiles().length).toBeGreaterThanOrEqual(5);
  });

  it("every one of them passes beforeBreadcrumb", () => {
    const offenders = initFiles().filter((f) => !readFileSync(f, "utf8").includes("beforeBreadcrumb"));
    expect(offenders.map((f) => f.replace(ROOT, "").replace(/\\/g, "/"))).toEqual([]);
  });
});
