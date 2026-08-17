/**
 * Enquiries — a Gmail-shaped sales inbox.
 *
 * ─── WHAT CHANGED, AND WHY IT WAS NOT COSMETIC ──────────────────────────────
 * This page used to offer folders called `untriaged`, `appended` and `skipped` —
 * the webhook's words for what IT did. "Appended" tells a salesperson nothing about
 * whether they owe someone a reply. The folders are now Inbox / Starred / Snoozed /
 * Converted Leads / Sent / Done / Spam, and the rules behind them live in
 * lib/inbound/folders.ts where they are tested.
 *
 * ─── TWO PANES, NOT THREE ───────────────────────────────────────────────────
 * The old layout gave folders a full pane of their own, which left the actual email
 * about a third of the screen. Folders are a rail; the list and the email get the
 * space, because reading the email is the job.
 *
 * ─── EVERY FILTER RULE IS IMPORTED, NONE IS WRITTEN HERE ────────────────────
 * parseSearch/matchesSearch and inFolder come from lib/inbound. A page that grew its
 * own copy of "what does is:unread mean" is how the folder list and the search box
 * end up disagreeing about the same mail.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatDate } from "@/lib/utils";
import { useInboundEmails, useConvertInboundToLead, useSetInboundState } from "@/lib/queries/inbound-emails";
import { inboundStatusMeta, canConvertToLead } from "@/lib/inbound/status";
import {
  MAIL_FOLDERS, inFolder, folderCounts, inboxUnread, snoozePresets, isSnoozed,
  type MailFolder,
} from "@/lib/inbound/folders";
import {
  parseSearch, matchesSearch, isEmptySearch, SUPPORTED_OPERATORS,
} from "@/lib/inbound/search";
import type { InboundEmailRow } from "@/lib/supabase/database.types";

/* ── Small presentational helpers ──────────────────────────────────────────── */

function senderLabel(e: InboundEmailRow): string {
  return e.from_name?.trim() || e.from_email || "Unknown sender";
}

function initials(e: InboundEmailRow): string {
  const parts = senderLabel(e).split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : senderLabel(e).slice(0, 2)).toUpperCase();
}

/** "3m", "2h", "5 Aug" — a mail from this morning does not need a date. */
function shortWhen(iso: string, nowMs: number): string {
  const mins = Math.floor((nowMs - new Date(iso).getTime()) / 60_000);
  if (mins < 1)    return "now";
  if (mins < 60)   return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return formatDate(iso);
}

/** First readable line of the body, for the list row. */
function snippet(e: InboundEmailRow): string {
  const text = e.body_text?.trim()
    /* body_html is a fallback, tags stripped. Never rendered as HTML anywhere on
       this page — an inbound email is untrusted input and this list is not the
       place to find that out. */
    || (e.body_html ? e.body_html.replace(/<[^>]+>/g, " ") : "");
  return text.replace(/\s+/g, " ").slice(0, 140);
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function EnquiriesPage() {
  const { data: rows, isLoading, error, refetch } = useInboundEmails();
  const setState = useSetInboundState();
  const convert  = useConvertInboundToLead();

  const [folder, setFolder]         = React.useState<MailFolder>("inbox");
  const [query, setQuery]           = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [snoozeOpen, setSnoozeOpen] = React.useState(false);

  /* ── "Now", pinned and refreshed on a timer ───────────────────────────────
     Snoozing is judged against the clock on every read (lib/inbound/folders.ts),
     so a page left open all afternoon has to notice its own snoozes expiring. A
     bare new Date() in render would also change every keystroke and defeat every
     useMemo below. One minute is finer than any snooze this offers. */
  const [nowISO, setNowISO] = React.useState(() => new Date().toISOString());
  React.useEffect(() => {
    const t = setInterval(() => setNowISO(new Date().toISOString()), 60_000);
    return () => clearInterval(t);
  }, []);
  const nowMs = React.useMemo(() => new Date(nowISO).getTime(), [nowISO]);

  const all      = React.useMemo(() => rows ?? [], [rows]);
  const parsed   = React.useMemo(() => parseSearch(query), [query]);
  const counts   = React.useMemo(() => folderCounts(all, nowISO), [all, nowISO]);
  const unread   = React.useMemo(() => inboxUnread(all, nowISO), [all, nowISO]);

  const visible = React.useMemo(() => {
    const inThisFolder = all.filter((r) => inFolder(r, folder, nowISO));
    return isEmptySearch(parsed) ? inThisFolder : inThisFolder.filter((r) => matchesSearch(r, parsed));
  }, [all, folder, nowISO, parsed]);

  const selected = React.useMemo(
    () => visible.find((r) => r.id === selectedId) ?? null,
    [visible, selectedId],
  );

  /* Opening an email marks it read. Deliberately an effect on the SELECTED row
     rather than part of the click handler, so it also fires when a row is reached
     by keyboard or by the selection surviving a folder change. */
  React.useEffect(() => {
    if (selected && selected.read_at == null) {
      setState.mutate({ id: selected.id, read: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  /* A folder change drops the selection: keeping it would leave the reading pane
     showing an email that is no longer in the list beside it. */
  React.useEffect(() => { setSelectedId(null); setSnoozeOpen(false); }, [folder]);

  const folderMeta = MAIL_FOLDERS.find((f) => f.id === folder)!;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <header className="mb-4">
        <h1 className="font-serif text-2xl text-ink">Enquiries</h1>
        <p className="text-sm text-ink-3 mt-0.5">
          Every email that came in, and what you still owe an answer on.
        </p>
      </header>

      {/* ── Search, full width above everything ──────────────────────────── */}
      <div className="mb-4">
        <div className="relative">
          <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mail — try from:sujay, is:unread, has:attachment"
            className="pl-9"
            aria-label="Search enquiries"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
              aria-label="Clear search"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>

        {/* An operator we cannot honour is SAID OUT LOUD. Silently ignoring it
            would return every email and look like it filtered — see search.ts. */}
        {parsed.unknown.length > 0 && (
          <div className="mt-2 rounded-md border border-amber bg-amber-soft px-3 py-2">
            <p className="text-[12px] leading-snug text-amber-ink">
              <span className="font-semibold">
                {parsed.unknown.join(", ")} {parsed.unknown.length === 1 ? "is" : "are"} not something this search understands
              </span>{" "}
              — the results below ignore it, so they are wider than you asked for.
              Supported: {SUPPORTED_OPERATORS.join("  ")}
            </p>
          </div>
        )}
      </div>

      <div className="flex gap-4">
        {/* ── Folder rail ───────────────────────────────────────────────── */}
        <nav className="hidden md:block w-[190px] shrink-0" aria-label="Mail folders">
          <ul className="space-y-0.5">
            {MAIL_FOLDERS.map((f) => {
              const isActive = f.id === folder;
              const count = counts[f.id];
              const badge = f.id === "inbox" ? unread : 0;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => setFolder(f.id)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                      isActive ? "bg-paper-2 font-semibold text-ink" : "text-ink-2 hover:bg-paper-2/60",
                    )}
                  >
                    <span aria-hidden className="text-[15px] leading-none">{f.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{f.label}</span>
                    {badge > 0
                      ? <Badge kind="danger" size="sm">{badge}</Badge>
                      : count > 0 && <span className="text-[11px] tabular-nums text-ink-3">{count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Mobile folder picker — the rail would eat the screen (CLAUDE.md §20). */}
        <div className="md:hidden mb-2 w-full">
          <select
            value={folder}
            onChange={(e) => setFolder(e.target.value as MailFolder)}
            aria-label="Mail folder"
            className="w-full rounded-lg border border-hairline bg-paper px-3 py-2 text-sm text-ink"
          >
            {MAIL_FOLDERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.icon} {f.label}{counts[f.id] ? ` (${counts[f.id]})` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* ── Pane 1: the list ──────────────────────────────────────────── */}
        <div className={cn(
          "min-w-0 flex-1",
          /* On a phone the two panes take turns — a 375px screen cannot hold both,
             and a squeezed reading pane is unreadable. */
          selected ? "hidden lg:block lg:max-w-[380px]" : "block lg:max-w-[380px]",
        )}>
          <Card className="p-0 overflow-hidden">
            <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                {folderMeta.icon} {folderMeta.label}
                {visible.length > 0 && <span className="ml-1.5 tabular-nums">({visible.length})</span>}
              </span>
              <Button variant="ghost" size="sm" onClick={() => refetch()} icon="refresh" aria-label="Refresh">
                Refresh
              </Button>
            </div>

            {isLoading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : error ? (
              <div className="p-4">
                <EmptyState
                  icon="alert"
                  title="Could not load your enquiries"
                  body={(error as Error).message}
                  action={<Button size="sm" onClick={() => refetch()}>Try again</Button>}
                />
              </div>
            ) : visible.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon="inbox"
                  title={isEmptySearch(parsed) ? `${folderMeta.label} is empty` : "Nothing matches that search"}
                  body={isEmptySearch(parsed)
                    ? folderMeta.hint
                    : `No mail in ${folderMeta.label} matches “${query}”. It may be in another folder.`}
                  action={isEmptySearch(parsed)
                    ? (folder !== "inbox"
                        ? <Button size="sm" variant="ghost" onClick={() => setFolder("inbox")}>Go to Inbox</Button>
                        : undefined)
                    : <Button size="sm" variant="ghost" onClick={() => setQuery("")}>Clear search</Button>}
                />
              </div>
            ) : (
              <ul className="divide-y divide-hairline max-h-[calc(100vh-260px)] overflow-y-auto">
                {visible.map((e) => {
                  const isUnread = e.read_at == null;
                  const isSel = e.id === selectedId;
                  return (
                    <li key={e.id}>
                      <div className={cn(
                        "flex items-start gap-2 px-3 py-2.5",
                        isSel && "bg-paper-2",
                        !isSel && "hover:bg-paper-2/50",
                      )}>
                        {/* Star is its own control, not part of opening the mail —
                            flagging something you have not read is a real move. */}
                        <button
                          type="button"
                          onClick={() => setState.mutate({ id: e.id, starred: !e.starred })}
                          aria-label={e.starred ? "Remove star" : "Star this enquiry"}
                          aria-pressed={e.starred}
                          className="mt-0.5 shrink-0 text-[14px] leading-none"
                        >
                          <span className={e.starred ? "" : "opacity-25"}>⭐</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedId(e.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className={cn(
                              "truncate text-[13px]",
                              isUnread ? "font-semibold text-ink" : "text-ink-2",
                            )}>
                              {senderLabel(e)}
                            </span>
                            <span className="shrink-0 text-[11px] tabular-nums text-ink-3">
                              {shortWhen(e.created_at, nowMs)}
                            </span>
                          </div>
                          <p className={cn(
                            "truncate text-[13px]",
                            isUnread ? "font-medium text-ink" : "text-ink-2",
                          )}>
                            {e.subject || "(no subject)"}
                          </p>
                          <p className="truncate text-[11px] text-ink-3">{snippet(e) || "—"}</p>
                        </button>

                        <span className="mt-0.5 shrink-0 text-[13px] leading-none" aria-hidden>
                          {initials(e)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        {/* ── Pane 2: the email ─────────────────────────────────────────── */}
        <div className={cn("min-w-0 flex-1", selected ? "block" : "hidden lg:block")}>
          {!selected ? (
            <Card className="h-full">
              <div className="flex h-full min-h-[240px] items-center justify-center">
                <p className="text-sm text-ink-3">Pick an enquiry to read it.</p>
              </div>
            </Card>
          ) : (
            <Card className="p-0 overflow-hidden">
              <div className="border-b border-hairline p-4">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-serif text-lg leading-snug text-ink">
                      {selected.subject || "(no subject)"}
                    </h2>
                    <p className="mt-0.5 text-[12px] text-ink-3">
                      {senderLabel(selected)}
                      {selected.from_email && selected.from_name && ` · ${selected.from_email}`}
                      {" · "}{formatDate(selected.created_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="lg:hidden shrink-0 text-ink-3 hover:text-ink"
                    aria-label="Back to list"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge kind={inboundStatusMeta(selected.status).kind} dot>
                    {inboundStatusMeta(selected.status).label}
                  </Badge>
                  {/* `as Route` below: next.config sets experimental.typedRoutes and Next
                      generates those types at BUILD time, so tsc --noEmit passes against
                      types that do not exist yet and only `npm run build` rejects a
                      templated href (CLAUDE.md §25.2). */}
                  {selected.lead_id && (
                    <Link href={`/leads?highlight=${selected.lead_id}` as Route} className="text-[12px] font-medium text-ink underline">
                      Open lead {selected.lead_id}
                    </Link>
                  )}
                  {isSnoozed(selected, nowISO) && selected.snoozed_until && (
                    <Badge kind="info">Snoozed until {formatDate(selected.snoozed_until)}</Badge>
                  )}
                  {selected.archived_at && <Badge kind="muted">Done</Badge>}
                </div>
              </div>

              {/* ── Actions ──────────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-paper-2/40 px-4 py-2">
                <Button
                  size="sm"
                  variant={selected.starred ? "default" : "ghost"}
                  onClick={() => setState.mutate({ id: selected.id, starred: !selected.starred })}
                >
                  {selected.starred ? "★ Starred" : "☆ Star"}
                </Button>

                <div className="relative">
                  <Button size="sm" variant="ghost" onClick={() => setSnoozeOpen((v) => !v)}>
                    ⏰ Snooze
                  </Button>
                  {snoozeOpen && (
                    <div className="absolute z-20 mt-1 w-48 rounded-lg border border-hairline bg-paper p-1 shadow-lg">
                      {snoozePresets(new Date(nowISO)).map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => {
                            setState.mutate({ id: selected.id, snoozeUntil: p.untilISO });
                            setSnoozeOpen(false);
                            toast.success(`Snoozed — back in your Inbox ${p.label.toLowerCase()}.`);
                          }}
                          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-paper-2"
                        >
                          {p.label}
                        </button>
                      ))}
                      {selected.snoozed_until && (
                        <button
                          type="button"
                          onClick={() => {
                            setState.mutate({ id: selected.id, snoozeUntil: null });
                            setSnoozeOpen(false);
                          }}
                          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-rose hover:bg-paper-2"
                        >
                          Wake it now
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setState.mutate({ id: selected.id, archived: !selected.archived_at })}
                >
                  {selected.archived_at ? "↩ Move back to Inbox" : "✅ Mark done"}
                </Button>

                {canConvertToLead(selected) && (
                  <Button
                    size="sm"
                    loading={convert.isPending}
                    onClick={() => convert.mutate(selected.id)}
                  >
                    🎯 Convert to lead
                  </Button>
                )}
              </div>

              {/* ── Body ─────────────────────────────────────────────────── */}
              <div className="p-4">
                {selected.attachment_name && (
                  <div className="mb-3 inline-flex items-center gap-2 rounded-md border border-hairline bg-paper-2 px-2.5 py-1.5">
                    <Icon name="paperclip" size={13} className="text-ink-3" />
                    <span className="text-[12px] text-ink-2">{selected.attachment_name}</span>
                  </div>
                )}
                {/* Rendered as TEXT, never as HTML. An inbound email is untrusted
                    input from anyone who can find the address. */}
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink-2">
                  {selected.body_text?.trim()
                    || (selected.body_html ? selected.body_html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "")
                    || "This email arrived with no readable body."}
                </pre>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Sent lives in a different table and has no body — said here rather than
          rendering an empty list that looks like nothing was ever sent. */}
      {folder === "sent" && (
        <p className="mt-3 px-1 text-[11px] leading-snug text-ink-3">
          Replies are recorded in the email log with their recipient, subject and
          delivery status — the message text itself is not stored, so it cannot be
          reprinted here.
        </p>
      )}
    </div>
  );
}
