import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREATED_BY_SINCE, addedByLabel } from "./added-by";
import type { UserName } from "@/lib/hooks/useUserNames";

const names = new Map<string, UserName>([
  ["u-1", { id: "u-1", label: "Darshan (Sales)", inactive: false }],
  ["u-2", { id: "u-2", label: "Priya Nair", inactive: true }],
]);

const lead = (over: Partial<Parameters<typeof addedByLabel>[0]> = {}) => ({
  createdBy: null,
  source: "manual",
  createdAt: "2026-08-26T09:00:00Z",
  ...over,
});

/* ══ WHY THIS TEST EXISTS ════════════════════════════════════════════════════
   This was an inline IIFE inside a <Fact> in leads/page.tsx. One branch got verified in a
   browser — a tele-calling lead, which read "Created by the calling agent" — and the other four
   were going to stay unverified, because checking each one meant finding a lead in that state and
   opening its drawer. Extracting it is what made them checkable. */

describe("a person added it", () => {
  it("names them", () => {
    expect(addedByLabel(lead({ createdBy: "u-1" }), names)).toBe("Darshan (Sales)");
  });

  it("says so when they have left the company", () => {
    /* `useUserNames` fetches inactive users on purpose: a colleague who left still created the
       leads they created, and filtering them out would turn a real name into a blank on every
       lead they ever added. */
    expect(addedByLabel(lead({ createdBy: "u-2" }), names)).toBe("Priya Nair (no longer active)");
  });

  it("does not show a uuid when the user cannot be resolved", () => {
    /* An id shown to a person is worse than nothing: it looks like a bug and they cannot act on
       it. "A colleague who has left" is both more useful and true — somebody did add this. */
    const out = addedByLabel(lead({ createdBy: "u-999" }), names);
    expect(out).toBe("a colleague who has left");
    expect(out).not.toContain("u-999");
  });

  it("does not show a uuid while the names are still loading", () => {
    expect(addedByLabel(lead({ createdBy: "u-1" }), undefined)).toBe("a colleague who has left");
  });

  it("prefers the person over the source, always", () => {
    /* A manually-added lead whose source says "email-inbound" is odd but possible, and the
       person who added it is still the answer. */
    expect(addedByLabel(lead({ createdBy: "u-1", source: "email-inbound" }), names)).toBe(
      "Darshan (Sales)",
    );
  });
});

describe("nobody added it — the source is the answer", () => {
  it.each([
    ["email-inbound", "Arrived by email — nobody added it"],
    ["whatsapp", "Arrived on WhatsApp — nobody added it"],
    ["tele-calling", "Created by the calling agent"],
    ["csv", "Imported from a file"],
  ])("reads %s as %s", (source, expected) => {
    /* Every one of these is a real value from the live table, not a guess at what might appear.
       Measured 25 Aug 2026: 15 email-inbound, 12 manual, 1 tele-calling, 1 whatsapp. */
    expect(addedByLabel(lead({ source, createdBy: null }), names)).toBe(expected);
  });

  it("never shows a bare dash for a webhook lead", () => {
    /* THE POINT OF THE WHOLE FUNCTION. 15 of 29 leads have no creator and never will — "—" reads
       as missing data and sends somebody looking for a bug that is not there. */
    for (const source of ["email-inbound", "whatsapp", "tele-calling", "csv"]) {
      expect(addedByLabel(lead({ source }), names)).not.toBe("—");
    }
  });
});

describe("rows older than the column", () => {
  it("says the field did not exist yet, rather than implying nobody added it", () => {
    /* The migration deliberately did not backfill: of the 24 leads with activity, the first one
       was an inbound email on 15 of them, so inferring a creator would have credited
       customer-created leads to whoever happened to touch them first. */
    const out = addedByLabel(lead({ source: "manual", createdAt: "2026-08-22T10:00:00Z" }));
    expect(out).toBe("Not recorded — predates this field");
  });

  it("does NOT say that for a lead created after the column landed", () => {
    /* A manual lead created today with no created_by is a real gap — a write path somebody
       missed — and it must not be excused as history. */
    expect(addedByLabel(lead({ source: "manual", createdAt: "2026-08-26T09:00:00Z" }))).toBe("—");
  });

  it("treats the boundary as before-not-after", () => {
    expect(addedByLabel(lead({ source: "manual", createdAt: CREATED_BY_SINCE }))).toBe("—");
  });

  it("survives a missing created_at", () => {
    expect(addedByLabel(lead({ source: "manual", createdAt: null }))).toBe("—");
  });

  it("survives a null source", () => {
    expect(addedByLabel(lead({ source: null, createdAt: null }))).toBe("—");
  });
});

describe("the cutoff matches the migration that created the column", () => {
  it("uses the migration's own timestamp", () => {
    /* Two places holding one date is how they stop agreeing. This is the cheap version of
       keeping them together: the test fails if either moves. */
    const files = readFileSync(
      join(__dirname, "..", "..", "..", "supabase", "migrations", "20260825230000_leads_created_by.sql"),
      "utf8",
    );
    expect(files).toContain("add column if not exists created_by");
    expect(CREATED_BY_SINCE).toBe("2026-08-25T23:00:00Z");
    expect(CREATED_BY_SINCE.slice(0, 13).replace(/[-T:]/g, "")).toBe("2026082523");
  });
});

describe("the three write paths all set it", () => {
  /* Source-read, because the behaviour needs a browser and a session. What it protects is a
     fourth create path being added later without it — at which point new leads would silently
     have no creator and the field would look broken rather than unset. */
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

  it.each([
    ["components/features/leads/quick-add-lead-form.tsx", "quick add"],
    ["components/features/leads/add-lead-form.tsx", "the full form"],
    ["components/features/leads/import-csv-dialog.tsx", "csv import"],
  ])("%s (%s) writes created_by", (path) => {
    expect(read(path)).toContain("created_by:");
  });

  it("the full form writes it on CREATE only, never on update", () => {
    /* THE BUG THIS PREVENTS. `sharedPatch` is the payload for both create and update. Putting
       created_by in there would rewrite the creator on every edit, turning the one column that
       remembers who added a lead into a second copy of "who touched it last" — which is the exact
       failure it was added to prevent. */
    const src = read("components/features/leads/add-lead-form.tsx");
    const patchStart = src.indexOf("const sharedPatch");
    const patchEnd = src.indexOf("if (isEditing && editingLead)");
    expect(patchStart).toBeGreaterThan(-1);
    expect(patchEnd).toBeGreaterThan(patchStart);
    /* Not inside the shared payload… */
    expect(src.slice(patchStart, patchEnd)).not.toContain("created_by");
    /* …and present on the create call. */
    expect(src).toContain("created_by: me?.userId ?? null");
  });
});
