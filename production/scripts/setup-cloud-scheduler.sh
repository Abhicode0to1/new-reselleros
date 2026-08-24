#!/usr/bin/env bash
#
# Cloud Scheduler jobs for the six ResellerOS cron endpoints.
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
