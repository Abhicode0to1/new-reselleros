import { describe, it, expect } from "vitest";
import { checkHealth, type HealthInput } from "./health-signals";

/** A healthy Monday: everything ran, every source readable. */
const OK: HealthInput = {
  today: "2026-08-24", todayDow: 1,
  backupsYesterday: 7,
  renewalEmailsEver: 12,
  subsDueUnreminded: 0,
  attendanceRemindersToday: 4,
  emailFailuresEver: 0,
  sourcesUnavailable: [],
};

const ids = (r: { findings: { id: string }[] }) => r.findings.map((f) => f.id);

describe("checkHealth — it will not call itself healthy while blind", () => {
  it("returns unknown, not ok, when a telemetry source is unreadable", () => {
    /* The whole reason this module exists. On 23 Aug the scan reported "System healthy"
       for half a session with gcloud auth expired — a verdict about what it could still
       see, which is indistinguishable from a verdict about the system. */
    const r = checkHealth({ ...OK, sourcesUnavailable: ["cloud-run-logs"] });
    expect(r.verdict).toBe("unknown");
    expect(r.summary).toMatch(/Cannot say the system is healthy/);
  });

  it("says which source and what to do about it", () => {
    const r = checkHealth({ ...OK, sourcesUnavailable: ["cloud-run-logs", "sentry"] });
    expect(ids(r)).toContain("source-unavailable-cloud-run-logs");
    expect(ids(r)).toContain("source-unavailable-sentry");
    const text = r.findings.map((f) => f.text).join(" ");
    expect(text).toMatch(/gcloud auth login/);
    expect(text).toMatch(/SENTRY_DSN/);
  });

  it("names an unknown source rather than ignoring it", () => {
    const r = checkHealth({ ...OK, sourcesUnavailable: ["some-new-thing"] });
    expect(r.verdict).toBe("unknown");
    expect(r.findings.map((f) => f.text).join(" ")).toContain("some-new-thing");
  });

  it("says ok only when everything ran AND everything was readable", () => {
    const r = checkHealth(OK);
    expect(r.verdict).toBe("ok");
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/every telemetry source was readable/);
  });
});

describe("checkHealth — the nightly backup", () => {
  it("alarms when yesterday has no snapshot", () => {
    /* AGENTS.md L1: one night in six was lost silently on a free plan with no PITR, and
       it was found two days later by reading logs. */
    const r = checkHealth({ ...OK, backupsYesterday: 0 });
    expect(ids(r)).toContain("backup-missing");
    expect(r.findings.find((f) => f.id === "backup-missing")?.severity).toBe("alarm");
    expect(r.verdict).toBe("attention");
  });

  it("says nothing when the backup ran", () => {
    expect(ids(checkHealth(OK))).not.toContain("backup-missing");
  });
});

describe("checkHealth — the renewal ladder", () => {
  it("alarms when nothing was ever sent AND a step was genuinely missed", () => {
    /* Two halves are still not enough — see the block at the bottom of this file for the
       third, and for the false alarm that proved it. `subsDueUnreminded` means "missed a
       ladder step it was present for", NOT "inside the 30-day window". */
    const r = checkHealth({ ...OK, renewalEmailsEver: 0, subsDueUnreminded: 1 });
    const f = r.findings.find((x) => x.id === "renewals-never-ran");
    expect(f?.severity).toBe("alarm");
    expect(f?.text).toMatch(/1 subscription/);
    expect(f?.text).toMatch(/\?dry=1/);
  });

  it("stays quiet when nothing was ever sent and nothing is due", () => {
    /* A young workspace with no renewals yet is not broken, and an alarm here would be
       the kind that gets muted. */
    const r = checkHealth({ ...OK, renewalEmailsEver: 0, subsDueUnreminded: 0 });
    expect(ids(r)).not.toContain("renewals-never-ran");
    expect(r.verdict).toBe("ok");
  });

  it("warns rather than alarms when the ladder has run before but is behind", () => {
    const r = checkHealth({ ...OK, renewalEmailsEver: 40, subsDueUnreminded: 2 });
    const f = r.findings.find((x) => x.id === "renewals-behind");
    expect(f?.severity).toBe("warn");
    expect(f?.text).toMatch(/2 subscription/);
  });
});

describe("checkHealth — reminders on a day nobody works", () => {
  it("flags attendance pushes sent on a Sunday", () => {
    /* Measured: attendance_reminder_log held 7 rows for Sunday 23 Aug. Kept as a check
       rather than deleted after the fix, because "the fix is not live" and "the fix is
       wrong" look identical from the outside. */
    const r = checkHealth({ ...OK, todayDow: 7, attendanceRemindersToday: 7 });
    const f = r.findings.find((x) => x.id === "attendance-on-weekly-off");
    expect(f?.text).toMatch(/7 attendance reminder/);
    expect(f?.text).toMatch(/working-day/);
  });

  it("says nothing about a Sunday with no reminders sent", () => {
    const r = checkHealth({ ...OK, todayDow: 7, attendanceRemindersToday: 0 });
    expect(ids(r)).not.toContain("attendance-on-weekly-off");
  });

  it("says nothing about reminders on a working day", () => {
    /* Saturday is a working day here, so 6 must not trip this. */
    expect(ids(checkHealth({ ...OK, todayDow: 6, attendanceRemindersToday: 5 })))
      .not.toContain("attendance-on-weekly-off");
  });
});

describe("checkHealth — email failures", () => {
  it("reports them, and says a stale one may be fine", () => {
    /* There IS one stale failure in this database, from 14 Aug, whose cause was fixed the
       same day. A check that treated it as a live fault would cry wolf forever. */
    const r = checkHealth({ ...OK, emailFailuresEver: 1 });
    const f = r.findings.find((x) => x.id === "email-failures");
    expect(f?.severity).toBe("warn");
    expect(f?.text).toMatch(/stale one from before a fix is fine/);
  });
});

describe("checkHealth — every finding is actionable", () => {
  it("names a next step, never just a status", () => {
    /* CLAUDE.md §24. A health check that only states facts sends the operator to the
       database to work out what to do. */
    const r = checkHealth({
      today: "2026-08-23", todayDow: 7,
      backupsYesterday: 0, renewalEmailsEver: 0, subsDueUnreminded: 1,
      attendanceRemindersToday: 7, emailFailuresEver: 1,
      sourcesUnavailable: ["cloud-run-logs", "sentry"],
    });
    expect(r.findings.length).toBeGreaterThanOrEqual(6);
    for (const f of r.findings) {
      expect(f.text.length, f.id).toBeGreaterThan(40);
      /* Each one tells the reader where to go or what to run. */
      expect(/check|run|read|Set |Run /i.test(f.text), f.id).toBe(true);
    }
    expect(r.verdict).toBe("unknown");
  });
});

describe("checkHealth — the renewals alarm I got wrong once", () => {
  /* On 23 Aug the first version of this check raised an ALARM saying the renewals cron
     had never run. Measured against Cloud Scheduler it had: the job is ENABLED, ran at
     03:30 UTC, and returned 200 in 1.4s.

     The subscription it counted was created 22 Aug for a 27 Aug renewal — five days —
     and the ladder opens at T-15, which for that row was 12 Aug, before it existed.
     Today is T-4, which is not a step at all (T-30/15/12/9/6/3/0).

     So `subsDueUnreminded` must count only rows that MISSED a step they were present
     for. The caller enforces that in SQL; these cases pin the arithmetic that made the
     alarm wrong, so the count can never again mean "inside the window". */

  it("stays SILENT when nothing has reached a ladder step yet", () => {
    /* Today's real numbers: renewal_email_log empty, and zero subscriptions that existed
       at their own T-15. A young workspace, not a dead cron. */
    const r = checkHealth({ ...OK, renewalEmailsEver: 0, subsDueUnreminded: 0 });
    expect(ids(r)).not.toContain("renewals-never-ran");
    expect(ids(r)).not.toContain("renewals-behind");
    expect(r.verdict).toBe("ok");
  });

  it("alarms only once a step was genuinely missed", () => {
    const r = checkHealth({ ...OK, renewalEmailsEver: 0, subsDueUnreminded: 3 });
    const f = r.findings.find((x) => x.id === "renewals-never-ran");
    expect(f?.severity).toBe("alarm");
    expect(f?.text).toMatch(/3 subscription/);
  });

  it("does not treat a healthy ladder with a fresh row as behind", () => {
    /* The ladder has run before AND nothing has missed a step — the ordinary state of a
       working system, which must produce no finding at all. */
    const r = checkHealth({ ...OK, renewalEmailsEver: 40, subsDueUnreminded: 0 });
    expect(r.findings).toEqual([]);
    expect(r.verdict).toBe("ok");
  });
});
