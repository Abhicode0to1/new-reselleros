import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Every cron route has a Cloud Scheduler job, and every job has a route.
 *
 * ─── THE FAILURE THIS PREVENTS, WHICH HAS ALREADY HAPPENED TWICE ─────────────
 * `scripts/setup-cloud-scheduler.sh` exists because the repo carried a
 * `vercel.json` with a `crons` block while the live deployment is Cloud Run —
 * so several routes documented a schedule that nothing honoured. Its own header
 * names the shape: "a job that looks configured, is documented as scheduled, and
 * never runs. Nothing errors, no log line appears, and the first sign is a
 * renewal that lapsed."
 *
 * Then it happened again to the script itself. On 11 Sep 2026 the app had 22 cron
 * routes and the script declared 12. The ten added since had each been written,
 * reviewed and merged without a schedule, and four of them were the whole domain
 * and hosting path — including `provision-domain`, where the consequence is money
 * taken and no domain delivered, with no error anywhere because the job that
 * would have done the work was never asked to run.
 *
 * A comment cannot prevent that a third time. This can.
 */

const ROOT = process.cwd();
const CRON_DIR = join(ROOT, "src", "app", "api", "cron");
const SCRIPT = join(ROOT, "scripts", "setup-cloud-scheduler.sh");

/** Route directories that actually export a handler. */
function cronRoutes(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CRON_DIR, e.name, "route.ts")))
    .map((e) => e.name)
    .sort();
}

/**
 * Job names from the JOBS array, taken only from real entries.
 *
 * The `|` is required: the header prose names jobs too ("Cloud Scheduler job
 * `resellersos-health-digest`"), and matching those would let a job be
 * "declared" by being mentioned in a comment — the exact class of thing this
 * file exists to stop.
 */
function declaredJobs(): { name: string; schedule: string; path: string }[] {
  const src = readFileSync(SCRIPT, "utf8");
  const out: { name: string; schedule: string; path: string }[] = [];
  for (const m of src.matchAll(/^\s*"resellersos-([a-z-]+)\|([^|]+)\|([^|]+)\|/gm)) {
    out.push({ name: m[1], schedule: m[2].trim(), path: m[3].trim() });
  }
  return out;
}

describe("every cron route is scheduled", () => {
  it("no route is missing a Cloud Scheduler job", () => {
    const declared = new Set(declaredJobs().map((j) => j.name));
    const missing = cronRoutes().filter((r) => !declared.has(r));
    expect(
      missing,
      `These cron routes exist and nothing schedules them, so they will never run:\n` +
        missing.map((m) => `  /api/cron/${m}`).join("\n") +
        `\nAdd each to the JOBS array in scripts/setup-cloud-scheduler.sh, with a comment\n` +
        `saying why that schedule and not another.`,
    ).toEqual([]);
  });

  it("no job points at a route that does not exist", () => {
    /* The other direction. A job whose path 404s is worse than a missing job: it
       runs, it is billed for, and it reports success to Cloud Scheduler while
       doing nothing. */
    const routes = new Set(cronRoutes());
    const phantom = declaredJobs().filter((j) => !routes.has(j.name));
    expect(
      phantom.map((j) => `${j.name} -> ${j.path}`),
      "These scheduled jobs have no matching cron route — they would run and 404.",
    ).toEqual([]);
  });
});

describe("each job's declaration is usable", () => {
  const jobs = declaredJobs();

  it("there are jobs to check", () => {
    expect(jobs.length).toBeGreaterThan(20);
  });

  it.each(jobs.map((j) => [j.name, j] as const))("%s has a real cron expression", (_name, job) => {
    /* Five whitespace-separated fields. A four-field typo is accepted by neither
       Cloud Scheduler nor this test, and finding out here is cheaper than finding
       out from a job that silently never fired. */
    const fields = job.schedule.split(/\s+/);
    expect(fields, `"${job.schedule}" is not a 5-field cron expression`).toHaveLength(5);
  });

  it.each(jobs.map((j) => [j.name, j] as const))("%s points at its own route path", (name, job) => {
    /* Catches the copy-paste that gives a new job the previous one's path — which
       would leave the new route unscheduled AND double-run the old one. */
    expect(job.path).toBe(`/api/cron/${name}`);
  });
});
