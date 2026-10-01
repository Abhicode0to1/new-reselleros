/**
 * The trial confirmation page (1 Oct 2026): once DMS has created the account, the next
 * step is the Customer Portal login; while a person still has to set it up, the page
 * promises no login and no "now".
 */
import { describe, expect, it } from "vitest";
import { TRIAL_STATUSES } from "./trial-statuses";

describe("trial confirmation page", () => {
  it("a created account (provisioned, already) leads to the Customer Portal login", () => {
    expect(TRIAL_STATUSES.provisioned.portal).toBe(true);
    expect(TRIAL_STATUSES.already.portal).toBe(true);
    expect(TRIAL_STATUSES.provisioned.body).toMatch(/set your Customer Portal password/);
  });
  it("a hand-made account (pending, error) shows no login button and promises no instant account", () => {
    for (const s of ["pending", "error", "needdomain", "notrialplan", "expired", "invalid"]) {
      expect(TRIAL_STATUSES[s].portal, s).toBeFalsy();
    }
    expect(TRIAL_STATUSES.pending.body).not.toMatch(/\bnow\b|shortly/);
    expect(TRIAL_STATUSES.pending.body).toMatch(/within 1 working day/);
  });
});
