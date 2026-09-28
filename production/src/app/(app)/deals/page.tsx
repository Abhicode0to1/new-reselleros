/**
 * /deals — Deal Pipeline page.
 *
 * Re-uses the same component as /leads. The component reads usePathname()
 * internally and switches its mode. The split is BY STAGE, not by plan:
 *   /leads → stage `new` or `contact`            (raw inbox, list view)
 *   /deals → stage demo / trial / quote / won / lost   (Kanban + list)
 *
 * ─── TWO CLAIMS THAT USED TO BE HERE AND WERE BOTH FALSE (17 Aug 2026) ──────
 * This header said the filter was "NULL-plan" vs "plan-set". It is not, and never
 * was — `isRaw()` in leads/page.tsx reads `stage`. Acting on the old wording produced
 * a completely inverted picture of where the pipeline lives: it suggested /deals held
 * most of the leads when in fact /leads holds 9 of 10 and /deals holds 1.
 *
 * It also said "Route is gated in middleware". That was RIGHT about the effect and
 * misleading about the mechanism, which cost a wrong conclusion: PROTECTED_PREFIXES is
 * only the auth check, and the real enforcement was middleware:105 calling
 * allowedRoutesForRole() — one hop away in nav.ts. A plain `sales` user without the
 * flag WAS redirected away from this page.
 *
 * That gate has now been removed (nav.ts), so every sales user can reach this page.
 * Pardeep confirmed the restriction is obsolete on 17 Aug 2026.
 */
export { default } from "../leads/page";
