/**
 * What an edition adds over the one below it — "Everything in Starter, plus: …" (2 Oct 2026).
 *
 * The three Google Workspace cards listed nearly the same features, so the eye could not find
 * the difference that the price difference pays for. A feature line is "Label" or
 * "Label: value"; a line that is new OR whose value changed (30 GB → 2 TB) counts as added.
 */
export function editionDelta(lower: readonly string[], current: readonly string[]): string[] {
  const had = new Set(lower);
  return current.filter((f) => !had.has(f));
}
