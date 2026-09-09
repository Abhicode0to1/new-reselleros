"use client";

/**
 * The DNS zone editor.
 *
 * ─── WHAT IT REFUSES TO PRETEND ──────────────────────────────────────────────
 * Every button here changes a real zone at ResellerClub, and the API it calls
 * writes upstream FIRST and mirrors second. So this component never shows an
 * optimistic row: a record appears in the table only after the server has said
 * the registrar accepted it. An optimistic DNS editor would show the customer's
 * mail record sitting there while mail bounced, which is the one failure a DNS
 * screen must not have.
 *
 * The same reasoning drives the two warnings it surfaces rather than swallows:
 *
 *   · `warning` on a write means the change IS live upstream and our copy did
 *     not catch it. The text says not to retry, because retrying files it twice.
 *   · `deletes_withheld` on a sync means the read was incomplete, so rows that
 *     look stale were deliberately kept. A sync that quietly declines to delete
 *     looks broken, so it says so.
 *
 * ─── TTL ─────────────────────────────────────────────────────────────────────
 * ResellerClub silently raises anything below 7200, so the server returns
 * `ttl_used` and this shows it when it differs from what was asked. A form that
 * accepts 300 and displays 300 while the zone serves 7200 is lying politely.
 */

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

const TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SRV"] as const;
type RecordType = (typeof TYPES)[number];

export interface DnsRecordView {
  id: string;
  record_type: string;
  host: string;
  value: string;
  ttl: number;
  priority: number | null;
  provider_record_id: string | null;
}

/** Types RC requires extra fields for. Mirrored from lib/resellerclub/dns.ts,
 *  which refuses rather than defaulting them — see its header on why. */
const NEEDS_PRIORITY: RecordType[] = ["MX", "SRV"];
const NEEDS_WEIGHT_PORT: RecordType[] = ["SRV"];

export function DnsEditor({
  domainId,
  domainName,
  initialRecords,
  canManage,
  registrarLinked,
}: {
  domainId: string;
  domainName: string;
  initialRecords: DnsRecordView[];
  /** False for anyone the API would refuse — the form is not rendered at all. */
  canManage: boolean;
  /** No registrar customer id yet: nothing can be filed upstream. */
  registrarLinked: boolean;
}) {
  const [records, setRecords] = React.useState<DnsRecordView[]>(initialRecords);
  const [busy, setBusy] = React.useState(false);
  const [type, setType] = React.useState<RecordType>("A");
  const [host, setHost] = React.useState("@");
  const [value, setValue] = React.useState("");
  const [ttl, setTtl] = React.useState("7200");
  const [priority, setPriority] = React.useState("10");
  const [weight, setWeight] = React.useState("10");
  const [port, setPort] = React.useState("443");
  const [syncNote, setSyncNote] = React.useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/domains/${domainId}/dns`, { cache: "no-store" });
    const json = await res.json();
    if (json?.ok) setRecords(json.records ?? []);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { type, host, value, ttl: Number(ttl) };
      if (NEEDS_PRIORITY.includes(type)) body.priority = Number(priority);
      if (NEEDS_WEIGHT_PORT.includes(type)) { body.weight = Number(weight); body.port = Number(port); }

      const res = await fetch(`/api/domains/${domainId}/dns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (!res.ok || !json?.ok) {
        /* The server's words, not ours. It distinguishes "RC refused this record"
           from "the write path is switched off", and flattening those into
           "Could not add record" is what makes a screen useless to debug. The
           description carries the §24 half the message cannot: what is safe to do
           next. Here that is "try again", and it is only safe to say because the
           API writes upstream first — a refusal means nothing was created. */
        toastError(json?.error, {
          fallback: "Could not add the record.",
          description: "Nothing was written at the registrar, so correcting the value and trying again is safe.",
        });
        return;
      }
      if (json.warning) {
        toast.warning(json.warning, { duration: 12_000 });
        await refresh();
        return;
      }
      if (json.ttl_used && Number(ttl) !== json.ttl_used) {
        toast.success(`Added. ResellerClub raised the TTL to ${json.ttl_used}s — its minimum.`);
      } else {
        toast.success("Record added at the registrar.");
      }
      setValue("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(rec: DnsRecordView) {
    /* A DNS delete takes a site or a mailbox down, and it is not undoable from
       here — so it asks, and it names the record rather than saying "this item". */
    const label = `${rec.record_type} ${rec.host} → ${rec.value}`;
    /* Two different actions behind one button, so the question has to say which.
       With a registrar link this takes the record out of the LIVE zone; without one
       there is nothing upstream to remove and the row is a local stray, which the
       API treats as a repair. Saying "removes it from the live zone" in that second
       case would be untrue, and the panel above has already told the reader the
       zone cannot be changed. */
    const consequence = registrarLinked
      ? "This removes it from the live zone at the registrar."
      : "This domain has no registrar link, so this only removes it from this app's copy.";
    if (!window.confirm(`Delete ${label}?\n\n${consequence}`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/domains/${domainId}/dns/${rec.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        toastError(json?.error, {
          fallback: "Could not delete the record.",
          description: "The record is still live at the registrar — nothing was removed, here or there.",
        });
        return;
      }
      if (json.warning) toast.warning(json.warning, { duration: 12_000 });
      else toast.success("Record deleted at the registrar.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function sync(dryRun: boolean) {
    setBusy(true);
    setSyncNote(null);
    try {
      const res = await fetch(`/api/domains/${domainId}/dns/sync${dryRun ? "?dry_run=1" : ""}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        toastError(json?.error, {
          fallback: "Could not read the registrar's zone.",
          description: "Your copy was left exactly as it was — a failed read never edits it.",
          action: { label: "Try again", onClick: () => void sync(dryRun) },
        });
      }
      else {
        const p = dryRun ? json.planned : json.applied;
        toast.success(
          dryRun
            ? `Would add ${p.insert}, change ${p.update}, remove ${p.delete}.`
            : `Added ${p.insert}, changed ${p.update}, removed ${p.delete}.`,
        );
        if (!dryRun) await refresh();
      }
      /* Kept on the page rather than in a toast: it explains an absence, and an
         explanation of an absence has to still be there while you look at it. */
      if (json?.deletes_withheld) setSyncNote(json.deletes_withheld);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-hairline">
        <div>
          <h2 className="font-serif text-lg">DNS records</h2>
          <p className="text-2xs text-ink-3 mt-0.5">
            The registrar holds the zone; this is our copy of it.
          </p>
        </div>
        {canManage && registrarLinked && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={() => sync(true)} disabled={busy}>
              Preview sync
            </Button>
            <Button type="button" variant="outline" onClick={() => sync(false)} disabled={busy}>
              <Icon name="refresh" size={14} /> Sync from registrar
            </Button>
          </div>
        )}
      </div>

      {!registrarLinked && (
        <p className="px-4 py-3 text-sm text-ink-2 bg-amber-soft/25 border-b border-hairline">
          This domain has no ResellerClub customer id yet, so its zone cannot be read or changed. It is
          set when the registration lands upstream.
        </p>
      )}

      {syncNote && (
        <p className="px-4 py-3 text-2xs text-ink-2 bg-paper-2/60 border-b border-hairline">
          <b>Nothing was deleted.</b> {syncNote}
        </p>
      )}

      {records.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-3">
          No records in our copy. {registrarLinked ? "Sync from the registrar to pull the live zone in." : ""}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Host</th>
                <th className="text-left px-4 py-3">Value</th>
                <th className="text-left px-4 py-3">TTL</th>
                <th className="text-left px-4 py-3">Priority</th>
                {canManage && <th className="text-right px-4 py-3">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {records.map((r) => (
                <tr key={r.id} className="hover:bg-paper-2/40">
                  <td className="px-4 py-3">
                    <Badge kind="muted">{r.record_type}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-ink break-all">{r.host}</td>
                  <td className="px-4 py-3 font-mono text-2xs text-ink-2 break-all">{r.value}</td>
                  <td className="px-4 py-3 text-ink-3">{r.ttl}s</td>
                  <td className="px-4 py-3 text-ink-3">{r.priority ?? "—"}</td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => remove(r)}
                        disabled={busy}
                        aria-label={`Delete ${r.record_type} record for ${r.host}`}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && registrarLinked && (
        <form onSubmit={add} className="border-t border-hairline px-4 py-4 space-y-3">
          <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Add a record</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div>
              <Label htmlFor="dns-type">Type</Label>
              <select
                id="dns-type"
                value={type}
                onChange={(e) => setType(e.target.value as RecordType)}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              >
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="dns-host">Host</Label>
              <Input id="dns-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="@" />
            </div>
            <div className="lg:col-span-2">
              <Label htmlFor="dns-value">Value</Label>
              <Input id="dns-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="203.0.113.10" required />
            </div>
            <div>
              <Label htmlFor="dns-ttl">TTL (seconds)</Label>
              <Input id="dns-ttl" type="number" min={60} value={ttl} onChange={(e) => setTtl(e.target.value)} />
              <p className="text-3xs text-ink-3 mt-1">Minimum 7200 at the registrar.</p>
            </div>
            {NEEDS_PRIORITY.includes(type) && (
              <div>
                <Label htmlFor="dns-priority">Priority</Label>
                <Input id="dns-priority" type="number" min={0} value={priority} onChange={(e) => setPriority(e.target.value)} required />
              </div>
            )}
            {NEEDS_WEIGHT_PORT.includes(type) && (
              <>
                <div>
                  <Label htmlFor="dns-weight">Weight</Label>
                  <Input id="dns-weight" type="number" min={0} value={weight} onChange={(e) => setWeight(e.target.value)} required />
                </div>
                <div>
                  <Label htmlFor="dns-port">Port</Label>
                  <Input id="dns-port" type="number" min={1} value={port} onChange={(e) => setPort(e.target.value)} required />
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy || !value.trim()}>Add record</Button>
            <p className="text-2xs text-ink-3">
              Writes to the live zone for <span className="font-mono">{domainName}</span>.
            </p>
          </div>
        </form>
      )}
    </Card>
  );
}
