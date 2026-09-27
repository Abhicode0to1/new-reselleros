#!/usr/bin/env bash
# ============================================================================
# Canonical ResellerOS production deploy — the ONE way to ship.
#
# Why this exists: on 25 Jul 2026 several deploys were wasted because the
# project id and gcloud account were guessed from stale docs. This script
# hard-codes the correct values and PRE-FLIGHT CHECKS them (account, project
# access, right directory) BEFORE the 3–5 min Cloud Build — so a wrong config
# fails in ~2 seconds with a clear message instead of a slow, confusing error.
#
# Usage:  bash deploy.sh          (run from anywhere; it cd's itself)
# Auth:   Pardeep runs `gcloud auth login` (interactive) himself first.
# ============================================================================
set -euo pipefail

# ── Canonical target (do NOT change without verifying in gcloud console) ──────
ACCOUNT="pardeep@anutech.in"       # owns the project below. NOT exceltechnologies.
PROJECT="resellsubsos-prod"        # LIVE project. NOT "resellersos-prod" (that is a
                                   # different, unrelated project — stale in old docs).
REGION="asia-southeast1"           # Singapore — the service moved here on 5 Sep 2026 (cloudbuild.yaml _REGION)
SERVICE="resellersos"

cd "$(dirname "$0")"               # always run from production/ (has the Dockerfile)

echo "── Pre-flight ─────────────────────────────────────────────"

# 1. Right directory? The Dockerfile must be here or Cloud Build falls back to
#    buildpacks and fails with "no buildpack groups passed detection".
[ -f Dockerfile ]  || { echo "✗ No Dockerfile in $(pwd) — run from production/"; exit 1; }
[ -f package.json ] || { echo "✗ No package.json in $(pwd)"; exit 1; }
echo "✓ In production/ (Dockerfile present)"

# 2. Correct account active.
gcloud config set account "$ACCOUNT" >/dev/null 2>&1
ACTIVE="$(gcloud config get-value account 2>/dev/null)"
[ "$ACTIVE" = "$ACCOUNT" ] || { echo "✗ Active account is '$ACTIVE', expected '$ACCOUNT'"; exit 1; }
echo "✓ Account: $ACCOUNT"

# 3. That account can actually see the service in the project. Catches BOTH a
#    permission problem (wrong account/project) AND an expired token — in ~1s,
#    not after a 5-min build.
if ! gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
        --format="value(metadata.name)" >/tmp/ros_preflight.txt 2>&1; then
  echo "✗ Cannot access $SERVICE in $PROJECT:"
  sed 's/^/    /' /tmp/ros_preflight.txt
  echo "    → If PERMISSION_DENIED: wrong project/account (see values above)."
  echo "    → If reauth/token error: ask Pardeep to run 'gcloud auth login' ($ACCOUNT)."
  exit 1
fi
echo "✓ Can reach $SERVICE in $PROJECT ($REGION)"

echo "── Deploying (3–5 min) ────────────────────────────────────"
# No pipe here — we must NOT mask gcloud's real exit code.
gcloud run deploy "$SERVICE" --source . --project "$PROJECT" --region "$REGION" --quiet

echo "✓ Deploy finished. Confirm the revision line above says 'serving 100 percent'."
