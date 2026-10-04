/**
 * /learn — the apprentice's own screen (Apprentice Academy, R-149).
 *
 * Deliberately outside the (app) shell: an apprentice is not staff and has no access to
 * company data (no public.users row; middleware keeps them on /learn and the academy API).
 * Shows today's work, every open task with start / submit, feedback, and the curriculum.
 */
"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import {
  useMyApprenticeProfile, useAcademyTasks, useSubmissions, usePrograms, useStartTask, useSubmitTask,
  TASK_STATUS_LABEL, TASK_KIND_LABEL, type AcademyTask,
} from "@/lib/queries/academy";

const STATUS_KIND: Record<string, "muted" | "info" | "warning" | "danger" | "success"> = {
  not_started: "muted", in_progress: "info", submitted: "warning", rework: "danger", completed: "success",
};

function greeting(): string {
  const h = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function LearnPage() {
  const router = useRouter();
  const me = useMyApprenticeProfile();
  const tasks = useAcademyTasks();
  const list = tasks.data ?? [];
  const subs = useSubmissions(list.map((t) => t.id));
  const programs = usePrograms();
  const start = useStartTask();
  const [submitFor, setSubmitFor] = React.useState<AcademyTask | null>(null);

  const today = istToday();
  const open = list.filter((t) => t.status !== "completed");
  const todays = open.filter((t) => !t.due_date || t.due_date <= today);
  const done = list.filter((t) => t.status === "completed").length;
  const pct = list.length ? Math.round((done / list.length) * 100) : 0;
  const modules = (programs.data?.modules ?? []).filter((m) => !me.data?.program_id || m.program_id === me.data.program_id);
  const feedback = (subs.data ?? []).filter((s) => s.feedback).slice(0, 5);
  const titleOf = (taskId: string) => list.find((t) => t.id === taskId)?.title ?? "Task";

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-20 bg-paper/95 backdrop-blur border-b border-hairline">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/lp/anutech-logo.png" alt="ANUTECH Digital Pvt Ltd" width={108} height={36} style={{ height: 36, width: "auto" }} priority />
            <span className="hidden sm:inline text-sm font-semibold text-ink-2">Academy</span>
          </div>
          <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {me.isLoading ? <Skeleton className="h-24" /> : !me.data ? (
          <Card className="p-6"><p className="text-ink">This sign-in is not linked to an apprentice profile. Ask your mentor.</p></Card>
        ) : (
          <>
            <section>
              <h1 className="font-serif text-3xl md:text-4xl">{greeting()}, {me.data.full_name.split(" ")[0]}</h1>
              <p className="text-sm text-ink-3 mt-1">{me.data.code}{me.data.end_date ? ` · training till ${formatDate(me.data.end_date, "short")}` : ""}</p>
              <div className="mt-4">
                <div className="flex justify-between text-sm mb-1"><span className="font-semibold text-ink">Overall progress</span><span className="tabular-nums text-ink-2">{pct}% · {done} of {list.length} tasks</span></div>
                <div className="h-2.5 rounded-full bg-paper-2 overflow-hidden"><div className="h-full bg-emerald" style={{ width: `${pct}%` }} /></div>
              </div>
            </section>

            <section className="space-y-3">
              <h2 className="font-serif text-xl">Today&apos;s training</h2>
              {tasks.isLoading ? <Skeleton className="h-24" /> : todays.length === 0 ? (
                <Card className="p-4 text-sm text-ink-3">Nothing due today. {open.length ? "Your upcoming tasks are below." : "Your mentor will add your next task."}</Card>
              ) : todays.map((t) => <TaskRow key={t.id} t={t} onStart={() => start.mutate(t.id)} onSubmit={() => setSubmitFor(t)} />)}
            </section>

            {open.length > todays.length && (
              <section className="space-y-3">
                <h2 className="font-serif text-xl">Coming up</h2>
                {open.filter((t) => !todays.includes(t)).map((t) => <TaskRow key={t.id} t={t} onStart={() => start.mutate(t.id)} onSubmit={() => setSubmitFor(t)} />)}
              </section>
            )}

            {feedback.length > 0 && (
              <section className="space-y-2">
                <h2 className="font-serif text-xl">Mentor feedback</h2>
                {feedback.map((s) => (
                  <Card key={s.id} className="p-3 text-sm">
                    <p className="font-semibold text-ink">{titleOf(s.task_id)} <span className="font-normal text-ink-3">· attempt {s.attempt}</span></p>
                    <p className="text-ink-2 mt-0.5">“{s.feedback}”</p>
                    <p className="text-xs text-ink-3 mt-1">{s.review_result === "approved" ? "Approved" : "Rework asked"}{s.marks != null ? ` · ${s.marks}/100` : ""}</p>
                  </Card>
                ))}
              </section>
            )}

            {modules.length > 0 && (
              <section className="space-y-2">
                <h2 className="font-serif text-xl">Your curriculum</h2>
                <ol className="grid gap-2 sm:grid-cols-2">
                  {modules.map((m) => (
                    <li key={m.id} className="rounded-lg border border-hairline bg-white p-3">
                      <p className="font-semibold text-ink text-sm">Module {m.position} — {m.title}</p>
                      <p className="text-xs text-ink-3 mt-1">{m.topics.join(" · ")}</p>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <p className="text-xs text-ink-3 border-t border-hairline pt-4">
              AI writes code that can be wrong. Test it, read it, commit it to Git and ask your mentor to review it.
              Never paste passwords, API keys or company files into any AI tool.
            </p>
          </>
        )}
      </main>

      {submitFor && <SubmitDialog task={submitFor} onClose={() => setSubmitFor(null)} />}
    </div>
  );
}

function TaskRow({ t, onStart, onSubmit }: { t: AcademyTask; onStart: () => void; onSubmit: () => void }) {
  const late = t.due_date && t.due_date < istToday();
  const canSubmit = t.status === "not_started" || t.status === "in_progress" || t.status === "rework";
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{t.title}</p>
          <p className="text-xs text-ink-3">
            {TASK_KIND_LABEL[t.kind] ?? t.kind}{t.est_minutes ? ` · ${t.est_minutes} min` : ""}
            {t.due_date ? <> · <span className={late ? "text-red-ink font-semibold" : ""}>due {formatDate(t.due_date, "short")}{late ? " (late)" : ""}</span></> : ""}
          </p>
        </div>
        <Badge kind={STATUS_KIND[t.status] ?? "muted"} size="sm">{TASK_STATUS_LABEL[t.status] ?? t.status}</Badge>
      </div>
      {t.description && <p className="text-sm text-ink-2 whitespace-pre-wrap">{t.description}</p>}
      {t.instructions && (
        <details className="text-sm"><summary className="cursor-pointer text-amber-ink font-semibold">Instructions</summary><p className="whitespace-pre-wrap text-ink-2 mt-1">{t.instructions}</p></details>
      )}
      {t.reference_url && <a href={t.reference_url} target="_blank" rel="noopener noreferrer" className="text-sm text-amber-ink underline break-all">Reference ↗</a>}
      {canSubmit && (
        <div className="flex gap-2 pt-1">
          {t.status !== "in_progress" && <Button size="sm" variant="outline" onClick={onStart}>{t.status === "rework" ? "Start the fix" : "Start"}</Button>}
          <Button size="sm" variant="primary" onClick={onSubmit}>Submit work</Button>
        </div>
      )}
    </Card>
  );
}

function SubmitDialog({ task, onClose }: { task: AcademyTask; onClose: () => void }) {
  const submit = useSubmitTask();
  const [note, setNote] = React.useState("");
  const [link, setLink] = React.useState("");
  const [github, setGithub] = React.useState("");
  const ghBad = github.trim() !== "" && !/^https:\/\/(www\.)?github\.com\//i.test(github.trim());
  const linkBad = link.trim() !== "" && !/^https?:\/\//i.test(link.trim());
  const needsGh = task.submission_type === "github" && !github.trim();
  const empty = !note.trim() && !link.trim() && !github.trim();

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit: {task.title}</DialogTitle>
          <DialogDescription>{task.submission_type === "github" ? "Paste your GitHub repository link." : task.submission_type === "text" ? "Write your answer." : "Paste the link to your work."} Add a short note on what you did.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          if (ghBad || linkBad || needsGh || empty) return;
          submit.mutate({ task_id: task.id, note, link, github }, { onSuccess: onClose });
        }}>
          {task.submission_type !== "text" && (
            task.submission_type === "github"
              ? <FormField label="GitHub link" required htmlFor="sb-gh"><Input id="sb-gh" value={github} onChange={(e) => setGithub(e.target.value)} placeholder="https://github.com/you/project" autoFocus /></FormField>
              : <FormField label="Link to your work" htmlFor="sb-link"><Input id="sb-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" autoFocus /></FormField>
          )}
          <FormField label={task.submission_type === "text" ? "Your answer" : "Note (what you did, what you learned)"} htmlFor="sb-note">
            <textarea id="sb-note" className="w-full rounded-lg border border-hairline-strong bg-paper px-3 py-2 text-sm min-h-[110px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
          </FormField>
          {ghBad && <p className="text-sm text-red-ink">The GitHub link must start with https://github.com/</p>}
          {linkBad && <p className="text-sm text-red-ink">The link must start with http:// or https://</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={submit.isPending} disabled={ghBad || linkBad || needsGh || empty}>Submit</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
