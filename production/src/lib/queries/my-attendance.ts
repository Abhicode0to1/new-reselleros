/**
 * Self check-in attendance for logged-in app users (migration 0216).
 *
 * The login IS the identity proof, so — unlike the shared kiosk — no PIN or
 * selfie is needed. A user marks their OWN attendance via mark_self_attendance
 * (toggles check-in → check-out for IST today). If the user isn't yet linked to
 * an employee row, set_my_employee links them one time.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export type MyAttendanceToday =
  | { linked: false }
  | {
      linked: true;
      employee_name: string;
      work_date: string;
      check_in: string | null;
      check_out: string | null;
    };

export function useMyAttendanceToday() {
  return useQuery({
    queryKey: ["my-attendance-today"],
    queryFn: async (): Promise<MyAttendanceToday> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("my_attendance_today");
      if (error) throw error;
      return data as unknown as MyAttendanceToday;
    },
  });
}

export function useMarkSelfAttendance() {
  const qc = useQueryClient();
  return useMutation({
    // Goes through the API route so the selfie + presence code + geo are handled
    // and enforced server-side (client-only checks would be bypassable).
    mutationFn: async (input?: {
      photo?: string | null; code?: string; lat?: number | null; lng?: number | null; accuracy?: number | null;
    }): Promise<string> => {
      const res = await fetch("/api/attendance/self", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photo: input?.photo ?? null,
          code: input?.code ?? "",
          lat: input?.lat ?? null,
          lng: input?.lng ?? null,
          accuracy: input?.accuracy ?? null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Attendance mark nahi hui");
      return json.action as string;
    },
    onSuccess: (result) => {
      if (result === "checked_in") toast.success("Check-in ho gaya ✅");
      else if (result === "checked_out") toast.success("Check-out ho gaya 👋");
      else toast.info("Aaj ki attendance already complete hai.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Attendance mark nahi hui");
    },
  });
}

export function useSetMyEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (employeeId: string): Promise<void> => {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_my_employee", { p_employee_id: employeeId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Aapka employee profile link ho gaya.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Link nahi ho paya");
    },
  });
}
