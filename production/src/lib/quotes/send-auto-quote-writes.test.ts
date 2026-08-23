import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Every write in the auto-quote sender reads its error.

   This file exists because of a bug that a green suite could not see, on 23 Aug 2026. A
   quote really was emailed — email_log said provider gmail, status sent — and:

     quote_send_log   EMPTY
     quotes.status    still "draft"
     lead_activities  "Quote Q-…-0042 emailed automatically … (PDF attached)"

   Three records, three different stories. Both middle writes were `await admin.from(...)`
   with the `{ error }` never read, and supabase-js does not throw: it hands back an error
   object nobody looked at. The function sailed past both and wrote a success line.

   The damage is not cosmetic. The customer holds a quote the pipeline calls a draft, so the
   next person to look sends it again — and the file's own header had promised
   "quote_send_log gets a row whatever happens".

   A source scan rather than a render test, for the same reason autonomy-chokepoint and
   auto-quote-wiring are scans: what failed was not a decision, it was a discarded return
   value, and that reads plainly in the source and not at all in a mock.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = readFileSync(
  join(process.cwd(), "src", "lib", "quotes", "send-auto-quote.ts"),
  "utf8",
);
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the audit write announces its own failure", () => {
  it("reads the error from the quote_send_log insert", () => {
    expect(code).toMatch(/const \{ error: sendLogErr \} = await admin\s*\.from\("quote_send_log"\)/);
  });

  it("says on the lead that the mail went but the audit row did not", () => {
    /* An audit trail with a hole in it must announce the hole, or whoever reconciles sends
       later concludes the quote was never sent. */
    expect(SRC).toMatch(/WAS emailed to \$\{args\.recipient\}, but the send could not be written/);
  });
});

describe("the status update is verified, not assumed", () => {
  it("selects the touched rows back", () => {
    /* THE SUBTLE HALF. An update matching NOTHING is a success in supabase-js, so without
       asking for the rows there is no way to tell "worked" from "matched nothing" — and it
       was the second of those. */
    expect(code).toMatch(/\.update\(\{ status: "sent" \}\)[\s\S]{0,160}\.select\("id"\)/);
  });

  it("treats zero rows as a failure, not as success", () => {
    expect(code).toMatch(/statusErr \|\| \(updated \?\? \[\]\)\.length === 0/);
  });

  it("tells the operator to mark it sent by hand, so nobody sends it twice", () => {
    /* §24: the consequence and the next step, not just the fault. Sending a customer two
       quotes for one requirement is the actual cost here. */
    expect(SRC).toMatch(/still marked DRAFT/);
    expect(SRC).toMatch(/nobody sends it twice/);
  });
});

describe("no write in this file discards its result", () => {
  it("every insert and update either reads an error or is a timeline note", () => {
    /* The general form of the bug. `note()` is the one deliberate exception — it is the
       reporting channel itself, and making a failure to report a reportable failure is a
       loop with no exit. Everything else must be checked. */
    const writes = [...code.matchAll(/(?:const \{[^}]*\} = )?await (?:admin|db)\s*\n?\s*\.from\("([a-z_]+)"\)\s*\n?\s*\.(insert|update|upsert)\(/g)];
    expect(writes.length, "expected to find the writes at all").toBeGreaterThan(0);
    const unchecked = writes
      .filter((m) => !m[0].startsWith("const {"))
      /* lead_activities is written by note() and by the final success line; both are the
         reporting channel, not the thing being reported on. */
      .filter((m) => m[1] !== "lead_activities")
      .map((m) => `${m[1]}.${m[2]}`);
    expect(unchecked, `these writes discard their result: ${unchecked.join(", ")}`).toEqual([]);
  });
});
