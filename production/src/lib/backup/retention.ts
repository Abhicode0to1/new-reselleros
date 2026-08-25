/**
 * Which database backups may be deleted — the decision, separated from the deleting.
 *
 * ─── WHY THIS IS A MODULE AND NOT TWENTY LINES INSIDE THE SCRIPT ────────────
 * It decides what to erase. A wrong answer here is not a failed run, it is a backup that is gone
 * on a free-plan project with no PITR and no automatic backups (see scripts/backup-db.mjs's own
 * header). So the rule is pure, and its tests can hand it the cases nobody wants to arrange for
 * real: an empty folder, one file, files with unreadable names, a folder nobody has backed up in
 * a month.
 *
 * ─── THE FILENAME IS THE CLOCK, NOT mtime ───────────────────────────────────
 * `backup-db.mjs` stamps the name: `resellersos-data-2026-08-25T13-07-04-635Z.json`. That string
 * is when the data was READ. `mtime` is when the file last touched a disk — copy it to a new
 * laptop, restore it from a sync folder, or let a backup tool rewrite it, and mtime says today
 * while the contents are from March. Deleting on mtime would keep the freshly-copied ancient one
 * and bin the genuinely recent one.
 *
 * A name this cannot parse is never deleted. An unrecognised file in a backup folder is either
 * somebody else's or a rename, and both deserve a person looking rather than a guess.
 */

/** How old a backup has to be before it is a candidate. */
export const DEFAULT_KEEP_DAYS = 7;

/**
 * How many of the newest are kept whatever their age.
 *
 * ─── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 * Age alone is the wrong test. If nobody has run a backup for three weeks, EVERY file is older
 * than the cutoff — and a script that obeyed only the cutoff would delete the last copy of the
 * database precisely because the situation was already bad. Two, so there is still one left after
 * a restore turns out to be from the wrong day.
 */
export const DEFAULT_KEEP_MIN = 2;

/** `resellersos-data-<ISO with : and . replaced by ->.json`, as backup-db.mjs writes it. */
const NAME_RE =
  /^resellersos-data-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

/**
 * The instant a backup's name says it was taken, or null when the name is not one of ours.
 *
 * Rebuilds the ISO string rather than doing arithmetic on the parts, so an impossible date in a
 * hand-edited name (`2026-13-45`) comes back null from `Date` instead of silently becoming some
 * other month.
 */
export function takenAt(filename: string): Date | null {
  const m = NAME_RE.exec(filename);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  /* Round-trip check: `new Date("2026-02-31…")` rolls into March rather than failing, and a
     rolled date is a name we do not understand. */
  return d.toISOString() === iso ? d : null;
}

export interface BackupFile {
  name: string;
  /** Bytes. Only used to report what was freed. */
  size: number;
}

export interface Verdict {
  name: string;
  size: number;
  action: "keep" | "delete";
  /** Why, in a sentence a person can read in the script's output. */
  reason: string;
}

export interface Plan {
  verdicts: readonly Verdict[];
  keeping: number;
  deleting: number;
  bytesFreed: number;
  /** One line for the top of the output. */
  summary: string;
}

/**
 * Decide the fate of every file in a backup folder.
 *
 * @param files whatever is in the directory — unrecognised names included, on purpose.
 * @param now injected rather than read, so the tests do not need a frozen clock.
 */
export function planCleanup(
  files: readonly BackupFile[],
  opts: { now: Date; keepDays?: number; keepMin?: number },
): Plan {
  const keepDays = Math.max(0, opts.keepDays ?? DEFAULT_KEEP_DAYS);
  const keepMin = Math.max(1, opts.keepMin ?? DEFAULT_KEEP_MIN);
  const cutoff = opts.now.getTime() - keepDays * 86_400_000;

  /* Ours, newest first. Anything else is set aside and never touched. */
  const dated = files
    .flatMap((f) => {
      const at = takenAt(f.name);
      return at ? [{ ...f, at }] : [];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const foreign = files.filter((f) => takenAt(f.name) === null);

  const verdicts: Verdict[] = [];

  for (const f of foreign) {
    verdicts.push({
      name: f.name,
      size: f.size,
      action: "keep",
      reason: "not a backup this script wrote — left alone",
    });
  }

  dated.forEach((f, i) => {
    /* The newest `keepMin` survive whatever their age. See DEFAULT_KEEP_MIN. */
    if (i < keepMin) {
      verdicts.push({
        name: f.name,
        size: f.size,
        action: "keep",
        reason:
          i === 0
            ? "newest backup — never deleted"
            : `one of the ${keepMin} newest — kept whatever its age`,
      });
      return;
    }

    const ageDays = Math.floor((opts.now.getTime() - f.at.getTime()) / 86_400_000);
    if (f.at.getTime() >= cutoff) {
      verdicts.push({
        name: f.name,
        size: f.size,
        action: "keep",
        reason: `${ageDays} day${ageDays === 1 ? "" : "s"} old, inside the ${keepDays}-day window`,
      });
      return;
    }

    verdicts.push({
      name: f.name,
      size: f.size,
      action: "delete",
      reason: `${ageDays} days old, past the ${keepDays}-day window, and ${keepMin} newer copies exist`,
    });
  });

  const deleting = verdicts.filter((v) => v.action === "delete");
  const bytesFreed = deleting.reduce((n, v) => n + v.size, 0);
  const keeping = verdicts.length - deleting.length;

  const summary =
    dated.length === 0
      ? files.length === 0
        ? "Nothing in this folder."
        : `No backups written by this script here — ${files.length} other file(s) left alone.`
      : deleting.length === 0
        ? `${dated.length} backup(s), none old enough to remove. Nothing to do.`
        : `${dated.length} backup(s): removing ${deleting.length}, keeping ${keeping}.`;

  return { verdicts, keeping, deleting: deleting.length, bytesFreed, summary };
}
