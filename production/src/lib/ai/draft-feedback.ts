/**
 * What the person changed before sending the AI's draft — the only honest measure of whether
 * the agent is any good.
 *
 * ─── WHY THIS EXISTS, AND WHAT IT IS NOT ────────────────────────────────────
 * The agent does not learn. It has memory of a conversation, it reads the live catalogue,
 * and that is the whole of it: nothing about a won deal, a lost deal, or a reply somebody
 * rewrote ever reaches it. Every improvement so far came from a human reading what it wrote
 * — nine prompt rules on 24 Aug 2026, each one traced to a real sentence in a real draft.
 *
 * That loop works and it does not scale, because it depends on somebody remembering an
 * anecdote. This module is the same loop with the anecdote written down: when a rep sends a
 * draft the agent produced, record what the agent wrote, what actually went out, and how far
 * apart they were. After a hundred sends that is a list of the places the agent is reliably
 * wrong, ordered by how often somebody had to fix it.
 *
 * It is NOT training data in the fine-tuning sense and must not be described as such. Nothing
 * here changes a weight. It changes what the next person editing the prompt knows.
 *
 * ─── WHY A VERDICT AND NOT JUST A DIFF ──────────────────────────────────────
 * A character count answers "how much changed" and not "did this draft do its job". The three
 * verdicts are the three decisions a reviewer actually makes:
 *
 *   sent_unchanged  — the draft was good enough to send. The number to watch.
 *   lightly_edited  — a name, a line, a softened phrase. Fine, and not a signal on its own.
 *   rewritten       — the rep started again. THIS is the row worth reading, every time.
 *
 * Pure, so the thresholds can be argued about against a table instead of against a mailbox.
 */

/** What happened to the draft between the agent writing it and the customer receiving it. */
export type DraftEditVerdict = "sent_unchanged" | "lightly_edited" | "rewritten";

export interface DraftEditSummary {
  verdict: DraftEditVerdict;
  /**
   * 0..1, where 1 is byte-identical after normalising whitespace.
   *
   * Word-level, not character-level. A rep who reflows a paragraph or fixes a line break
   * changes hundreds of characters and no words, and a character measure would call that a
   * rewrite — which would bury the rows that matter under formatting noise.
   */
  similarity: number;
  /** Words in the sent version that were not in the draft. The additions, in order. */
  wordsAdded: string[];
  /** Words in the draft that did not survive. The deletions, in order. */
  wordsRemoved: string[];
}

/**
 * Above this, the send counts as unchanged.
 *
 * Not 1.0. A rep replacing "Dear Customer" with the person's actual name, or dropping a
 * trailing line, has accepted the draft — calling that an edit would make the headline number
 * ("how often is it good enough") read far worse than the truth and hide the real rewrites.
 */
export const UNCHANGED_SIMILARITY = 0.95;

/**
 * Below this, the rep started again.
 *
 * ─── THESE TWO NUMBERS ARE CALIBRATED FOR SHORT DRAFTS, AND THAT IS A LIMIT ──
 * A ratio over word counts is LENGTH-SENSITIVE, which is worth saying out loud rather than
 * discovering later. On a 35-word reply — which is what this agent writes — replacing one
 * sentence of three moves the score by about 0.4; on a 400-word document the same edit would
 * barely register. Both thresholds were set by running real drafts through, not by taste:
 *
 *   name swapped                          → 0.94   must read as unchanged
 *   closing sentence softened / replaced   → 0.53   must read as a light edit
 *   most of the draft deleted              → 0.22   must read as a rewrite
 *   answered from scratch                  → 0.10   must read as a rewrite
 *
 * If the agent ever writes long-form, revisit these before trusting the counts. A test pins
 * each of the four cases so a threshold change cannot pass quietly.
 */
export const REWRITTEN_SIMILARITY = 0.45;

/**
 * However low the ratio goes, this many changed words is a typo or a name — not an edit.
 *
 * The ratio alone got the commonest case wrong: swapping "Dear Customer" for the person's
 * actual name scored 0.944 on a short draft and was reported as an edit. That would have made
 * the one number anybody cares about — how often the draft was good enough to send — read
 * worse than the truth, and buried the real rewrites under name changes.
 */
export const TRIVIAL_WORD_CHANGES = 2;

/**
 * Words, lower-cased, punctuation dropped.
 *
 * Punctuation is dropped on purpose. "Rs 10,368." and "Rs 10,368" are the same claim, and a
 * comparison that treats a full stop as a change reports edits nobody made. The digits and
 * the comma inside a number survive, because 10,368 and 10368 ARE worth telling apart.
 */
export function words(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N},./₹%@-]+/gu, " ")
    .split(/\s+/)
    /* Trim punctuation off the ENDS, keep it inside. "10,368." and "10,368" are the same
       claim and must not read as an edit; "10,368" and "10368" are not, and the comma inside
       survives. Caught by the punctuation test, which scored those two texts 0.333 — one
       trailing full stop reported as two thirds of the reply changing. */
    .map((w) => w.replace(/^[,./-]+/, "").replace(/[,./-]+$/, ""))
    .filter(Boolean);
}

/**
 * How much of the draft survived, as a multiset comparison.
 *
 * ─── A MULTISET, NOT A SET ──────────────────────────────────────────────────
 * Set intersection would score "yes yes yes" and "yes" as identical. Counting occurrences
 * means a rep who deleted two of three repetitions is measured as having deleted something,
 * which is what happened.
 *
 * Both directions matter and are combined as a Jaccard-style ratio over totals: a draft the
 * rep only ADDED to is not the same event as one they cut in half, and dividing by the union
 * keeps both visible in one number.
 */
export function wordSimilarity(draft: string, sent: string): number {
  const a = words(draft);
  const b = words(sent);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);

  let shared = 0;
  for (const [w, n] of ca) shared += Math.min(n, cb.get(w) ?? 0);

  /* Union of the multisets: |a| + |b| − shared. Identical texts give shared = |a| = |b|, so
     the ratio is 1; disjoint texts give 0. */
  return shared / (a.length + b.length - shared);
}

/**
 * Compare the draft the agent produced with what the customer actually received.
 *
 * `wordsAdded` / `wordsRemoved` are capped at twenty each. The point of storing them is that
 * somebody reads them — a hundred-word list is a diff nobody opens, and the full texts are
 * on the row anyway for when the summary is not enough.
 */
export function summariseEdit(draft: string, sent: string): DraftEditSummary {
  const similarity = wordSimilarity(draft, sent);

  const a = words(draft);
  const b = words(sent);
  const remaining = new Map<string, number>();
  for (const w of a) remaining.set(w, (remaining.get(w) ?? 0) + 1);

  const wordsAdded: string[] = [];
  for (const w of b) {
    const n = remaining.get(w) ?? 0;
    if (n > 0) remaining.set(w, n - 1);
    else wordsAdded.push(w);
  }
  const wordsRemoved = [...remaining.entries()].flatMap(([w, n]) =>
    Array.from({ length: n }, () => w),
  );

  const changed = wordsAdded.length + wordsRemoved.length;
  const verdict: DraftEditVerdict =
    similarity >= UNCHANGED_SIMILARITY || changed <= TRIVIAL_WORD_CHANGES
      ? "sent_unchanged"
      : similarity < REWRITTEN_SIMILARITY
        ? "rewritten"
        : "lightly_edited";

  return {
    verdict,
    /* Three decimals, matching the numeric(4,3) the column holds. Rounded once, here, so the
       stored value and the value a test asserts on cannot disagree. */
    similarity: Math.round(similarity * 1000) / 1000,
    wordsAdded: wordsAdded.slice(0, 20),
    wordsRemoved: wordsRemoved.slice(0, 20),
  };
}
