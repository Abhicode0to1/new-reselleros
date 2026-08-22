import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Reported 22 Aug 2026: "email receive me bahut time lagta hai, real time nahi
   ho sakta?"

   Inbound mail is NOT polled from Gmail — it is pushed:

     customer → Gmail → forwarding rule → inbound-parse provider
              → POST /api/webhooks/inbound-email → inbound_emails → UI

   Everything up to the database is seconds. The delay was the LAST arrow. Measured
   in the source:

     - useInboundEmails() declared no refetchInterval, so it never polled.
     - query-provider.tsx sets refetchOnWindowFocus: false globally ("annoying for
       SaaS apps"), which is right for a settings page and wrong for an inbox.
     - staleTime is 30s, so even navigating away and back served the cache.

   Net effect: once the page was open, a new email could sit in the database
   indefinitely and never appear. The operator's only remedy was a hard reload —
   and because nothing on screen said "as of 11:04", it read as "email is slow"
   rather than "this list is frozen".

   Why this is a source scan and not a render test: the defect is a MISSING option
   object key. A rendered component with no polling looks identical to one with
   polling until you wait 20 seconds, which no unit test does. jsdom also has no
   real timers here worth trusting for this.

   The comparison that makes the omission obvious: lib/queries/whatsapp.ts already
   polls at 15s and 10s, and useNavBadges at 60s. Inbound email — the one surface a
   customer is actively waiting on the other end of — had nothing.
   ───────────────────────────────────────────────────────────────────────────── */

const QUERIES = join(process.cwd(), "src", "lib", "queries");

/** The option-object body of a named hook, so `refetchInterval` is judged in context. */
function hookSource(file: string, hookName: string): string {
  const src = readFileSync(join(QUERIES, file), "utf8");
  const at = src.indexOf(`export function ${hookName}`);
  if (at < 0) throw new Error(`${hookName} not found in ${file} — did it get renamed?`);
  /* Up to the next top-level export, so a later hook's options cannot satisfy this one. */
  const next = src.indexOf("\nexport ", at + 10);
  return src.slice(at, next < 0 ? undefined : next);
}

/**
 * `refetchInterval: 20_000` → 20000, and `refetchInterval: INBOX_REFETCH_MS` →
 * whatever that module-level const holds.
 *
 * The indirection is resolved rather than banned: a named constant is where the
 * reasoning for the number lives, and a test that only accepts an inline literal
 * would push the value back inline and the explanation out of the file.
 */
function refetchMs(file: string, body: string): number | null {
  const m = /refetchInterval\s*:\s*([A-Za-z_$][\w$]*|[\d_]+)/.exec(body);
  if (!m) return null;
  if (/^[\d_]+$/.test(m[1])) return Number(m[1].replace(/_/g, ""));
  const src = readFileSync(join(QUERIES, file), "utf8");
  const c = new RegExp(`const\\s+${m[1]}\\s*(?::[^=]+)?=\\s*([\\d_]+)`).exec(src);
  return c ? Number(c[1].replace(/_/g, "")) : null;
}

describe("the enquiries inbox refreshes itself", () => {
  const body = hookSource("inbound-emails.ts", "useInboundEmails");

  it("polls, so a new customer email appears without a page reload", () => {
    const ms = refetchMs("inbound-emails.ts", body);
    expect(ms, "useInboundEmails declares no refetchInterval — an inbox that never refetches shows a customer's email only after a manual reload").not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
  });

  it("polls often enough to feel live, and not so often it hammers the API", () => {
    /* Bounds, not a magic number. Above 60s a reply feels lost; below 5s this is a
       DB query per tab per few seconds for no perceptible gain. whatsapp.ts sits at
       10-15s and is the precedent. */
    const ms = refetchMs("inbound-emails.ts", body)!;
    expect(ms).toBeGreaterThanOrEqual(5_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("refetches when the operator returns to the tab", () => {
    /* The global default is refetchOnWindowFocus: false, which is correct for most
       screens and wrong here — the commonest real motion is reading mail in Gmail,
       then switching to this tab expecting to see it. This must be overridden
       LOCALLY; flipping the global default would make every screen chatty. */
    expect(
      /refetchOnWindowFocus\s*:\s*true/.test(body),
      "useInboundEmails must opt into refetchOnWindowFocus — the global default is false",
    ).toBe(true);
  });

  it("does not serve a stale cache to an inbox", () => {
    /* Global staleTime is 30s. On an inbox that means a refetch can be answered from
       cache and show nothing new, which is the same bug wearing a shorter delay. */
    expect(
      /staleTime\s*:\s*0/.test(body),
      "useInboundEmails must set staleTime: 0 — the 30s global default lets a poll return cached rows",
    ).toBe(true);
  });

  it("the global defaults this relies on have not silently changed", () => {
    /* If somebody turns refetchOnWindowFocus on globally, the local override above
       becomes redundant rather than wrong — but if staleTime grows, the reasoning in
       these tests needs rereading. Pinning it makes that a visible decision. */
    const provider = readFileSync(
      join(process.cwd(), "src", "components", "providers", "query-provider.tsx"),
      "utf8",
    );
    expect(provider).toMatch(/staleTime\s*:\s*30\s*\*\s*1000/);
    expect(provider).toMatch(/refetchOnWindowFocus\s*:\s*false/);
  });
});
