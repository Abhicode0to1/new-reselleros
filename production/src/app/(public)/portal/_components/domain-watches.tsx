"use client";

/**
 * "Tell me when this name frees up" — the customer's side of `domain_watches`.
 *
 * A client island on an otherwise server-rendered page, for the same reason
 * `portal-nav.tsx` is one: adding and removing a watch is the only interactive
 * thing here, so it is the only part that needs to ship JavaScript.
 *
 * ─── WHAT IT PROMISES, AND WHAT IT CAREFULLY DOES NOT ───────────────────────
 * It promises ONE email, once, if the name comes free. It does not promise the
 * name — the sweep checks daily and a name released at 3am can be gone by the
 * time anybody reads their mail, and saying otherwise would set the customer up
 * to be disappointed by physics. The copy says "as soon as we see it free",
 * which is the true claim.
 *
 * ─── EVERY REFUSAL SHOWN IS THE SERVER'S OWN WORDS ──────────────────────────
 * `watchableDomain` and `canAddWatch` write sentences meant for this customer
 * (§24), so they are rendered verbatim rather than replaced with "invalid
 * input". The one exception is a network failure, which the server never got to
 * describe.
 */

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

export interface WatchRowView {
  id: string;
  domain_name: string;
  last_status: string;
  last_checked_at: string | null;
  notified_at: string | null;
}

/** How the last check reads to somebody who is waiting. */
function statusLabel(row: WatchRowView): { text: string; kind: "success" | "muted" | "warning" } {
  if (row.notified_at) return { text: "We emailed you", kind: "success" };
  if (row.last_status === "taken") return { text: "Still taken", kind: "muted" };
  if (row.last_status === "available") return { text: "Available", kind: "success" };
  /* `unknown` covers "not checked yet" and "the registrar would not answer", and
     the customer does not need those told apart — both mean "no news". */
  return { text: row.last_checked_at ? "No answer yet" : "Not checked yet", kind: "warning" };
}

export function DomainWatches({ initial, limit }: { initial: WatchRowView[]; limit: number }) {
  const [rows, setRows] = React.useState(initial);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const open = rows.filter((r) => !r.notified_at).length;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/portal/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toastError(body.error ?? "Could not add that watch.");
        return;
      }
      if (body.already) {
        /* Not an error: they already watch it, so the thing they wanted is true.
           Said plainly rather than as a duplicate-key complaint. */
        toast.success(`You are already watching ${body.domain}.`);
        setName("");
        return;
      }
      setRows((prev) => [
        { id: body.id, domain_name: body.domain, last_status: "unknown", last_checked_at: null, notified_at: null },
        ...prev,
      ]);
      setName("");
      toast.success(`Watching ${body.domain}. We will email you once, as soon as we see it free.`);
    } catch {
      toastError("Could not reach us just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, domain: string) {
    if (busy) return;
    setBusy(true);
    /* Optimistic, with the row put back on failure. Removing a watch is not
       money and not irreversible — re-adding it costs one line — so the fast
       path is worth more here than a confirmation dialog would be. */
    const before = rows;
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      const res = await fetch("/api/portal/watch", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRows(before);
        toastError(body.error ?? "Could not remove that watch.");
        return;
      }
      toast.success(`Stopped watching ${domain}.`);
    } catch {
      setRows(before);
      toastError("Could not reach us just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4 md:p-5 mt-6">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-lg text-ink">Watching a name</h2>
        <p className="text-2xs text-ink-3">
          {open} of {limit} watches
        </p>
      </div>
      <p className="text-sm text-ink-3 mt-1">
        Wanted a name that was already taken? We will check it once a day and email you
        once, as soon as we see it free.
      </p>

      <form onSubmit={add} className="mt-4 flex flex-col sm:flex-row gap-2">
        <label htmlFor="watch-domain" className="sr-only">
          Domain name to watch
        </label>
        <Input
          id="watch-domain"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. theonewewanted.com"
          className="flex-1 font-mono"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <Button type="submit" variant="primary" icon="bell" loading={busy} disabled={!name.trim()}>
          Watch it
        </Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-2xs text-ink-3 mt-4">
          Nothing on watch yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline">
          {rows.map((r) => {
            const s = statusLabel(r);
            return (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-ink break-all">{r.domain_name}</p>
                  <p className="text-2xs text-ink-3 mt-0.5">
                    {r.notified_at
                      ? `Told you on ${formatDate(r.notified_at)}`
                      : r.last_checked_at
                        ? `Last checked ${formatDate(r.last_checked_at)}`
                        : "We will check it within a day"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge kind={s.kind} size="sm" dot>
                    {s.text}
                  </Badge>
                  <IconButton
                    icon="trash"
                    aria-label={`Stop watching ${r.domain_name}`}
                    onClick={() => remove(r.id, r.domain_name)}
                    disabled={busy}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
