/**
 * GET|POST /api/cron/domain-expiry — tell somebody before a domain lapses.
 *
 * Schedule: 09:30 IST, once a day. AFTER `asset-sweep` at 08:00, and the order is
 * load-bearing: asset-sweep is what refreshes `domains.expires_at` from the
 * registrar, so running first would warn people from dates that are up to a day
 * stale — including warning about a domain that was renewed yesterday.
 *
 * ─── THE GAP THIS FILLS, MEASURED 11 SEP 2026 ───────────────────────────────
 * Nothing in this codebase told anybody a domain was expiring. asset-sweep kept
 * the dates accurate and notified nobody; the only place a customer could find
 * out was by opening /portal/domains of their own accord. In this database:
 *
 *   acme-legacy.net   grace    2026-09-01   lapsed nine days ago, nobody told
 *   acmecorp.com      active   2026-09-21   eleven days left, nobody told
 *
 * ─── IT SENDS AND DOES NOT SELL ─────────────────────────────────────────────
 * The email carries no price and no payment link, and that is deliberate rather
 * than unfinished. A renewal is priced from the rate card at the moment a quote
 * is raised, so a figure in a warning would be a number the quote then
 * contradicts — the mistake `seat-request.ts` documents and that the hosting
 * upgrade avoids. The customer is told to reply or open the portal; the reseller
 * quotes.
 *
 * It also SPENDS NOTHING. `rcRenewDomain` is not imported here. Filing a renewal
 * at the registrar costs money from the reseller's wallet and belongs on the path
 * where the customer has already paid — the same rule `asset-sweep`'s header
 * states for itself.
 *
 * ─── THE CLAIM IS THE NOTIFICATION ──────────────────────────────────────────
 * The `domain_renewal_notices` row is inserted BEFORE the email goes, and the
 * unique index `(domain_id, step, term_expires_at)` is what makes the insert the
 * claim. Two Cloud Run instances running this minute cannot both send: the second
 * insert violates the index and that instance moves on.
 *
 * And the claim is RELEASED when the mail does not actually go, which is the
 * opposite of what this file said on its first draft. That draft argued the row
 * should stand because "re-sending tomorrow would be a duplicate" — an argument
 * that only holds for an email that WENT. Nothing is duplicated by retrying a
 * send that never left, and a notice row claiming we warned a customer we did not
 * is the one lie this table exists to prevent.
 *
 * Caught by running it: with no Resend key, all three sends came back
 * `status: "failed"`, `email_log` recorded them as failed, and the notice rows
 * were stamped `sent_at` regardless. The cause was `if (!sent)` — `sendEmail`
 * always returns an OBJECT, so that test only ever catches a thrown exception,
 * never a failed send. `domain-watch` had the identical bug, which means its own
 * claim-rollback had never once fired.
 *
 * ─── WHICH NOTICE IS NOT DECIDED HERE ───────────────────────────────────────
 * `noticeDueFor` decides, in `lib/domains/renewal-notice.ts`, with its own tests
 * and five killed mutations. The cadence has one rule that is easy to get wrong
 * and invisible when wrong — a domain first seen inside the 7-day window must get
 * ONE notice, not the 30, the 14 and the 7 in the same minute — and the first
 * version of that function got it wrong in the other direction, sending "expires
 * in 30 days" to somebody with 11 days left.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { localDateISO } from "@/lib/leads/outcomes";
import {
  noticeDueFor,
  noticeSubject,
  type DomainNoticeStatus,
  type RenewalNoticeStep,
} from "@/lib/domains/renewal-notice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "onboarding@resend.dev";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://app.resellersos.in";

/** Per run. A backlog drains over several days rather than one long request. */
const BATCH = 100;

/** The widest window `noticeDueFor` acts on, plus slack for lapsed rows. */
const LOOKAHEAD_DAYS = 30;

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (timingSafeEqualStr(m?.[1] ?? "", secret)) return true;
  }
  try {
    const supabase = createClient();
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) return false;
    const { data: me } = await supabase.from("users").select("role").eq("id", authData.user.id).single();
    return me?.role === "owner";
  } catch {
    return false;
  }
}

async function handle(req: Request): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const today = localDateISO(new Date());
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + LOOKAHEAD_DAYS);

  const result = {
    ran_at: new Date().toISOString(),
    considered: 0,
    sent: 0,
    /* Named, not counted — an operator has to know WHICH customer was warned. */
    notices: [] as Array<{ domain: string; step: string; to: string }>,
    no_email: [] as string[],
    failed: [] as Array<{ domain: string; step: string; reason: string }>,
    nothing_due: 0,
    owner_alerts: 0,
  };

  /* Everything inside the widest window, plus everything already past it.
     `expires_at <= horizon` covers both — a lapsed domain's date is in the past,
     so it is inside any future horizon. */
  const { data: rows } = await admin
    .from("domains")
    .select("id, tenant_id, customer_id, domain_name, status, expires_at")
    .is("deleted_at", null)
    .not("expires_at", "is", null)
    .lte("expires_at", horizon.toISOString())
    .order("expires_at", { ascending: true })
    .limit(BATCH);

  for (const row of rows ?? []) {
    result.considered++;
    const term = (row.expires_at ?? "").slice(0, 10);

    /* Steps already sent for THIS term. Keyed on the term, not the domain — see
       the migration: a renewal moves the expiry and the cadence starts again. */
    const { data: already } = await admin
      .from("domain_renewal_notices")
      .select("step")
      .eq("domain_id", row.id)
      .eq("term_expires_at", term);

    const due = noticeDueFor({
      expiresAt: row.expires_at,
      status: row.status as DomainNoticeStatus,
      today,
      alreadySent: (already ?? []).map((a) => a.step as RenewalNoticeStep),
    });

    if (!due) {
      result.nothing_due++;
      continue;
    }

    const { data: customer } = row.customer_id
      ? await admin
          .from("customers")
          .select("contact_email, contact_name, name")
          .eq("id", row.customer_id)
          .maybeSingle()
      : { data: null };

    const to = customer?.contact_email?.trim();
    if (!to) {
      /* No address, so no claim — unlike domain-watch, which claims anyway.
         The difference is that an address CAN appear before the next step comes
         round, and burning the claim would silence the whole remaining cadence
         for a customer whose email is added tomorrow. */
      result.no_email.push(`${row.domain_name} (${due.step})`);
      continue;
    }

    const subject = noticeSubject(row.domain_name, due);

    /* ─── THE CLAIM. Insert first; the unique index is the lock. ───────────── */
    const { error: claimErr } = await admin.from("domain_renewal_notices").insert({
      tenant_id: row.tenant_id,
      domain_id: row.id,
      step: due.step,
      term_expires_at: term,
      recipient_email: to,
      subject,
    });
    if (claimErr) {
      /* 23505 is another instance getting there first this minute. Not an error
         worth reporting — the customer is being told by that one. */
      if (claimErr.code !== "23505") {
        console.error(`[domain-expiry] could not claim ${row.domain_name}/${due.step}:`, claimErr.message);
        result.failed.push({ domain: row.domain_name, step: due.step, reason: claimErr.message });
      }
      continue;
    }

    const greet = customer?.contact_name?.trim()?.split(" ")[0] || null;
    const when = due.alreadyLapsed
      ? `expired on ${term}`
      : due.daysLeft <= 1
        ? "expires tomorrow"
        : `expires in ${due.daysLeft} days, on ${term}`;

    const body = due.alreadyLapsed
      ? `Hi${greet ? ` ${greet}` : ""},\n\n` +
        `${row.domain_name} ${when} and is now in its grace period. The website and any email on ` +
        `it may already have stopped working.\n\n` +
        `It can still be renewed — but not indefinitely. Once the grace period ends the name is ` +
        `released and anybody can register it, and getting it back after that is not something we ` +
        `can promise.\n\n` +
        `Reply to this email and we will send you the renewal cost straight away.\n\n` +
        `Your domains: ${APP_URL}/portal/domains`
      : `Hi${greet ? ` ${greet}` : ""},\n\n` +
        `${row.domain_name} ${when}.\n\n` +
        `If you want to keep it, reply to this email and we will send you the renewal cost. ` +
        `Renewing before the expiry date avoids any interruption — once a domain lapses the ` +
        `website and the email on it stop, and there is a limited window to get it back.\n\n` +
        `If you would rather let it go, no reply is needed.\n\n` +
        `Your domains: ${APP_URL}/portal/domains`;

    const outcome = await sendEmail({
      to,
      from: FROM_EMAIL,
      kind: "domain_expiry_notice",
      subject,
      text: body,
      route: { tenantId: row.tenant_id },
      /* The gate every unattended send in this app goes through. Without it the
         kill switch would not stop this cron, and autonomy-chokepoint.test.ts
         scans for exactly that omission. */
      automated: { tenantId: row.tenant_id, action: "renewal.send" },
    }).catch((e) => {
      console.error(`[domain-expiry] send failed for ${row.domain_name}:`, (e as Error).message);
      return null;
    });

    /* `status`, not truthiness. See the header — `sendEmail` returns an object on
       every path, so `if (!outcome)` reads only the thrown-exception case and
       treats a FAILED send as a success. `stubbed` counts as not-sent too: it
       means this deployment has no mail provider, so nothing left the building
       and the customer has not been warned. */
    if (!outcome || outcome.status !== "sent") {
      /* Release the claim, so tomorrow tries again. Nothing is duplicated by
         retrying a send that never went. */
      await admin
        .from("domain_renewal_notices")
        .delete()
        .eq("domain_id", row.id)
        .eq("step", due.step)
        .eq("term_expires_at", term);
      const reason = !outcome
        ? "send threw"
        : outcome.status === "stubbed"
          ? "no email provider is configured in this environment"
          : outcome.errorMessage || "send failed";
      result.failed.push({ domain: row.domain_name, step: due.step, reason });
      continue;
    }

    await admin
      .from("domain_renewal_notices")
      .update({ sent_at: new Date().toISOString() })
      .eq("domain_id", row.id)
      .eq("step", due.step)
      .eq("term_expires_at", term);

    result.sent++;
    result.notices.push({ domain: row.domain_name, step: due.step, to });

    /* ─── THE OPERATOR HEARS ABOUT A LAPSE, AND ONLY A LAPSE ───────────────
       The countdown steps are the customer's business and an alert per domain
       per step would be noise the reseller learns to filter. A domain that has
       actually lapsed is different: somebody has to pick up the phone, and the
       grace window is finite. */
    if (due.alreadyLapsed) {
      const owner = await loadOwnerAlert(admin, row.tenant_id).catch(() => null);
      if (owner?.alert.ok && owner.alert.to) {
        const alerted = await sendEmail({
          to: owner.alert.to,
          from: FROM_EMAIL,
          kind: "domain_expiry_owner",
          subject: `${row.domain_name} has LAPSED — grace period running`,
          text:
            `${row.domain_name} expired on ${term} and is in its grace period.\n\n` +
            `Customer: ${customer?.name ?? "unknown"} (${to})\n` +
            `They have been emailed once about it.\n\n` +
            `The grace window is finite and the name is released when it ends. If they want it, ` +
            `raise the renewal now: ${APP_URL}/assets/domains\n`,
          route: { tenantId: row.tenant_id },
          automated: { tenantId: row.tenant_id, action: "renewal.send" },
        }).catch(() => null);
        if (alerted?.status === "sent") result.owner_alerts++;
      }
    }
  }

  return NextResponse.json({ ran: true, ...result });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
