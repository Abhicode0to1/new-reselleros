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
import { ticketHref } from "@/lib/portal/ticket-link";
import { notLiveBreakdown } from "./not-live";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, daysBetween } from "@/lib/utils";
import { OpenPanelButton } from "../_components/open-panel-button";
import { UpgradePlanControl } from "../_components/upgrade-plan-control";
import type { HostingAccountStatus } from "@/lib/supabase/database.types";
import { describeSuspension } from "@/lib/portal/suspension-notice";
import { PortalPageHeader, PortalStats } from "../_components/portal-page";
import { EmptyState } from "@/components/shared/empty-state";

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
    .select("id, domain_name, status, plan_name, plan_code, da_username, expires_at, trial_ends_at, is_trial, suspended_at, disk_quota_mb, bandwidth_quota_mb, started_at, resolved_at")
    .order("expires_at", { ascending: true, nullsFirst: false });

  const rows = data ?? [];

  /* Upgrade requests this customer already has waiting.
     Scoped by RLS (`hosting_plan_changes_select_own_customer`), like the accounts
     above — the customer's own id never appears as a filter here. Read as a MAP
     so the card can replace its chooser with "already asked" rather than offering
     a button that would 409; see upgrade-plan-control.tsx. */
  const { data: pendingChanges } = await supabase
    .from("hosting_plan_changes")
    .select("hosting_account_id, requested_plan_code")
    .eq("status", "pending");
  const pendingByAccount = new Map(
    (pendingChanges ?? []).map((c) => [c.hosting_account_id, c.requested_plan_code]),
  );
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
      <PortalPageHeader
        title="Your Hosting"
        sub="Your hosting accounts, where to log in, and what each one includes."
      />

      {/* Live and not-live counted apart: a suspended site is the thing a
          customer opens this page to understand, and folding it into a single
          total is how it stops being visible. */}
      <PortalStats
        items={[
          { label: "Accounts", value: rows.length, icon: "package" },
          {
            label: "Live",
            value: rows.filter((r) => r.status === "active").length,
            icon: "check",
            accent: "emerald",
          },
          {
            label: "Not live",
            value: rows.filter((r) => r.status !== "active").length,
            icon: "alert",
            accent: rows.some((r) => r.status !== "active") ? "rose" : "ink",
            /* "2" told a customer nothing; "1 paused · 1 setting up" tells them
               which half needs them. */
            trend: notLiveBreakdown(rows.filter((r) => r.status !== "active").map((r) => r.status)),
          },
          {
            label: "Ending soon",
            value: endingSoon.length,
            icon: "clock",
            accent: endingSoon.length > 0 ? "amber" : "ink",
            trend: endingSoon.length > 0 ? "within 14 days" : undefined,
          },
        ]}
      />

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
            {endingSoon.length === 1 ? (
              <Link
                href={ticketHref(
                  `Please extend ${endingSoon[0].domain_name}`,
                  `I would like to extend the hosting for ${endingSoon[0].domain_name}.` +
                    `

The panel says it ends within 14 days.` +
                    `
Please confirm what it costs and how to pay.`,
                )}
                className="text-rose-ink underline"
              >
                Ask {reseller} to extend {endingSoon[0].domain_name} →
              </Link>
            ) : (
              /* Several: each card below carries its own named link, and one
                 nameless ticket for all of them is worse than saying so. */
              <span className="text-ink-3">Each account below has a link to ask about it.</span>
            )}
          </p>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon="package"
            title="No hosting yet"
            body="An account you buy appears here within a few minutes, and the login reaches you by email at the same time."
            action={
              <Link href="/portal/shop" className="text-sm text-amber-ink underline">
                See hosting plans →
              </Link>
            }
            compact
          />
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

                  {/* ─── ONLY THE FACTS WE ACTUALLY HAVE ─────────────────────
                      Every slot used to be drawn whether or not it held anything,
                      so an account still being set up showed four labelled
                      metrics reading "—" — RENEWS, DISK, BANDWIDTH, USERNAME,
                      none of which can exist before the account does. Four dashes
                      do not read as "we do not know this yet"; they read as a
                      broken card, directly above the line explaining that
                      everything is fine.

                      So each fact renders only when it has a value, and the grid
                      disappears entirely when none do. That is data-driven rather
                      than keyed to `pending`, which matters because the same
                      emptiness turns up on legacy rows that were never swept. */}
                  {(() => {
                    const facts: { label: string; value: string; className: string }[] = [];
                    if (r.days !== null) {
                      facts.push({
                        label: h.is_trial ? "Trial ends" : "Renews",
                        value: r.text,
                        className: `font-medium ${r.kind === "danger" ? "text-rose-ink" : r.kind === "warning" ? "text-amber-ink" : "text-ink-2"}`,
                      });
                    }
                    if (h.disk_quota_mb != null) {
                      facts.push({ label: "Disk", value: gb(h.disk_quota_mb), className: "text-ink-2 font-mono" });
                    }
                    if (h.bandwidth_quota_mb != null) {
                      facts.push({ label: "Bandwidth", value: gb(h.bandwidth_quota_mb), className: "text-ink-2 font-mono" });
                    }
                    if (h.da_username) {
                      facts.push({ label: "Username", value: h.da_username, className: "text-ink-2 font-mono break-all" });
                    }
                    if (facts.length === 0) return null;
                    return (
                      <dl className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        {facts.map((f) => (
                          <div key={f.label}>
                            <dt className="text-3xs uppercase tracking-wider text-ink-3">{f.label}</dt>
                            <dd className={`mt-0.5 ${f.className}`}>{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    );
                  })()}

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
                      {/* min-h-11 on phones only — §20 scopes the 44px minimum to
                          <768px. Measured 17 Sep 2026: this rendered 17px tall at
                          390, and it is NOT the inline-in-a-sentence case WCAG
                          2.5.5 exempts — it is a discrete control sitting beside
                          the explanatory span, in a flex row of its own. */}
                      <a
                        href={CONTROL_PANEL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-11 md:min-h-0 inline-flex items-center text-2xs text-amber-ink underline"
                      >
                        Or sign in yourself →
                      </a>
                      <span className="text-2xs text-ink-3">
                        as <span className="font-mono">{h.da_username}</span>. Forgotten the
                        password?{" "}
                        <Link
                          href={ticketHref(
                            `Control-panel password reset for ${h.domain_name}`,
                            `Please reset the control-panel password for ${h.domain_name}` +
                              `${h.da_username ? ` (username ${h.da_username})` : ""}.`,
                          )}
                          className="underline"
                        >
                          Ask for a reset
                        </Link>.
                      </span>
                    </div>
                  )}

                  {h.status === "pending" && (
                    /* §24 — the one status that said nothing at all.
                       `active`, `suspended` and both halves of `failed` each get
                       an explanation and a way out; "Setting up" got the word and
                       four dashes, on a card with no login, no username and no
                       action. A customer cannot tell whether that means minutes,
                       days, or that something has gone wrong.

                       The email is real, not a comfort: provision-hosting sends
                       the control-panel login the moment the account exists
                       (api/cron/provision-hosting/route.ts — "Your {pkg} hosting
                       account is set up and ready"). No time is promised, because
                       the cron's pace depends on a queue and an upstream this copy
                       cannot see — so the honest offer is a way to ask rather than
                       an estimate that could be wrong. */
                    <p className="mt-4 pt-4 border-t border-hairline text-2xs text-ink-3">
                      {reseller} is setting this account up — there is nothing for you to do. As
                      soon as it is ready you will get an email with the control-panel login, and
                      this page will show it too.{" "}
                      <Link
                        href={ticketHref(
                          `Hosting setup for ${h.domain_name}`,
                          `The panel still shows the hosting for ${h.domain_name} as being set up.` +
                            `

Could you tell me where it has got to?`,
                        )}
                        className="underline hover:text-ink"
                      >
                        Taking longer than you expected? Ask about it
                      </Link>
                      .
                    </p>
                  )}

                  {h.status === "failed" && !h.resolved_at && (
                    /* §24 — never a dead end. The customer did nothing wrong and
                       must not be left staring at the word "failed". */
                    <p className="mt-4 pt-4 border-t border-hairline text-2xs text-rose-ink">
                      Setup did not complete. {reseller} has been told and is on it — you have not
                      been charged twice.{" "}
                      <Link
                        href={ticketHref(
                          `Hosting setup failed for ${h.domain_name}`,
                          `The panel says the hosting setup for ${h.domain_name} did not complete.` +
                            `

Please tell me where this stands and what happens next.`,
                        )}
                        className="underline"
                      >
                        Chase it up
                      </Link>.
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
                      <Link
                        href={ticketHref(
                          `Hosting for ${h.domain_name}`,
                          `The panel says the setup for ${h.domain_name} failed and was then sorted out.` +
                            `

Something still does not look right to me:`,
                        )}
                        className="underline"
                      >
                        Ask about it
                      </Link> if
                      anything still looks wrong.
                    </p>
                  )}

                  {h.status === "suspended" && (() => {
                    /* ─── §24: A RED PILL IS NOT AN EXPLANATION ──────────────
                       Until 11 Sep 2026 a suspended account rendered the word
                       "Suspended" and nothing else — no reason, no date, and
                       nothing about whether the site and mailboxes still
                       existed. Found in the browser on the portal test fixture.

                       The reason is DERIVED, never guessed: there is no
                       `suspension_reason` column, so `describeSuspension` says
                       "a person paused this, ask them" whenever the dates do
                       not actually show a trial or a term running out — which
                       is exactly what a refund mid-term leaves behind. */
                    const notice = describeSuspension({
                      isTrial: h.is_trial,
                      trialEndsAt: h.trial_ends_at,
                      expiresAt: h.expires_at,
                      suspendedAt: h.suspended_at,
                    });
                    return (
                      <div className="mt-4 pt-4 border-t border-hairline">
                        <p className="text-2xs text-rose-ink">{notice.headline}</p>
                        {/* The sentence the old card was missing entirely, and the
                            first thing somebody looking at this needs. */}
                        <p className="text-2xs text-ink-2 mt-1.5">{notice.reassurance}</p>
                        <Link
                          href={
                            notice.actionRoute === "shop"
                              ? "/portal/shop"
                              : ticketHref(
                                  `Hosting for ${h.domain_name} is paused`,
                                  `The panel says the hosting for ${h.domain_name} is paused, so the site is offline.` +
                                    `

${notice.headline}` +
                                    `

Please tell me why, and what it takes to switch it back on.`,
                                )
                          }
                          className="inline-block mt-2 text-2xs text-amber-ink underline"
                        >
                          {notice.action} →
                        </Link>
                      </div>
                    );
                  })()}

                  {/* ─── MOVE TO A BIGGER PLAN ───────────────────────────────
                      Only on a LIVE account, and only a paid one. A trial has no
                      term to pro-rate against and no money on it, so "upgrade"
                      there means "convert to paid" — a different conversation
                      with a different price, and offering this instead would
                      quote the difference between two plans when the customer
                      has paid for neither. */}
                  {h.status === "active" && !h.is_trial && (
                    <UpgradePlanControl
                      hostingId={h.id}
                      domainName={h.domain_name}
                      currentPlanCode={h.plan_code ?? h.plan_name}
                      pendingTo={pendingByAccount.get(h.id) ?? null}
                    />
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
