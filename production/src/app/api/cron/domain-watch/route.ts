/**
 * GET|POST /api/cron/domain-watch — check watched names, and tell whoever asked.
 *
 * Schedule: once a day. `lib/domains/watch.ts` holds every decision this route
 * makes; the route is the wiring, which is the split the rest of this repo uses
 * (`lifecycle.ts` beside `asset-sweep`) because the arithmetic is the part worth
 * testing and a cron route is the part that cannot be.
 *
 * ─── THE ONE THING THAT MUST NOT HAPPEN ──────────────────────────────────────
 * A "acme.com is free!" email about a name that is not free. The customer tries
 * to buy it, fails, and stops trusting anything else we send — including the
 * expiry warnings, which are the ones that cost money to ignore. So:
 *
 *   · `shouldNotify` requires a POSITIVE `available` reading. An unreachable
 *     registrar, an unparseable answer and RC's concatenated-key case are all
 *     UNKNOWN, and unknown never sends.
 *   · The claim is the notification. `notified_at` is stamped BEFORE the email,
 *     conditionally on it still being null — so two Cloud Run instances racing
 *     cannot both send. If the send then fails the stamp is rolled back, because
 *     a watch nobody was told about is a feature that silently did not work.
 *   · The send goes through `sendEmail`'s automated gate (`watch.send`), so it
 *     obeys the kill switch and the dial like every other unattended send.
 *
 * ─── WHY IT ASKS RESELLERCLUB AND NOT A WHOIS ────────────────────────────────
 * `rcAvailability` is the same call the shop's search box makes, so a watch and
 * a search cannot disagree about the same name — which they would if this used a
 * second source. It also already handles RC's concatenated-key answer, which a
 * fresh caller here would have had to learn the hard way.
 */
import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { sendEmail } from "@/lib/email/send";
import { rcConfigured, rcAvailability } from "@/lib/resellerclub";
import {
  shouldCheck,
  shouldNotify,
  statusFromReading,
  applyCheck,
  splitDomain,
  type WatchStatus,
} from "@/lib/domains/watch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Per run. A backlog drains over several days rather than one long request. */
const BATCH = 60;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://app.resellersos.in";
const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "onboarding@resend.dev";

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

  const result = {
    ran_at: new Date().toISOString(),
    considered: 0,
    checked: 0,
    skipped: 0,
    notified: 0,
    unreadable: 0,
    details: [] as { domain: string; outcome: string }[],
  };

  if (!rcConfigured()) {
    /* No credentials (every local machine). Reported rather than silently
       counted as "nothing to do" — a sweep that cannot check anything and says
       it ran is how a dead feature looks healthy. */
    return NextResponse.json({ ...result, skipped_reason: "ResellerClub is not configured in this environment" });
  }

  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("domain_watches")
    .select("id, tenant_id, customer_id, domain_name, last_checked_at, last_status, notified_at, consecutive_errors")
    .is("notified_at", null)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);

  if (error) {
    console.error("[domain-watch] could not read watches:", error.message);
    return NextResponse.json({ ...result, error: "could not read watches" }, { status: 500 });
  }

  result.considered = (rows ?? []).length;

  for (const row of rows ?? []) {
    const note = (outcome: string) => result.details.push({ domain: row.domain_name, outcome });

    const decision = shouldCheck(row, new Date());
    if (decision.kind === "skip") {
      result.skipped++; note(`skipped — ${decision.reason}`);
      continue;
    }

    const parts = splitDomain(row.domain_name);
    if (!parts) {
      /* The CHECK constraint keeps the name non-empty and lowercase but does not
         require a dot, and `watchableDomain` guards the entry point rather than
         the table. A row that cannot be split is recorded as unknown so it burns
         its error budget and retires, instead of being retried forever. */
      await admin.from("domain_watches")
        .update(applyCheck(row, "unknown", { error: "not a domain name that can be checked" }))
        .eq("id", row.id);
      result.unreadable++; note("unreadable name");
      continue;
    }

    const reading = await rcAvailability(parts.name, [parts.tld]);
    /* `rcAvailability` returns null for "upstream unreachable or errored", and an
       entry with `available: null` for "answered, but not usefully about this
       name". Both are UNKNOWN here — see statusFromReading. */
    const entry = reading?.find((r) => r.domain === row.domain_name) ?? null;
    const status: WatchStatus = reading === null ? "unknown" : statusFromReading(entry);

    result.checked++;

    const notify = shouldNotify(row, status);
    if (!notify.notify) {
      await admin.from("domain_watches")
        .update(applyCheck(row, status, { error: status === "unknown" ? notify.reason : null }))
        .eq("id", row.id);
      note(`${status} — not notifying: ${notify.reason}`);
      continue;
    }

    /* ── The claim IS the notification ──────────────────────────────────────
       Stamped before the send and conditional on `notified_at` still being null,
       so two instances racing cannot both email. Same shape as the insert-as-claim
       in provision-domain. */
    const { data: claimed } = await admin
      .from("domain_watches")
      .update(applyCheck(row, status, { notified: true }))
      .eq("id", row.id)
      .is("notified_at", null)
      .select("id")
      .maybeSingle();

    if (!claimed) {
      result.skipped++; note("another run claimed the notification");
      continue;
    }

    const { data: customer } = await admin
      .from("customers")
      .select("name, contact_name, contact_email")
      .eq("id", row.customer_id)
      .maybeSingle();

    /* `customers.name` is the BUSINESS; `contact_name` is the person and
       `contact_email` is where mail goes. The business name is NOT a fallback
       for the greeting — "Good news, Acme Technologies Pvt Ltd" reads like a
       mailshot, which is the wrong tone for something the customer asked for. */
    const greetName = customer?.contact_name?.trim() || null;

    if (!customer?.contact_email) {
      /* Nothing to send to. The claim stands — re-checking daily would not
         produce an address, and the row has done its job by recording that the
         name came free. Visible in the run detail rather than silent. */
      note(`${row.domain_name} is available but the customer has no email address on file`);
      continue;
    }

    const sent = await sendEmail({
      to: customer.contact_email,
      from: FROM_EMAIL,
      kind: "domain_watch_available",
      subject: `${row.domain_name} is available`,
      text:
        `Good news${greetName ? `, ${greetName}` : ""} —\n\n` +
        `${row.domain_name}, which you asked us to watch, is available to register right now.\n\n` +
        `Domain names go quickly once they are released, so it is worth acting today:\n` +
        `${APP_URL}/portal/shop?q=${encodeURIComponent(row.domain_name)}\n\n` +
        `We checked this a few minutes ago. If somebody else registers it first it will show as taken — ` +
        `we are telling you as soon as we saw it free, which is the most notice we can give.\n\n` +
        `This was a one-off alert for this name, so you will not hear from us about it again.`,
      /* The gate every unattended send in this app goes through. Without this the
         kill switch would not stop it, and autonomy-chokepoint.test.ts scans for
         exactly that omission. */
      automated: { tenantId: row.tenant_id, action: "watch.send" },
    }).catch((e) => {
      console.error(`[domain-watch] send failed for ${row.domain_name}:`, (e as Error).message);
      return null;
    });

    if (!sent) {
      /* Roll the claim back. A watch marked notified whose email never left is
         worse than a duplicate: the customer never learns, and the row will
         never be checked again. */
      await admin.from("domain_watches")
        .update({ notified_at: null, last_error: "the alert email could not be sent — will try again" })
        .eq("id", row.id);
      note(`${row.domain_name} is available but the email failed — claim released, will retry`);
      continue;
    }

    result.notified++; note(`${row.domain_name} is AVAILABLE — customer told`);
  }

  console.log(
    `[domain-watch] considered ${result.considered}, checked ${result.checked}, notified ${result.notified}, skipped ${result.skipped}`,
  );
  return NextResponse.json(result);
}

export async function GET(req: Request) { return handle(req); }
export async function POST(req: Request) { return handle(req); }
