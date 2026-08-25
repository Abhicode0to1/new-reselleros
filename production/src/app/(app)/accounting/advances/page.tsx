/**
 * /accounting/advances — Employee Expense Advances & Petty Cash Management.
 *
 * Allows company owners/accountants to:
 * 1. Disburse advance money to employees for official expenses (Travel, Client Meetings, Maintenance).
 * 2. Record expenses incurred by employees against their advance balance (Hits P&L as Expense & reduces available advance).
 * 3. Track real-time remaining advance balance & settle completed advances.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FormField } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import {
  useEmployeeAdvances,
  useDisburseAdvance,
  useRecordAdvanceExpense,
  useSettleAdvance,
  ADVANCE_PAYMENT_METHODS,
  type EmployeeAdvance,
} from "@/lib/queries/advances";
import { useEmployees } from "@/lib/queries/payroll";
import { useBankAccounts } from "@/lib/queries/bank";
import { EXPENSE_CATEGORIES } from "@/lib/queries/expenses";
import { toast } from "sonner";

function todayISO() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export default function EmployeeAdvancesPage() {
  const { data: advances = [], isLoading } = useEmployeeAdvances();
  const [disburseOpen, setDisburseOpen] = React.useState(false);
  const [recordExpenseFor, setRecordExpenseFor] = React.useState<EmployeeAdvance | null>(null);
  const [settleFor, setSettleFor] = React.useState<EmployeeAdvance | null>(null);

  const activeAdvances = advances.filter((a) => a.status === "active");
  const settledAdvances = advances.filter((a) => a.status === "settled");

  const totalDisbursedActive = activeAdvances.reduce((sum, a) => sum + a.disbursed_amount, 0);
  const totalSpentActive = activeAdvances.reduce((sum, a) => sum + a.total_spent, 0);
  const totalOutstandingBalance = activeAdvances.reduce((sum, a) => sum + a.remaining_balance, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">HR &amp; Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Employee Expense Advances</h1>
          <p className="text-sm text-ink-3 mt-1">
            Manage advance money given to employees for company expenses + track expenses booked against advance balances.
          </p>
        </div>

        <Button variant="primary" icon="plus" onClick={() => setDisburseOpen(true)}>
          Give Advance to Employee
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 border-l-4 border-l-amber">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Advance Money in Hands of Employees</p>
          <p className="font-serif text-3xl text-amber-dark mt-1">{rupee(totalOutstandingBalance)}</p>
          <p className="text-xs text-ink-3 mt-1">{activeAdvances.length} active employee advances</p>
        </Card>

        <Card className="p-5 border-l-4 border-l-indigo">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total Disbursed Advances</p>
          <p className="font-serif text-3xl text-indigo mt-1">{rupee(totalDisbursedActive)}</p>
          <p className="text-xs text-ink-3 mt-1">Total cash/bank given for expenses</p>
        </Card>

        <Card className="p-5 border-l-4 border-l-emerald">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Booked P&amp;L Expenses</p>
          <p className="font-serif text-3xl text-emerald mt-1">{rupee(totalSpentActive)}</p>
          <p className="text-xs text-ink-3 mt-1">Expenses adjusted &amp; recorded in P&amp;L</p>
        </Card>
      </div>

      {/* Active Advances List */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-xl">Active Employee Advances</h2>
          <span className="text-xs text-ink-3 font-medium">{activeAdvances.length} active</span>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
          </div>
        ) : activeAdvances.length === 0 ? (
          <Card className="py-10 text-center">
            <EmptyState
              icon="wallet"
              title="No Active Employee Advances"
              body="When you give advance money to employees for travel, client meetings, or office expenses, click 'Give Advance to Employee' above."
            />
          </Card>
        ) : (
          <div className="space-y-4">
            {activeAdvances.map((adv) => (
              <Card key={adv.id} className="p-5 space-y-4 hover:shadow-md transition-all">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-hairline">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-lg text-ink">{adv.employee_name}</span>
                      <Badge kind="warning" size="sm">Active Advance</Badge>
                    </div>
                    <p className="text-xs text-ink-3">
                      Purpose: <strong className="text-ink-2">{adv.purpose || "Official Company Expenses"}</strong> · Disbursed on {formatDate(adv.disbursed_date, "short")} via {ADVANCE_PAYMENT_METHODS[adv.payment_method] || adv.payment_method}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="primary"
                      className="gap-1.5"
                      onClick={() => setRecordExpenseFor(adv)}
                    >
                      <Icon name="plus" size={14} />
                      Record Expense from Advance
                    </Button>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSettleFor(adv)}
                    >
                      Settle / Close Advance
                    </Button>
                  </div>
                </div>

                {/* Balance Progress Bar */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-paper-2/50 p-3 rounded-lg border border-hairline">
                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Disbursed Advance</p>
                    <p className="font-serif text-lg text-ink font-semibold">{rupee(adv.disbursed_amount)}</p>
                  </div>

                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Total Spent &amp; Booked in P&amp;L</p>
                    <p className="font-serif text-lg text-emerald font-semibold">{rupee(adv.total_spent)}</p>
                  </div>

                  <div>
                    <p className="text-3xs uppercase tracking-wider text-ink-3">Remaining Advance in Hand</p>
                    <p className="font-serif text-lg text-amber-dark font-bold">{rupee(adv.remaining_balance)}</p>
                  </div>
                </div>

                {/* Linked Expenses Breakdown */}
                {adv.linked_expenses.length > 0 && (
                  <div className="pt-2">
                    <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                      Expenses Claimed &amp; Adjusted ({adv.linked_expenses.length})
                    </p>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {adv.linked_expenses.map((exp) => (
                        <div key={exp.id} className="flex items-center justify-between p-2.5 bg-paper rounded border border-hairline text-xs">
                          <div className="space-y-0.5">
                            <span className="font-semibold text-ink">{exp.category}</span>
                            {exp.description && <p className="text-ink-3 text-2xs">{exp.description}</p>}
                            <span className="text-3xs text-ink-3">{formatDate(exp.expense_date, "short")} {exp.vendor_name ? `· Vendor: ${exp.vendor_name}` : ""}</span>
                          </div>

                          <div className="text-right">
                            <span className="font-bold text-ink">{rupee(exp.amount)}</span>
                            <p className="text-3xs text-emerald font-medium">✓ Adjusted vs Advance</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* History / Settled Advances */}
      {settledAdvances.length > 0 && (
        <div className="pt-6 border-t border-hairline space-y-3">
          <h2 className="font-serif text-lg text-ink-2">Completed / Settled Advances</h2>
          <div className="space-y-2">
            {settledAdvances.map((adv) => (
              <Card key={adv.id} className="p-4 flex items-center justify-between text-xs bg-paper-2/40">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-ink">{adv.employee_name}</span>
                    <Badge kind="success" size="sm">Settled</Badge>
                  </div>
                  <p className="text-ink-3 text-2xs mt-0.5">
                    Disbursed: {rupee(adv.disbursed_amount)} · Spent: {rupee(adv.total_spent)} · Disbursed on {formatDate(adv.disbursed_date, "short")}
                  </p>
                </div>

                <span className="font-mono text-ink-3 font-medium">Completed</span>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Disburse Advance Modal */}
      <DisburseAdvanceDialog open={disburseOpen} onOpenChange={setDisburseOpen} />

      {/* Record Expense Modal */}
      {recordExpenseFor && (
        <RecordAdvanceExpenseDialog
          advance={recordExpenseFor}
          open={!!recordExpenseFor}
          onOpenChange={(open) => !open && setRecordExpenseFor(null)}
        />
      )}

      {/* Settle Advance Modal */}
      {settleFor && (
        <SettleAdvanceDialog
          advance={settleFor}
          open={!!settleFor}
          onOpenChange={(open) => !open && setSettleFor(null)}
        />
      )}
    </div>
  );
}

/** Disburse Advance Modal */
function DisburseAdvanceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const disburse = useDisburseAdvance();
  const { data: employees = [] } = useEmployees();
  const { data: bankAccounts = [] } = useBankAccounts();

  const [selectedEmpId, setSelectedEmpId] = React.useState<string>("");
  const [customName, setCustomName] = React.useState<string>("");
  const [amount, setAmount] = React.useState<string>("");
  const [date, setDate] = React.useState<string>(todayISO());
  const [method, setMethod] = React.useState<string>("bank_transfer");
  const [bankId, setBankId] = React.useState<string>("");
  const [purpose, setPurpose] = React.useState<string>("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error("Valid advance amount daalo");
      return;
    }

    const empObj = employees.find((e) => e.id === selectedEmpId);
    const empName = empObj ? empObj.name : customName.trim();

    if (!empName) {
      toast.error("Employee select karo ya naam enter karo");
      return;
    }

    disburse.mutate(
      {
        employee_id: selectedEmpId || null,
        employee_name: empName,
        disbursed_amount: parsedAmount,
        disbursed_date: date,
        payment_method: method,
        bank_account_id: bankId || null,
        purpose: purpose.trim() || null,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setAmount("");
          setPurpose("");
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disburse Employee Expense Advance</DialogTitle>
          <DialogDescription>
            Give advance money to an employee for official company expenses (Travel, Client Visit, Petty Cash).
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <FormField label="Employee">
            <Select value={selectedEmpId} onValueChange={(val) => { setSelectedEmpId(val); setCustomName(""); }}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select Employee..." />
              </SelectTrigger>
              <SelectContent>
                {employees.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {!selectedEmpId && (
            <FormField label="Or Enter Employee Name">
              <Input
                placeholder="e.g. Pawan Kumar"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
            </FormField>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Advance Amount (₹)" required>
              <Input
                type="number"
                placeholder="5000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </FormField>

            <FormField label="Disbursed Date">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Payment Method">
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(ADVANCE_PAYMENT_METHODS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Company Bank / Cash">
              <Select value={bankId} onValueChange={setBankId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select Bank..." />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name} ({rupee(b.current_balance ?? b.opening_balance)})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="Purpose / Purpose Notes">
            <Input
              placeholder="e.g. Client visit travel & lodging expenses"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </FormField>

          <DialogFooter className="pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={disburse.isPending}>
              Disburse Advance
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Record Expense from Advance Modal */
function RecordAdvanceExpenseDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const record = useRecordAdvanceExpense();

  const [category, setCategory] = React.useState<string>("Travel & Local Conveyance");
  const [amount, setAmount] = React.useState<string>("");
  const [date, setDate] = React.useState<string>(todayISO());
  const [vendor, setVendor] = React.useState<string>("");
  const [description, setDescription] = React.useState<string>("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error("Valid expense amount daalo");
      return;
    }

    record.mutate(
      {
        advance_id: advance.id,
        category,
        amount: parsedAmount,
        expense_date: date,
        vendor_name: vendor.trim() || null,
        description: description.trim() || null,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setAmount("");
          setDescription("");
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record Expense from Advance</DialogTitle>
          <DialogDescription>
            Record an official expense incurred by <strong>{advance.employee_name}</strong> out of their advance balance. Hits P&amp;L as an expense and reduces available advance.
          </DialogDescription>
        </DialogHeader>

        <div className="p-3 bg-amber-soft/30 border border-amber/30 rounded-lg text-xs space-y-1 my-1">
          <p className="font-semibold text-amber-dark">Advance Balance Available: {rupee(advance.remaining_balance)}</p>
          <p className="text-ink-3">Total Disbursed: {rupee(advance.disbursed_amount)} · Total Spent: {rupee(advance.total_spent)}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <FormField label="Expense Category" required>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Spent Amount (₹)" required>
              <Input
                type="number"
                placeholder="1200"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </FormField>

            <FormField label="Bill Date">
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          <FormField label="Vendor / Paid To (Optional)">
            <Input
              placeholder="e.g. Uber / Indian Oil / Restaurant"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </FormField>

          <FormField label="Description / Bill Details">
            <Input
              placeholder="e.g. Travel fare for client site visit"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>

          <DialogFooter className="pt-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={record.isPending}>
              Record &amp; Adjust Expense
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Settle Advance Modal */
function SettleAdvanceDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const settle = useSettleAdvance();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settle &amp; Close Employee Advance</DialogTitle>
          <DialogDescription>
            Settle advance for <strong>{advance.employee_name}</strong> once all expenses have been recorded or remaining cash has been returned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-3 text-xs">
          <div className="p-3 bg-paper-2 rounded-lg border border-hairline space-y-1">
            <div className="flex justify-between"><span>Disbursed Advance:</span><span className="font-bold">{rupee(advance.disbursed_amount)}</span></div>
            <div className="flex justify-between"><span>Expenses Booked:</span><span className="font-bold text-emerald">{rupee(advance.total_spent)}</span></div>
            <div className="flex justify-between border-t border-hairline pt-1 font-semibold text-amber-dark">
              <span>Remaining Advance Balance:</span>
              <span>{rupee(advance.remaining_balance)}</span>
            </div>
          </div>

          {advance.remaining_balance > 0 ? (
            <p className="text-ink-2 bg-amber-soft/20 p-2.5 rounded border border-amber/30">
              💡 <strong>Employee has {rupee(advance.remaining_balance)} cash remaining.</strong> Marking this settled assumes the remaining cash has been returned to petty cash or company bank.
            </p>
          ) : (
            <p className="text-emerald font-medium">
              ✓ All advance money has been 100% accounted for with booked expenses.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={settle.isPending}
            onClick={() => {
              settle.mutate(advance.id, {
                onSuccess: () => onOpenChange(false),
              });
            }}
          >
            Confirm &amp; Settle Advance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
