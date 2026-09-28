/**
 * Books lock — the period-close control (migration 20260927120000).
 *
 * The owner sets a date; every money row dated on or before it (expenses, bank lines,
 * salaries, tax payments, invoices, payments, notes…) can no longer be added, edited or
 * deleted from the app. Set it the day a GSTR-3B / TDS return is filed, so the books stay
 * equal to what was filed. Anyone else on the team sees the date, read-only.
 */
"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/providers/confirm-provider";
import { createClient } from "@/lib/supabase/client";
import { useUpdateTenant } from "@/lib/queries/tenant";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { formatDate } from "@/lib/utils";

const KEY = ["books-lock"] as const;

export function useBooksLock() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<string | null> => {
      /* RLS returns only this company's row. */
      const { data, error } = await createClient().from("tenants").select("books_locked_until").limit(1).maybeSingle();
      if (error) throw error;
      return (data as { books_locked_until?: string | null } | null)?.books_locked_until ?? null;
    },
    staleTime: 60_000,
  });
}

export function BooksLockCard() {
  const lock = useBooksLock();
  const update = useUpdateTenant();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";
  const [draft, setDraft] = React.useState<string>("");
  React.useEffect(() => { if (lock.data !== undefined) setDraft(lock.data ?? ""); }, [lock.data]);

  const today = new Date().toISOString().slice(0, 10);
  const current = lock.data ?? null;

  async function save(next: string | null) {
    const ok = await confirm({
      title: next ? `Books ${formatDate(next)} tak lock karein?` : "Lock hatayein?",
      body: next
        ? "Us tareekh tak ki koi bhi entry (kharcha, bank line, salary, tax, invoice, payment) app se badal ya mit nahi sakegi. Return file karne ke baad yahi karna chahiye."
        : "Purani entries phir se badali ja sakengi. File ho chuke mahine ki entry badli to return aur books alag ho jaayenge.",
      confirmLabel: next ? "Haan, lock karo" : "Haan, kholo", cancelLabel: "Nahi",
    });
    if (!ok) return;
    await update.mutateAsync({ books_locked_until: next });
    qc.invalidateQueries({ queryKey: KEY });
  }

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink flex items-center gap-1.5">
            <Icon name="lock" size={14} className={current ? "text-emerald" : "text-ink-3"} />
            Books lock (period close)
          </p>
          <p className="text-xs text-ink-2 mt-0.5">
            {lock.isLoading ? "…" : current
              ? <>Books <b>{formatDate(current)}</b> tak lock hain — us tareekh tak ki entry app se nahi badal sakti.</>
              : <>Abhi koi lock nahi. GSTR-3B / TDS return file karne ke baad us mahine ki aakhri tareekh tak lock karo, taaki books aur return ek jaise rahein.</>}
          </p>
        </div>
        {isOwner ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Input type="date" value={draft} max={today} onChange={(e) => setDraft(e.target.value)} className="w-[170px]" aria-label="Lock till" />
            <Button size="sm" disabled={!draft || draft === (current ?? "") || update.isPending} onClick={() => save(draft)}>Lock karo</Button>
            {current && <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => save(null)}>Lock hatao</Button>}
          </div>
        ) : (
          <span className="text-xs text-ink-3">Sirf owner badal sakta hai</span>
        )}
      </div>
    </Card>
  );
}
