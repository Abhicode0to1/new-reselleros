import { describe, it, expect } from "vitest";
import {
  decideAttendanceReminder,
  istNow,
  parseTimeToMinutes,
  minutesToTimeValue,
  dismissKey,
  snoozeKey,
  CHECKIN_WINDOW_START_MIN,
  type ReminderInput,
} from "./reminders";

/** A person who is linked, has reminders on, finishes at 18:00, and has done nothing yet. */
function base(overrides: Partial<ReminderInput> = {}): ReminderInput {
  return {
    now: { minutes: 10 * 60, date: "2026-08-19" },
    linked: true,
    checkIn: null,
    checkOut: null,
    enabled: true,
    checkoutReminderAt: "18:00:00",
    ...overrides,
  };
}

describe("istNow", () => {
  it("reads the wall clock in Asia/Kolkata, not the machine's zone", () => {
    // 2026-08-19T04:30:00Z is exactly 10:00 IST (+5:30).
    const r = istNow(new Date("2026-08-19T04:30:00Z"));
    expect(r.minutes).toBe(10 * 60);
    expect(r.date).toBe("2026-08-19");
  });

  it("rolls the IST date over before UTC midnight", () => {
    // 18:45 UTC is 00:15 IST the NEXT day. A browser reading its own local date here
    // would ask somebody to check in for a day the database has already closed.
    const r = istNow(new Date("2026-08-19T18:45:00Z"));
    expect(r.date).toBe("2026-08-20");
    expect(r.minutes).toBe(15);
  });

  it("has not rolled over just before that", () => {
    const r = istNow(new Date("2026-08-19T18:20:00Z")); // 23:50 IST same day
    expect(r.date).toBe("2026-08-19");
    expect(r.minutes).toBe(23 * 60 + 50);
  });
});

describe("parseTimeToMinutes", () => {
  it("reads what Postgres sends", () => {
    expect(parseTimeToMinutes("18:00:00")).toBe(1080);
  });

  it("reads what an <input type=time> sends", () => {
    expect(parseTimeToMinutes("18:00")).toBe(1080);
    expect(parseTimeToMinutes("09:30")).toBe(570);
  });

  it("tolerates an offset suffix", () => {
    expect(parseTimeToMinutes("18:00:00+05:30")).toBe(1080);
  });

  it("returns null for anything unreadable, so a bad value cannot fire at midnight", () => {
    for (const bad of ["", "   ", "nonsense", "25:00", "18:99", "-1:00", null, undefined]) {
      expect(parseTimeToMinutes(bad), `${String(bad)} should be null`).toBeNull();
    }
  });
});

describe("minutesToTimeValue", () => {
  it("round-trips with parseTimeToMinutes", () => {
    for (const v of ["00:00", "06:00", "09:30", "18:00", "23:59"]) {
      expect(minutesToTimeValue(parseTimeToMinutes(v) as number)).toBe(v);
    }
  });

  it("clamps rather than wrapping past midnight", () => {
    expect(minutesToTimeValue(-30)).toBe("00:00");
    expect(minutesToTimeValue(99_999)).toBe("23:59");
  });
});

describe("never shows — these beat every nudge", () => {
  it("when the person switched reminders off", () => {
    const r = decideAttendanceReminder(base({ enabled: false }));
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("switched off");
  });

  it("when the login has no employee record", () => {
    // They cannot punch at all; nagging them to do something the app will refuse is how
    // a popup becomes something people close without reading.
    const r = decideAttendanceReminder(base({ linked: false }));
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("not linked");
  });

  it("when the day is already complete", () => {
    const r = decideAttendanceReminder(
      base({ now: { minutes: 20 * 60, date: "2026-08-19" }, checkIn: "2026-08-19T04:00:00Z", checkOut: "2026-08-19T13:00:00Z" }),
    );
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("complete");
  });

  it("when they are already looking at the attendance screen", () => {
    const r = decideAttendanceReminder(base({ onAttendanceScreen: true }));
    expect(r.kind).toBeNull();
  });

  it("while snoozed, and again once the snooze expires", () => {
    const at = { minutes: 18 * 60 + 5, date: "2026-08-19" };
    const input = base({ now: at, checkIn: "2026-08-19T04:00:00Z", snoozedUntilMin: 18 * 60 + 20 });
    expect(decideAttendanceReminder(input).kind).toBeNull();

    const later = decideAttendanceReminder({ ...input, now: { minutes: 18 * 60 + 20, date: "2026-08-19" } });
    expect(later.kind).toBe("check_out");
  });
});

describe("check-in reminder", () => {
  it("fires during the day when nothing has been punched", () => {
    expect(decideAttendanceReminder(base()).kind).toBe("check_in");
  });

  it("stays quiet before the window opens", () => {
    const r = decideAttendanceReminder(base({ now: { minutes: CHECKIN_WINDOW_START_MIN - 1, date: "2026-08-19" } }));
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("Too early");
  });

  it("fires the minute the window opens", () => {
    expect(decideAttendanceReminder(base({ now: { minutes: CHECKIN_WINDOW_START_MIN, date: "2026-08-19" } })).kind).toBe("check_in");
  });

  it("stops nagging once the working day is over", () => {
    // At 19:00 with no check-in at all, "you haven't checked in" is not a useful nudge
    // any more — it just reads as an accusation, and there is no check-in to close either.
    const r = decideAttendanceReminder(base({ now: { minutes: 19 * 60, date: "2026-08-19" } }));
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("too late");
  });

  it("respects a dismissal, but only for the day it was made", () => {
    const dismissed = { check_in: "2026-08-19" };
    expect(decideAttendanceReminder(base({ dismissed })).kind).toBeNull();

    // Next morning it comes back — a dismissal is for today, not forever.
    const tomorrow = decideAttendanceReminder(base({ now: { minutes: 10 * 60, date: "2026-08-20" }, dismissed }));
    expect(tomorrow.kind).toBe("check_in");
  });
});

describe("check-out reminder", () => {
  const checkedIn = { checkIn: "2026-08-19T04:00:00Z", checkOut: null };

  it("stays quiet before the configured time", () => {
    const r = decideAttendanceReminder(base({ ...checkedIn, now: { minutes: 17 * 60 + 59, date: "2026-08-19" } }));
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("Not yet");
  });

  it("fires exactly at the configured time", () => {
    expect(decideAttendanceReminder(base({ ...checkedIn, now: { minutes: 18 * 60, date: "2026-08-19" } })).kind).toBe("check_out");
  });

  it("keeps firing afterwards, because the punch is still missing", () => {
    expect(decideAttendanceReminder(base({ ...checkedIn, now: { minutes: 21 * 60, date: "2026-08-19" } })).kind).toBe("check_out");
  });

  it("follows a custom time rather than a hardcoded 6 PM", () => {
    // The whole point of the setting: someone who finishes at 15:30 is reminded then.
    const early = base({ ...checkedIn, checkoutReminderAt: "15:30", now: { minutes: 15 * 60 + 30, date: "2026-08-19" } });
    expect(decideAttendanceReminder(early).kind).toBe("check_out");

    const notYet = decideAttendanceReminder({ ...early, now: { minutes: 15 * 60 + 29, date: "2026-08-19" } });
    expect(notYet.kind).toBeNull();
  });

  it("says nothing at all when the stored time is unreadable", () => {
    // Falling back to 00:00 here would put a popup on the screen at midnight and teach
    // everybody to ignore it.
    const r = decideAttendanceReminder(base({ ...checkedIn, checkoutReminderAt: "garbage", now: { minutes: 23 * 60, date: "2026-08-19" } }));
    expect(r.kind).toBeNull();
    expect(r.reason).toContain("No usable");
  });

  it("respects a dismissal for that day only", () => {
    const at = { minutes: 19 * 60, date: "2026-08-19" };
    const dismissed = { check_out: "2026-08-19" };
    expect(decideAttendanceReminder(base({ ...checkedIn, now: at, dismissed })).kind).toBeNull();
    expect(decideAttendanceReminder(base({ ...checkedIn, now: { minutes: 19 * 60, date: "2026-08-20" }, dismissed })).kind).toBe("check_out");
  });

  it("is not silenced by a check-IN dismissal", () => {
    // Two different nudges. Closing the morning one must not cost you the evening one —
    // that would lose exactly the punch this feature exists to catch.
    const r = decideAttendanceReminder(
      base({ ...checkedIn, now: { minutes: 19 * 60, date: "2026-08-19" }, dismissed: { check_in: "2026-08-19" } }),
    );
    expect(r.kind).toBe("check_out");
  });
});

describe("storage keys", () => {
  it("are scoped per user, so a shared laptop does not leak one person's state onto another", () => {
    expect(dismissKey("user-a", "check_in")).not.toBe(dismissKey("user-b", "check_in"));
    expect(snoozeKey("user-a", "2026-08-19")).not.toBe(snoozeKey("user-b", "2026-08-19"));
  });

  it("separate the two kinds and the days", () => {
    expect(dismissKey("u", "check_in")).not.toBe(dismissKey("u", "check_out"));
    expect(snoozeKey("u", "2026-08-19")).not.toBe(snoozeKey("u", "2026-08-20"));
  });
});
