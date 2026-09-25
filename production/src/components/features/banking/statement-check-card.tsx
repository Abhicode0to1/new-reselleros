/**
 * StatementCheckCard — does "Balance in bank" agree with the statement's own balance?
 *
 * Shown on the bank account page under the balance tiles. Quiet (one line) when the
 * two agree; when they do not, it says by how much and why, in the two ways it can be
 * wrong: the opening balance, and lines missing between two dates (lib/banking/
 * statement-check.ts). Each reason carries its own amount, and they add up to the total.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import type { StatementCheck } from "@/lib/banking/statement-check";

interface Props {
  check: StatementCheck;
  openingBalance: number;
  openingDate: string;
  onImport: () => void;
}

export function StatementCheckCard({ check, openingBalance, openingDate, onImport }: Props) {
  const off = Math.abs(check.difference) > 1;

  if (!off) {
    return (
      <p className="-mt-3 mb-5 text-2xs text-emerald flex items-center gap-1.5">
        <Icon name="check_circle" size={13} />
        Matches the bank statement&apos;s own balance — {rupee(check.statementBalance)} on {formatDate(check.statementDate)}.
      </p>
    );
  }

  const openingOff = Math.abs(check.openingDifference) > 1;

  return (
    <Card className="mb-6 p-4 border-rose/40 bg-rose-soft/20" role="alert">
      <div className="flex items-start gap-2.5">
        <Icon name="alert" size={16} className="text-rose shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink">
            The bank statement says <b>{rupee(check.statementBalance)}</b> on {formatDate(check.statementDate)}, but this page
            shows <b>{rupee(check.appBalance)}</b> — <b className="text-rose">{rupee(Math.abs(check.difference))}</b> apart.
          </p>
          <p className="text-2xs text-ink-3 mt-0.5">
            Worked out from the running balance printed on every imported line. Why:
          </p>

          <ul className="mt-2 space-y-1.5 text-xs text-ink-2">
            {openingOff && (
              <li className="flex items-start gap-2">
                <span className="text-rose font-semibold tabular-nums shrink-0 w-24 text-right">
                  {check.openingDifference < 0 ? "−" : "+"}{rupee(Math.abs(check.openingDifference))}
                </span>
                <span>
                  <b>Opening balance.</b> It is {rupee(openingBalance)} as of {formatDate(openingDate)}, but the statement shows{" "}
                  <b>{rupee(check.impliedOpening)}</b> in the account just before its first line ({formatDate(check.firstLineDate)}).
                </span>
              </li>
            )}
            {check.gaps.map((g) => (
              <li key={`${g.after}-${g.by}`} className="flex items-start gap-2">
                <span className="text-rose font-semibold tabular-nums shrink-0 w-24 text-right">
                  {g.amount > 0 ? "+" : "−"}{rupee(Math.abs(g.amount))}
                </span>
                <span>
                  <b>Lines missing between {formatDate(g.after)} and {formatDate(g.by)}.</b>{" "}
                  {g.amount > 0
                    ? `About ${rupee(g.amount)} left the bank in this period with no line for it here.`
                    : `About ${rupee(-g.amount)} came into the bank in this period with no line for it here.`}
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-2xs text-ink-2 leading-relaxed">
            <b>Fix:</b> download the full statement from the bank for the whole period as CSV/Excel (not
            &quot;Recent transactions&quot; — that shows only the last 20), then{" "}
            <button type="button" onClick={onImport} className="text-amber-ink font-medium underline hover:no-underline">
              import it
            </button>{" "}
            with <b>Set opening balance from this statement</b> ticked. Lines already here are skipped; only the missing ones are added.
          </p>
        </div>
      </div>
    </Card>
  );
}
