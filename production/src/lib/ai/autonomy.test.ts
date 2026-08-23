import { describe, it, expect } from "vitest";
import {
  resolveAutonomy,
  mayActUnattended,
  killSwitchFor,
  needsConfirmation,
  AI_ACTIONS,
  type AiAction,
  type AutonomyPolicy,
} from "./autonomy";

const OPEN: AutonomyPolicy = { killSwitch: false };

describe("the kill switch", () => {
  it("stops every action, whatever its own mode says", () => {
    /* The thing this app did not have. Grepped 23 Aug 2026 for ai_enabled / emails_paused /
       sending_paused / DISABLE_EMAIL: nothing. Five crons emailed customers unattended and
       the only way to stop one was a Cloud Scheduler job in a Google console. */
    for (const action of Object.keys(AI_ACTIONS) as AiAction[]) {
      const v = resolveAutonomy(action, { killSwitch: true, modes: { [action]: "auto" } });
      expect(v.mode, action).toBe("off");
    }
  });

  it("outranks an explicit auto, not the other way round", () => {
    const v = resolveAutonomy("dunning.send", { killSwitch: true, modes: { "dunning.send": "auto" } });
    expect(v.mode).toBe("off");
    expect(mayActUnattended("dunning.send", { killSwitch: true, modes: { "dunning.send": "auto" } })).toBe(false);
  });

  it("says what did not happen and where to undo it", () => {
    /* §24. Somebody reaches for this switch in a hurry — a wrong price has gone out — and
       the log has to read as an explanation, not as an error code. */
    const v = resolveAutonomy("quote.send", { killSwitch: true });
    expect(v.reason).toMatch(/switched off/);
    expect(v.reason).toMatch(/Email a drafted quote/);
    expect(v.reason).toMatch(/Settings/);
  });
});

describe("defaults describe what the app does TODAY", () => {
  it("leaves the five live crons on when nothing is configured", () => {
    /* THE TRAP THIS AVOIDS. Defaulting everything to "hold" and letting config opt in was
       the obvious design, and it would have silently stopped five working crons the moment
       this was wired, because no tenant has any config yet — dunning would have quietly
       stopped chasing money. Introducing a brake must not itself change behaviour. */
    for (const action of ["dunning.send", "renewal.send", "trial.send", "greeting.send"] as AiAction[]) {
      expect(resolveAutonomy(action, OPEN).mode, action).toBe("auto");
    }
  });

  it("does not list compliance reminders at all", () => {
    /* Listed here for an hour and then removed: compliance reminders go to the TENANT'S OWN
       TEAM ("your GSTR-1 is due"), not to a customer. This dial stops what the app sends OUT
       to other people and must never be able to silence what it says TO YOU — a kill switch
       that muted the filing alarm would turn one bad afternoon into a late fee. A registry
       entry nobody enforces reads as a control the operator does not have. */
    expect(Object.keys(AI_ACTIONS)).not.toContain("compliance.send");
  });

  it("leaves the inbound pipeline on", () => {
    expect(resolveAutonomy("lead.create", OPEN).mode).toBe("auto");
    expect(resolveAutonomy("quote.draft", OPEN).mode).toBe("auto");
    expect(resolveAutonomy("quote.send", OPEN).mode).toBe("auto");
  });

  it("keeps the unbuilt action off", () => {
    /* Not a policy choice — a description. Nothing can send a follow-up nudge, so "off" is
       what is true. Building it will move this default, the way reply.send's moved. */
    expect(resolveAutonomy("followup.send", OPEN).mode).toBe("off");
  });

  it("starts reply.send at HOLD, not auto and no longer off", () => {
    /* `off` used to be a description — nothing could send a reply. Built 23 Aug 2026, so it
       became untrue and moved to `hold`.

       `hold` and not `auto` is the rollout, not caution for its own sake: this is the first
       sentence the app would ever write to a customer unattended, and a default of `auto`
       would have made that a side effect of a deploy rather than a decision somebody made.
       The drafter runs, the draft lands on the lead's timeline, the decision is logged, and
       nothing is sent until the dial is moved from /automation. */
    expect(resolveAutonomy("reply.send", OPEN).mode).toBe("hold");
    expect(mayActUnattended("reply.send", OPEN)).toBe(false);
  });

  it("says the mode came from a default and not from a setting", () => {
    expect(resolveAutonomy("renewal.send", OPEN).reason).toMatch(/no setting for this action/);
    expect(resolveAutonomy("renewal.send", { killSwitch: false, modes: { "renewal.send": "hold" } }).reason)
      .toMatch(/set to "hold"/);
  });
});

describe("a setting an action cannot honour is reported, not rounded off", () => {
  it("refuses to 'hold' a lead creation and says so", () => {
    /* There is no draft lead to hold. Answering that config silently with the default would
       leave somebody believing something untrue about the system. */
    const v = resolveAutonomy("lead.create", { killSwitch: false, modes: { "lead.create": "hold" } });
    expect(v.mode).toBe("auto");
    expect(v.reason).toMatch(/is not a mode/);
    expect(v.reason).toMatch(/fix the setting/);
  });

  it("falls back to the action's own default, not to off and not to auto", () => {
    const v = resolveAutonomy("quote.draft", { killSwitch: false, modes: { "quote.draft": "hold" } });
    expect(v.mode).toBe(AI_ACTIONS["quote.draft"].today);
  });
});

describe("every declared action is internally consistent", () => {
  /* A table-driven check over the registry itself, so a future action cannot be added in a
     state that cannot occur — the kind of mistake nobody notices until the row is live. */
  it.each(Object.keys(AI_ACTIONS) as AiAction[])("%s declares a default it supports", (action) => {
    const spec = AI_ACTIONS[action];
    expect(spec.supports).toContain(spec.today);
  });

  it.each(Object.keys(AI_ACTIONS) as AiAction[])("%s can always be turned off", (action) => {
    /* Non-negotiable. An action the operator cannot stop is not a feature, it is a
       liability — and the kill switch alone is too blunt to be the only answer. */
    expect(AI_ACTIONS[action].supports).toContain("off");
  });

  it.each(Object.keys(AI_ACTIONS) as AiAction[])("%s has a human-readable label", (action) => {
    /* It is written into the audit log and read by somebody who did not write the code. */
    expect(AI_ACTIONS[action].label.length).toBeGreaterThan(8);
  });
});

describe("mayActUnattended", () => {
  it("is true only for auto", () => {
    expect(mayActUnattended("renewal.send", OPEN)).toBe(true);
    expect(mayActUnattended("reply.send", OPEN)).toBe(false);
    expect(mayActUnattended("renewal.send", { killSwitch: false, modes: { "renewal.send": "hold" } })).toBe(false);
  });
});

describe("the UI switch versus the stored column — they are opposites", () => {
  /* THE BUG THIS EXISTS FOR, found 23 Aug 2026 by clicking the switch in a browser rather
     than by reading the code. The page shows "Automation is on"; the column stores
     `ai_kill_switch`. The first version got BOTH halves backwards: turning automation off
     popped a dialog reading "Turn automation back on?", and would then have written
     killSwitch=false — leaving automation running while the operator believed they had
     stopped it.

     A kill switch that silently does nothing is worse than no kill switch. */

  it("maps automation-on to kill-switch-off", () => {
    expect(killSwitchFor(true)).toBe(false);
    expect(killSwitchFor(false)).toBe(true);
  });

  it("round-trips, so neither direction can drift alone", () => {
    for (const on of [true, false]) {
      expect(!killSwitchFor(on)).toBe(on);
    }
  });

  it("confirms turning automation ON, not off", () => {
    /* Off is the safe move and asking would slow down the emergency the switch exists for.
       On resumes mail to real customers — that is the half that cannot be taken back. */
    expect(needsConfirmation(true)).toBe(true);
    expect(needsConfirmation(false)).toBe(false);
  });

  it("means the resolved policy actually stops when the switch is flipped off", () => {
    /* End to end through the real resolver, so the mapping and the rule are checked
       together rather than each being right about a different convention. */
    const policy: AutonomyPolicy = { killSwitch: killSwitchFor(false) };
    expect(resolveAutonomy("renewal.send", policy).mode).toBe("off");
    const back: AutonomyPolicy = { killSwitch: killSwitchFor(true) };
    expect(resolveAutonomy("renewal.send", back).mode).toBe("auto");
  });
});
