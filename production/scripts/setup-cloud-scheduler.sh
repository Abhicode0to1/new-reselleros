#!/usr/bin/env bash
#
# Cloud Scheduler jobs for every ResellerOS cron endpoint.
#
# ─── IT SAID "SIX", AND THERE WERE 22 ────────────────────────────────────
# 11 Sep 2026: counted. The app has 22 cron routes; this file declared 12. The ten
# that were missing had been added since it was written, and each one was the same
# failure this file exists to prevent — "a job that looks configured, is documented
# as scheduled, and never runs".
#
# Four of the ten were the domain and hosting path, end to end:
#
#   provision-domain    a customer PAYS and nothing registers the name
#   provision-hosting   the same for a hosting account
#   asset-sweep         expiry dates never refresh, so the portal's "12d left" is
#                       true on the day of purchase and drifts from the next morning
#   domain-watch        watched names are never checked, so no alert ever fires
#
# The first of those is the worst thing in the list: money taken, nothing delivered,
# and no error anywhere because the job that would have done the work was never
# asked to run.
#
# ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
# The repo carries a vercel.json with a `crons` block, and three of the six cron
# routes document their schedule as "set via vercel.json". The live deployment is
# CLOUD RUN. Vercel crons are a Vercel platform feature — they do not exist on
# Cloud Run, so nothing in that file schedules anything here.
#
# The effect is the failure mode this codebase keeps producing: a job that looks
# configured, is documented as scheduled, and never runs. Nothing errors, no log
# line appears, and the first sign is a renewal that lapsed or a statutory
# deadline that passed.
#
# Two of the six are not even in vercel.json (trial-expiry, attendance-retention),
# and compliance-reminders was added later — so on Vercel they would be missed
# too. This file is the single place all six are declared for the platform that
# is actually running.
#
# ─── BEFORE YOU RUN IT ───────────────────────────────────────────────────────
# See what already exists — birthday-greetings names a Cloud Scheduler job in its
# own comments, so some jobs may already be set up by hand:
#
#   gcloud scheduler jobs list --location=asia-south1
#
# This script CREATES missing jobs and SKIPS ones that already exist, so it is
# safe to re-run and cannot disturb a job that is working. Set UPDATE_EXISTING=1
# only when you mean to overwrite every job — rotating CRON_SECRET is the case
# that calls for it.
#
#   chmod +x scripts/setup-cloud-scheduler.sh
#   CRON_SECRET='<the same value the service runs with>' ./scripts/setup-cloud-scheduler.sh
#
# The secret must MATCH what the Cloud Run service has, or every job gets 401 and
# you are back to jobs that appear scheduled and do nothing.

set -euo pipefail

REGION="${REGION:-asia-south1}"
SERVICE_URL="${SERVICE_URL:-https://resellersos-1005662057478.asia-south1.run.app}"
# Schedules are written in IST. Cloud Scheduler does the UTC conversion, and
# daylight saving does not apply in India — so these read exactly as intended,
# which UTC cron expressions do not.
TZ_NAME="${TZ_NAME:-Asia/Kolkata}"

if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "CRON_SECRET is not set. Export the same value the Cloud Run service uses:" >&2
  echo "  CRON_SECRET='…' $0" >&2
  exit 2
fi

# name | schedule (IST) | path | description
JOBS=(
  "resellersos-renewals|0 9 * * *|/api/cron/renewals|Renewal cadence: T-30/15/12/9/6/3/0, grace, auto-suspend"
  # 09:15 IST — AFTER the renewal cron, deliberately. Renewals can settle a payment
  # and mark an invoice paid; dunning running first would chase money that was about
  # to be recorded, and a customer chased for an invoice they already paid stops
  # reading these emails entirely.
  "resellersos-invoice-dunning|15 9 * * *|/api/cron/invoice-dunning|Overdue-invoice dunning: day 1/3/7/14 from due date"
  # 1st of the month, 00:30 IST — after the midnight backup and before the day's
  # jobs touch anything, so the snapshot describes the month that just ended rather
  # than one already half-modified by a renewal run.
  "resellersos-mrr-snapshot|30 0 1 * *|/api/cron/mrr-snapshot|Monthly MRR per customer — the history NRR is computed from"
  "resellersos-compliance-reminders|30 9 * * *|/api/cron/compliance-reminders|Statutory reminders T-15/T-7/T-3 to owner + CA"
  "resellersos-trial-expiry|0 10 * * *|/api/cron/trial-expiry|Expire trials that have run out"
  "resellersos-birthday-greetings|1 21 * * *|/api/cron/birthday-greetings|Birthday and anniversary greetings"
  "resellersos-google-contacts-sync|0 */6 * * *|/api/cron/google-contacts-sync|Two-way Google Contacts sync"
  "resellersos-attendance-retention|0 2 * * *|/api/cron/attendance-retention|Erase attendance face images past retention"
  # Midnight IST, before the other jobs touch anything — a restore point of the
  # day that just ended, not of a day already half-modified by the 09:00 renewal
  # cron. Keeps the newest 30 per tenant (0244).
  "resellersos-backup|0 0 * * *|/api/cron/backup|Nightly restore point for every tenant"
  # HOURLY, and the only job here that is not daily. The AI sales agent schedules its
  # follow-ups in HOURS (SALES_AGENT_SCHEMA bounds in_hours at 1..720), so a daily sweep
  # would round every "chase them this afternoon" up to tomorrow and make the shortest
  # useful follow-up impossible to express.
  #
  # Business hours only (09:00–19:00 IST, Mon–Sat). A nudge landing at 03:00 reads as a
  # machine no matter how well it is written, and Sunday mail to an Indian SME owner is
  # worse than no mail. The rows do not expire — anything that came due overnight is
  # picked up by the 09:00 run.
  #
  # Safe to enable before anybody trusts it: `followup.send` ships as `hold`, so until
  # somebody moves that dial from /automation this job drafts onto lead timelines and
  # sends nothing.
  "resellersos-ai-sales-loop|0 9-19 * * 1-6|/api/cron/ai-sales-loop|AI sales agent follow-ups that have come due"
  # EVERY 15 MINUTES, and ROUND THE CLOCK — the only job here that is both.
  #
  # The frequency is set by the cheaper of its two halves, not the more important one. The
  # 48-hour auto-close would be happy running daily; the "an escalated ticket has been
  # nobody's for 30 minutes" alert cannot be kept by an hourly sweep, because the alert
  # would land anywhere between 30 and 90 minutes late and the number in it would be a
  # fiction. A support promise people learn to distrust is worse than no promise.
  #
  # No business-hours window, unlike the sales follow-up above. Both halves are INTERNAL:
  # closing a ticket for silence is a state change on our own row, and the breach alert goes
  # to our own desk. Nothing here mails a customer, so there is no 03:00 message to be
  # embarrassed by — and a Saturday-night outage escalation nobody was told about until
  # Monday is exactly the failure this job exists to prevent.
  #
  # Safe to enable immediately, and it is NOT gated by the autonomy dial for the reason
  # above: the dial stops what the app sends OUT to other people, and must never be able to
  # silence what the app says TO US.
  "resellersos-ai-support-sla|*/15 * * * *|/api/cron/ai-support-sla|Close silent support tickets; alert on unassigned escalations"
  # 10:30 IST, once a day, weekdays only — and every part of that is deliberate.
  #
  # ONCE: the job selects subscriptions renewing on an EXACT date five days out, so each one
  # is a candidate exactly once. A second run the same day would find the same cohort and,
  # were it not for the 24-hour gap in decideTelecall, ring them twice.
  #
  # 10:30, not 09:00 like the mail crons: this one RINGS A PHONE. Nine in the morning is
  # somebody's commute. It also has to sit inside the quiet-hours window the app already
  # obeys (09:00–19:00 IST) with room to spare, because a run that starts near the edge of
  # that window has its later calls refused by the clock.
  #
  # Mon–Fri, not Mon–Sat: quietHoursDecision treats Saturday as a weekend and would refuse
  # every call, so a Saturday entry would be a job that exists to be turned down.
  #
  # Safe to enable before anybody trusts it: `telecall.place` ships as `hold`, so until
  # somebody moves that dial from /automation this job prepares each call — number, script,
  # the figures it is allowed to quote — files it on the call record, and dials nothing.
  "resellersos-ai-telecall-renewals|30 10 * * 1-5|/api/cron/ai-telecall-renewals|AI voice reminder for subscriptions renewing in 5 days"
  # ── The domain and hosting path ─────────────────────────────────────
  #
  # EVERY 5 MINUTES, and that is the point: the customer has already paid. A daily
  # sweep would mean somebody buys a domain in the morning and it appears tomorrow,
  # which reads as a broken shop. Five minutes is as close to immediate as a cron
  # gets, and the ceiling it puts on ResellerClub is 12 calls an hour even with a
  # backlog.
  #
  # Safe at this frequency because the INSERT is the claim: `domains_name_unique` is
  # a global unique index, so a second worker reaching the same name loses the
  # insert and skips. Overlapping runs cannot double-order.
  #
  # And safe to schedule BEFORE the money gate is open: without
  # DOMAIN_REGISTER_LIVE=1 the route refuses every order and reports why, so this
  # job can be in place waiting rather than remembered later.
  "resellersos-provision-domain|*/5 * * * *|/api/cron/provision-domain|Register paid domains at ResellerClub"
  "resellersos-provision-hosting|*/5 * * * *|/api/cron/provision-hosting|Create paid hosting accounts on DirectAdmin"
  # 08:00 IST — BEFORE the 09:00 renewal cron, and the ordering is the reason for the
  # time. Renewals decide what to chase from `expires_at`; this sweep is what makes
  # `expires_at` true. Run the other way round and every renewal decision is made on
  # yesterday's arithmetic. Same argument as dunning sitting after renewals below.
  "resellersos-asset-sweep|0 8 * * *|/api/cron/asset-sweep|Refresh domain/hosting expiry and status from the registrar"
  # 11:00 IST, once a day. Once, because lib/domains/watch.ts checks a watch at most
  # every 24h and a second run would find nothing to do. 11:00 rather than the 09:00
  # block: this one mails a CUSTOMER good news about a name they wanted, and it is
  # the only mail they get from us that is not about money — worth its own slot
  # rather than arriving in the same minute as an invoice reminder.
  "resellersos-domain-watch|0 11 * * *|/api/cron/domain-watch|Check watched domain names and tell the customer when one frees up"

  # EVERY 15 MINUTES, and that is the shortest interval in this file. It is not
  # eagerness. `refund_payment` suspends hosting when a refund takes the last of
  # the money off a quote, but a database transaction cannot call DirectAdmin, so
  # between the refund and this run the state is: money returned, our records say
  # suspended, and the customer's website is still serving. Daily would leave a
  # site up for up to 24 hours after it was paid back for. Fifteen minutes is
  # short enough that nobody has to think about the gap, and the run is free when
  # the queue is empty (one indexed read, no writes).
  "resellersos-hosting-suspend|*/15 * * * *|/api/cron/hosting-suspend|Suspend or restore hosting on DirectAdmin to match our record"

  # 09:30 IST, once a day, and the 08:00 asset-sweep MUST have run first. That job
  # is what refreshes domains.expires_at from the registrar; warning people before
  # it runs means warning them from dates up to a day stale — including a customer
  # whose domain was renewed yesterday. 90 minutes is slack for a slow sweep.
  #
  # Once a day and not more: the cadence is 30/14/7/1 days and lapsed, one notice
  # per step per term, so a second run the same day would find nothing to do.
  "resellersos-domain-expiry|30 9 * * *|/api/cron/domain-expiry|Warn a customer before their domain lapses (and the owner once it has)"

  # EVERY 30 MINUTES. A customer who has just paid to renew a domain is waiting,
  # and the gap between their payment and the registrar being told is a gap in
  # which the domain can lapse. Not */15 like hosting-suspend: each item here is
  # a live purchase and a read before it, so the run is not free, and a renewal
  # is never as urgent as a site that is up when the books say it is off.
  #
  # It files nothing unless DOMAIN_REGISTER_LIVE=1 and the credentials are set —
  # with the gate shut it writes nothing and leaves the queue intact.
  "resellersos-domain-renew|*/30 * * * *|/api/cron/domain-renew|File a PAID domain renewal at ResellerClub"

  # ── The rest of what was missing ───────────────────────────────────
  #
  # 08:30 IST, GET — both taken from the route's own header rather than chosen here.
  # It is silent when nothing is wrong, so a daily slot costs nothing on a good day.
  "resellersos-health-digest|30 8 * * *|/api/cron/health-digest|Read production logs and email only if something broke"
  # 01:00 IST — after the midnight backup, before every other money job. A billing
  # run that creates invoices should land before renewals (09:00) and dunning (09:15)
  # look at what is owed, or those two spend a day working from a stale picture.
  # The route states it survives at-least-once delivery, which is what makes a
  # scheduled retry safe here.
  "resellersos-billing|0 1 * * *|/api/cron/billing|Split-cycle subscription billing"
  # EVERY 15 MINUTES. An enquiry sitting unread is a lead going cold, and this is the
  # path an emailed enquiry arrives on — the same frequency as the support-SLA sweep
  # below, for the same reason: the cheaper half would tolerate hourly, the expensive
  # half would not.
  "resellersos-gmail-inbox|*/15 * * * *|/api/cron/gmail-inbox|Pull inbound enquiry mail"
  # EVERY 10 MINUTES, and the route explains why in one sentence: a customer answered
  # the exact question the app asked, the reply died on a 15-second Gemini timeout,
  # "and the next call minutes later would have worked. There was simply nobody to
  # make it." Ten minutes is that call. Not five: this path produced duplicate
  # replies once (the entity_id fix, 1 Sep) and there is no reason to sit close to
  # the edge of a bug that has already happened.
  "resellersos-ai-reply-retry|*/10 * * * *|/api/cron/ai-reply-retry|Retry replies that died on an upstream timeout"
  # EVERY 30 MINUTES — the figure is the route's own. The in-app reminder is mounted
  # in the (app) layout, so it only fires for somebody who already has the app open;
  # this job is what reaches the people who do not, which is precisely the group a
  # reminder is for.
  "resellersos-attendance-reminders|*/30 * * * *|/api/cron/attendance-reminders|Remind staff who have not marked attendance"
  # 23:00 IST — end of day, once. It distils lessons from the day's conversations, so
  # running it before the day is over would teach it half a day. Latest of all the
  # jobs here on purpose: nothing waits on its output.
  "resellersos-ai-reflection|0 23 * * *|/api/cron/ai-reflection|Distil the day's conversations into lessons for the agent"

)

echo "Region:  $REGION"
echo "Service: $SERVICE_URL"
echo "Zone:    $TZ_NAME"
echo

for row in "${JOBS[@]}"; do
  IFS='|' read -r NAME SCHEDULE PATH_ DESC <<< "$row"

  # `describe` is the cheapest existence check that does not depend on parsing
  # `list` output, which changes between gcloud versions.
  if gcloud scheduler jobs describe "$NAME" --location="$REGION" >/dev/null 2>&1; then
    # SKIP BY DEFAULT — do not touch a job that already works.
    #
    # This script used to `update` here, and that was dangerous. An update rewrites
    # the Authorization header, so running it with the wrong CRON_SECRET would
    # break jobs that are currently fine. Three of these (renewals, trial-expiry,
    # birthday-greetings) have been running in production since July; renewals last
    # fired at 09:00 IST today. Silently re-pointing their credentials to "whatever
    # was in my shell" is not a setup step, it is an outage.
    #
    # Pass UPDATE_EXISTING=1 to overwrite deliberately — e.g. when rotating the
    # secret, which is the one time you actually want every job rewritten.
    if [[ "${UPDATE_EXISTING:-0}" != "1" ]]; then
      echo "==> skip:   $NAME  (already exists — set UPDATE_EXISTING=1 to overwrite)"
      continue
    fi
    ACTION="update"
  else
    ACTION="create"
  fi

  # `create` takes --headers; `update` takes --update-headers. They are not
  # interchangeable, and this script used --update-headers for BOTH — so it could
  # never create a job. Every "create" line it printed was followed by
  # "unrecognized arguments", which is why the six jobs in production were made by
  # hand. The same failure this file was written to fix, one level up: a setup
  # script that looks like it works and has never once created anything.
  if [[ "$ACTION" == "create" ]]; then
    HEADER_FLAG="--headers"
  else
    HEADER_FLAG="--update-headers"
  fi

  echo "==> ${ACTION}: $NAME  ($SCHEDULE $TZ_NAME)  $PATH_"
  # 2>&1 through a filter: gcloud echoes the FULL argument list on an argument
  # error, which put the live CRON_SECRET into a terminal once already. Any line
  # carrying the secret is replaced rather than printed.
  if ! gcloud scheduler jobs "$ACTION" http "$NAME" \
    --location="$REGION" \
    --schedule="$SCHEDULE" \
    --time-zone="$TZ_NAME" \
    --uri="${SERVICE_URL}${PATH_}" \
    --http-method=GET \
    "$HEADER_FLAG"="Authorization=Bearer ${CRON_SECRET}" \
    --attempt-deadline=540s \
    --description="$DESC" \
    --quiet 2>&1 | sed "s|${CRON_SECRET}|<redacted>|g"
  then
    echo "    ^ failed — see the message above (secret redacted)." >&2
  fi
done

cat <<'DONE'

Done. Verify what is now scheduled:

  gcloud scheduler jobs list --location=asia-south1

Prove one end to end WITHOUT waiting for its schedule — the renewals and
compliance jobs both support a dry run that sends nothing and writes nothing:

  gcloud scheduler jobs run resellersos-renewals --location=asia-south1
  gcloud logging read \
    'resource.type=cloud_run_revision AND textPayload:"cron"' \
    --limit=20 --freshness=10m

A 401 in those logs means the CRON_SECRET here does not match the one the
service runs with — fix that before trusting any of these jobs.
DONE
