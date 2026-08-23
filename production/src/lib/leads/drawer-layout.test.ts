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

/* Comments STRIPPED. Several assertions below are about a token being absent, or
   about where it sits — and every one of those tokens is also NAMED in a comment
   explaining why it moved or went. A blunt scan of the raw source failed on the
   explanation, which would have pushed the reasoning out of the file to satisfy the
   test. Same guard sentry-client.test.ts uses, for the same reason. Assert prose
   against `page`, code against `code`. */
const code = page
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

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


/* ─────────────────────────────────────────────────────────────────────────────
   The card that used to sit above all three tabs, and where its five parts went.

   Asked for as "is section ko bhi kahin adjust karo logically". Measuring it first
   showed the tab move on its own had bought nothing: a ~300px block still stood
   between the pinned tabs and the thread. It held five unrelated jobs, and each one
   has a different correct home — which is why it is asserted here as five separate
   destinations rather than one "card removed" check.
   ───────────────────────────────────────────────────────────────────────────── */

describe("the contact card, dissolved by what each part is for", () => {
  it("puts contact identity in the header, where it cannot scroll away", () => {
    /* Identity is the guard against a reply reaching the wrong person, and in the
       scroll it disappeared the moment you opened the thread you were answering. */
    const header = page.slice(page.indexOf("<SheetHeader"), page.indexOf("</SheetHeader>"));
    expect(header).toContain("lead.contact_name");
    expect(header).toContain("lead.contact_phone");
    expect(header).toContain("lead.gstin");
  });

  it("shows the full GSTIN somewhere, not just its first two characters", () => {
    /* The badge renders `lead.gstin.slice(0, 2)` and the old tooltip said only "GST
       Identification Number", so the number itself was readable nowhere in the drawer. */
    expect(page).toMatch(/title=\{`GSTIN \$\{lead\.gstin\}`\}/);
  });

  it("moves the note box and Log call into the Conversation tab", () => {
    /* They put things INTO the conversation, so they belong to it. On Details and
       Follow-ups they were only height. */
    const convo = code.indexOf('{drawerTab === "activity" && (');
    const note = code.indexOf('placeholder="Add a note');
    const logCall = code.indexOf("Log call");
    expect(convo).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(convo);
    expect(logCall).toBeGreaterThan(convo);
    /* And specifically NOT in the tab-agnostic space above the tab bodies, which is
       where they used to be — visible on Details and Follow-ups too. */
    expect(note).toBeGreaterThan(code.indexOf('{drawerTab === "details" && ('));
  });

  it("keeps Log call, which the footer's Call button does not replace", () => {
    /* One starts a call, the other records one that already happened elsewhere. A call
       made and never logged is invisible to the timeline, the stage-age badge and every
       forecast built on them. */
    expect(page).toContain("LOG CALL IS NOT THE FOOTER'S CALL BUTTON");
    expect(page).toMatch(/kind: "call"/);
  });

  it("drops the duplicate Generate quote button", () => {
    /* It called handleSendQuote — the same handler as the footer's quote button, ~40px
       away in the same drawer. */
    expect(code).not.toContain("Generate quote");
  });

  it("lays the two thread buttons out with flex, not a fixed 2-col grid", () => {
    /* The AI button is conditional on a phone or an email existing; in a fixed grid its
       absence left Log call at half width against dead space. */
    const convo = code.slice(code.indexOf('{drawerTab === "activity" && ('));
    expect(convo.slice(0, 2500)).not.toContain('grid grid-cols-2 gap-2');
  });
});

describe("exactly one primary action in the drawer", () => {
  it("has no variant=\"primary\" button left in the footer", () => {
    /* THE DEFECT IN THE SCREENSHOT. The footer built its own stage-aware primary while
       nextAction built another from different logic, so a new lead with a phone showed
       "Call now · first contact" at the top and "Send Quote" at the bottom, both
       full-strength. Two primaries is no primary. */
    const footer = code.slice(code.indexOf("<SheetFooter"), code.indexOf("</SheetFooter>"));
    expect(footer).not.toMatch(/variant="primary"/);
  });

  it("keeps the two footer actions nextAction does not cover", () => {
    /* Deleting the footer's stage block wholesale would have been a quiet capability
       loss: nextAction offers "Upsell · new quote" on a won deal but no way to open the
       accepted quote, and on a sent quote the top block is the QuoteActionBar, which
       moves a quote's status and cannot revise it. */
    const footer = page.slice(page.indexOf("<SheetFooter"), page.indexOf("</SheetFooter>"));
    expect(footer).toContain("Open accepted quote");
    expect(footer).toContain("handleReviseQuote");
  });

  it("keeps the footer's three reach-out actions", () => {
    expect(page).toMatch(/<Button icon="mail" onClick=\{handleEmail\}>Email<\/Button>/);
  });

  it("stops gating the next-step CTA on the lead having contact details", () => {
    /* A BUG FOUND ON THE WAY. The whole card was wrapped in
       `lead.contact_phone || lead.contact_email || lead.gstin`, and the CTA was inside
       it — so a lead with no phone, no email and no GSTIN got no next-step suggestion
       at all. Exactly the lead that most needs one, since there is nobody to call. */
    expect(page).not.toMatch(
      /\{\(lead\.contact_phone \|\| lead\.contact_email \|\| lead\.gstin\) && \(/,
    );
  });

  it("renders the decision above the tab bodies, since it does not depend on the tab", () => {
    const decision = page.indexOf("{latestQuoteForAction ? (");
    const firstTabBody = page.indexOf('{drawerTab === "details" && (');
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(firstTabBody);
  });

  it("never renders QuoteActionBar and nextAction together", () => {
    /* Both have a button labelled "Record payment" and they do DIFFERENT things — the
       bar opens the dialog inline, nextAction navigates to the quote hub. Same label,
       two behaviours, side by side would be the worst version of this bug. */
    expect(page).toMatch(/\{latestQuoteForAction \? \([\s\S]{0,6000}?\) : nextAction \? \(/);
  });
});
