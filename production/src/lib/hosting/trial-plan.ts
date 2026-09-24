/**
 * Which hosting plan can be trialled free.
 *
 * Owner decision, 24 Sep 2026: only Starter, whether the customer is looking at
 * monthly or yearly prices. Standard and Plus are buy-only.
 *
 * One definition, read by the /hosting page, the trial form, the trial API and
 * the confirm route that creates the account. The page hiding a button is not
 * the rule — the API refusing is — so a hand-typed `?plan=plus` or a direct POST
 * cannot start a Plus trial either.
 */
export const TRIAL_PLAN_ID = "starter" as const;
export const TRIAL_PLAN_NAME = "Starter";

/** True only for the one plan that has a free trial. Case-insensitive. */
export function isTrialPlan(planId: string | null | undefined): boolean {
  return (planId ?? "").trim().toLowerCase() === TRIAL_PLAN_ID;
}
