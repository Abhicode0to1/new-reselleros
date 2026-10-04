/**
 * Apprentice Academy (R-149) — data hooks for the staff side (/academy) and the apprentice
 * side (/learn). Who sees what is decided by RLS (migration 20261004150000): an apprentice
 * gets only their own rows; a mentor only their apprentices; owner / manager everything.
 * Apprentices change tasks only through the start / submit RPCs; mentors review through
 * academy_review_task.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.generated";

type T = Database["public"]["Tables"];
export type Apprentice = T["academy_apprentices"]["Row"];
export type AcademyProgram = T["academy_programs"]["Row"];
export type AcademyModule = T["academy_modules"]["Row"];
export type AcademyTask = T["academy_tasks"]["Row"];
export type AcademySubmission = T["academy_submissions"]["Row"];

export const TASK_STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  submitted: "Submitted — under review",
  rework: "Rework required",
  completed: "Completed",
};
export const TASK_KIND_LABEL: Record<string, string> = {
  daily: "Daily task", weekly: "Weekly task", assignment: "Assignment",
  learning: "Learning task", project: "Project task", practical: "Practical task",
};
export const APPRENTICE_STATUS_LABEL: Record<string, string> = {
  active: "Active", on_leave: "On leave", completed: "Completed", dropped: "Dropped",
};

const KEY = ["academy"] as const;
function refresh(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
}
async function tenantId(): Promise<string> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("users").select("tenant_id").eq("id", auth.user?.id ?? "").single();
  if (error || !data) throw new Error("Not signed in to a company.");
  return data.tenant_id as string;
}

/* ── reads ─────────────────────────────────────────────────────────────── */
export function useApprentices() {
  return useQuery({
    queryKey: [...KEY, "apprentices"],
    queryFn: async () => {
      const { data, error } = await createClient().from("academy_apprentices").select("*").order("code");
      if (error) throw error;
      return data as Apprentice[];
    },
  });
}

export function usePrograms() {
  return useQuery({
    queryKey: [...KEY, "programs"],
    queryFn: async () => {
      const supabase = createClient();
      const [{ data: programs, error: e1 }, { data: modules, error: e2 }] = await Promise.all([
        supabase.from("academy_programs").select("*").order("created_at"),
        supabase.from("academy_modules").select("*").order("position"),
      ]);
      if (e1 || e2) throw e1 ?? e2;
      return { programs: (programs ?? []) as AcademyProgram[], modules: (modules ?? []) as AcademyModule[] };
    },
  });
}

/** All tasks the viewer may see (staff: their apprentices'; apprentice: own). */
export function useAcademyTasks(apprenticeId?: string) {
  return useQuery({
    queryKey: [...KEY, "tasks", apprenticeId ?? "all"],
    queryFn: async () => {
      let q = createClient().from("academy_tasks").select("*").order("due_date", { ascending: true, nullsFirst: false }).order("created_at");
      if (apprenticeId) q = q.eq("apprentice_id", apprenticeId);
      const { data, error } = await q;
      if (error) throw error;
      return data as AcademyTask[];
    },
  });
}

export function useSubmissions(taskIds: string[]) {
  return useQuery({
    queryKey: [...KEY, "submissions", [...taskIds].sort().join(",")],
    enabled: taskIds.length > 0,
    queryFn: async () => {
      const { data, error } = await createClient().from("academy_submissions").select("*").in("task_id", taskIds).order("attempt", { ascending: false });
      if (error) throw error;
      return data as AcademySubmission[];
    },
  });
}

/** The signed-in apprentice's own profile (apprentice side). */
export function useMyApprenticeProfile() {
  return useQuery({
    queryKey: [...KEY, "me"],
    queryFn: async () => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase.from("academy_apprentices").select("*").eq("user_id", auth.user?.id ?? "").maybeSingle();
      if (error) throw error;
      return data as Apprentice | null;
    },
  });
}

/* ── staff writes ──────────────────────────────────────────────────────── */
export type ApprenticeInput = Partial<Omit<Apprentice, "id" | "tenant_id" | "code" | "user_id" | "created_at" | "updated_at">> & { full_name: string };

export function useSaveApprentice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: ApprenticeInput & { id?: string }) => {
      const supabase = createClient();
      if (id) {
        const { error } = await supabase.from("academy_apprentices").update(input).eq("id", id);
        if (error) throw error;
        return id;
      }
      const { data, error } = await supabase.from("academy_apprentices").insert({ ...input, tenant_id: await tenantId() }).select("id").single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: () => { refresh(qc); toast.success("Apprentice saved"); },
    onError: (e) => toast.error("Could not save the apprentice", { description: friendly(e) }),
  });
}

export type TaskInput = Pick<AcademyTask, "apprentice_id" | "title"> & Partial<Pick<AcademyTask,
  "description" | "instructions" | "kind" | "difficulty" | "est_minutes" | "due_date" | "priority" | "reference_url" | "submission_type" | "module_id">>;

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskInput) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase.from("academy_tasks").insert({ ...input, tenant_id: await tenantId(), created_by: auth.user?.id ?? null });
      if (error) throw error;
    },
    onSuccess: () => { refresh(qc); toast.success("Task assigned"); },
    onError: (e) => toast.error("Could not assign the task", { description: friendly(e) }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await createClient().from("academy_tasks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { refresh(qc); toast.success("Task removed"); },
    onError: (e) => toast.error("Could not remove the task", { description: friendly(e) }),
  });
}

export function useReviewTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { task_id: string; result: "approved" | "rework"; feedback: string; marks: number | null }) => {
      const { error } = await createClient().rpc("academy_review_task", {
        p_task_id: input.task_id, p_result: input.result, p_feedback: input.feedback, p_marks: input.marks,
      });
      if (error) throw error;
    },
    onSuccess: (_d, v) => { refresh(qc); toast.success(v.result === "approved" ? "Approved — task completed" : "Sent back for rework"); },
    onError: (e) => toast.error("Could not save the review", { description: friendly(e) }),
  });
}

export function useLoadDefaultProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await createClient().rpc("academy_load_default_program");
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => { refresh(qc); toast.success("Curriculum ready", { description: "AI-Assisted Software Development — 7 modules." }); },
    onError: (e) => toast.error("Could not load the curriculum", { description: friendly(e) }),
  });
}

export function useCreateApprenticeLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (apprenticeId: string) => {
      const res = await fetch(`/api/academy/apprentices/${apprenticeId}/login`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; emailSent?: boolean };
      if (!res.ok) throw new Error(json.error || "Could not create the login.");
      return json;
    },
    onSuccess: (r) => {
      refresh(qc);
      toast.success("Login created", {
        description: r.emailSent ? "We emailed them how to set a password." : "Email could not be sent — ask them to use Forgot password on the login page.",
      });
    },
    onError: (e) => toast.error("Could not create the login", { description: friendly(e) }),
  });
}

/* ── apprentice writes ─────────────────────────────────────────────────── */
export function useStartTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string) => {
      const { error } = await createClient().rpc("academy_start_task", { p_task_id: taskId });
      if (error) throw error;
    },
    onSuccess: () => refresh(qc),
    onError: (e) => toast.error("Could not start the task", { description: friendly(e) }),
  });
}

export function useSubmitTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { task_id: string; note: string; link: string; github: string }) => {
      const { error } = await createClient().rpc("academy_submit_task", {
        p_task_id: input.task_id, p_note: input.note, p_link: input.link, p_github: input.github,
      });
      if (error) throw error;
    },
    onSuccess: () => { refresh(qc); toast.success("Submitted", { description: "Your mentor will review it." }); },
    onError: (e) => toast.error("Could not submit", { description: friendly(e) }),
  });
}

/* Database messages are written for people; Postgres codes are not. */
function friendly(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/academy_apprentices_email_unique|duplicate key.*email/i.test(msg)) return "Another apprentice already has this email.";
  if (/row-level security|permission denied/i.test(msg)) return "You do not have access to do this.";
  return msg;
}
