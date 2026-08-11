/**
 * Project task roadmap — an ordered checklist per project, each task assignable
 * to an employee who's on the project's team (project_labour). Owner/manager use
 * this to plan delivery and hand work to the team.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { formatDate, rupee } from "@/lib/utils";
import { toast } from "sonner";
import {
  useProjectTasks, useCreateProjectTask, useUpdateProjectTask, useDeleteProjectTask,
  useCreateProjectTasksBulk, generateProjectPlan, fetchProjectQuestions, type PlannedTask,
} from "@/lib/queries/projects";
import type { ProjectTaskStatus } from "@/lib/supabase/database.types";

type TeamMember = { employee_id: string; employeeName: string };
export type ProjectSummary = { title: string; customerName: string; value: number; startDate: string | null; targetDate: string | null };

const STATUS_META: Record<ProjectTaskStatus, { label: string; kind: "muted" | "warning" | "success" }> = {
  todo:        { label: "To do",       kind: "muted" },
  in_progress: { label: "In progress", kind: "warning" },
  done:        { label: "Done",        kind: "success" },
};
const STATUS_ORDER: ProjectTaskStatus[] = ["todo", "in_progress", "done"];

export function ProjectTasks({ projectId, team, project }: { projectId: string; team: TeamMember[]; project?: ProjectSummary }) {
  const q = useProjectTasks(projectId);
  const create = useCreateProjectTask();
  const update = useUpdateProjectTask();
  const del = useDeleteProjectTask();
  const confirm = useConfirm();

  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<string>("none");
  const [due, setDue] = React.useState("");
  const [aiOpen, setAiOpen] = React.useState(false);

  const tasks = q.data ?? [];
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length > 0 ? Math.round((doneCount / tasks.length) * 100) : 0;

  async function add() {
    const t = title.trim();
    if (!t) return;
    await create.mutateAsync({
      projectId, title: t,
      assigneeId: assignee === "none" ? null : assignee,
      dueDate: due || null,
      seq: tasks.length,
    });
    setTitle(""); setAssignee("none"); setDue("");
  }

  return (
    <Card
      title="Roadmap & tasks"
      sub={tasks.length > 0 ? `${doneCount}/${tasks.length} done · ${pct}%` : "Plan the delivery — assign work to the team"}
    >
      {/* AI planner — ask for details, get a full explanation + ready tasks. */}
      {project && (
        <div className="mb-3">
          <Button variant="default" icon="sparkles" onClick={() => setAiOpen(true)}>
            Plan with AI
          </Button>
          <span className="text-[11px] text-ink-3 ml-2">Project ki detail do → explanation + tasks ban jaayenge</span>
        </div>
      )}

      {/* Progress bar */}
      {tasks.length > 0 && (
        <div className="mb-3 h-1.5 rounded-full bg-paper-2 overflow-hidden">
          <div className="h-full bg-emerald transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {/* Task list */}
      {q.isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-ink-3 py-2">Abhi koi task nahi. Neeche pehla task add karo aur team member ko assign karo.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {tasks.map((t) => {
            const done = t.status === "done";
            const overdue = t.due_date && !done && new Date(t.due_date) < new Date();
            return (
              <li key={t.id} className="flex items-center gap-2 py-2 flex-wrap">
                {/* Quick done toggle */}
                <button type="button" aria-label="Toggle done"
                  onClick={() => update.mutate({ id: t.id, projectId, patch: { status: done ? "todo" : "done" } })}
                  className={`shrink-0 grid place-items-center h-5 w-5 rounded border ${done ? "bg-emerald border-emerald text-paper" : "border-hairline-strong text-transparent hover:border-emerald"}`}>
                  <Icon name="check" size={13} />
                </button>

                <span className={`flex-1 min-w-[8rem] text-sm ${done ? "line-through text-ink-3" : "text-ink"}`}>{t.title}</span>

                {/* Assignee */}
                <Select value={t.assignee_employee_id ?? "none"}
                  onValueChange={(v) => update.mutate({ id: t.id, projectId, patch: { assignee_employee_id: v === "none" ? null : v } })}>
                  <SelectTrigger className="h-7 w-[9.5rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {team.map((m) => <SelectItem key={m.employee_id} value={m.employee_id}>{m.employeeName}</SelectItem>)}
                  </SelectContent>
                </Select>

                {/* Status */}
                <Select value={t.status}
                  onValueChange={(v) => update.mutate({ id: t.id, projectId, patch: { status: v as ProjectTaskStatus } })}>
                  <SelectTrigger className="h-7 w-[7.5rem] text-[12px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_ORDER.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}
                  </SelectContent>
                </Select>

                {t.due_date && (
                  <Badge kind={overdue ? "danger" : "muted"} size="sm">{formatDate(t.due_date)}</Badge>
                )}

                <button type="button" aria-label="Delete task"
                  onClick={async () => { if (await confirm({ title: "Delete this task?", body: t.title, danger: true, confirmLabel: "Delete" })) del.mutate({ id: t.id, projectId }); }}
                  className="shrink-0 text-ink-3 hover:text-rose p-1">
                  <Icon name="trash" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add task */}
      <div className="mt-3 pt-3 border-t border-hairline flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[12rem]">
          <Input placeholder="e.g. Finalise database schema" value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
        </div>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger className="h-9 w-[9.5rem] text-sm"><SelectValue placeholder="Assign to" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {team.map((m) => <SelectItem key={m.employee_id} value={m.employee_id}>{m.employeeName}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" className="w-[9rem]" value={due} onChange={(e) => setDue(e.target.value)} />
        <Button variant="primary" icon="plus" loading={create.isPending} disabled={!title.trim()} onClick={add}>Add task</Button>
      </div>

      {team.length === 0 && (
        <p className="text-[11px] text-ink-3 mt-2">
          Tip: is project ki <b>Team</b> me employees add karo (upar Labour section), phir unhe tasks assign kar paoge.
        </p>
      )}

      {project && aiOpen && (
        <AiPlanDialog projectId={projectId} team={team} project={project} startSeq={tasks.length} onClose={() => setAiOpen(false)} />
      )}
    </Card>
  );
}

// ── AI planner dialog ────────────────────────────────────────────────────────
function AiPlanDialog({ projectId, team, project, startSeq, onClose }: {
  projectId: string; team: TeamMember[]; project: ProjectSummary; startSeq: number; onClose: () => void;
}) {
  const bulk = useCreateProjectTasksBulk();
  const [step, setStep] = React.useState<"input" | "questions" | "results">("input");
  const [details, setDetails] = React.useState("");
  const [loadingQuestions, setLoadingQuestions] = React.useState(false);
  const [generatingPlan, setGeneratingPlan] = React.useState(false);

  const [questions, setQuestions] = React.useState<string[]>([]);
  const [answers, setAnswers] = React.useState<Record<number, string>>({});

  const [clientProposal, setClientProposal] = React.useState("");
  const [explanation, setExplanation] = React.useState("");
  const [rows, setRows] = React.useState<{ title: string; phase?: string; assigneeId: string }[]>([]);
  const [stub, setStub] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<"proposal" | "tasks">("proposal");

  // Match an AI-suggested assignee name to a team member id (else "none").
  function matchAssignee(name?: string): string {
    if (!name) return "none";
    const n = name.trim().toLowerCase();
    return team.find((m) => m.employeeName.toLowerCase() === n)?.employee_id ?? "none";
  }

  // Step 1 -> Step 2: Fetch AI Clarifying Questions
  async function handleAskQuestions() {
    setLoadingQuestions(true);
    try {
      const qList = await fetchProjectQuestions({
        title: project.title,
        customer: project.customerName,
        details: details.trim() || undefined,
      });
      setQuestions(qList);
      setStep("questions");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingQuestions(false);
    }
  }

  // Step 1 or 2 -> Step 3: Generate Final Plan & Proposal
  async function handleGeneratePlan() {
    setGeneratingPlan(true);
    try {
      const formattedAnswers = questions
        .map((q, idx) => answers[idx] ? `Q: ${q}\nA: ${answers[idx]}` : "")
        .filter(Boolean)
        .join("\n\n");

      const plan = await generateProjectPlan({
        title: project.title,
        customer: project.customerName,
        value: project.value,
        startDate: project.startDate,
        targetDate: project.targetDate,
        details: details.trim() || undefined,
        qaAnswers: formattedAnswers || undefined,
        team: team.map((m) => m.employeeName),
      });

      setClientProposal(plan.clientProposal ?? "");
      setExplanation(plan.explanation ?? "");
      setStub(plan.mode === "stub");
      setRows(
        (plan.tasks as PlannedTask[]).map((t) => ({
          title: t.title,
          phase: t.phase || "Phase 1: Discovery & Delivery",
          assigneeId: matchAssignee(t.assignee),
        }))
      );
      setStep("results");
      setActiveTab("proposal");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGeneratingPlan(false);
    }
  }

  // Copy proposal to clipboard for client presentations
  const handleCopyProposal = () => {
    if (!clientProposal && !explanation) return;
    const textToCopy = clientProposal || explanation;
    navigator.clipboard.writeText(textToCopy);
    toast.success("Client presentation proposal copied to clipboard!");
  };

  async function createAll() {
    if (rows.length === 0) return;
    await bulk.mutateAsync({
      projectId,
      startSeq,
      tasks: rows.map((r) => ({ title: r.title, assigneeId: r.assigneeId === "none" ? null : r.assigneeId })),
    });
    onClose();
  }

  // Group tasks by Phase
  const groupedTasks = React.useMemo(() => {
    const map = new Map<string, typeof rows>();
    rows.forEach((r) => {
      const p = r.phase || "Phase 1: General Delivery";
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(r);
    });
    return map;
  }, [rows]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl p-0">
        {/* Header */}
        <DialogHeader className="p-6 pb-4 border-b border-hairline bg-paper/95 backdrop-blur-xs sticky top-0 z-10 flex-shrink-0">
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="sparkles" size={16} />
            <span>AI Project Architect & Proposal Builder</span>
          </div>
          <DialogTitle className="text-xl font-serif flex items-center justify-between">
            <span>{project.title}</span>
            <Badge kind="info" size="sm" className="font-mono text-xs">{rupee(project.value)}</Badge>
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Client: <b>{project.customerName}</b> {project.targetDate ? `· Deadline: ${formatDate(project.targetDate)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* STEP 1: Description Input */}
          {step === "input" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1.5">
                  1. Project Description / Client Requirements Brief *
                </label>
                <textarea
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  rows={5}
                  placeholder="Paste or type project description... e.g. Custom ERP & Billing Solution for Private Ltd company with GST invoicing, inventory tracking, role-based access, payment gateway integration, and automated WhatsApp notifications. Delivery in 6 weeks."
                  className="w-full rounded-xl border border-hairline bg-paper px-4 py-3 text-sm focus:border-amber focus:ring-amber font-sans"
                />
                <p className="text-[11px] text-ink-3 mt-1.5">
                  💡 Provide project details, scope, or client requirements. AI agent will analyze this and ask key questions for proposal generation & phase breakdown.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="primary"
                  icon="sparkles"
                  loading={loadingQuestions}
                  onClick={handleAskQuestions}
                  className="flex-1 justify-center py-2.5 font-bold"
                >
                  {loadingQuestions ? "Analyzing & Generating Questions..." : "🤖 Analyze & Ask Key Project Questions"}
                </Button>
                <Button
                  variant="outline"
                  loading={generatingPlan}
                  onClick={handleGeneratePlan}
                  className="text-xs shrink-0"
                >
                  ⚡ Skip Q&A & Generate Directly
                </Button>
              </div>
            </div>
          )}

          {/* STEP 2: Interactive AI Clarifying Questions */}
          {step === "questions" && (
            <div className="space-y-4">
              <div className="p-3 bg-amber-soft/40 border border-amber/20 rounded-xl text-xs text-amber-ink flex items-start gap-2">
                <Icon name="help_circle" size={16} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">Project Clarification Questions</span>
                  <p className="text-[11px] text-ink-2 mt-0.5">
                    Answer these key questions to help AI generate an accurate client presentation proposal and structured phase-wise delivery tasks.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {questions.map((q, idx) => (
                  <div key={idx} className="p-3.5 bg-paper-2/50 border border-hairline rounded-xl space-y-1.5">
                    <label className="block text-xs font-semibold text-ink leading-snug">{q}</label>
                    <Input
                      placeholder="Type answer or key requirement..."
                      value={answers[idx] || ""}
                      onChange={(e) => setAnswers({ ...answers, [idx]: e.target.value })}
                      className="bg-paper text-xs"
                    />
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 pt-3 border-t border-hairline">
                <Button type="button" variant="outline" onClick={() => setStep("input")} className="text-xs">
                  ← Back to Description
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  icon="sparkles"
                  loading={generatingPlan}
                  onClick={handleGeneratePlan}
                  className="font-bold px-5"
                >
                  {generatingPlan ? "Generating Proposal & Phases..." : "🚀 Generate Proposal & Phase Roadmap"}
                </Button>
              </div>
            </div>
          )}

          {/* STEP 3: Results (Client Proposal Presentation & Phase Roadmap) */}
          {step === "results" && (
            <div className="space-y-4">
              {stub && (
                <div className="p-2.5 bg-amber-soft/50 border border-amber/20 rounded-lg text-xs text-amber-ink">
                  ℹ️ AI key not configured — showing high-quality sample plan. Add a Gemini key in Settings for live customized AI.
                </div>
              )}

              {/* View Switcher Tabs */}
              <div className="flex items-center justify-between border-b border-hairline pb-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("proposal")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeTab === "proposal"
                        ? "bg-primary text-white shadow-xs"
                        : "bg-paper-2 text-ink-3 hover:text-ink"
                    }`}
                  >
                    📄 Client Presentation Proposal
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("tasks")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeTab === "tasks"
                        ? "bg-primary text-white shadow-xs"
                        : "bg-paper-2 text-ink-3 hover:text-ink"
                    }`}
                  >
                    📋 Phase Roadmap & Tasks ({rows.length})
                  </button>
                </div>

                {activeTab === "proposal" && (
                  <Button variant="outline" size="sm" icon="copy" onClick={handleCopyProposal} className="text-xs">
                    Copy Proposal Text
                  </Button>
                )}
              </div>

              {/* TAB 1: Client Proposal Presentation */}
              {activeTab === "proposal" && (
                <div className="p-4 bg-paper-2/40 border border-hairline rounded-xl max-h-[50vh] overflow-y-auto space-y-3 font-sans">
                  {clientProposal ? (
                    <div className="prose prose-sm max-w-none text-ink whitespace-pre-wrap leading-relaxed text-xs">
                      {clientProposal}
                    </div>
                  ) : (
                    <p className="text-xs text-ink-2 whitespace-pre-wrap leading-relaxed">{explanation}</p>
                  )}
                </div>
              )}

              {/* TAB 2: Phase-Divided Tasks & Team Allocation */}
              {activeTab === "tasks" && (
                <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
                  <div className="flex items-center justify-between text-xs text-ink-3">
                    <span>Tasks divided across <b>{groupedTasks.size} Delivery Phases</b></span>
                    <span>Assign tasks to team members before adding to roadmap</span>
                  </div>

                  {Array.from(groupedTasks.entries()).map(([phase, phaseTasks], pIdx) => (
                    <div key={pIdx} className="border border-hairline rounded-xl overflow-hidden bg-paper">
                      <div className="bg-paper-2/80 px-3.5 py-2 border-b border-hairline flex items-center justify-between">
                        <span className="font-bold text-xs text-primary uppercase tracking-wider">{phase}</span>
                        <Badge kind="info" size="sm">{phaseTasks.length} tasks</Badge>
                      </div>

                      <ul className="divide-y divide-hairline">
                        {phaseTasks.map((r, i) => {
                          const globalIdx = rows.findIndex((x) => x === r);
                          return (
                            <li key={i} className="p-2.5 flex items-center gap-3 hover:bg-paper-2/30 transition-colors">
                              <span className="flex-1 text-xs font-medium text-ink">{r.title}</span>
                              <Select
                                value={r.assigneeId}
                                onValueChange={(v) =>
                                  setRows((rs) => rs.map((x, j) => (j === globalIdx ? { ...x, assigneeId: v } : x)))
                                }
                              >
                                <SelectTrigger className="h-8 w-[10rem] text-xs">
                                  <SelectValue placeholder="Assign employee" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">Unassigned</SelectItem>
                                  {team.map((m) => (
                                    <SelectItem key={m.employee_id} value={m.employee_id}>
                                      👤 {m.employeeName}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <button
                                type="button"
                                aria-label="Remove task"
                                onClick={() => setRows((rs) => rs.filter((_, j) => j !== globalIdx))}
                                className="text-ink-3 hover:text-rose p-1 transition-colors"
                              >
                                <Icon name="x" size={14} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="p-4 border-t border-hairline bg-paper/95 flex items-center justify-between">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {step === "results" && (
            <Button
              type="button"
              variant="primary"
              icon="plus"
              loading={bulk.isPending}
              disabled={rows.length === 0}
              onClick={createAll}
              className="font-bold px-5 bg-primary text-white"
            >
              ⚡ Add {rows.length} Phase Tasks to Project Roadmap
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
