/**
 * One apprentice (R-149): profile, sign-in, tasks, and review of submitted work.
 * Mentors reach only their own apprentices — RLS returns nothing for anyone else, and the
 * page then says so instead of showing an empty profile.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/ui/label";
import { EmptyState } from "@/components/shared/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTeamMembers } from "@/lib/queries/team";
import {
  useApprentices, usePrograms, useAcademyTasks, useSubmissions, useCreateTask, useDeleteTask, useCreateApprenticeLogin,
  TASK_STATUS_LABEL, TASK_KIND_LABEL, APPRENTICE_STATUS_LABEL, type Apprentice,
} from "@/lib/queries/academy";
import { ReviewTaskCard } from "@/components/features/academy/review-task-card";
import { PerformanceCard } from "@/components/features/academy/performance-card";
import { SkillsPanel } from "@/components/features/academy/skills-panel";
import { EvaluationsPanel } from "@/components/features/academy/evaluations-panel";
import { computePerformance } from "@/lib/academy/performance";
import { useEvaluations } from "@/lib/queries/academy";

const STATUS_KIND: Record<string, "muted" | "info" | "warning" | "danger" | "success"> = {
  not_started: "muted", in_progress: "info", submitted: "warning", rework: "danger", completed: "success",
};

export default function ApprenticeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const me = useCurrentUser().data;
  const canManage = me?.role === "owner" || me?.role === "manager";
  const apprentices = useApprentices();
  const tasks = useAcademyTasks(id);
  const taskList = tasks.data ?? [];
  const subs = useSubmissions(taskList.map((t) => t.id));
  const evals = useEvaluations(id);
  const team = useTeamMembers();
  const login = useCreateApprenticeLogin();
  const del = useDeleteTask();
  const confirm = useConfirm();
  const [assignOpen, setAssignOpen] = React.useState(false);

  const a = (apprentices.data ?? []).find((x) => x.id === id);
  if (apprentices.isLoading) return <div className="p-6"><Skeleton className="h-60" /></div>;
  if (!a) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Card className="py-6"><EmptyState icon="users" title="Apprentice not found" body="Either it was removed, or you are not this apprentice's mentor." action={<Link href="/academy" className="text-amber-ink font-semibold">Back to the Academy</Link>} /></Card>
      </div>
    );
  }
  const mentor = (team.data ?? []).find((m) => m.id === a.mentor_user_id);
  const done = taskList.filter((t) => t.status === "completed").length;
  const pct = taskList.length ? Math.round((done / taskList.length) * 100) : 0;
  const submitted = taskList.filter((t) => t.status === "submitted");
  const perf = computePerformance({ tasks: taskList, submissions: subs.data ?? [], evaluations: evals.data ?? [], today: istToday() });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto space-y-6">
      <Link href="/academy" className="text-sm text-ink-3 hover:text-ink">← Apprentice Academy</Link>

      <Card className="p-5">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-serif text-3xl">{a.full_name}</h1>
              <Badge kind={a.status === "active" ? "success" : "muted"} size="sm">{APPRENTICE_STATUS_LABEL[a.status] ?? a.status}</Badge>
            </div>
            <p className="text-sm text-ink-3 mt-1">
              {a.code} · Mentor: <b className="text-ink-2">{mentor?.full_name ?? mentor?.email ?? "not set"}</b>
              {a.start_date ? ` · ${formatDate(a.start_date, "short")}` : ""}{a.end_date ? ` – ${formatDate(a.end_date, "short")}` : ""}
            </p>
            <p className="text-sm text-ink-3">{[a.course, a.institute, a.qualification].filter(Boolean).join(" · ") || "Course and institute not added yet."}</p>
          </div>
          <div className="flex flex-col items-start md:items-end gap-2">
            {canManage && (a.user_id
              ? <Badge kind="info">Has a sign-in · {a.email}</Badge>
              : <Button size="sm" variant="outline" loading={login.isPending} disabled={!a.email}
                  title={a.email ? undefined : "Add their email first (Edit on the Academy page)"}
                  onClick={async () => {
                    if (await confirm({ title: `Create a sign-in for ${a.full_name}?`, body: `We create an account for ${a.email} and email them how to set a password. They see only their own training — nothing else in the company.`, confirmLabel: "Create sign-in" })) login.mutate(a.id);
                  }}>Create sign-in</Button>)}
            <Button size="sm" variant="primary" icon="plus" onClick={() => setAssignOpen(true)}>Assign task</Button>
          </div>
        </div>
        <div className="mt-4">
          <div className="flex justify-between text-xs text-ink-3 mb-1"><span>Tasks completed</span><span className="tabular-nums">{done} of {taskList.length} · {pct}%</span></div>
          <div className="h-2 rounded-full bg-paper-2 overflow-hidden"><div className="h-full bg-emerald" style={{ width: `${pct}%` }} /></div>
        </div>
      </Card>

      <PerformanceCard perf={perf} />

      {submitted.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-serif text-xl">Waiting for review</h2>
          {submitted.map((t) => (
            <ReviewTaskCard key={t.id} task={t} apprenticeName={a.full_name} submissions={(subs.data ?? []).filter((s) => s.task_id === t.id)} />
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-serif text-xl">Tasks</h2>
        {taskList.length === 0 ? (
          <Card className="py-6"><EmptyState icon="check" title="No tasks yet" body="Assign the first task — a daily task, an assignment or a practical." action={<Button variant="primary" icon="plus" onClick={() => setAssignOpen(true)}>Assign task</Button>} /></Card>
        ) : (
          <Card className="divide-y divide-hairline">
            {taskList.map((t) => {
              const last = (subs.data ?? []).find((s) => s.task_id === t.id);
              const late = t.due_date && t.due_date < istToday() && t.status !== "completed";
              return (
                <div key={t.id} className="p-3.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">{t.title}</p>
                    <p className="text-xs text-ink-3">
                      {TASK_KIND_LABEL[t.kind] ?? t.kind} · {t.difficulty}{t.est_minutes ? ` · ${t.est_minutes} min` : ""}
                      {t.due_date ? <> · <span className={late ? "text-red-ink font-semibold" : ""}>due {formatDate(t.due_date, "short")}{late ? " (late)" : ""}</span></> : ""}
                    </p>
                    {last?.feedback && <p className="text-xs text-ink-2 mt-1">Feedback: “{last.feedback}”{last.marks != null ? ` · ${last.marks}/100` : ""}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge kind={STATUS_KIND[t.status] ?? "muted"} size="sm">{TASK_STATUS_LABEL[t.status] ?? t.status}</Badge>
                    {t.status === "not_started" && (
                      <button type="button" className="text-xs text-ink-3 hover:text-red-ink" aria-label={`Remove ${t.title}`}
                        onClick={async () => { if (await confirm({ title: "Remove this task?", body: t.title, confirmLabel: "Remove", danger: true })) del.mutate(t.id); }}>Remove</button>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <EvaluationsPanel apprenticeId={a.id} apprenticeName={a.full_name} editable />
        <SkillsPanel apprenticeId={a.id} editable canSetUp={canManage} />
      </div>

      {assignOpen && <AssignTaskDialog apprentice={a} onClose={() => setAssignOpen(false)} />}
    </div>
  );
}

function AssignTaskDialog({ apprentice, onClose }: { apprentice: Apprentice; onClose: () => void }) {
  const create = useCreateTask();
  const programs = usePrograms();
  const modules = (programs.data?.modules ?? []).filter((m) => !apprentice.program_id || m.program_id === apprentice.program_id);
  const [f, setF] = React.useState({
    title: "", description: "", instructions: "", kind: "daily", difficulty: "medium", est_minutes: "60",
    due_date: istToday(), priority: "normal", reference_url: "", submission_type: "github", module_id: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const selectCls = "w-full h-10 rounded-lg border border-hairline-strong bg-paper px-3 text-sm";
  const areaCls = "w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-sm min-h-[70px]";
  const refOk = !f.reference_url.trim() || /^https?:\/\//i.test(f.reference_url.trim());

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign a task to {apprentice.full_name}</DialogTitle>
          <DialogDescription>They see it on their own screen and submit their work there.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3 max-h-[65vh] overflow-y-auto pr-1" onSubmit={(e) => {
          e.preventDefault();
          if (!refOk) return;
          create.mutate({
            apprentice_id: apprentice.id, title: f.title.trim(), description: f.description.trim() || null, instructions: f.instructions.trim() || null,
            kind: f.kind, difficulty: f.difficulty, est_minutes: f.est_minutes ? Math.round(Number(f.est_minutes)) : null,
            due_date: f.due_date || null, priority: f.priority, reference_url: f.reference_url.trim() || null,
            submission_type: f.submission_type, module_id: f.module_id || null,
          }, { onSuccess: onClose });
        }}>
          <FormField label="Title" required htmlFor="tk-title"><Input id="tk-title" value={f.title} onChange={set("title")} required minLength={3} autoFocus placeholder="e.g. Call a REST API and show the result on a page" /></FormField>
          <FormField label="What to do" htmlFor="tk-desc"><textarea id="tk-desc" className={areaCls} value={f.description} onChange={set("description")} /></FormField>
          <FormField label="Step-by-step instructions" htmlFor="tk-ins"><textarea id="tk-ins" className={areaCls} value={f.instructions} onChange={set("instructions")} /></FormField>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Type" htmlFor="tk-kind"><select id="tk-kind" className={selectCls} value={f.kind} onChange={set("kind")}>{Object.entries(TASK_KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FormField>
            <FormField label="Difficulty" htmlFor="tk-diff"><select id="tk-diff" className={selectCls} value={f.difficulty} onChange={set("difficulty")}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></FormField>
            <FormField label="Priority" htmlFor="tk-pri"><select id="tk-pri" className={selectCls} value={f.priority} onChange={set("priority")}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></FormField>
            <FormField label="Due date" htmlFor="tk-due"><Input id="tk-due" type="date" value={f.due_date} onChange={set("due_date")} /></FormField>
            <FormField label="Time (minutes)" htmlFor="tk-min"><Input id="tk-min" type="number" min={5} max={2400} value={f.est_minutes} onChange={set("est_minutes")} /></FormField>
            <FormField label="They submit" htmlFor="tk-sub"><select id="tk-sub" className={selectCls} value={f.submission_type} onChange={set("submission_type")}><option value="github">GitHub link</option><option value="link">Any link</option><option value="text">Written answer</option></select></FormField>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Module" htmlFor="tk-mod">
              <select id="tk-mod" className={selectCls} value={f.module_id} onChange={set("module_id")}>
                <option value="">— None —</option>
                {modules.map((m) => <option key={m.id} value={m.id}>Module {m.position} — {m.title}</option>)}
              </select>
            </FormField>
            <FormField label="Reference link" htmlFor="tk-ref"><Input id="tk-ref" value={f.reference_url} onChange={set("reference_url")} placeholder="https://…" /></FormField>
          </div>
          {!refOk && <p className="text-sm text-red-ink">The reference link must start with http:// or https://</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending}>Assign task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
