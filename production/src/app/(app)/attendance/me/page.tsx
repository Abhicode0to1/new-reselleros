/**
 * My Attendance — self check-in for logged-in app users (migration 0216).
 *
 * Unlike the shared kiosk (PIN + selfie), the login itself is the identity
 * proof, so this is a single big Check In / Check Out button. If the user isn't
 * yet linked to an employee record, they pick themselves once.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useEmployees } from "@/lib/queries/payroll";
import {
  useMyAttendanceToday,
  useMarkSelfAttendance,
  useSetMyEmployee,
} from "@/lib/queries/my-attendance";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export default function MyAttendancePage() {
  const meQ = useMyAttendanceToday();
  const mark = useMarkSelfAttendance();

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[560px] mx-auto">
      <div className="mb-6 text-center">
        <p className="text-[11px] uppercase tracking-wider text-ink-3">Payroll</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight mt-1">My Attendance</h1>
        <p className="text-sm text-ink-3 mt-1">{todayLabel()}</p>
      </div>

      {meQ.isLoading ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : meQ.error ? (
        <Card className="p-6 text-center text-sm text-rose">
          Attendance load nahi ho payi. Page refresh karke dobara try karo.
        </Card>
      ) : meQ.data && !meQ.data.linked ? (
        <LinkEmployeeCard />
      ) : meQ.data && meQ.data.linked ? (
        <CheckInCard
          name={meQ.data.employee_name}
          checkIn={meQ.data.check_in}
          checkOut={meQ.data.check_out}
          onMark={() => mark.mutate()}
          marking={mark.isPending}
        />
      ) : null}
    </div>
  );
}

function CheckInCard({
  name,
  checkIn,
  checkOut,
  onMark,
  marking,
}: {
  name: string;
  checkIn: string | null;
  checkOut: string | null;
  onMark: () => void;
  marking: boolean;
}) {
  const state: "out" | "in" | "done" = !checkIn ? "out" : !checkOut ? "in" : "done";

  return (
    <Card className="p-6 md:p-8 text-center">
      <p className="text-sm text-ink-3">Namaste</p>
      <p className="font-serif text-2xl mt-0.5">{name}</p>

      <div className="mt-6 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-hairline p-4">
          <p className="text-[11px] uppercase tracking-wider text-ink-3">Check-in</p>
          <p className={cn("font-serif text-2xl mt-1 tabular-nums", checkIn ? "text-emerald" : "text-ink-3")}>
            {fmtTime(checkIn)}
          </p>
        </div>
        <div className="rounded-lg border border-hairline p-4">
          <p className="text-[11px] uppercase tracking-wider text-ink-3">Check-out</p>
          <p className={cn("font-serif text-2xl mt-1 tabular-nums", checkOut ? "text-indigo" : "text-ink-3")}>
            {fmtTime(checkOut)}
          </p>
        </div>
      </div>

      <div className="mt-6">
        {state === "done" ? (
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-soft px-4 py-2 text-sm text-emerald">
            <Icon name="check_circle" className="h-4 w-4" />
            Aaj ki attendance complete hai
          </div>
        ) : (
          <Button
            size="lg"
            className="w-full h-14 text-base"
            onClick={onMark}
            disabled={marking}
          >
            <Icon name={state === "out" ? "check" : "logout"} className="h-5 w-5 mr-2" />
            {marking ? "…" : state === "out" ? "Check In" : "Check Out"}
          </Button>
        )}
      </div>

      <p className="text-[11px] text-ink-3 mt-4">
        Aap logged in ho — isliye PIN ya selfie ki zaroorat nahi.
      </p>
    </Card>
  );
}

function LinkEmployeeCard() {
  const empQ = useEmployees();
  const link = useSetMyEmployee();
  const [selected, setSelected] = React.useState<string>("");

  const employees = (empQ.data ?? []).filter((e) => e.is_active);

  return (
    <Card className="p-6 md:p-8">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
          <Icon name="user" className="h-6 w-6 text-amber-ink" />
        </div>
        <h2 className="font-serif text-xl">Apna naam select karo</h2>
        <p className="text-sm text-ink-3 mt-1">
          Attendance mark karne se pehle, ek baar apne employee record se link karo.
        </p>
      </div>

      {empQ.isLoading ? (
        <Skeleton className="h-10 w-full mt-6" />
      ) : employees.length === 0 ? (
        <p className="mt-6 text-center text-sm text-ink-3">
          Koi active employee record nahi mila. Owner se kaho ki Payroll me aapko employee ke roop me add kare.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger>
              <SelectValue placeholder="Employee choose karo" />
            </SelectTrigger>
            <SelectContent>
              {employees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="w-full"
            disabled={!selected || link.isPending}
            onClick={() => link.mutate(selected)}
          >
            {link.isPending ? "Link ho raha hai…" : "Link & continue"}
          </Button>
        </div>
      )}
    </Card>
  );
}
