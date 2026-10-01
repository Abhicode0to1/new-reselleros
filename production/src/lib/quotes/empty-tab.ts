/**
 * R-063 — what an empty /quotes tab says.
 *
 * The Subscription tab said "No quotes yet — create your first quote" while the Project
 * tab beside it held 2. "No quotes" was false; the owner thought the quotes were lost.
 * An empty tab now says it is empty FOR THAT KIND, and points at the other tab when the
 * other tab has some. Short plain English (house rule, 1 Oct 2026).
 */
export type QuoteView = "subscription" | "project";

export interface EmptyTabCopy {
  title: string;
  body: string;
  /** Label for a "go to the other tab" button, or null when the other tab is empty too. */
  switchLabel: string | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function quotesEmptyCopy(view: QuoteView, otherCount: number): EmptyTabCopy {
  const other = Math.max(0, otherCount);
  if (view === "subscription") {
    return other > 0
      ? { title: "No subscription quotes", body: `${plural(other, "project quote")} in the Project tab.`, switchLabel: "Show project quotes" }
      : { title: "No quotes yet", body: "Quotes will appear here once you create your first quote for a customer.", switchLabel: null };
  }
  return other > 0
    ? { title: "No project quotes", body: `${plural(other, "subscription quote")} in the Subscription tab.`, switchLabel: "Show subscription quotes" }
    : { title: "No project quotes yet", body: "One-time and custom software quotes show here. Create one from Project Sales.", switchLabel: null };
}
