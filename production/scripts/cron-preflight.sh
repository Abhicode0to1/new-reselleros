#!/usr/bin/env bash
#
# Preflight + runner for setup-cloud-scheduler.sh.
#
# ─── WHY THIS WRAPPER EXISTS ─────────────────────────────────────────────────
# setup-cloud-scheduler.sh needs CRON_SECRET, and its own header states the danger
# plainly: "The secret must MATCH what the Cloud Run service has, or every job gets
# 401 and you are back to jobs that appear scheduled and do nothing."
#
# That is the same failure the scheduler script was written to fix — a job that looks
# configured and never runs — just moved one step later. Nothing in the script checks
# it, because it cannot: it only sees the value you exported.
#
# So this does two things before anything is created:
#
#   1. Reads CRON_SECRET from production/.env.local, so nobody types or pastes a
#      secret into a terminal, and no placeholder ends up inside a copy-pasteable
#      command.
#   2. COMPARES it against the value the live Cloud Run service actually runs with,
#      and refuses to continue if they differ.
#
# Neither value is ever printed. The comparison is on SHA-256 prefixes, which is
# enough to tell "same" from "different" and useless to anyone reading the scrollback
# or a screenshot.
#
# Usage (from the production/ directory):
#
#   bash scripts/cron-preflight.sh
#
# Add UPDATE_EXISTING=1 only when deliberately overwriting every job — rotating the
# secret is the case that calls for it.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
REGION="${REGION:-asia-south1}"
PROJECT="${PROJECT:-resellsubsos-prod}"
SERVICE="${SERVICE:-resellersos}"

fail() { echo "✗ $*" >&2; exit 1; }

# ── 1. Local secret ──────────────────────────────────────────────────────────
[[ -f "$ENV_FILE" ]] || fail "No $ENV_FILE — cannot read CRON_SECRET."
LOCAL_SECRET="$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' | sed 's/^"\(.*\)"$/\1/')"
[[ -n "$LOCAL_SECRET" ]] || fail "CRON_SECRET is empty in $ENV_FILE."

# ── 2. Are we actually logged in? ────────────────────────────────────────────
# Checked explicitly rather than letting the first gcloud call fail deep inside the
# loop, half way through creating jobs.
#
# CLOUDSDK_CORE_DISABLE_PROMPTS and the timeout are both load-bearing. When the
# org's reauth policy has expired the session, gcloud tries to open a browser and
# WAITS — so without these the check hangs instead of failing, which is worse than
# no check at all: nothing happens and nothing says why.
if ! CLOUDSDK_CORE_DISABLE_PROMPTS=1 timeout 25 gcloud auth print-access-token >/dev/null 2>&1; then
  fail "gcloud needs a fresh login (its session has expired). Run:  gcloud auth login"
fi

# ── 3. What does the LIVE service run with? ──────────────────────────────────
echo "Reading CRON_SECRET from the live Cloud Run service ($SERVICE, $REGION)…"
REMOTE_SECRET="$(
  gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT" \
    --format='value(spec.template.spec.containers[0].env.filter("name:CRON_SECRET").extract("value"))' \
    2>/dev/null | tr -d '\r[]' | head -1
)"

fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-12; }

if [[ -z "$REMOTE_SECRET" ]]; then
  # Most likely it is a Secret Manager reference rather than a literal value, which
  # this cannot read from here. Say so instead of guessing they match.
  echo "⚠ Could not read a literal CRON_SECRET off the service."
  echo "  It is probably wired through Secret Manager, which this check cannot see."
  echo "  Nothing has been created. Either confirm the values match and re-run with"
  echo "  SKIP_SECRET_CHECK=1, or set the job headers by hand."
  [[ "${SKIP_SECRET_CHECK:-0}" == "1" ]] || exit 3
  echo "  SKIP_SECRET_CHECK=1 set — continuing on your say-so."
elif [[ "$(fingerprint "$LOCAL_SECRET")" != "$(fingerprint "$REMOTE_SECRET")" ]]; then
  cat >&2 <<MISMATCH
✗ CRON_SECRET does not match.

  .env.local fingerprint : $(fingerprint "$LOCAL_SECRET")
  Cloud Run fingerprint  : $(fingerprint "$REMOTE_SECRET")

Nothing has been created. Creating jobs now would give every one of them a 401
for ever — scheduled, green in the console, and doing nothing.

Fix the mismatch first: either update .env.local to the deployed value, or
redeploy the service with the local one.
MISMATCH
  exit 4
else
  echo "✓ CRON_SECRET matches the live service (fingerprint $(fingerprint "$LOCAL_SECRET"))."
fi

# ── 4. Create the missing jobs ───────────────────────────────────────────────
echo
CRON_SECRET="$LOCAL_SECRET" bash "$HERE/setup-cloud-scheduler.sh"
