import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_KEEP_DAYS,
  DEFAULT_KEEP_MIN,
  planCleanup,
  takenAt,
  type BackupFile,
} from "./retention";

const NOW = new Date("2026-08-25T18:00:00Z");

/** A backup file whose name says it was taken `daysAgo` days before NOW. */
const at = (daysAgo: number, size = 2_000_000): BackupFile => {
  const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
  const stamp = d.toISOString().replace(/[:.]/g, "-");
  return { name: `resellersos-data-${stamp}.json`, size };
};

const plan = (files: readonly BackupFile[], o: { keepDays?: number; keepMin?: number } = {}) =>
  planCleanup(files, { now: NOW, ...o });

const deleted = (files: readonly BackupFile[], o = {}) =>
  plan(files, o).verdicts.filter((v) => v.action === "delete").map((v) => v.name);

/* ══ THE RULE THAT MATTERS MOST ══════════════════════════════════════════════ */

describe("the newest backups survive their own age", () => {
  it("never deletes the only backup, however old it is", () => {
    /* ─── AGE ALONE IS THE WRONG TEST ─────────────────────────────────────────
       If nobody has run a backup for three months then EVERY file is past the cutoff, and a
       script obeying only the cutoff would delete the last copy of the database PRECISELY
       because the situation was already bad. This project is on the Supabase free plan with no
       PITR and no automatic backups — backup-db.mjs's own header says so. */
    expect(deleted([at(400)])).toEqual([]);
  });

  it("keeps the newest two when everything is ancient", () => {
    /* Two rather than one, so there is still a copy left after a restore turns out to be from
       the wrong day. */
    const files = [at(300), at(200), at(100)];
    expect(deleted(files)).toEqual([at(300).name]);
    expect(plan(files).keeping).toBe(2);
  });

  it("says WHY each survivor survived, in words", () => {
    /* The output of a deleting script is read by somebody deciding whether to trust it. */
    const reasons = plan([at(90), at(80), at(70)]).verdicts.map((v) => v.reason);
    expect(reasons[0]).toContain("newest backup — never deleted");
    expect(reasons[1]).toContain("kept whatever its age");
    expect(reasons[2]).toContain("2 newer copies exist");
  });

  it("honours a larger keep-min", () => {
    expect(deleted([at(90), at(80), at(70), at(60)], { keepMin: 4 })).toEqual([]);
  });

  it("never lets keep-min fall below one, whatever is passed", () => {
    /* `--keep-min 0` is a request to delete everything. It is clamped rather than obeyed. */
    for (const keepMin of [0, -5]) {
      expect(deleted([at(90)], { keepMin }), `keepMin ${keepMin}`).toEqual([]);
    }
  });
});

/* ══ The window ══════════════════════════════════════════════════════════════ */

describe("the age window", () => {
  it("keeps everything inside it and deletes what is past it", () => {
    /* Newest two are kept by rule; the 3-day-old one by the window; the 30-day-old one goes. */
    const files = [at(0), at(1), at(3), at(30)];
    expect(deleted(files)).toEqual([at(30).name]);
  });

  it("treats the boundary as inside the window", () => {
    /* A file exactly at the cutoff is kept. On a decision that deletes, the boundary belongs on
       the safe side. */
    const files = [at(0), at(1), at(DEFAULT_KEEP_DAYS)];
    expect(deleted(files)).toEqual([]);
  });

  it("honours a wider window", () => {
    const files = [at(0), at(1), at(20)];
    expect(deleted(files, { keepDays: 30 })).toEqual([]);
    expect(deleted(files, { keepDays: 7 })).toEqual([at(20).name]);
  });

  it("with keep-days 0, still keeps the newest two", () => {
    /* The most aggressive setting available must not become "delete everything". */
    const files = [at(0), at(1), at(2)];
    expect(deleted(files, { keepDays: 0 })).toEqual([at(2).name]);
  });
});

/* ══ The filename is the clock ═══════════════════════════════════════════════ */

describe("takenAt", () => {
  it("reads the stamp backup-db.mjs writes", () => {
    /* That script does `new Date().toISOString().replace(/[:.]/g, "-")`. This is the inverse, and
       the round-trip below is what keeps them honest. */
    const d = takenAt("resellersos-data-2026-08-25T13-07-04-635Z.json");
    expect(d?.toISOString()).toBe("2026-08-25T13:07:04.635Z");
  });

  it("round-trips whatever backup-db.mjs would produce", () => {
    for (const iso of ["2026-01-01T00:00:00.000Z", "2026-12-31T23:59:59.999Z", "2026-02-29T12-00-00-000Z".replace(/-(\d\d)-(\d\d)-(\d\d\d)Z/, ":$1:$2.$3Z")]) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const name = `resellersos-data-${d.toISOString().replace(/[:.]/g, "-")}.json`;
      expect(takenAt(name)?.toISOString(), name).toBe(d.toISOString());
    }
  });

  it.each([
    ["notes.txt", "somebody else's file"],
    ["resellersos-data.json", "no stamp"],
    ["resellersos-data-2026-08-25.json", "date only"],
    ["backup-2026-08-25T13-07-04-635Z.json", "different prefix"],
    ["resellersos-data-2026-08-25T13-07-04-635Z.json.bak", "renamed"],
    ["resellersos-data-2026-13-01T00-00-00-000Z.json", "month 13"],
    ["resellersos-data-2026-02-31T00-00-00-000Z.json", "31 February"],
  ])("returns null for %s (%s)", (name) => {
    expect(takenAt(name)).toBeNull();
  });

  it("refuses a date that JavaScript would silently roll over", () => {
    /* `new Date("2026-02-31…")` becomes 3 March rather than failing. A rolled date is a name we
       do not understand, and a file we do not understand is a file we do not delete. */
    expect(takenAt("resellersos-data-2026-02-31T00-00-00-000Z.json")).toBeNull();
  });
});

describe("files this script did not write", () => {
  it("leaves them alone and says so", () => {
    const files = [{ name: "notes.txt", size: 10 }, at(400)];
    const p = plan(files);
    expect(p.deleting).toBe(0);
    expect(p.verdicts.find((v) => v.name === "notes.txt")?.reason).toContain(
      "not a backup this script wrote",
    );
  });

  it("never counts them toward keep-min", () => {
    /* Otherwise three unrelated text files would "use up" the protected slots and the real
       backups would all become deletable. */
    const files = [
      { name: "a.txt", size: 1 },
      { name: "b.txt", size: 1 },
      { name: "c.txt", size: 1 },
      at(90),
      at(80),
      at(70),
    ];
    expect(deleted(files)).toEqual([at(90).name]);
  });

  it("never reports their bytes as freed", () => {
    const p = plan([{ name: "big.iso", size: 9_000_000_000 }, at(90), at(80), at(70)]);
    expect(p.bytesFreed).toBe(at(90).size);
  });
});

/* ══ What the operator reads ══════════════════════════════════════════════════ */

describe("the summary line", () => {
  it("says nothing to do when the folder is empty", () => {
    expect(plan([]).summary).toBe("Nothing in this folder.");
  });

  it("distinguishes an empty folder from one holding only foreign files", () => {
    /* Different situations, different next steps: one means no backups have run, the other means
       the path is probably wrong. */
    expect(plan([{ name: "readme.md", size: 5 }]).summary).toContain("No backups written by this script");
  });

  it("says nothing is old enough, rather than reporting a zero", () => {
    expect(plan([at(0), at(1)]).summary).toContain("none old enough to remove");
  });

  it("counts both sides when it will delete", () => {
    expect(plan([at(0), at(1), at(90), at(91)]).summary).toBe("4 backup(s): removing 2, keeping 2.");
  });
});

/* ══ The script and the rule agree ═══════════════════════════════════════════ */

describe("scripts/prune-backups.mjs", () => {
  const src = readFileSync(join(__dirname, "..", "..", "..", "scripts", "prune-backups.mjs"), "utf8");

  it("does not delete unless asked", () => {
    /* A script that deletes on its first invocation is a script somebody runs to find out what
       it does. */
    expect(src).toContain('const doDelete = args.includes("--delete");');
    expect(src).toContain("if (!doDelete) {");
    expect(src).toContain("Re-run with --delete");
  });

  it("does not create the directory it was pointed at", () => {
    /* `mkdir -p` here would let a typo produce an empty folder and a cheerful "nothing to do",
       which reads as success while the real backups sit untouched somewhere else. */
    expect(src).not.toContain("mkdirSync");
    expect(src).toContain("this script does not create folders");
  });

  it("uses the shared rule rather than its own copy", () => {
    expect(src).toContain('from "../src/lib/backup/retention.ts"');
    /* No second cutoff, no second regex, no second sort. */
    expect(src).not.toMatch(/86_?400_?000/);
    expect(src).not.toContain("resellersos-data-(");
  });

  it("keeps going when one file will not delete", () => {
    /* One locked file must not strand the rest, and a half-finished prune that says so is better
       than one that stops silently. */
    expect(src).toContain("failed += 1");
    expect(src).toContain("process.exit(failed ? 1 : 0)");
  });

  it("prints the keeps before the deletes", () => {
    /* The reassuring half of the output should not sit below the frightening half. */
    expect(src.indexOf('`  keep    ')).toBeLessThan(src.indexOf('doDelete ? "DELETE "'));
  });
});

describe("the defaults", () => {
  it("are a week and two copies", () => {
    expect(DEFAULT_KEEP_DAYS).toBe(7);
    expect(DEFAULT_KEEP_MIN).toBe(2);
  });
});
