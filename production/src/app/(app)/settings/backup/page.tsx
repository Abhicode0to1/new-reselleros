/**
 * Backup — owner takes a downloadable snapshot of their tenant's data. Safety
 * net before experiments / big changes (the free Supabase plan has no automatic
 * DB backups). Snapshots are tenant-scoped via SECURITY DEFINER RPCs.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { useConfirm } from "@/components/providers/confirm-provider";
import { toast } from "sonner";
import { useBackups, useCreateBackup, useDeleteBackup, downloadBackup } from "@/lib/queries/backups";

function humanSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function BackupPage() {
  const q = useBackups();
  const create = useCreateBackup();
  const del = useDeleteBackup();
  const confirm = useConfirm();
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);

  const rows = q.data ?? [];

  async function takeBackup() {
    try {
      const res = await create.mutateAsync(undefined);
      // Immediately hand the owner a downloaded copy of the fresh snapshot.
      setDownloadingId(res.id);
      await downloadBackup(res.id, res.created_at);
      toast.success(`Backup ban gaya — ${res.table_count} tables, ${humanSize(res.bytes)}. Copy download ho gayi.`);
    } catch {
      /* create surfaces its own error toast */
    } finally {
      setDownloadingId(null);
    }
  }

  async function onDownload(id: string, createdAt: string) {
    setDownloadingId(id);
    try { await downloadBackup(id, createdAt); }
    finally { setDownloadingId(null); }
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Settings</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Backup</h1>
          <p className="text-sm text-ink-2 mt-1 max-w-2xl">
            Apne poore business data ka ek copy le lo — customers, leads, quotes, invoices, payments,
            expenses, subscriptions, sab kuch. Kisi bhi bade change ya experiment se pehle ek backup
            le lena safe rehta hai.
          </p>
        </div>
        <Button variant="primary" icon="download" loading={create.isPending || downloadingId != null} onClick={takeBackup} className="shrink-0">
          Take backup now
        </Button>
      </div>

      {/* What this does + honest note */}
      <Card className="p-4 mb-4 bg-paper-2/40">
        <div className="flex items-start gap-2 text-[12px] text-ink-2">
          <Icon name="info" size={14} className="text-indigo mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p><b>Backup lene par:</b> tumhare tenant ka saara data ek JSON file me download ho jaata hai (tumhare computer par). App ke andar bhi last 20 backups save rehte hain — jab chaaho dobara download kar lo.</p>
            <p className="text-ink-3">Note: ye tumhare apne data ka copy hai (kisi aur tenant ka nahi). Restore ke liye ye file surakshit rakho — zarurat padne par isi se data wapas laaya ja sakta hai.</p>
          </div>
        </div>
      </Card>

      {q.isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="download" title="No backups yet"
            body="Take your first backup — it downloads a copy of all your data and keeps one inside the app too."
            action={<Button variant="primary" icon="download" loading={create.isPending} onClick={takeBackup}>Take backup now</Button>} />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((b) => (
            <li key={b.id}>
              <Card className="p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0 flex items-center gap-3">
                  <span className="grid place-items-center h-9 w-9 rounded-lg bg-emerald/10 text-emerald shrink-0">
                    <Icon name="check_circle" size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-ink truncate">{b.label || "Backup"}</div>
                    <div className="text-[11px] text-ink-3">{whenLabel(b.created_at)} · {b.table_count} tables · {humanSize(b.bytes)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="default" className="h-8 px-3 text-[12px]" icon="download"
                    loading={downloadingId === b.id} onClick={() => onDownload(b.id, b.created_at)}>
                    Download
                  </Button>
                  <Button variant="ghost" className="h-8 px-2 text-[12px]"
                    onClick={async () => { if (await confirm({ title: "Delete this backup?", body: "Sirf ye stored copy hategi. Pehle download ki hui file tumhare paas rahegi.", danger: true, confirmLabel: "Delete" })) del.mutate(b.id); }}>
                    Delete
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
