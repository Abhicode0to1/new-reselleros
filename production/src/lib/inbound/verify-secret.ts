/**
 * The inbound webhook's only guard — and how to rotate it without losing mail.
 *
 * ─── WHY MORE THAN ONE SECRET AT A TIME ─────────────────────────────────────
 * Rotating a single shared secret has a window: whichever side you change first, the other
 * is wrong until you finish. For most systems that means a few failed requests and a retry.
 * Not here.
 *
 * The Apps Script forwarder labels a Gmail thread `erp-sent` AFTER the POST, unconditionally
 * — it never looks at the response code (docs/ENQUIRY-EMAIL-SETUP.md, and the live script
 * Pardeep showed on 23 Aug 2026). So a 401 during the rotation window does not retry: the
 * thread is marked done and that enquiry is gone from the pipeline for good. A five-minute
 * window is five minutes of silently dropped customers.
 *
 * So `INBOUND_EMAIL_SECRET` accepts a COMMA-SEPARATED list, and rotation becomes:
 *   1. set it to "old,new"      → both work, no window
 *   2. update the Apps Script to new
 *   3. set it to "new"          → old is dead
 *
 * ─── AND IT COMPARES IN CONSTANT TIME ───────────────────────────────────────
 * `provided !== SECRET` leaks length and prefix through timing. That is a small
 * consideration for a shared secret in a query string, but this is a PUBLIC endpoint whose
 * only guard is this string, and `timingSafeEqual` costs one import.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Parses the env var into the list of secrets that are currently valid.
 *
 * An empty or missing value yields an EMPTY list, and `secretMatches` then refuses
 * everything — the same fail-closed posture the route had before. A webhook with no
 * configured secret must not be an open one.
 */
export function acceptedSecrets(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    /* Blanks dropped rather than kept: "old," is a typo, and treating the empty tail as a
       valid secret would make every request with no key at all authorised. */
    .filter((s) => s.length > 0);
}

export function secretMatches(provided: string | null | undefined, accepted: readonly string[]): boolean {
  const given = (provided ?? "").trim();
  if (!given || accepted.length === 0) return false;

  const a = Buffer.from(given);
  let ok = false;
  for (const candidate of accepted) {
    const b = Buffer.from(candidate);
    /* Length is checked first because timingSafeEqual throws on a mismatch. That does leak
       length, which is unavoidable with this API and not the part worth protecting.

       Every candidate is compared even after a match, so the work does not depend on WHICH
       secret matched — during a rotation that would otherwise reveal whether a caller is on
       the old key or the new one. */
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}
