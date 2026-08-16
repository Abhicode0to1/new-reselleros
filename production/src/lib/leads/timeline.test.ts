import { describe, it, expect } from "vitest";
import { buildTimeline, timelineMeta } from "./timeline";

const at = (iso: string) => iso;

describe("buildTimeline — one stream, newest first", () => {
  const t = buildTimeline({
    activities: [{ id: "a1", kind: "call", detail: "No answer", created_at: at("2026-08-05T10:00:00Z") }],
    quotes:     [{ id: "Q-1", status: "sent", amount: 120_000, created_at: at("2026-08-03T09:00:00Z") }],
    tasks:      [{ id: "t1", title: "Send proposal", status: "pending", due_at: "2026-08-20", created_at: at("2026-08-04T08:00:00Z") }],
    payments:   [{ id: "p1", amount: 60_000, method: "upi", paid_at: at("2026-08-06T11:00:00Z") }],
  });

  it("interleaves every source in true chronological order", () => {
    /* The bug this removes: three separate lists, each sorted alone, so the quote sent
       on the 3rd renders above the call made on the 5th purely because quotes render
       first. */
    expect(t.entries.map((e) => e.kind)).toEqual(["payment", "activity", "task", "quote"]);
  });

  it("carries the rupee amount where the event has one", () => {
    expect(t.entries.find((e) => e.kind === "payment")!.amount).toBe(60_000);
    expect(t.entries.find((e) => e.kind === "quote")!.amount).toBe(120_000);
    expect(t.entries.find((e) => e.kind === "activity")!.amount).toBeUndefined();
  });

  it("turns raw kinds into readable titles", () => {
    expect(t.entries.find((e) => e.kind === "activity")!.title).toBe("Call logged");
    expect(t.entries.find((e) => e.kind === "quote")!.title).toBe("Quote sent");
  });

  it("prefixes ids by source, so two rows can never collide on key", () => {
    const ids = t.entries.map((e) => e.id);
    expect(ids).toContain("payment:p1");
    expect(ids).toContain("quote:Q-1");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildTimeline — what it refuses to place", () => {
  it("DROPS an entry with no usable date and counts it", () => {
    /* In a chronological view a wrongly-placed event is worse than a missing one: it
       invents a sequence that never happened, and sequence is the only thing a timeline
       is for. */
    const t = buildTimeline({
      activities: [
        { id: "a1", kind: "call", created_at: at("2026-08-05T10:00:00Z") },
        { id: "a2", kind: "note", created_at: null },
      ],
      quotes: [{ id: "Q-2", status: "sent", created_at: null, created_date: null }],
    });
    expect(t.entries).toHaveLength(1);
    expect(t.undated).toBe(2);
  });

  it("drops an unparseable date rather than sorting it as epoch zero", () => {
    const t = buildTimeline({ activities: [{ id: "a1", kind: "call", created_at: "not-a-date" }] });
    expect(t.entries).toHaveLength(0);
    expect(t.undated).toBe(1);
  });

  it("falls back to the next best date before giving up", () => {
    // A quote with created_date but no created_at is dated, not dropped.
    const t = buildTimeline({ quotes: [{ id: "Q-3", status: "draft", created_date: "2026-08-01" }] });
    expect(t.entries).toHaveLength(1);
    expect(t.undated).toBe(0);
  });
});

describe("buildTimeline — tasks are placed by CREATION, not by due date", () => {
  it("does not show a future task inside a history", () => {
    /* A task due next Friday did not happen next Friday. Placing it there would put the
       future above today's events. */
    const t = buildTimeline({
      activities: [{ id: "a1", kind: "call", created_at: at("2026-08-10T10:00:00Z") }],
      tasks: [{ id: "t1", title: "Call back", status: "pending",
                created_at: at("2026-08-01T09:00:00Z"), due_at: "2026-12-31" }],
    });
    expect(t.entries[0].kind).toBe("activity");
    expect(t.entries[1].kind).toBe("task");
    // The due date is still visible, just not used for placement.
    expect(t.entries[1].detail).toBe("Due 2026-12-31");
  });

  it("marks a done task differently from a pending one", () => {
    const t = buildTimeline({ tasks: [
      { id: "t1", title: "Send deck", status: "done", created_at: at("2026-08-01T09:00:00Z") },
    ] });
    expect(t.entries[0].title).toBe("Task done — Send deck");
  });
});

describe("buildTimeline — ordering is TOTAL", () => {
  it("two events in the same second never swap between renders", () => {
    /* Without a tiebreak the sort is unstable across engines, and a rep re-reading the
       drawer sees a different history than the one they just read. */
    const src = {
      activities: [
        { id: "b", kind: "call", created_at: at("2026-08-05T10:00:00Z") },
        { id: "a", kind: "note", created_at: at("2026-08-05T10:00:00Z") },
      ],
    };
    const first  = buildTimeline(src).entries.map((e) => e.id);
    const second = buildTimeline({ activities: [...src.activities].reverse() }).entries.map((e) => e.id);
    expect(first).toEqual(second);
  });

  it("handles an entirely empty lead without throwing", () => {
    expect(buildTimeline({})).toEqual({ entries: [], undated: 0 });
  });
});

describe("timelineMeta", () => {
  it("gives money its own icon and tone", () => {
    expect(timelineMeta({ id: "x", kind: "payment", at: "", title: "" }).icon).toBe("rupee");
  });

  it("picks the icon from the activity variant", () => {
    expect(timelineMeta({ id: "x", kind: "activity", at: "", title: "", variant: "whatsapp" }).icon).toBe("whatsapp");
    expect(timelineMeta({ id: "x", kind: "activity", at: "", title: "", variant: "call" }).icon).toBe("mobile");
  });

  it("falls back to a clock for an unknown variant rather than rendering nothing", () => {
    expect(timelineMeta({ id: "x", kind: "activity", at: "", title: "", variant: "mystery" }).icon).toBe("clock");
  });
});
