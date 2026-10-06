/**
 * Apprentice performance (Apprentice Academy phase 2, R-150) — pure functions, no I/O.
 *
 * The score is computed, never stored, from rows that already exist (evaluations, marked
 * submissions, tasks), so it can never drift from them. Parts that have no data yet are
 * left out and the remaining weights are re-scaled — a new apprentice with two marked
 * tasks is scored on those, not punished with zeros for evaluations nobody has written.
 * Attendance is not a part yet: it arrives with phase 4 and the page says so.
 */

export interface PerfTask { status: string; due_date: string | null; completed_at: string | null }
export interface PerfSubmission { review_result: string | null; marks: number | null }
/** `total` is a generated column, so the generated types call it nullable. */
export interface PerfEvaluation { week_start: string; total: number | null }

export type Band = "green" | "yellow" | "red";
export interface PerfPart { key: "evaluation" | "marks" | "completion" | "on_time"; label: string; weight: number; value: number | null; note: string }
export interface Performance { score: number | null; band: Band | null; parts: PerfPart[]; alerts: string[]; trend: "up" | "down" | "flat" | null }

const WEIGHTS = { evaluation: 40, marks: 25, completion: 20, on_time: 15 } as const;

export function bandOf(score: number): Band {
  return score >= 75 ? "green" : score >= 50 ? "yellow" : "red";
}

/** The weekly evaluation's verdict (master prompt §9). */
export function evaluationBand(total: number): string {
  if (total >= 90) return "Excellent";
  if (total >= 75) return "Very Good";
  if (total >= 60) return "Good";
  if (total >= 40) return "Needs Improvement";
  return "Critical Improvement Required";
}

/** Skill level from a 0–100 percentage (master prompt §8). */
export function skillLevel(percent: number): "Beginner" | "Learning" | "Competent" | "Advanced" {
  if (percent >= 75) return "Advanced";
  if (percent >= 50) return "Competent";
  if (percent >= 25) return "Learning";
  return "Beginner";
}

/** Monday of the ISO week that contains `isoDate` (YYYY-MM-DD), as YYYY-MM-DD. */
export function weekStart(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function computePerformance(input: { tasks: PerfTask[]; submissions: PerfSubmission[]; evaluations: PerfEvaluation[]; today: string }): Performance {
  const { tasks, submissions, evaluations, today } = input;
  const evals = evaluations
    .filter((e): e is { week_start: string; total: number } => e.total != null)
    .sort((a, b) => b.week_start.localeCompare(a.week_start));

  const evalAvg = avg(evals.slice(0, 4).map((e) => e.total));
  const marks = avg(submissions.filter((s) => s.review_result === "approved" && s.marks != null).map((s) => s.marks as number));
  const dueOrDone = tasks.filter((t) => t.status === "completed" || (t.due_date != null && t.due_date <= today));
  const completion = dueOrDone.length ? (dueOrDone.filter((t) => t.status === "completed").length / dueOrDone.length) * 100 : null;
  const doneWithDue = tasks.filter((t) => t.status === "completed" && t.due_date && t.completed_at);
  const onTime = doneWithDue.length
    ? (doneWithDue.filter((t) => (t.completed_at as string).slice(0, 10) <= (t.due_date as string)).length / doneWithDue.length) * 100
    : null;

  const parts: PerfPart[] = [
    { key: "evaluation", label: "Weekly evaluations", weight: WEIGHTS.evaluation, value: evalAvg, note: evals.length ? `last ${Math.min(4, evals.length)} week${evals.length === 1 ? "" : "s"}` : "no evaluation yet" },
    { key: "marks", label: "Marks on approved work", weight: WEIGHTS.marks, value: marks, note: marks == null ? "no marked work yet" : "average /100" },
    { key: "completion", label: "Tasks completed", weight: WEIGHTS.completion, value: completion, note: dueOrDone.length ? `${dueOrDone.filter((t) => t.status === "completed").length} of ${dueOrDone.length} due` : "nothing due yet" },
    { key: "on_time", label: "Completed on time", weight: WEIGHTS.on_time, value: onTime, note: doneWithDue.length ? `${doneWithDue.length} with a due date` : "no dated task done yet" },
  ];

  const present = parts.filter((p) => p.value != null);
  const weightSum = present.reduce((s, p) => s + p.weight, 0);
  const score = weightSum ? Math.round(present.reduce((s, p) => s + (p.value as number) * p.weight, 0) / weightSum) : null;
  const band = score == null ? null : bandOf(score);

  let trend: Performance["trend"] = null;
  if (evals.length >= 2) {
    const diff = evals[0].total - evals[1].total;
    trend = diff >= 5 ? "up" : diff <= -5 ? "down" : "flat";
  }

  const alerts: string[] = [];
  if (band === "red") alerts.push(`At risk — performance score ${score}/100.`);
  if (evals.length >= 2 && evals[1].total - evals[0].total >= 15) {
    alerts.push(`Evaluation fell from ${evals[1].total} to ${evals[0].total} in a week.`);
  }
  if (evals.length && evals[0].total < 40) alerts.push(`Latest evaluation ${evals[0].total}/100 — critical improvement required.`);
  const overdue = tasks.filter((t) => t.status !== "completed" && t.due_date != null && t.due_date < today).length;
  if (overdue >= 2) alerts.push(`${overdue} tasks are overdue.`);

  return { score, band, parts, alerts, trend };
}
