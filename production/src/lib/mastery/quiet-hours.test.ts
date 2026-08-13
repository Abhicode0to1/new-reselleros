import { describe, it, expect } from "vitest";
import {
  quietHoursDecision, isNightIST, isWeekendIST, istParts,
  QUIET_START_HOUR, QUIET_END_HOUR,
} from "./quiet-hours";

/** An IST wall-clock time, as the UTC instant it actually is. */
const ist = (ymd: string, hh: number, mm = 0) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + (hh * 60 + mm - 330) * 60_000);

// 2026-08-13 is a Thursday; 15th Sat, 16th Sun, 17th Mon.
const THU_1000 = ist("2026-08-13", 10);
const THU_1830 = ist("2026-08-13", 18, 30);
const THU_1901 = ist("2026-08-13", 19,  1);
const THU_2101 = ist("2026-08-13", 21,  1);   // the birthday cron
const FRI_0300 = ist("2026-08-14",  3);
const FRI_0900 = ist("2026-08-14",  9);
const SAT_1100 = ist("2026-08-15", 11);
const SUN_1400 = ist("2026-08-16", 14);

describe("IST wall clock", () => {
  it("reads the hour in IST, not UTC", () => {
    expect(istParts(THU_2101).hour).toBe(21);
    expect(istParts(FRI_0300).hour).toBe(3);
  });

  it("identifies the weekend in IST", () => {
    expect(isWeekendIST(SAT_1100)).toBe(true);
    expect(isWeekendIST(SUN_1400)).toBe(true);
    expect(isWeekendIST(THU_1000)).toBe(false);
    // 00:30 IST Monday is 19:00 UTC Sunday — a UTC-based check would call this
    // the weekend and hold Monday's first hour of mail.
    expect(isWeekendIST(ist("2026-08-17", 0, 30))).toBe(false);
  });

  it("marks the quiet window, which wraps midnight", () => {
    expect(isNightIST(THU_1830)).toBe(false);
    expect(isNightIST(ist("2026-08-13", QUIET_START_HOUR))).toBe(true);
    expect(isNightIST(FRI_0300)).toBe(true);
    expect(isNightIST(ist("2026-08-14", QUIET_END_HOUR))).toBe(false);
  });
});

describe("the 21:01 birthday cron — the case this module exists for", () => {
  it("is held, not sent, at 21:01 IST", () => {
    const d = quietHoursDecision("greeting", THU_2101);
    expect(d.send).toBe(false);
    expect(d.reason).toBe("night");
  });

  it("is DEFERRED with a timestamp, never discarded", () => {
    // Dropping instead of deferring is how a suppressed renewal notice becomes a
    // money bug: the cadence records it as handled and the customer hears nothing.
    const d = quietHoursDecision("greeting", THU_2101);
    expect(d.sendAfter).toBeInstanceOf(Date);
    expect(d.sendAfter!.getTime()).toBeGreaterThan(THU_2101.getTime());
  });

  it("resumes at 09:00 IST the next morning", () => {
    const d = quietHoursDecision("greeting", THU_2101);
    const p = istParts(d.sendAfter!);
    expect(p.hour).toBe(QUIET_END_HOUR);
    expect(p.ymd).toBe("2026-08-14");
  });
});

describe("stressful classes are held", () => {
  it("holds reminders at night", () => {
    expect(quietHoursDecision("reminder", THU_1901).send).toBe(false);
    expect(quietHoursDecision("reminder", FRI_0300).send).toBe(false);
  });

  it("holds reminders, gamification and digests all weekend", () => {
    for (const cls of ["reminder", "gamification", "greeting", "digest"] as const) {
      const d = quietHoursDecision(cls, SAT_1100);
      expect(d.send, cls).toBe(false);
      expect(d.reason, cls).toBe("weekend");
    }
  });

  it("sends normally inside working hours", () => {
    for (const cls of ["reminder", "gamification", "greeting", "digest"] as const) {
      const d = quietHoursDecision(cls, THU_1000);
      expect(d.send, cls).toBe(true);
      expect(d.sendAfter, cls).toBeNull();
    }
  });

  it("treats 18:30 as working and 19:00 as quiet — the boundary is exact", () => {
    expect(quietHoursDecision("reminder", THU_1830).send).toBe(true);
    expect(quietHoursDecision("reminder", ist("2026-08-13", QUIET_START_HOUR)).send).toBe(false);
  });

  it("is sendable again at exactly 09:00 IST", () => {
    expect(quietHoursDecision("reminder", FRI_0900).send).toBe(true);
  });
});

describe("exempt classes are never held", () => {
  it("sends a payment receipt at 3 AM on a Sunday", () => {
    // A customer who just paid is refreshing their inbox. Holding this looks
    // broken, and it is not the kind of message that burns anyone out.
    const d = quietHoursDecision("transactional", ist("2026-08-16", 3));
    expect(d.send).toBe(true);
    expect(d.sendAfter).toBeNull();
  });

  it("sends security mail at any hour", () => {
    for (const at of [THU_2101, FRI_0300, SAT_1100, SUN_1400]) {
      expect(quietHoursDecision("security", at).send).toBe(true);
    }
  });

  it("explains the exemption rather than passing silently", () => {
    expect(quietHoursDecision("transactional", SUN_1400).explanation).toMatch(/exempt/i);
  });
});

describe("the deferral target is always a working moment", () => {
  const cases = [THU_1901, THU_2101, FRI_0300, SAT_1100, SUN_1400, ist("2026-08-14", 23, 59)];

  it("never queues into a night or a weekend", () => {
    for (const at of cases) {
      const d = quietHoursDecision("reminder", at);
      if (d.send) continue;
      const target = d.sendAfter!;
      expect(isWeekendIST(target), `weekend for ${at.toISOString()}`).toBe(false);
      expect(isNightIST(target), `night for ${at.toISOString()}`).toBe(false);
    }
  });

  it("always queues forward in time, never into the past", () => {
    for (const at of cases) {
      const d = quietHoursDecision("reminder", at);
      if (d.send) continue;
      expect(d.sendAfter!.getTime(), at.toISOString()).toBeGreaterThan(at.getTime());
    }
  });

  it("sends Saturday and Sunday mail on Monday morning", () => {
    for (const at of [SAT_1100, SUN_1400]) {
      const p = istParts(quietHoursDecision("digest", at).sendAfter!);
      expect(p.ymd).toBe("2026-08-17");   // Monday
      expect(p.hour).toBe(QUIET_END_HOUR);
    }
  });

  it("sends Friday-night mail on Monday, not Saturday", () => {
    // The trap: "next morning at 9" lands on Saturday for a Friday-night message.
    const p = istParts(quietHoursDecision("reminder", ist("2026-08-14", 22)).sendAfter!);
    expect(p.ymd).toBe("2026-08-17");
    expect(isWeekendIST(quietHoursDecision("reminder", ist("2026-08-14", 22)).sendAfter!)).toBe(false);
  });
});
