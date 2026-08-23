import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   The browser Sentry init cannot be meaningfully unit-tested — calling
   `Sentry.init` in jsdom would either do nothing useful or start a real
   transport. What CAN be checked, and what actually went wrong, is the wiring:

     - lib/sentry.ts reads SENTRY_DSN and is server-only (its own header says so)
     - nothing read NEXT_PUBLIC_SENTRY_DSN, so no client init ever ran
     - global-error.tsx and (app)/error.tsx call captureException FROM THE CLIENT

   So both boundaries minted event ids locally and dropped them, while their own
   comments said they "report to Sentry". Every crash an operator actually saw went
   nowhere. These assertions pin the shape that fixes it — the same approach
   route-map.test.ts and the grid-flow scan take for things a render test cannot see.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("Sentry is initialised on BOTH sides", () => {
  it("takes the DSN as an argument, not from process.env", () => {
    /* The first version read process.env.NEXT_PUBLIC_SENTRY_DSN inside the client module
       and the browser test page reported dsnPresent:false on its first run — that variable
       is inlined at BUILD time and the DSN is a Cloud Run RUNTIME one, so it was in
       neither bundle. An event id was minted and nothing left the tab. */
    const s = read("lib/sentry-client.ts");
    expect(s).toContain("initClientSentry(dsn:");
    /* Comments stripped before asserting. The file EXPLAINS the old
       process.env.NEXT_PUBLIC_SENTRY_DSN read at length, and a blunt not.toContain
       would fail on the explanation — which would push the reasoning out of the file to
       satisfy the test. What must not exist is a READ. */
    const code = s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("NEXT_PUBLIC_SENTRY_DSN");
  });

  it("the server initialiser still reads the non-public one", () => {
    /* Two variables on purpose. Swapping them would ship the server config to the
       browser or leave the server unconfigured. */
    expect(read("lib/sentry.ts")).toContain("process.env.SENTRY_DSN");
  });

  it("is mounted in the ROOT layout, which can read runtime env", () => {
    /* (app)/layout.tsx is "use client" and cannot read server env at all. The root
       layout is a Server Component, and a crash in (public)/ or (auth)/ deserves
       reporting just as much as one behind the login. */
    const root = read("app/layout.tsx");
    expect(root).toContain("<SentryBoot");
    expect(root).toContain("process.env.SENTRY_DSN");
    expect(read("app/(app)/layout.tsx")).not.toContain("SentryBoot");
  });

  it("does nothing at all when the DSN is unset", () => {
    /* An early return, not a throw and not a console warning. Until somebody
       configures it the app must behave exactly as it does today. */
    const s = read("lib/sentry-client.ts");
    expect(s).toMatch(/if \(!DSN\) return;/);
  });

  it("is idempotent, like the server one", () => {
    expect(read("lib/sentry-client.ts")).toMatch(/if \(Sentry\.getClient\(\)\) return;/);
  });
});

describe("the client init sends less than the server one", () => {
  it("keeps default PII off", () => {
    /* Sentry's "default PII" is IP and user agent. Neither is needed to reproduce a
       bug, and this app is not a place to accumulate them. */
    expect(read("lib/sentry-client.ts")).toMatch(/sendDefaultPii:\s*false/);
  });

  it("scrubs email addresses out of messages, exceptions and breadcrumbs", () => {
    /* A browser event carries whatever was on screen, and these screens carry customer
       names, emails and amounts. A crash on /leads would otherwise copy the customer's
       address into a third-party service nobody audits. */
    const s = read("lib/sentry-client.ts");
    expect(s).toContain("[email]");
    for (const field of ["event.message", "ex.value", "b.message"]) {
      expect(s, field).toContain(field);
    }
  });

  it("samples browser traces lower than the server's 0.1", () => {
    /* Browser traces are far noisier per user, and the reason to have this at all is
       exceptions rather than performance. */
    const client = read("lib/sentry-client.ts");
    expect(client).toMatch(/tracesSampleRate:.*0\.02/);
    expect(read("lib/sentry.ts")).toMatch(/tracesSampleRate:.*0\.1/);
  });
});

describe("the error boundaries this exists for", () => {
  it("both still report from the client", () => {
    /* If either stops calling captureException, this whole client init is dead weight
       and should be reconsidered rather than left looking useful. */
    expect(read("app/global-error.tsx")).toContain("Sentry.captureException");
    expect(read("app/(app)/error.tsx")).toMatch(/captureException|Sentry/);
  });
});
