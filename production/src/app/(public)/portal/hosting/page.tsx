/**
 * /portal/hosting — the hosting accounts this customer has.
 *
 * Reads `hosting_accounts` (migration 20260908100000). Before that table, a
 * provisioned account existed only on the DirectAdmin server and as a couple of
 * fields stamped onto the `leads` row, so there was nothing a customer could be
 * shown — which is why this page did not exist.
 *
 * ─── THE TWO QUESTIONS THIS ANSWERS ──────────────────────────────────────────
 * 1. "Where do I log in?" — the single most common support ticket a hosting
 *    business gets, and it is answerable without a human.
 * 2. "When does it run out?" — with trials called what they are. A trial that
 *    silently suspends on day 15 and a paid account that lapses look identical
 *    on a status pill, and they are not the same conversation at all.
 *
 * The control-panel password is NOT here and must never be. It was emailed once
 * at provisioning and is the customer's to change; storing it to render it
 * would turn this page into a credential dump behind one session cookie.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, daysBetween } from "@/lib/utils";
import { OpenPanelButton } from "../_components/open-panel-button";
import type { HostingAccountStatus } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type BadgeKind = "success" | "warning" | "danger" | "info" | "muted";

const STATUS: Record<HostingAccountStatus, { label: string; kind: BadgeKind }> = {
  active:     { label: "Active",       kind: "success" },
  pending:    { label: "Setting up",   kind: "info"    },
  suspended:  { label: "Suspended",    kind: "danger"  },
  expired:    { label: "Expired",      kind: "danger"  },
  terminated: { label: "Closed",       kind: "muted"   },
  failed:     { label: "Setup failed", kind: "danger"  },
};

const CONTROL_PANEL = (process.env.DIRECTADMIN_URL?.trim() || "").replace(/\/+$/, "");

function remaining(at: string | null): { text: string; kind: BadgeKind; days: number | null } {
  if (!at) return { text: "—", kind: "muted", days: null };
  const days = daysBetween(new Date(), at);
  if (days < 0)   return { text: `Ended ${Math.abs(days)}d ago`, kind: "danger",  days };
  if (days === 0) return { text: "Ends today",                   kind: "danger",  days };
  if (days <= 14) return { text: `${days}d left`,                kind: "danger",  days };
  if (days <= 30) return { text: `${days}d left`,                kind: "warning", days };
  return { text: formatDate(at), kind: "muted", days };
}

function gb(mb: number | null): string {
  if (mb == null) return "—";
  return mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`;
}

export default async function PortalHostingPage() {
  const session  = await requirePortalSession();
  const reseller = session.tenantContactName ?? session.tenantName;
  const supabase = createClient();

  /* Scoped by RLS (`hosting_accounts_select_own_customer`), not by a filter here. */
  const { data } = await supabase
    .from("hosting_accounts")
    .select("id, domain_name, status, plan_name, plan_code, da_username, expires_at, trial_ends_at, is_trial, disk_quota_mb, bandwidth_quota_mb, started_at, resolved_at")
    .order("expires_at", { ascending: true, nullsFirst: false });

  const rows = data ?? [];
  /* A trial counts down to trial_ends_at; a paid account to expires_at. Reading
     the wrong one tells a trial customer they have a year. */
  const endsAt = (r: { is_trial: boolean; trial_ends_at: string | null; expires_at: string | null }) =>
    r.is_trial ? r.trial_ends_at : r.expires_at;

  const endingSoon = rows.filter((r) => {
    const d = remaining(endsAt(r)).days;
    return d !== null && d <= 14 && r.status !== "terminated";
  });

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Your Hosting</h1>
        <p className="text-sm text-ink-3 mt-1">
          Your hosting accounts, where to log in, and what each one includes.
        </p>
      </div>

      {endingSoon.length > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <p className="text-sm text-ink-2">
            <b>
              {endingSoon.length === 1
                ? `${endingSoon[0].is_trial ? "A trial ends" : "An account expires"}`
                : `${endingSoon.length} accounts end`}{" "}
              within 14 days.
            </b>{" "}
            Sites on a suspended account stop loading.{" "}
            <Link href="/portal/support/new" className="text-rose-ink underline">
              Ask {reseller} to extend →
            </Link>
          </p>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-ink-3">
            No hosting on your account yet. An account you buy appears here within a few
            minutes, and the login reaches you by email at the same time.
          </p>
          <Link href="/portal/shop" className="inline-block mt-4 text-sm text-amber-ink underline">
            See hosting plans →
          </Link>
        </Card>
      ) : (
        <ul className="space-y-4">
          {rows.map((h) => {
            const s = STATUS[h.status] ?? STATUS.pending;
            const r = remaining(endsAt(h));
            return (
              <li key={h.id}>
                <Card className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-base text-ink break-all">{h.domain_name}</p>
                      <p className="text-2xs text-ink-3 mt-0.5">
                        {h.plan_name ?? h.plan_code ?? "Hosting"}
                        {h.started_at ? ` · since ${formatDate(h.started_at)}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* A trial is labelled as one. It is not a status, it is a
                          different promise, and merging them misleads. */}
                      {h.is_trial && <Badge kind="info">Free trial</Badge>}
                      <Badge kind={s.kind} dot>{s.label}</Badge>
                    </div>
                  </div>

                  <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <dt className="text-3xs uppercase tracking-wider text-ink-3">
                        {h.is_trial ? "Trial ends" : "Renews"}
                      </dt>
                      <dd className={`mt-0.5 font-medium ${r.kind === "danger" ? "text-rose-ink" : r.kind === "warning" ? "text-amber-ink" : "text-ink-2"}`}>
                        {r.text}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-3xs uppercase tracking-wider text-ink-3">Disk</dt>
                      <dd className="mt-0.5 text-ink-2 font-mono">{gb(h.disk_quota_mb)}</dd>
                    </div>
                    <div>
                      <dt className="text-3xs uppercase tracking-wider text-ink-3">Bandwidth</dt>
                      <dd className="mt-0.5 text-ink-2 font-mono">{gb(h.bandwidth_quota_mb)}</dd>
                    </div>
                    <div>
                      <dt className="text-3xs uppercase tracking-wider text-ink-3">Username</dt>
                      <dd className="mt-0.5 text-ink-2 font-mono break-all">{h.da_username ?? "—"}</dd>
                    </div>
                  </dl>

                  {/* ─── "WHERE DO I LOG IN" ─────────────────────────────────
                      Two ways, and the order matters. The BUTTON mints a one-time
                      DirectAdmin session and drops the customer straight in — no
                      password needed, which is the whole point: until 11 Sep the
                      only route was the manual link below, so a customer who had
                      forgotten their hosting password had to raise a ticket and
                      wait for somebody to reset it.

                      The manual link stays underneath rather than being replaced.
                      It works when DirectAdmin SSO is not configured in this
                      environment, and it is the honest fallback when the one-time
                      link fails for any reason. */}
                  {h.da_username && h.status === "active" && (
                    <div className="mt-4 pt-4 border-t border-hairline flex flex-wrap items-center gap-3">
                      <OpenPanelButton hostingId={h.id} domainName={h.domain_name} />
                      <span className="text-2xs text-ink-3">
                        Opens straight into your panel — no password needed.
                      </span>
                    </div>
                  )}

                  {CONTROL_PANEL && h.da_username && (h.status === "active" || h.status === "suspended") && (
                    <div className={`flex flex-wrap items-center gap-3 ${h.status === "active" ? "mt-2" : "mt-4 pt-4 border-t border-hairline"}`}>
                      <a
                        href={CONTROL_PANEL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-2xs text-amber-ink underline"
                      >
                        Or sign in yourself →
                      </a>
                      <span className="text-2xs text-ink-3">
                        as <span className="font-mono">{h.da_username}</span>. Forgotten the
                        password?{" "}
                        <Link href="/portal/support/new" className="underline">Ask for a reset</Link>.
                      </span>
                    </div>
                  )}

                  {h.status === "failed" && !h.resolved_at && (
                    /* §24 — never a dead end. The customer did nothing wrong and
                       must not be left staring at the word "failed". */
                    <p className="mt-4 pt-4 border-t border-hairline text-2xs text-rose-ink">
                      Setup did not complete. {reseller} has been told and is on it — you have not
                      been charged twice.{" "}
                      <Link href="/portal/support/new" className="underline">Chase it up</Link>.
                    </p>
                  )}

                  {h.status === "failed" && h.resolved_at && (
                    /* ─── ONCE SOMEBODY HAS DEALT WITH IT, STOP SAYING THEY ARE ON IT ──
                       The message above is true right up until an operator resolves
                       the row — and then it keeps promising that somebody is working
                       on something that has already been settled, which is how a
                       customer comes to chase a refund they have already had.

                       It does NOT say WHAT was decided. The four resolutions
                       (`refunded`, `re_registered`, `alternative_offered`,
                       `written_off`) are an OPERATOR vocabulary: "written off" is an
                       accounting decision about our own books, and showing that
                       sentence to the person who paid would be worse than the stale
                       message it replaces. So this says the true, safe thing — it has
                       been dealt with, here is how to ask — and the detail lives in
                       the activity log where it belongs. */
                    <p className="mt-4 pt-4 border-t border-hairline text-2xs text-ink-3">
                      Setup did not complete, and {reseller} has since sorted this out with you.{" "}
                      <Link href="/portal/support/new" className="underline">Ask about it</Link> if
                      anything still looks wrong.
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
