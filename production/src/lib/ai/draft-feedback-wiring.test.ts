import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   The capture has to be WIRED, end to end, or it records nothing and looks fine.

   This is a four-hop chain — composer remembers the draft → mutation forwards it → route
   accepts it → helper stores it — and every hop is optional by design so no existing caller
   breaks. That is the right call and it is also the risk: drop any one link and the table
   stays empty, no test fails, and the first anybody knows is somebody asking why there is
   nothing to review.

   Pinned on the SOURCE because the failure is an ABSENCE. A mock of the route would pass
   happily while the composer never sent the field, which is exactly the shape of the bug
   this file exists to catch. Same reasoning as human-touch.test.ts and the autonomy
   chokepoint scan.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the draft-feedback chain", () => {
  it("1. the composer keeps the AI draft it put in the box", () => {
    const code = read("components/features/enquiries/reply-composer.tsx");
    expect(code).toContain("setAiDraft({");
    /* Kept EXACTLY as it came back — comparing against a reformatted copy would report edits
       the person never made. */
    expect(code).toContain("body: json.message");
  });

  it("2. the composer forwards it on send, and ONLY when there was one", () => {
    const code = read("components/features/enquiries/reply-composer.tsx");
    expect(code).toContain("ai_draft_body: aiDraft.body");
    /* The conditional spread is the load-bearing part: sending it unconditionally would
       record rows for replies the agent never touched, and every "how often was the draft
       good enough" number would be wrong in the flattering direction. */
    expect(code).toMatch(/\.\.\.\(aiDraft \? \{/);
  });

  it("3. the composer forgets it once the box is emptied", () => {
    /* Otherwise the NEXT reply — typed from scratch — is measured against the last draft,
       and shows up as a rewrite of something the rep never saw. */
    const code = read("components/features/enquiries/reply-composer.tsx");
    expect(code).toContain("setAiDraft(null)");
  });

  it("4. the mutation passes it through instead of dropping it", () => {
    /* `const { id, ...body } = input` forwards whatever is on the object, so the risk here is
       the TYPE not allowing the field and a future edit "tidying" it away. */
    const code = read("lib/queries/inbound-emails.ts");
    expect(code).toContain("ai_draft_body?: string;");
  });

  it("5. the route accepts it and records the pair after a REAL send", () => {
    const code = read("app/api/inbound-emails/[id]/reply/route.ts");
    expect(code).toContain("ai_draft_body:");
    expect(code).toContain("recordDraftFeedback({");
    /* Only a real send. A stubbed attempt reached nobody, and a review list full of drafts
       that were never delivered teaches the wrong lesson. */
    expect(code).toMatch(/sent\.status === "sent" && parsed\.ai_draft_body/);
  });

  it("6. the helper refuses to write a row with no draft", () => {
    /* The one that keeps the numbers honest: a row with an empty draft_body would count as
       "the agent wrote something and the human sent it", which never happened. */
    const code = read("lib/ai/draft-feedback.server.ts");
    expect(code).toMatch(/if \(!draft\) return;/);
  });

  it("7. and it can never break a send", () => {
    /* The customer has the email by the time this runs. A throw here would hand the operator
       an error for a message that already left, and they would send it again. */
    const code = read("lib/ai/draft-feedback.server.ts");
    expect(code).toContain("catch (err)");
    expect(code).not.toMatch(/\bthrow\b/);
  });
});
