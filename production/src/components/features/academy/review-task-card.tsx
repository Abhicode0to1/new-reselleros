"use client";

/**
 * One submitted task, its latest work and the mentor's decision (R-149). Approve completes
 * the task; rework needs feedback (the database refuses rework without it). Earlier attempts
 * stay visible with their feedback, so a mentor sees what was already asked.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { useReviewTask, TASK_KIND_LABEL, type AcademyTask, type AcademySubmission } from "@/lib/queries/academy";

export function ReviewTaskCard({ task, apprenticeName, submissions }: { task: AcademyTask; apprenticeName: string; submissions: AcademySubmission[] }) {
  const review = useReviewTask();
  const [feedback, setFeedback] = React.useState("");
  const [marks, setMarks] = React.useState("");
  const latest = submissions[0];
  const earlier = submissions.slice(1);
  const m = marks.trim() === "" ? null : Math.max(0, Math.min(100, Math.round(Number(marks))));

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold text-ink">{task.title}</p>
          <p className="text-xs text-ink-3">{apprenticeName} · {TASK_KIND_LABEL[task.kind] ?? task.kind}{task.due_date ? ` · due ${formatDate(task.due_date, "short")}` : ""}</p>
        </div>
        {latest && <Badge kind="warning" size="sm">Attempt {latest.attempt}</Badge>}
      </div>

      {latest ? (
        <div className="rounded-lg bg-paper-2/60 border border-hairline p-3 text-sm space-y-1.5">
          {latest.note && <p className="whitespace-pre-wrap text-ink">{latest.note}</p>}
          {latest.github_url && <p>GitHub: <a className="text-amber-ink underline break-all" href={latest.github_url} target="_blank" rel="noopener noreferrer">{latest.github_url}</a></p>}
          {latest.link_url && <p>Link: <a className="text-amber-ink underline break-all" href={latest.link_url} target="_blank" rel="noopener noreferrer">{latest.link_url}</a></p>}
          <p className="text-xs text-ink-3">Submitted {formatDate(latest.submitted_at, "short")}</p>
        </div>
      ) : (
        <p className="text-sm text-ink-3">Loading the submission…</p>
      )}

      {earlier.length > 0 && (
        <details className="text-xs text-ink-3">
          <summary className="cursor-pointer">Earlier attempts ({earlier.length})</summary>
          <ul className="mt-2 space-y-1">
            {earlier.map((s) => <li key={s.id}>Attempt {s.attempt}: {s.review_result === "rework" ? "rework" : s.review_result ?? "—"}{s.feedback ? ` — “${s.feedback}”` : ""}</li>)}
          </ul>
        </details>
      )}

      <div className="grid gap-2 sm:grid-cols-[1fr_110px]">
        <Input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Feedback — what was good, what to fix" aria-label="Feedback" />
        <Input value={marks} onChange={(e) => setMarks(e.target.value)} type="number" min={0} max={100} placeholder="Marks /100" aria-label="Marks out of 100" />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="primary" loading={review.isPending}
          onClick={() => review.mutate({ task_id: task.id, result: "approved", feedback, marks: m })}>Approve</Button>
        <Button size="sm" variant="outline" disabled={!feedback.trim()} title={feedback.trim() ? undefined : "Write what to fix first"}
          onClick={() => review.mutate({ task_id: task.id, result: "rework", feedback, marks: m })}>Ask for rework</Button>
      </div>
    </Card>
  );
}
