import { describe, it, expect } from "vitest";
import {
  APPROVER_ROLES,
  INSIGHT_EXPIRY_DAYS,
  INSIGHT_KINDS,
  MIN_SAMPLE_TO_QUEUE,
  NEVER_QUEUED,
  decideApproval,
  screenInsight,
  type Insight,
  type Reviewer,
} from "./insights";
import { AUTHORISED_CLAIMS } from "./tone";
import { screenHumanAnswer } from "./gold-standard";
import { redactLesson } from "./playbook";

const insight = (over: Partial<Insight> = {}): Insight => ({
  kind: "claim_ordering",
  leadWith: "gst_invoice",
  replaces: "migration_included",
  sampleSize: 40,
  summary: "Deals that raised a price objection closed more often when the invoice led.",
  ...over,
});

const reviewer = (over: Partial<Reviewer> = {}): Reviewer => ({
  role: "manager",
  openedTheItem: true,
  sawWhatItReplaces: true,
  ...over,
});

/* ══ THE GUARDRAIL IS THE QUEUE'S TYPE, NOT THE REVIEWER'S ATTENTION ═════════ */

describe("no approval can introduce a claim, because the queue has no shape for one", () => {
  it("holds exactly three kinds, and none of them can add a claim", () => {
    /* ─── WHERE THE BRIEF'S FAILURE HAS TO BE STOPPED ─────────────────────────
       If the queue can contain "a new claim" then one careless click adds a claim. If it can only
       contain an ORDERING among claims already authorised, then no click — careless, rushed, or
       malicious — can add one. THE REVIEWER IS THE SECOND LINE. The first line is that there is
       nothing dangerous in the queue to approve. */
    expect([...INSIGHT_KINDS].sort()).toEqual(
      ["claim_ordering", "objection_frequency", "operational_alert"].sort(),
    );
    for (const k of INSIGHT_KINDS) {
      expect(k).not.toMatch(/claim_new|new_claim|price|discount|prompt|template|verbatim/);
    }
  });

  it("refuses an ordering that names something off the authorised list", () => {
    /* Not a reordering at all — a new claim wearing a reordering's clothes. */
    const s = screenInsight(
      insight({ leadWith: "iso_certified" as unknown as Insight["leadWith"] }),
    );
    expect(s.queueable).toBe(false);
    expect(s.reason).toContain("a new claim wearing a reordering's clothes");
  });

  it("refuses an ordering that REPLACES something off the list", () => {
    const s = screenInsight(
      insight({ replaces: "uptime_sla" as unknown as Insight["replaces"] }),
    );
    expect(s.queueable).toBe(false);
  });

  it("refuses a kind that does not exist", () => {
    const s = screenInsight(insight({ kind: "prompt_edit" as unknown as Insight["kind"] }));
    expect(s.queueable).toBe(false);
    expect(s.reason).toContain("no approval can introduce a claim, a price or a discount");
  });

  it("only ever leads with a claim from the authorised universe", () => {
    for (const claim of AUTHORISED_CLAIMS) {
      expect(screenInsight(insight({ leadWith: claim })).queueable).toBe(true);
    }
  });
});

/* ══ The brief's own example never reaches the queue ═════════════════════════ */

describe("the 90% discount is stopped twice BEFORE this queue", () => {
  it("gold-standard blocks any human answer containing a discount", () => {
    /* ─── THE FIRST OF THE TWO UPSTREAM STOPS ─────────────────────────────────
       "kisi customer ko galti se 90% discount dekar usse winning pattern samajh lena" — the brief
       names its own worst case, and the guardrail for it already existed before this feature. */
    const answer =
      "Given the volume I have gone ahead and applied a 90% discount for you on this one, which " +
      "is well past what we normally do but I would rather have you as a customer.";
    const s = screenHumanAnswer(answer);
    expect(s.eligible).toBe(false);
    expect(s.blockers).toContain("offers_a_discount");
  });

  it("playbook keeps no figure from the deal at all", () => {
    /* The second stop. Nothing numeric survives the reduction, so there is no "90" to promote. */
    const lesson = redactLesson({
      outcome: "won",
      customerMessages: ["we got 90% off elsewhere, match it"],
      claimsLedWith: ["gst_invoice"],
      seats: 30,
      turnCount: 6,
      hadBusinessDomain: true,
    });
    expect(JSON.stringify(lesson)).not.toContain("90");
  });

  it("and the queue itself refuses a percentage in the summary — the belt", () => {
    /* A summary is written by the app, so a number in one means something assembled it from a
       deal rather than from a count. */
    const s = screenInsight(
      insight({ summary: "Deals closed more often when a 90% discount was offered." }),
    );
    expect(s.queueable).toBe(false);
    expect(s.reason).toContain("a discount that worked once is the exact thing this queue must not");
  });

  it("refuses money in a summary however it is written", () => {
    for (const summary of [
      "Leading with Rs 3,240 per seat worked better.",
      "Deals under ₹50,000 closed faster.",
      "A 15% concession helped.",
    ]) {
      expect(screenInsight(insight({ summary })).queueable, summary).toBe(false);
    }
  });
});

/* ══ One click is refused ════════════════════════════════════════════════════ */

describe("decideApproval will not accept a click on a row", () => {
  it("refuses an approval from the list, without the item being opened", () => {
    /* ─── ONE CLICK IS THE PROBLEM, NOT THE FEATURE ───────────────────────────
       "Sales Manager bas 1-click [Approve Insight] dabata hai" describes the mechanism by which a
       human in the loop stops being one. A row-level button makes approval a scroll-and-tap habit,
       and within a week it is rubber-stamping — at which point the queue is WORSE than no queue,
       because it produces a record saying somebody checked.

       This codebase already knows it: BulkBarConfirmButton carries a four-second disarm, and
       money-health-card renders nothing when healthy so its appearance still means "stop and
       read". */
    const d = decideApproval({ insight: insight(), reviewer: reviewer({ openedTheItem: false }) });
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("without being opened");
    expect(d.reason).toContain("worse than no queue");
    expect(d.reason).toContain("a record saying somebody checked");
  });

  it("refuses an ordering approved without seeing what it replaces", () => {
    /* "Lead with the GST invoice" means nothing until you know it displaces migration. */
    const d = decideApproval({
      insight: insight(),
      reviewer: reviewer({ sawWhatItReplaces: false }),
    });
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("approving it blind is approving half a change");
  });

  it("does not require the replaces-check for a kind that replaces nothing", () => {
    /* An objection count changes no behaviour, so demanding that screen would be friction with
       no argument behind it — and friction without a reason is what teaches people to click past
       the friction that has one. */
    const d = decideApproval({
      insight: insight({ kind: "objection_frequency", leadWith: null, replaces: null }),
      reviewer: reviewer({ sawWhatItReplaces: false }),
    });
    expect(d.approved).toBe(true);
  });

  it("limits approval to owner or manager", () => {
    for (const role of ["support", "delivery", "sales_senior"]) {
      const d = decideApproval({ insight: insight(), reviewer: reviewer({ role }) });
      expect(d.approved, role).toBe(false);
      expect(d.reason).toContain("changes what the agent says to");
    }
    for (const role of APPROVER_ROLES) {
      expect(decideApproval({ insight: insight(), reviewer: reviewer({ role }) }).approved).toBe(true);
    }
  });

  it("screens BEFORE it checks the reviewer", () => {
    /* An unqueueable insight is refused whoever is looking at it — the type is the first line and
       the person is the second, in that order. */
    const d = decideApproval({
      insight: insight({ summary: "A 90% discount worked." }),
      reviewer: reviewer({ role: "owner" }),
    });
    expect(d.approved).toBe(false);
    expect(d.reason).toContain("never a percentage off");
  });
});

/* ══ Nothing is permanent ════════════════════════════════════════════════════ */

describe("every approval carries an expiry", () => {
  it("stands for a bounded number of days, not forever", () => {
    /* The brief says an approved rule becomes part of the AI's memory permanently. An ordering
       that was right in August is wrong after a vendor price change or a new product. */
    const d = decideApproval({ insight: insight(), reviewer: reviewer() });
    expect(d.approved).toBe(true);
    expect(d.expiresInDays).toBe(INSIGHT_EXPIRY_DAYS);
    expect(INSIGHT_EXPIRY_DAYS).toBeGreaterThan(0);
    expect(INSIGHT_EXPIRY_DAYS).toBeLessThanOrEqual(180);
    expect(d.reason).toContain("Nothing here is permanent");
  });

  it("reports no expiry when nothing was approved", () => {
    expect(decideApproval({ insight: insight(), reviewer: reviewer({ role: "support" }) }).expiresInDays).toBeNull();
  });
});

/* ══ A short queue is the point ══════════════════════════════════════════════ */

describe("the sample floor keeps the queue short", () => {
  it("refuses an insight drawn from too few deals", () => {
    /* A queue full of things that should not be approved teaches the reviewer to skim, and a
       skimming reviewer is the failure this whole queue exists to prevent. */
    const s = screenInsight(insight({ sampleSize: 3 }));
    expect(s.queueable).toBe(false);
    expect(s.reason).toContain("teaches the reviewer to skim");
    expect(s.reason).toContain(String(MIN_SAMPLE_TO_QUEUE));
  });

  it("accepts one exactly at the floor", () => {
    expect(screenInsight(insight({ sampleSize: MIN_SAMPLE_TO_QUEUE })).queueable).toBe(true);
  });

  it("gets the singular right, because a reviewer reads these", () => {
    expect(screenInsight(insight({ sampleSize: 1 })).reason).toContain("1 deal,");
    expect(screenInsight(insight({ sampleSize: 2 })).reason).toContain("2 deals,");
  });
});

/* ══ What the empty state should say ════════════════════════════════════════ */

describe("NEVER_QUEUED", () => {
  const all = NEVER_QUEUED.join(" | ");

  it("names the new claim first, and says the type has no shape for it", () => {
    expect(all).toContain("A new claim");
    expect(all).toContain("the type has no shape for it");
  });

  it("names the brief's own example and where it is actually stopped", () => {
    expect(all).toContain("a 90% discount given");
    expect(all).toContain("screenHumanAnswer blocks any answer containing a discount");
    expect(all).toContain("redactLesson keeps no");
  });

  it("names the prompt, and why one click on it is one click on the guards", () => {
    expect(all).toContain("An edit to any prompt");
    expect(all).toContain("a one-click change to the guards");
  });

  it("names verbatim wording", () => {
    expect(all).toContain("A verbatim message");
    expect(all).toContain("whoever approved it");
  });
});
