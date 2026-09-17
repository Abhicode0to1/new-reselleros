/**
 * Lives beside the page rather than in it because **a Next App Router page file
 * may export only the things Next names** — `default`, `metadata`, `revalidate`
 * and the rest of the route-segment config. A stray named export fails the
 * build with "Property 'notLiveBreakdown' is incompatible with index signature",
 * from `.next/types/app/…/page.ts`.
 *
 * `tsc --noEmit` passes it happily, because those generated route types do not
 * exist until a build has run — which is exactly the case CLAUDE.md §25 gives
 * for keeping `next build` in the green rather than trusting three faster checks.
 */

/**
 * What "Not live" is actually made of.
 *
 * The tile counted every status that is not `active` and stopped there, so a
 * customer with one paused site and one still being built read "Not live 2" —
 * one number for two situations that call for opposite reactions. Paused means
 * the site is off and somebody needs to be asked why; setting up means nothing
 * is wrong and there is nothing to do.
 *
 * The KPI already has a slot for this (`trend`, which the Ending-soon tile and
 * the whole domains panel use), so the breakdown costs no width.
 *
 * Only non-zero parts appear, in a fixed order — worst first, because the point
 * of reading it is to find the one that needs attention. Exported for tests.
 */
export function notLiveBreakdown(statuses: readonly string[]): string | undefined {
  const parts: string[] = [];
  const count = (s: string) => statuses.filter((x) => x === s).length;
  for (const [status, word] of [
    ["suspended", "paused"],
    ["failed", "setup failed"],
    ["expired", "ended"],
    ["terminated", "closed"],
    ["pending", "setting up"],
  ] as const) {
    const n = count(status);
    if (n > 0) parts.push(`${n} ${word}`);
  }
  /* One part that just restates the number adds nothing: "1 · 1 paused". */
  return parts.length > 1 ? parts.join(" · ") : parts[0];
}
