#!/usr/bin/env bash
#
# Rotate CRON_SECRET across the Cloud Run service AND all six Cloud Scheduler
# jobs, in one shot.
#
# ─── WHY THIS SCRIPT EXISTS ──────────────────────────────────────────────────
# Rotating this secret by hand means running seven commands that must all carry
# the SAME value. Doing that by copy-paste has already failed twice here:
#
#   1. A placeholder (`NAYA_SECRET`) was pasted verbatim into
#      `gcloud run services update`, so the live service started expecting the
#      literal string "NAYA_SECRET" while all six jobs still sent the old secret.
#      Result: every cron 401s, silently, until someone notices a missed renewal.
#   2. Earlier, the same class of mistake sent `ASLI_SECRET` to a webhook test.
#
# So the secret is GENERATED INSIDE this script and never printed, never typed,
# and never pasted. There is no placeholder to get wrong.
#
# ─── ORDER MATTERS ───────────────────────────────────────────────────────────
# The service is updated FIRST, then the jobs. Between those two steps the crons
# are broken — jobs still send the old secret while the service expects the new
# one. That window is seconds, and it is unavoidable without two secrets being
# accepted at once. Running this at 02:00–08:00 IST keeps the window clear of
# every scheduled job (the earliest is attendance-retention at 02:00, then
# renewals at 09:00).
#
# If the job loop fails partway, RE-RUN THE WHOLE SCRIPT. A partial rotation
# leaves some jobs on the old secret; a fresh run puts everything on one new
# value again.
#
# Usage — from Git Bash (not Command Prompt; this is a bash script):
#
#   cd "C:/dev/ResellerOSv3 - Copy/production"
#   chmod +x scripts/rotate-cron-secret.sh
#   ./scripts/rotate-cron-secret.sh

set -euo pipefail

REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-resellersos}"
JOBS=(
  resellersos-renewals
  resellersos-compliance-reminders
  resellersos-trial-expiry
  resellersos-attendance-retention
  resellersos-birthday-greetings
  resellersos-google-contacts-sync
)

command -v gcloud >/dev/null || { echo "gcloud not on PATH" >&2; exit 2; }
command -v node   >/dev/null || { echo "node not on PATH" >&2; exit 2; }

# 32 random bytes as hex. Never echoed — not even truncated, because a prefix is
# still a head start for anyone guessing.
SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
[[ ${#SECRET} -eq 64 ]] || { echo "secret generation failed" >&2; exit 1; }
echo "Generated a fresh 64-character secret. Its value is not displayed."
echo

echo "1/2  Updating the Cloud Run service ($SERVICE, $REGION)…"
# Output is filtered so a future gcloud version that echoes env vars cannot leak
# the value into a terminal that ends up in a screenshot.
if ! gcloud run services update "$SERVICE" \
      --region="$REGION" \
      --update-env-vars "CRON_SECRET=$SECRET" \
      --quiet 2>&1 | grep -v "$SECRET" | grep -iE "revision|Done|ERROR" ; then
  echo "     (service update produced no matching output — check it manually)" >&2
fi

echo
echo "2/2  Updating the scheduler jobs…"
FAILED=()
for J in "${JOBS[@]}"; do
  if gcloud scheduler jobs update http "$J" \
       --location="$REGION" \
       --update-headers="Authorization=Bearer $SECRET" \
       --quiet >/dev/null 2>&1; then
    echo "     ok   $J"
  else
    echo "     FAIL $J"
    FAILED+=("$J")
  fi
done

if (( ${#FAILED[@]} > 0 )); then
  echo
  echo "‼ ${#FAILED[@]} job(s) did not update: ${FAILED[*]}" >&2
  echo "  Those still carry the OLD secret and will 401. Re-run this whole script." >&2
  exit 1
fi

cat <<'DONE'

All six jobs and the service now share one new secret.

VERIFY — this is the step that actually proves it, because a wrong secret leaves
every job looking ENABLED while doing nothing:

  gcloud scheduler jobs run resellersos-renewals --location=asia-south1
  sleep 15
  gcloud logging read \
    'resource.type=cloud_run_revision AND httpRequest.status=401' \
    --limit=5 --freshness=5m

The second command must print NOTHING. Any 401 means a job and the service still
disagree — re-run this script.
DONE
