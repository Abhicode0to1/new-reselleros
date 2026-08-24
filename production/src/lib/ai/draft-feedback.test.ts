import { describe, it, expect } from "vitest";
import {
  summariseEdit,
  wordSimilarity,
  words,
  REWRITTEN_SIMILARITY,
  UNCHANGED_SIMILARITY,
  TRIVIAL_WORD_CHANGES,
} from "./draft-feedback";

/* ─────────────────────────────────────────────────────────────────────────────
   What the person changed before sending.

   The agent does not learn from outcomes — nothing about a won deal, a lost deal or a
   rewritten reply reaches it. Every improvement so far came from a human reading a real
   draft: nine prompt rules on 24 Aug 2026, each traced to one sentence somebody noticed.

   That loop depends on remembering an anecdote. These are the tests for writing the
   anecdote down, so "the places the agent is reliably wrong" becomes a list ordered by how
   often somebody had to fix it — not a memory.
   ───────────────────────────────────────────────────────────────────────────── */

const DRAFT =
  "Dear Customer,\n\nGoogle Workspace Business Standard is Rs 10,368 per seat per year " +
  "plus 18% GST. Send me the seat count and I will prepare the quotation.\n\n" +
  "Warm regards,\nANUTECH DIGITAL PVT LTD";

describe("sent unchanged", () => {
  it("scores an identical send as 1 and calls it unchanged", () => {
    const s = summariseEdit(DRAFT, DRAFT);
    expect(s.similarity).toBe(1);
    expect(s.verdict).toBe("sent_unchanged");
    expect(s.wordsAdded).toEqual([]);
    expect(s.wordsRemoved).toEqual([]);
  });

  it("ignores reflowed whitespace and line breaks", () => {
    /* A rep whose mail client rewraps the paragraph changed hundreds of characters and no
       words. A character-level measure would call that a rewrite and bury the real ones. */
    const reflowed = DRAFT.replace(/\n+/g, " ").replace(/\s+/g, " ");
    expect(summariseEdit(DRAFT, reflowed).verdict).toBe("sent_unchanged");
  });

  it("still counts as unchanged when the rep uses the customer's real name", () => {
    /* The commonest edit there is, and it means the draft was accepted. Calling it an edit
       would make the headline number — how often the agent is good enough — read worse than
       the truth. */
    const named = DRAFT.replace("Dear Customer", "Dear Ramesh");
    const s = summariseEdit(DRAFT, named);
    expect(s.verdict).toBe("sent_unchanged");
    /* Note WHICH rule carries it: the ratio is 0.941, BELOW the 0.95 threshold. It reads as
       unchanged because only two words moved, which is the TRIVIAL_WORD_CHANGES carve-out.
       Asserted explicitly, because the first version of this test checked the ratio and would
       have gone green the day somebody quietly loosened the threshold instead. */
    expect(s.similarity).toBeLessThan(UNCHANGED_SIMILARITY);
    expect(s.wordsAdded.length + s.wordsRemoved.length).toBeLessThanOrEqual(TRIVIAL_WORD_CHANGES);
    expect(s.wordsAdded).toEqual(["ramesh"]);
    expect(s.wordsRemoved).toEqual(["customer"]);
  });
});

describe("lightly edited", () => {
  it("flags a softened sentence without calling it a rewrite", () => {
    const softened = DRAFT.replace(
      "Send me the seat count and I will prepare the quotation.",
      "Whenever you have the seat count, just share it and we will get the quotation ready for you.",
    );
    const s = summariseEdit(DRAFT, softened);
    expect(s.verdict).toBe("lightly_edited");
  });

  it("reports what was added and what went, so the row can be read", () => {
    const s = summariseEdit("the price is Rs 10,368 per seat", "the price is Rs 10,368 per seat plus GST");
    expect(s.wordsAdded).toEqual(["plus", "gst"]);
    expect(s.wordsRemoved).toEqual([]);
  });

  it("caps both lists at twenty, because the point is that somebody reads them", () => {
    const many = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const s = summariseEdit("hello", `hello ${many}`);
    expect(s.wordsAdded).toHaveLength(20);
  });
});

describe("rewritten — the rows worth reading", () => {
  it("calls a fresh reply a rewrite", () => {
    const fresh =
      "Hi Ramesh, thanks for your patience. Our engineer will call you this afternoon to " +
      "walk through the migration before we talk about licences at all.";
    const s = summariseEdit(DRAFT, fresh);
    expect(s.verdict).toBe("rewritten");
    expect(s.similarity).toBeLessThan(REWRITTEN_SIMILARITY);
  });

  it("catches the rep deleting most of the draft", () => {
    const trimmed = "Dear Customer,\n\nRs 10,368 per seat per year.\n\nANUTECH";
    expect(summariseEdit(DRAFT, trimmed).verdict).toBe("rewritten");
  });
});

describe("the measure itself", () => {
  it("is a MULTISET comparison, not a set one", () => {
    /* Set intersection scores "yes yes yes" and "yes" as identical. A rep who cut two of
       three repetitions deleted something, and the number has to say so. */
    expect(wordSimilarity("yes yes yes", "yes")).toBeLessThan(1);
    expect(wordSimilarity("yes yes yes", "yes yes yes")).toBe(1);
  });

  it("sees a changed FIGURE as a change", () => {
    /* The whole reason this exists. If a rep is repeatedly correcting the price, that is the
       single most important pattern in the data — a comparison that normalised numbers away
       would hide the one thing worth knowing. */
    const a = "Rs 10,368 per seat per year";
    const b = "Rs 10,368 per seat per month";
    expect(wordSimilarity(a, b)).toBeLessThan(1);
    expect(summariseEdit(a, b).wordsAdded).toContain("month");

    const c = "Rs 864 per seat per year";
    expect(summariseEdit(a, c).wordsRemoved).toContain("10,368");
  });

  it("does not report punctuation as an edit", () => {
    expect(wordSimilarity("Rs 10,368.", "Rs 10,368")).toBe(1);
  });

  it("keeps the currency symbol and the percent sign, which carry meaning", () => {
    expect(words("₹10,368 plus 18% GST")).toEqual(["₹10,368", "plus", "18%", "gst"]);
  });

  it("handles an empty side without dividing by zero", () => {
    expect(wordSimilarity("", "")).toBe(1);
    expect(wordSimilarity(DRAFT, "")).toBe(0);
    expect(summariseEdit(DRAFT, "").verdict).toBe("rewritten");
  });

  it("rounds to three places, matching the column that stores it", () => {
    /* numeric(4,3). Rounded once, in one place, so the stored value and an asserted value
       cannot disagree — the same reason the confidence column is numeric and not float. */
    const s = summariseEdit("one two three", "one two four");
    expect(String(s.similarity)).toMatch(/^\d(\.\d{1,3})?$/);
  });
});
