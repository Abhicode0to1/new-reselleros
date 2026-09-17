import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ticketHref, TICKET_SUBJECT_MAX, TICKET_BODY_MAX } from "./ticket-link";

describe("ticketHref", () => {
  it("writes the ticket into the URL", () => {
    expect(ticketHref("Please renew acme.in", "It expires on 20 Sept 2026.")).toBe(
      "/portal/support/new?subject=Please+renew+acme.in&body=It+expires+on+20+Sept+2026.",
    );
  });

  it("carries a body only when there is one", () => {
    expect(ticketHref("Please renew acme.in")).toBe("/portal/support/new?subject=Please+renew+acme.in");
    expect(ticketHref("Please renew acme.in", "   ")).toBe("/portal/support/new?subject=Please+renew+acme.in");
  });

  it("falls back to the bare route rather than emitting an empty query", () => {
    expect(ticketHref("")).toBe("/portal/support/new");
    expect(ticketHref("   ", "  ")).toBe("/portal/support/new");
  });

  it("escapes what a domain name can legally contain", () => {
    /* & and = in a body would otherwise invent query parameters. */
    const href = ticketHref("a&b=c", "one & two = three");
    expect(href).toContain("subject=a%26b%3Dc");
    expect(href).toContain("body=one+%26+two+%3D+three");
  });

  it("round-trips through the same parser the form uses", () => {
    const body = "I would like to renew acme.in.\n\nIt expires on 20 Sept 2026 (3 days left).";
    const url = new URL("http://x" + ticketHref("Please renew acme.in", body));
    expect(url.searchParams.get("subject")).toBe("Please renew acme.in");
    expect(url.searchParams.get("body")).toBe(body);
  });

  it("never emits more than the form will keep", () => {
    /* The whole reason the caps live in this module. A link that carries more
       than the form reads back loses its last sentence silently — which is the
       failure the prefill exists to prevent. */
    const href = ticketHref("s".repeat(500), "b".repeat(5000));
    const url = new URL("http://x" + href);
    expect(url.searchParams.get("subject")!.length).toBeLessThanOrEqual(TICKET_SUBJECT_MAX);
    expect(url.searchParams.get("body")!.length).toBeLessThanOrEqual(TICKET_BODY_MAX);
  });

  it("marks a truncation instead of stopping mid-word", () => {
    const long = `${"word ".repeat(600)}END`;
    const body = new URL("http://x" + ticketHref("s", long)).searchParams.get("body")!;
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toContain("END");
    /* Cut at a word boundary, not through one. */
    expect(body.slice(-2, -1)).not.toBe("w");
  });

  it("leaves text that fits exactly alone", () => {
    const exact = "x".repeat(TICKET_SUBJECT_MAX);
    expect(new URL("http://x" + ticketHref(exact)).searchParams.get("subject")).toBe(exact);
  });
});

describe("the form and the links agree on the limits", () => {
  /* A source pin. If the form ever hardcodes its own numbers again, a link can
     outrun it and the customer loses the end of a ticket they never wrote. */
  const form = readFileSync(
    join(process.cwd(), "src/app/(public)/portal/support/new/page.tsx"),
    "utf8",
  );

  it("the ticket form imports the caps rather than repeating them", () => {
    expect(form).toContain("TICKET_SUBJECT_MAX");
    expect(form).toContain("TICKET_BODY_MAX");
    expect(form, "a hardcoded slice(0, 200) is how the two drift").not.toMatch(/slice\(0,\s*\d+\)/);
  });

  it("every portal link to the ticket form goes through ticketHref", () => {
    const FILES = [
      "src/app/(public)/portal/domains/page.tsx",
      "src/app/(public)/portal/hosting/page.tsx",
      "src/app/(public)/portal/_components/domain-search.tsx",
    ];
    for (const rel of FILES) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      if (!src.includes("support/new")) continue;
      expect(src, `${rel} builds a ticket URL by hand`).not.toMatch(
        /portal\/support\/new\?subject=/,
      );
    }
  });
});
