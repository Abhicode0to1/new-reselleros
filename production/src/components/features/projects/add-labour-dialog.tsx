/**
 * AddLabourDialog — attach an employee to a project as a labour cost.
 *
 * Cost = employee monthly_gross × percent% × months. This is a MANAGEMENT overlay
 * (project_labour table) — it never writes to `expenses`, so payroll salaries are
 * never double-counted in the company P&L.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useEmployees } from "@/lib/queries/payroll";
import { useSaveProjectLabour, type ProjectLabourLine } from "@/lib/queries/projects";
import { rupee } from "@/lib/utils";

export function AddLabourDialog({
  open, onClose, projectId, existing, defaultMonths = 1,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Present = edit an existing allocation. */
  existing?: ProjectLabourLine | null;
  /** Auto-suggested months from the project's start→target duration. */
  defaultMonths?: number;
}) {
  const { data: employees = [] } = useEmployees();
  const save = useSaveProjectLabour();

  const [employeeId, setEmployeeId] = React.useState("");
  const [percent, setPercent] = React.useState("100");
  const [months, setMonths] = React.useState("1");
  const [note, setNote] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setEmployeeId(existing?.employee_id ?? "");
    setPercent(existing ? String(existing.percent) : "100");
    // New allocation → default months to the project duration (auto). Editing →
    // keep the saved value.
    setMonths(existing ? String(existing.months) : String(defaultMonths || 1));
    setNote(existing?.note ?? "");
  }, [open, existing, defaultMonths]);

  const emp = employees.find((e) => e.id === employeeId);
  const pctN = Number(percent) || 0;
  const monN = Number(months) || 0;
  const cost = emp ? Math.round((emp.monthly_gross ?? 0) * (pctN / 100) * monN) : 0;
  const valid = !!employeeId && pctN > 0 && pctN <= 100 && monN > 0;

  async function handleSave() {
    if (!valid) return;
    await save.mutateAsync({
      id: existing?.id,
      projectId,
      employeeId,
      percent: pctN,
      months: monN,
      note: note.trim() || null,
    }).catch(() => {});
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit labour" : "Add labour"}</DialogTitle>
          <DialogDescription>
            Attach an employee&apos;s time to this project. Their salary share counts as a project cost — it does NOT double-count in your overall P&amp;L (payroll books it once).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Employee" htmlFor="lab-emp">
            <Select value={employeeId} onValueChange={setEmployeeId} disabled={!!existing}>
              <SelectTrigger id="lab-emp"><SelectValue placeholder="Pick an employee" /></SelectTrigger>
              <SelectContent>
                {employees.filter((e) => e.is_active || e.id === employeeId).map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}{e.designation ? ` · ${e.designation}` : ""} — {rupee(e.monthly_gross ?? 0)}/mo
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Time on project (%)"><Input type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} /></FormField>
            <FormField label="Months"><Input type="number" min={0.5} step={0.5} value={months} onChange={(e) => setMonths(e.target.value)} /></FormField>
          </div>

          <FormField label="Note (optional)"><Input placeholder="e.g. backend development" value={note} onChange={(e) => setNote(e.target.value)} /></FormField>

          {emp && (
            <div className="rounded-lg border border-hairline bg-paper-2/50 px-3 py-2.5 text-sm">
              <span className="text-ink-3">Labour cost: </span>
              <span className="font-semibold text-ink">{rupee(cost)}</span>
              <span className="text-[11px] text-ink-3"> = {rupee(emp.monthly_gross ?? 0)}/mo × {pctN}% × {monN} month{monN === 1 ? "" : "s"}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!valid} loading={save.isPending}>
            {existing ? "Save" : "Add labour"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
