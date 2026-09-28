import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* S22 (28 Sep 2026): Cloud Scheduler waits 540s for a cron; Cloud Run's default request
   timeout is 300s. Every cron longer than five minutes was killed halfway, and the
   scheduler's retry started it again from the top. Both deploy paths must set a service
   timeout at least as long as the longest scheduler deadline. */

const prod = process.cwd();
const read = (...p: string[]) => readFileSync(join(...p), "utf8");

function schedulerDeadlines(): number[] {
  const src = read(prod, "scripts", "setup-cloud-scheduler.sh");
  return [...src.matchAll(/--attempt-deadline=(\d+)s/g)].map((m) => Number(m[1]));
}

function timeoutOf(src: string): number | null {
  const m = /--timeout[= ](\d+)s?\b/.exec(src);
  return m ? Number(m[1]) : null;
}

describe("Cloud Run timeout covers the scheduler deadline", () => {
  const deadline = Math.max(...schedulerDeadlines());

  it("the scheduler script declares a deadline", () => {
    expect(schedulerDeadlines().length).toBeGreaterThan(0);
  });

  it("deploy.sh sets --timeout >= the deadline", () => {
    const deploy = read(prod, "deploy.sh");
    const line = deploy.split("\n").find((l) => /^gcloud run deploy/.test(l)) ?? "";
    const t = timeoutOf(line);
    expect(t, "gcloud run deploy in deploy.sh has no --timeout").not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(deadline);
    expect(t!).toBeLessThanOrEqual(3600); // Cloud Run's ceiling
  });

  it("cloudbuild.yaml's deploy step sets --timeout >= the deadline", () => {
    const cb = read(prod, "..", "cloudbuild.yaml");
    const step = cb.slice(cb.indexOf("- id: deploy"));
    const t = timeoutOf(step.slice(0, step.indexOf("substitutions:")));
    expect(t, "cloudbuild deploy step has no --timeout").not.toBeNull();
    expect(t!).toBeGreaterThanOrEqual(deadline);
    expect(t!).toBeLessThanOrEqual(3600);
  });
});
