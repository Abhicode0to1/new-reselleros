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
import { useConfirm } from "@/components/providers/confirm-provider";
import { formatDate } from "@/lib/utils";
import {
  useProjectTasks, useCreateProjectTask, useUpdateProjectTask, useDeleteProjectTask,
} from "@/lib/queries/projects";
import type { ProjectTaskStatus } from "@/lib/supabase/database.types";

type TeamMember = { employee_id: string; employeeName: string };

const STATUS_META: Record<ProjectTaskStatus, { label: string; kind: "muted" | "warning" | "success" }> = {
  todo:        { label: "To do",       kind: "muted" },
  in_progress: { label: "In progress", kind: "warning" },
  done:        { label: "Done",        kind: "success" },
};
const STATUS_ORDER: ProjectTaskStatus[] = ["todo", "in_progress", "done"];

export function ProjectTasks({ projectId, team }: { projectId: string; team: TeamMember[] }) {
  const q = useProjectTasks(projectId);
  const create = useCreateProjectTask();
  const update = useUpdateProjectTask();
  const del = useDeleteProjectTask();
  const confirm = useConfirm();

  const [title, setTitle] = React.useState("");
  const [assignee, setAssignee] = React.useState<string>("none");
  const [due, setDue] = React.useState("");

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
    </Card>
  );
}
