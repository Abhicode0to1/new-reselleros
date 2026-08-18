/**
 * /admin/feedback — the triage queue for bug reports the team files with Ctrl+Shift+B.
 *
 * ─── WHAT "RUN AI AUTO-FIX" HONESTLY DOES ───────────────────────────────────
 * It makes sure a directive exists, copies it to the clipboard, and marks the report
 * `agent_queued` with who queued it and when. That is the whole of it.
 *
 * It does NOT edit code, and the button does not pretend to. This app is a Next.js
 * server on Cloud Run; it has no checkout of the repository, no git credentials and no
 * shell, and any design where a web button could rewrite source would be a remote code
 * execution feature with a friendly label. The value here is real but narrower than the
 * name suggests: the hard part of handing work to a coding agent is writing a directive
 * that names the right files and carries the repo's rules, and that is what this
 * generates. The button is the last 5%, not the first 95%.
 *
 * The screen says this in as many words, because a status of "queued" that an owner
 * reads as "being fixed" is worse than no status at all — they would stop chasing it.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  useFeedbackList,
  useTriageFeedback,
  useDispatchFeedback,
  useUpdateFeedbackStatus,
  feedbackScreenshotUrl,
  type FeedbackWithShots,
  type FeedbackStatus,
} from "@/lib/queries/feedback";

const STATUS_TABS: { id: string; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "agent_queued", label: "Queued for agent" },
  { id: "fixed", label: "Fixed" },
  { id: "all", label: "All" },
];

const TYPE_BADGE: Record<string, { kind: "danger" | "info" | "warning"; label: string }> = {
  bug: { kind: "danger", label: "Bug" },
  feature: { kind: "info", label: "Feature" },
  ui_improvement: { kind: "warning", label: "UI polish" },
};

/** Severity band → colour. Bands, not a gradient: an operator reads three groups, not 100 shades. */
function severityKind(score: number | null): "danger" | "warning" | "muted" {
  if (score === null) return "muted";
  if (score >= 60) return "danger";
  if (score >= 36) return "warning";
  return "muted";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function ScreenshotThumb({ path, name }: { path: string; name: string | null }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    feedbackScreenshotUrl(path)
      .then((u) => { if (alive) { if (u) setUrl(u); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [path]);

  if (failed) {
    // Says what is wrong rather than showing a broken image frame.
    return (
      <div className="w-24 h-16 rounded border border-hairline bg-paper-2 flex items-center justify-center text-[10px] text-ink-4 text-center px-1">
        Could not load
      </div>
    );
  }
  if (!url) return <Skeleton className="w-24 h-16 rounded" />;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={name ?? "Screenshot"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name ?? "Reported screen"}
        className="w-24 h-16 object-cover rounded border border-hairline hover:border-primary transition-colors"
      />
    </a>
  );
}

function FeedbackCard({ row, userId }: { row: FeedbackWithShots; userId: string | null }) {
  const [open, setOpen] = React.useState(false);

  const triage = useTriageFeedback();
  const dispatch = useDispatchFeedback();
  const setStatus = useUpdateFeedbackStatus();

  const type = row.inferred_type ?? row.reported_type;
  const badge = TYPE_BADGE[type] ?? TYPE_BADGE.bug;
  const untriaged = row.triage_status !== "triaged" || !row.directive;

  const handleCopy = async () => {
    if (!row.directive) {
      toast.error("There is no directive yet.", { description: "Run triage on this report first." });
      return;
    }
    const ok = await copyToClipboard(row.directive);
    if (ok) toast.success("Directive copied — paste it into Claude Code.");
    else toast.error("Could not reach the clipboard.", { description: "Select the directive text below and copy it manually." });
  };

  const handleRunTriage = async () => {
    try {
      const { mode } = await triage.mutateAsync(row.id);
      toast.success(
        mode === "gemini" ? "Triaged with Gemini." : "Triaged with the built-in engine.",
        { description: mode === "stub" ? "No Gemini key is configured, so the deterministic engine ran." : undefined },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Triage failed.");
    }
  };

  /**
   * The 1-click path: make sure a directive exists, put it on the clipboard, and record
   * that it was handed out. Deliberately does not claim a fix is underway.
   */
  const handleAutoFix = async () => {
    try {
      if (untriaged) await triage.mutateAsync(row.id);

      // Re-read from the row we have; after a triage the list refetches, but the copy
      // must not depend on that race. Fall back to triggering a copy of what we hold.
      const directive = row.directive;
      const copied = directive ? await copyToClipboard(directive) : false;

      await dispatch.mutateAsync({ id: row.id, userId });

      toast.success("Directive queued and copied.", {
        description: copied
          ? "Paste it into Claude Code to start the fix. Nothing has changed in the code yet — this app cannot edit the repository."
          : "Open the report below to copy the directive. Nothing has changed in the code yet.",
        duration: 9_000,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not queue this report.");
    }
  };

  const handleStatus = async (status: FeedbackStatus) => {
    try {
      await setStatus.mutateAsync({ id: row.id, status });
      toast.success(status === "fixed" ? "Marked fixed." : status === "wont_fix" ? "Marked won't fix." : "Reopened.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the status.");
    }
  };

  const busy = triage.isPending || dispatch.isPending || setStatus.isPending;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-11 h-11 rounded-lg bg-paper-2 border border-hairline flex flex-col items-center justify-center"
          title={row.severity_score === null ? "Not triaged yet" : `Severity ${row.severity_score} of 100`}
        >
          <span className="text-sm font-bold leading-none text-ink">{row.severity_score ?? "—"}</span>
          <span className="text-[9px] uppercase tracking-wide text-ink-4 mt-0.5">sev</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge kind={badge.kind} size="sm">{badge.label}</Badge>
            {row.inferred_type && row.inferred_type !== row.reported_type && (
              <Badge kind="outline" size="sm" title={`The reporter filed this as "${row.reported_type}"`}>
                filed as {row.reported_type}
              </Badge>
            )}
            <Badge kind={severityKind(row.severity_score)} size="sm">
              {row.reported_severity}
            </Badge>
            {row.triage_mode && (
              <Badge kind="muted" size="sm" title={row.triage_mode === "stub" ? "No Gemini key configured — the built-in engine ran" : "Triaged by Gemini"}>
                {row.triage_mode}
              </Badge>
            )}
            {row.status === "agent_queued" && <Badge kind="info" size="sm">queued for agent</Badge>}
            {row.status === "fixed" && <Badge kind="success" size="sm">fixed</Badge>}
            {row.status === "wont_fix" && <Badge kind="muted" size="sm">won&apos;t fix</Badge>}
          </div>

          <p className="mt-1.5 text-sm font-medium text-ink">
            {row.problem_summary || row.title}
          </p>

          <p className="mt-1 text-xs text-ink-3 flex items-center gap-2 flex-wrap">
            <span className="font-mono">{row.route_pattern ?? row.page_path ?? "screen unknown"}</span>
            <span className="text-ink-4">·</span>
            <span>{row.reporter_name ?? "Unknown reporter"}</span>
            <span className="text-ink-4">·</span>
            <span>{formatDate(row.created_at)}</span>
            {row.screenshots.length > 0 && (
              <>
                <span className="text-ink-4">·</span>
                <span className="inline-flex items-center gap-1"><Icon name="camera" size={12} />{row.screenshots.length}</span>
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-shrink-0 text-xs font-medium text-ink-3 hover:text-ink inline-flex items-center gap-1"
          aria-expanded={open}
        >
          {open ? "Hide" : "Details"}
          <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={handleAutoFix} disabled={busy} className="bg-primary text-white">
          <Icon name="sparkles" size={14} className="mr-1.5" />
          Run AI Auto-Fix
        </Button>
        <Button size="sm" variant="outline" onClick={handleCopy} disabled={busy || !row.directive}>
          <Icon name="copy" size={14} className="mr-1.5" />
          Copy Directive
        </Button>
        <Button size="sm" variant="ghost" onClick={handleRunTriage} disabled={busy}>
          <Icon name="refresh" size={14} className="mr-1.5" />
          {untriaged ? "Triage" : "Re-triage"}
        </Button>
        <span className="flex-1" />
        {row.status !== "fixed" && (
          <Button size="sm" variant="ghost" onClick={() => handleStatus("fixed")} disabled={busy}>
            Mark fixed
          </Button>
        )}
        {/* Offered from EVERY non-open state, not just "fixed". A report that was queued
            for an agent which then failed, stalled, or was never actually run has to be
            able to come back — otherwise the only exits from `agent_queued` are "fixed"
            and "won't fix", and somebody eventually picks one of those to clear the row.
            A queue you can only leave by lying about the outcome stops being a queue. */}
        {row.status !== "open" && (
          <Button size="sm" variant="ghost" onClick={() => handleStatus("open")} disabled={busy}>
            Reopen
          </Button>
        )}
        {row.status !== "wont_fix" && (
          <Button size="sm" variant="ghost" onClick={() => handleStatus("wont_fix")} disabled={busy}>
            Won&apos;t fix
          </Button>
        )}
      </div>

      {open && (
        <div className="pt-3 border-t border-hairline space-y-4">
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">What the reporter wrote</h4>
            <pre className="text-xs text-ink whitespace-pre-wrap font-mono bg-paper-2 border border-hairline rounded-md p-3 max-h-56 overflow-y-auto">
              {row.body}
            </pre>
          </div>

          {row.screenshots.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">Screenshots</h4>
              <div className="flex gap-2 flex-wrap">
                {row.screenshots.map((s) => (
                  <ScreenshotThumb key={s.id} path={s.file_path} name={s.file_name} />
                ))}
              </div>
            </div>
          )}

          {row.triage_notes.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">What the triage noticed</h4>
              <ul className="space-y-1">
                {row.triage_notes.map((n, i) => (
                  <li key={i} className="text-xs text-ink-2 flex gap-2">
                    <span className="text-ink-4 flex-shrink-0">•</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {row.target_files.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">Target files</h4>
              <ul className="space-y-0.5">
                {row.target_files.map((f) => (
                  <li key={f} className="text-xs font-mono text-ink-2">{f}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3">AI agent directive</h4>
              {row.directive && (
                <button type="button" onClick={handleCopy} className="text-xs font-medium text-primary hover:underline">
                  Copy
                </button>
              )}
            </div>
            {row.directive ? (
              <pre className="text-[11px] leading-relaxed text-ink whitespace-pre-wrap font-mono bg-paper-2 border border-hairline rounded-md p-3 max-h-96 overflow-y-auto">
                {row.directive}
              </pre>
            ) : (
              <p className="text-xs text-ink-3">
                No directive yet — press <b>Triage</b> above to generate one.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function AdminFeedbackPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const [tab, setTab] = React.useState("open");

  const filter = tab === "all" ? {} : { status: tab as FeedbackStatus };
  const { data, isLoading, error } = useFeedbackList(filter);

  const rows = data ?? [];
  const untriagedCount = rows.filter((r) => r.triage_status !== "triaged").length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-5">
      <div>
        <h1 className="text-2xl md:text-3xl font-serif text-ink">Feedback &amp; AI Fixes</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every bug report and idea the team files with <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-[11px]">Ctrl</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-[11px]">Shift</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-[11px]">B</kbd>, triaged and turned into a directive for a coding agent.
        </p>
      </div>

      {/* Said once, at the top, rather than left for someone to infer from a status chip. */}
      <div className="rounded-lg border border-hairline bg-paper-2 p-3 flex gap-2.5">
        <Icon name="info" size={16} className="text-ink-3 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-ink-2 leading-relaxed">
          <b>Run AI Auto-Fix</b> writes the directive, copies it to your clipboard and marks the report queued.
          It does <b>not</b> change any code by itself — this app runs on a server with no access to the
          repository. Paste the directive into Claude Code to actually make the fix.
        </p>
      </div>

      <TabBar
        value={tab}
        onChange={setTab}
        items={STATUS_TABS.map((t) => ({
          ...t,
          count: t.id === tab ? rows.length : undefined,
        }))}
      />

      {untriagedCount > 0 && (
        <p className="text-xs text-amber-ink bg-amber-soft border border-amber/30 rounded-md px-3 py-2">
          {untriagedCount} report(s) in this view have no directive yet. Press <b>Triage</b> on each, or{" "}
          <b>Run AI Auto-Fix</b>, which triages first.
        </p>
      )}

      {(isLoading || meLoading) && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
        </div>
      )}

      {error && (
        <Card className="p-6">
          <EmptyState
            icon="alert"
            title="Could not load the feedback queue"
            body={
              <>
                {error instanceof Error ? error.message : "Unknown error."}
                <br />
                If this says the table does not exist, migration{" "}
                <code className="font-mono text-[11px]">20260819120000_feedback_triage</code> has not been applied yet.
              </>
            }
          />
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card className="p-6">
          <EmptyState
            icon="bug"
            title={tab === "open" ? "Nothing open" : "Nothing here"}
            body={
              tab === "open"
                ? "No open reports. Anyone on the team can file one from any screen with Ctrl + Shift + B."
                : "No reports with this status."
            }
          />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => (
            <FeedbackCard key={row.id} row={row} userId={me?.userId ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}
