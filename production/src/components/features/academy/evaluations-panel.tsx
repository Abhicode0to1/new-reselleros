"use client";

/**
 * Weekly evaluations (R-150, master prompt §9): six parts out of 100, the verdict band, and
 * what to focus on next week. One evaluation per apprentice per week (the database refuses
 * a second — the dialog opens the existing one to edit instead).
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { evaluationBand, weekStart } from "@/lib/academy/performance";
import { useEvaluations, useSaveEvaluation, type AcademyEvaluation } from "@/lib/queries/academy";

export const EVAL_PARTS = [
  { key: "technical", label: "Technical knowledge", max: 20 },
  { key: "problem_solving", label: "Problem solving", max: 20 },
  { key: "ai_tool_usage", label: "AI tool usage", max: 20 },
  { key: "task_completion", label: "Task completion", max: 15 },
  { key: "code_quality", label: "Code quality", max: 15 },
  { key: "communication", label: "Communication", max: 10 },
] as const;
type PartKey = (typeof EVAL_PARTS)[number]["key"];

export function bandKind(total: number): "success" | "info" | "warning" | "danger" | "muted" {
  return total >= 90 ? "success" : total >= 75 ? "info" : total >= 60 ? "muted" : total >= 40 ? "warning" : "danger";
}

export function EvaluationsPanel({ apprenticeId, apprenticeName, editable }: { apprenticeId: string; apprenticeName: string; editable: boolean }) {
  const evals = useEvaluations(apprenticeId);
  const [open, setOpen] = React.useState<AcademyEvaluation | "new" | null>(null);
  const list = evals.data ?? [];
  const thisWeek = weekStart(istToday());
  const current = list.find((e) => e.week_start === thisWeek);

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-xl">Weekly evaluations</h2>
        {editable && <Button size="sm" variant="primary" onClick={() => setOpen(current ?? "new")}>{current ? "Edit this week" : "Evaluate this week"}</Button>}
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-ink-3">No evaluation yet.{editable ? " Score this week on six parts — 100 in all." : ""}</p>
      ) : (
        <ul className="space-y-3">
          {list.map((e) => (
            <li key={e.id} className="rounded-lg border border-hairline p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-semibold text-ink">Week of {formatDate(e.week_start, "short")}</span>
                <span className="flex items-center gap-2">
                  <span className="font-serif text-xl tabular-nums">{e.total ?? 0}<span className="text-xs text-ink-3">/100</span></span>
                  <Badge kind={bandKind(e.total ?? 0)} size="sm">{evaluationBand(e.total ?? 0)}</Badge>
                  {editable && <button type="button" className="text-xs text-ink-3 hover:text-ink" onClick={() => setOpen(e)}>Edit</button>}
                </span>
              </div>
              <p className="text-xs text-ink-3">{EVAL_PARTS.map((p) => `${p.label} ${e[p.key]}/${p.max}`).join(" · ")}</p>
              {e.strengths && <p className="text-sm"><b className="text-ink">Good:</b> <span className="text-ink-2">{e.strengths}</span></p>}
              {e.improve && <p className="text-sm"><b className="text-ink">Improve:</b> <span className="text-ink-2">{e.improve}</span></p>}
              {e.next_focus && <p className="text-sm"><b className="text-ink">Next week:</b> <span className="text-ink-2">{e.next_focus}</span></p>}
            </li>
          ))}
        </ul>
      )}
      {open && <EvaluationDialog apprenticeId={apprenticeId} apprenticeName={apprenticeName} existing={open === "new" ? null : open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function EvaluationDialog({ apprenticeId, apprenticeName, existing, onClose }: { apprenticeId: string; apprenticeName: string; existing: AcademyEvaluation | null; onClose: () => void }) {
  const save = useSaveEvaluation();
  const [week, setWeek] = React.useState(existing?.week_start ?? weekStart(istToday()));
  const [marks, setMarks] = React.useState<Record<PartKey, string>>(() =>
    Object.fromEntries(EVAL_PARTS.map((p) => [p.key, existing ? String(existing[p.key]) : ""])) as Record<PartKey, string>);
  const [strengths, setStrengths] = React.useState(existing?.strengths ?? "");
  const [improve, setImprove] = React.useState(existing?.improve ?? "");
  const [nextFocus, setNextFocus] = React.useState(existing?.next_focus ?? "");

  const nums = EVAL_PARTS.map((p) => ({ ...p, n: Math.round(Number(marks[p.key])) }));
  const bad = nums.filter((p) => marks[p.key] === "" || !Number.isFinite(p.n) || p.n < 0 || p.n > p.max);
  const total = nums.reduce((s, p) => s + (Number.isFinite(p.n) ? Math.max(0, Math.min(p.max, p.n)) : 0), 0);
  const weakest = [...nums].filter((p) => Number.isFinite(p.n)).sort((a, b) => a.n / a.max - b.n / b.max)[0];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:!max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit evaluation" : "Weekly evaluation"} — {apprenticeName}</DialogTitle>
          <DialogDescription>Six parts, 100 in all. The verdict and the performance score update on save.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3 max-h-[65vh] overflow-y-auto pr-1" onSubmit={(e) => {
          e.preventDefault();
          if (bad.length) return;
          save.mutate({
            id: existing?.id, apprentice_id: apprenticeId, week_start: weekStart(week),
            technical: nums[0].n, problem_solving: nums[1].n, ai_tool_usage: nums[2].n,
            task_completion: nums[3].n, code_quality: nums[4].n, communication: nums[5].n,
            strengths: strengths.trim() || null, improve: improve.trim() || null, next_focus: nextFocus.trim() || null,
          }, { onSuccess: onClose });
        }}>
          <FormField label="Week (any day — saved as that week's Monday)" htmlFor="ev-week">
            <Input id="ev-week" type="date" value={week} onChange={(e) => setWeek(e.target.value)} disabled={!!existing} />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            {EVAL_PARTS.map((p) => (
              <FormField key={p.key} label={`${p.label} (out of ${p.max})`} htmlFor={`ev-${p.key}`} required>
                <Input id={`ev-${p.key}`} type="number" min={0} max={p.max} value={marks[p.key]}
                  onChange={(e) => setMarks((m) => ({ ...m, [p.key]: e.target.value }))} />
              </FormField>
            ))}
          </div>
          <div className="rounded-lg bg-paper-2/60 border border-hairline p-3 flex items-center justify-between">
            <span className="text-sm text-ink-2">Total</span>
            <span className="flex items-center gap-2"><b className="font-serif text-2xl tabular-nums">{total}</b><span className="text-ink-3">/100</span><Badge kind={bandKind(total)} size="sm">{evaluationBand(total)}</Badge></span>
          </div>
          {bad.length > 0 && <p className="text-xs text-red-ink">Fill each part within its maximum: {bad.map((p) => `${p.label} (0–${p.max})`).join(", ")}.</p>}
          <FormField label="What went well" htmlFor="ev-good"><Input id="ev-good" value={strengths} onChange={(e) => setStrengths(e.target.value)} /></FormField>
          <FormField label="What to improve" htmlFor="ev-imp"><Input id="ev-imp" value={improve} onChange={(e) => setImprove(e.target.value)} /></FormField>
          <FormField label="Focus for next week" htmlFor="ev-next">
            <Input id="ev-next" value={nextFocus} onChange={(e) => setNextFocus(e.target.value)}
              placeholder={weakest && Number.isFinite(weakest.n) ? `e.g. ${weakest.label.toLowerCase()} — the lowest part this week` : ""} />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={bad.length > 0}>Save evaluation</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
