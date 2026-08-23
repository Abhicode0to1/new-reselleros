import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   The lead drawer's shape, asked for on 23 Aug 2026: "follow ups and conversation
   tab ke page ke top le jao".

   A source scan rather than a render test. The drawer is ~1,000 lines of JSX inside
   a 3,700-line page; mounting it here would need the whole query layer stubbed, and
   the thing being protected is an ORDER — which reads plainly in the source and not
   at all in a jsdom snapshot. Same approach route-map.test.ts and the grid-flow scan
   take.

   What made the change worth testing is that the obvious version of it silently did
   not work: `activities` arrives asynchronously, so an effect keyed on `lead?.id`
   alone runs while the list is still empty, lands on Details, and never re-runs. Every
   lead WITH a conversation would still have opened on Details and the feature would
   have looked applied.
   ───────────────────────────────────────────────────────────────────────────── */

const page = readFileSync(
  join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"),
  "utf8",
);

describe("lead drawer — tab order and position", () => {
  it("lists Conversation first and Details last", () => {
    /* Order IS the request. Conversation is what an operator opens a lead to do;
       Details is reference, and reference does not go first. */
    expect(page).toContain('(["activity", "followups", "details"] as const)');
  });

  it("renders the tabs OUTSIDE the scrolling body", () => {
    /* More than a reorder: pinned tabs are reachable from any depth of a long
       thread. Inside the scroll container they were below four blocks, so switching
       tabs meant scrolling back up to find them. */
    const tabs = page.indexOf('(["activity", "followups", "details"] as const)');
    const scroll = page.indexOf('className="flex-1 overflow-y-auto p-5 space-y-4"');
    expect(tabs).toBeGreaterThan(0);
    expect(scroll).toBeGreaterThan(0);
    expect(tabs).toBeLessThan(scroll);
  });

  it("keeps the tabs below the header, so identity stays on screen", () => {
    /* The header was already outside the scroll. A reply composed without knowing
       who it is going to is how the wrong name reaches a customer. */
    expect(page.indexOf("</SheetHeader>")).toBeLessThan(
      page.indexOf('(["activity", "followups", "details"] as const)'),
    );
  });

  it("gives each tab a 44px touch target", () => {
    /* CLAUDE.md §20. The old py-2 gave ~32px, which on a 375px phone is a miss
       waiting to happen. */
    expect(page).toMatch(/min-h-11 px-3 text-xs font-semibold border-b-2/);
  });

  it("marks the active tab for assistive tech, not just visually", () => {
    /* Colour and a border alone say nothing to a screen reader. */
    expect(page).toMatch(/aria-current=\{drawerTab === t \? "page" : undefined\}/);
  });
});

describe("lead drawer — which tab a lead opens on", () => {
  it("re-runs when the activity count changes, not only when the lead does", () => {
    /* THE BUG IN THE OBVIOUS VERSION. activities is async: keyed on lead?.id alone
       the effect fires against an empty list, picks Details, and never re-runs. */
    expect(page).toMatch(/\}, \[lead\?\.id, activities\.length\]\);/);
  });

  it("decides at most once per lead", () => {
    /* A second automatic switch would move the tab out from under somebody who had
       just chosen one — worse than never switching at all. */
    expect(page).toContain("autoPickedFor");
    expect(page).toMatch(/if \(autoPickedFor\.current === id\) return;/);
  });

  it("does not switch while the list is still empty", () => {
    /* Both the loading case and the genuinely-empty case. A brand-new lead has no
       conversation, and landing on an empty Conversation tab is worse than the
       Details default it replaced — that lead's fields are what need filling in. */
    expect(page).toMatch(/if \(activities\.length === 0\) return;/);
  });
});

describe("lead drawer — the duplication that made room for the tabs", () => {
  it("no longer carries a Call/WhatsApp/Email row at the top of the drawer", () => {
    /* The pinned footer has all three and is always visible, so the copy at the very
       top added height and no capability — in exactly the space the tabs now use.
       Asking for the tabs at the top turned out to cost nothing. */
    expect(page).not.toContain("Action row — Call / WhatsApp / Email as big buttons");
    expect(page).not.toContain('<div className="grid grid-cols-3 gap-2">');
  });

  it("still lets the operator LOG a call or a WhatsApp", () => {
    /* Different job from starting one, and the reason that row stayed: a call made
       and never logged is invisible to the timeline, the stage-age badge and every
       forecast built on them. */
    expect(page).toContain("LOGGING what happened");
    expect(page).toContain('<div className="grid grid-cols-2 gap-2">');
  });

  it("keeps the footer's three reach-out actions", () => {
    expect(page).toMatch(/<Button icon="mail" onClick=\{handleEmail\}>Email<\/Button>/);
  });
});
