import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   "Has a person picked this thread up?" must not be answered by the app's own footprints.

   Found 24 Aug 2026 by reading run-auto-reply before asking Pardeep to re-run a self-test.
   The inbound webhook writes its own `note` a fraction of a second after filing the
   customer's email ("No new quote from this reply — …", route.ts:737), or an `email_out` row
   when the auto-quote does go out. Both are newer than the inbound message, both matched the
   `kind` filter, and both are this app. So the second enquiry in a thread would hold the reply
   saying "a person has picked this thread up" when nobody had.

   A wrong REASON is worse than a wrong outcome here: the reason is what somebody reads when
   deciding whether to trust the automation. Same failure as L97, where a marked self-test was
   held for the own-address rule instead of the dial.

   `created_by` is the discriminator and it needed no migration. Checked against live data
   before relying on it: call ×5, email ×3, note ×6 all carry a created_by; note ×9,
   email_in ×14, email_out ×1 and quote ×1 are all NULL.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const RUN = strip(readFileSync(join(SRC, "lib", "ai", "run-auto-reply.ts"), "utf8"));

describe("the human-touch check counts only humans", () => {
  it("requires created_by to be set", () => {
    expect(RUN).toMatch(/\.not\("created_by", "is", null\)/);
  });

  it("applies it to the SAME query as the kind filter, not a separate one", () => {
    /* Two queries would let one of them drift. The filter has to sit on the chain that
       produces `humanIsHandlingIt`, between the kind list and the timestamp bound. */
    const q = RUN.slice(RUN.indexOf('.in("kind", ["call"'), RUN.indexOf("humanIsHandlingIt ="));
    expect(q).toContain('.not("created_by", "is", null)');
    expect(q).toContain('.gt("created_at"');
  });

  it("still bounds the window to messages newer than the customer's last one", () => {
    /* Dropping this would make any old human note hold every future reply forever. */
    expect(RUN).toMatch(/\.gt\("created_at", lastIn\?\.created_at \?\? "1970-01-01"\)/);
  });

  it("still asks about the kinds a person actually does", () => {
    /* email_in is deliberately absent — the customer writing IS the thing being answered, so
       counting it would mean never replying to anybody. */
    expect(RUN).toMatch(/\.in\("kind", \["call", "whatsapp", "note", "email_out"\]\)/);
    expect(RUN).not.toMatch(/\.in\("kind", \[[^\]]*"email_in"/);
  });
});

describe("the app's own writes really are anonymous", () => {
  /* The fix is only sound while automated writes leave created_by NULL. If somebody later
     gives the service-role client a user id, the discriminator silently inverts and this bug
     comes back — so the assumption is pinned here rather than left in a comment. */

  it("the webhook's own activity inserts never set created_by", () => {
    const hook = strip(
      readFileSync(join(SRC, "app", "api", "webhooks", "inbound-email", "route.ts"), "utf8"),
    );
    const inserts = hook.split('from("lead_activities")').slice(1);
    expect(inserts.length).toBeGreaterThan(0);
    for (const chunk of inserts) {
      expect(chunk.slice(0, 300)).not.toContain("created_by");
    }
  });

  it("run-auto-reply's own note does not set it either", () => {
    const noteFn = RUN.slice(RUN.indexOf("const note ="), RUN.indexOf("const policy"));
    expect(noteFn).toContain('kind: "note"');
    expect(noteFn).not.toContain("created_by");
  });
});
