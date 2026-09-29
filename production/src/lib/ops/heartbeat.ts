/**
 * Dead-man's switch for the crons.
 *
 * Until 27 Sep 2026 the only way a stopped cron was noticed was the next morning's
 * health-digest email — and if the digest job itself stopped (Scheduler auth broke, the
 * region moved, the billing trial ended), nothing reported that. Three weeks of silent
 * 403s after the Singapore move is the incident this file exists for.
 *
 * Every cron that returns through `reportCron` now also pings an external heartbeat
 * service (Healthchecks.io, Cronitor, Better Uptime — anything that alerts when a ping is
 * LATE). The alert comes from outside the system, so it fires precisely when the system
 * cannot speak for itself.
 *
 * Config: HEARTBEAT_PING_URL, with `{job}` where the job slug goes, e.g.
 *   https://hc-ping.com/<ping-key>/resellersos-{job}
 * On a failed run the ping goes to `<url>/fail` (Healthchecks convention) so a job that
 * runs but fails is not mistaken for a healthy one. Unset → no-op; a ping never throws and
 * never delays the response.
 */
export function heartbeatUrl(job: string): string | null {
  const tpl = process.env.HEARTBEAT_PING_URL?.trim();
  if (!tpl) return null;
  const slug = job.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return tpl.includes("{job}") ? tpl.replace("{job}", slug) : `${tpl.replace(/\/$/, "")}/${slug}`;
}

export function pingHeartbeat(job: string, ok: boolean): void {
  const url = heartbeatUrl(job);
  if (!url) return;
  const target = ok ? url : `${url}/fail`;
  fetch(target, { method: "POST", signal: AbortSignal.timeout(5000), cache: "no-store" }).catch(() => { /* an unreachable heartbeat service must never fail a cron */ });
}
