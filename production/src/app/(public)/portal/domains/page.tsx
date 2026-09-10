/**
 * /portal/domains — the domains this customer owns.
 *
 * Until migration 20260908100000 there was nothing to put on this page: a
 * registered domain was not recorded anywhere a customer could be shown it. It
 * reads `domains`, which is the REGISTRAR's truth (what exists, and when it
 * expires up there) — not the billing schedule, which lives on `subscriptions`.
 *
 * ─── WHAT THIS PAGE IS FOR ───────────────────────────────────────────────────
 * One question, above all others: **is anything about to lapse?** A domain that
 * expires is released and can be taken by anybody, and unlike a lapsed seat it
 * cannot be bought back at the old price — sometimes not at all. So expiry is
 * the loudest thing here, sorted first, and stated in days rather than a date
 * the reader has to subtract from today.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * There is no auto-renew toggle. That is migration 0063's decision, not an
 * omission: with no stored-card autopay, a switch marked "auto-renew" promises
 * a charge that cannot happen, and a customer who trusts it loses the name.
 * Renewal is a conversation, so the page routes to one.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { expiryPhrase, summariseExpiries, type ExpiryUrgency } from "@/lib/domains/lifecycle";
import { MAX_WATCHES_PER_CUSTOMER } from "@/lib/domains/watch";
import { DomainWatches } from "../_components/domain-watches";
import type { DomainAssetStatus } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

type BadgeKind = "success" | "warning" | "danger" | "info" | "muted";

/**
 * How the registrar's word is shown. `grace` and `redemption` are ICANN states
 * with a deadline and a fee attached — collapsing them into "expired" would
 * hide the one fact that matters, which is that the name can still be saved.
 */
const STATUS: Record<DomainAssetStatus, { label: string; kind: BadgeKind }> = {
  active:          { label: "Active",          kind: "success" },
  pending:         { label: "Registering",     kind: "info"    },
  expiring_soon:   { label: "Expiring soon",   kind: "warning" },
  grace:           { label: "In grace period", kind: "danger"  },
  redemption:      { label: "Redemption",      kind: "danger"  },
  suspended:       { label: "Suspended",       kind: "danger"  },
  transferred_out: { label: "Transferred out", kind: "muted"   },
  failed:          { label: "Failed",          kind: "danger"  },
  cancelled:       { label: "Cancelled",       kind: "muted"   },
};

/**
 * How an expiry is coloured. The phrase itself comes from
 * `lib/domains/lifecycle.ts` — it is arithmetic about a deadline, which is worth
 * testing, and it used to fall back to printing the same date as the column next
 * to it. This is only the paint.
 */
const URGENCY_TEXT: Record<ExpiryUrgency, string> = {
  lapsed:   "text-rose-ink",
  critical: "text-rose-ink",
  soon:     "text-amber-ink",
  calm:     "text-ink-2",
  unknown:  "text-ink-3",
};

export default async function PortalDomainsPage() {
  const session  = await requirePortalSession();
  const reseller = session.tenantContactName ?? session.tenantName;
  const supabase = createClient();

  /* RLS scopes this to the signed-in customer (policy
     `domains_select_own_customer`), so there is no customer_id filter here —
     one definition of "yours", and it lives in the database. */
  const { data } = await supabase
    .from("domains")
    .select("id, domain_name, status, expires_at, registered_at, auto_renew, nameservers, privacy_protection, registration_years")
    .order("expires_at", { ascending: true, nullsFirst: false });

  /* The customer's watches, read here so the island below renders with them
     already on screen. RLS scopes this to the signed-in customer the same way
     the domains query above is scoped — `domain_watches_own_select`. */
  const { data: watchData } = await supabase
    .from("domain_watches")
    .select("id, domain_name, last_status, last_checked_at, notified_at")
    .order("created_at", { ascending: false });

  const rows = data ?? [];
  /* Lapsed and expiring-soon are counted apart, because they need different
     sentences: one has already happened. Counting them together is how the
     banner came to tell a customer a domain "expires within 30 days" twelve
     days after it had in fact lapsed. */
  const { lapsed, expiringSoon } = summariseExpiries(rows, new Date());

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Your Domains</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every domain registered on your account, and when each one is due to renew.
        </p>
      </div>

      {/* The one thing worth interrupting for. §24: says what, why, and where to go.
          Two banners rather than one, because a name that has ALREADY lapsed is a
          different situation with a different deadline — it can usually still be
          recovered, but only for a while and usually for a fee. Telling somebody
          it "expires within 30 days" would be both untrue and reassuring. */}
      {lapsed > 0 && (
        <Card className="p-4 mb-3 border-rose/40 bg-rose-soft/30">
          <p className="text-sm text-ink-2">
            <b>{lapsed === 1 ? "1 domain has already expired." : `${lapsed} domains have already expired.`}</b>{" "}
            An expired name can usually still be recovered, but not for long and often for a
            fee — after that it is released and anybody can register it.{" "}
            <Link href="/portal/support/new" className="text-rose-ink underline">
              Ask {reseller} about recovering it →
            </Link>
          </p>
        </Card>
      )}

      {expiringSoon > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <p className="text-sm text-ink-2">
            <b>{expiringSoon === 1 ? "1 domain expires" : `${expiringSoon} domains expire`} within 30 days.</b>{" "}
            A domain that lapses is released and someone else can register it.{" "}
            <Link href="/portal/support/new" className="text-rose-ink underline">
              Ask {reseller} to renew →
            </Link>
          </p>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-ink-3">
            No domains on your account yet. A domain you buy appears here within a few
            minutes of the payment clearing.
          </p>
          <Link href="/portal/shop" className="inline-block mt-4 text-sm text-amber-ink underline">
            Search for a domain →
          </Link>
        </Card>
      ) : (
        <>
          {/* Phone: card list (§20 — the portal is a phone-first surface). */}
          <ul className="md:hidden space-y-3">
            {rows.map((d) => {
              const e = expiryPhrase(d.expires_at);
              const s = STATUS[d.status] ?? STATUS.pending;
              return (
                <li key={d.id}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-mono text-sm text-ink break-all">{d.domain_name}</p>
                      <Badge kind={s.kind} dot>{s.label}</Badge>
                    </div>
                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div>
                        <p className="text-3xs uppercase tracking-wider text-ink-3">Renews</p>
                        <p className={`text-sm font-medium ${URGENCY_TEXT[e.urgency]}`}>
                          {e.text}
                        </p>
                      </div>
                      {/* The absolute date, next to the relative phrase — they
                          complement each other. When there is no date the phrase
                          already says so, and repeating it here was the other half
                          of the duplicate-value finding. */}
                      {d.expires_at && <p className="text-2xs text-ink-3">{formatDate(d.expires_at)}</p>}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>

          <Card className="overflow-hidden hidden md:block">
            {/* Wide content scrolls inside its own container, never the page. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                  <tr>
                    <th className="text-left px-4 py-3">Domain</th>
                    <th className="text-left px-4 py-3">Status</th>
                    {/* These two carry short phrases and a date. Left to wrap they
                        break mid-phrase ("in about 10 / months") while the Domain
                        column keeps its width — so they hold their line and the
                        squeeze lands on Domain, which is the one that should absorb
                        it: a 43-character name wrapping reads fine, a countdown
                        broken in half does not. */}
                    <th className="text-left px-4 py-3 whitespace-nowrap">Renews</th>
                    <th className="text-left px-4 py-3 whitespace-nowrap">Expiry date</th>
                    <th className="text-left px-4 py-3">Privacy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {rows.map((d) => {
                    const e = expiryPhrase(d.expires_at);
                    const s = STATUS[d.status] ?? STATUS.pending;
                    return (
                      <tr key={d.id} className="hover:bg-paper-2/40">
                        <td className="px-4 py-3 font-mono text-ink">{d.domain_name}</td>
                        <td className="px-4 py-3"><Badge kind={s.kind} dot>{s.label}</Badge></td>
                        <td className={`px-4 py-3 font-medium whitespace-nowrap ${URGENCY_TEXT[e.urgency]}`}>
                          {e.text}
                        </td>
                        <td className="px-4 py-3 text-ink-3 whitespace-nowrap">
                          {d.expires_at ? formatDate(d.expires_at) : "—"}
                        </td>
                        <td className="px-4 py-3 text-ink-3">
                          {d.privacy_protection ? "On" : "Off"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* Watching a name is offered whether or not they own any domains — somebody
          with nothing registered yet is exactly the person who wanted a name that
          was taken. */}
      <DomainWatches initial={watchData ?? []} limit={MAX_WATCHES_PER_CUSTOMER} />

      {rows.length > 0 && (
        <p className="mt-4 text-2xs text-ink-3">
          Renewals are handled by {reseller} — there is no card stored on your account, so
          nothing is charged automatically.{" "}
          <Link href="/portal/support/new" className="underline">Raise a request</Link> to renew,
          transfer, or change where a domain points.
        </p>
      )}
    </div>
  );
}
