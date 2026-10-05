#!/usr/bin/env bash
# Turn on "Sign in with Google" on STAGING (5 Oct 2026). Pardeep runs this once:
#
#   bash production/supabase/cloudsql/staging/enable-staging-google.sh
#
# It reuses LIVE's Google OAuth client: reads the client id + secret from the live auth
# container (supabase-gateway) and writes them into staging-gateway's ~/.env, sets
# GOOGLE_ENABLED=true and restarts staging's auth service. Nothing secret is printed or
# written on this machine — the values go VM to VM through a pipe. ~/.env is backed up on
# the staging VM as ~/.env.bak-google first. Live is only READ, never changed.
#
# ONE MORE STEP IS YOURS (Google does not allow it from a script): in Google Cloud Console
# → APIs & Services → Credentials → the OAuth 2.0 Client used for live login → Authorised
# redirect URIs → add
#     https://35-240-252-6.sslip.io/auth/v1/callback
# and Save. Without it Google answers "redirect_uri_mismatch".
set -euo pipefail
Z=asia-southeast1-a
P=resellsubsos-prod

say() { printf '\n== %s\n' "$1"; }

say "1. Copy live's Google client to staging (values are not shown)"
gcloud compute ssh supabase-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="sudo docker inspect pardeep-auth-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^GOTRUE_EXTERNAL_GOOGLE_(CLIENT_ID|SECRET)=' | sed -E 's/^GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=/GOOGLE_CLIENT_ID=/; s/^GOTRUE_EXTERNAL_GOOGLE_SECRET=/GOOGLE_SECRET=/'" 2>/dev/null \
| gcloud compute ssh staging-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="set -e; cp ~/.env ~/.env.bak-google; new=\$(cat); n=\$(printf '%s\n' \"\$new\" | grep -c '^GOOGLE_' || true); [ \"\$n\" = 2 ] || { echo 'Did not receive both Google values from live — nothing changed.'; exit 1; }; grep -vE '^GOOGLE_(ENABLED|CLIENT_ID|SECRET)=' ~/.env > ~/.env.tmp; printf '%s\nGOOGLE_ENABLED=true\n' \"\$new\" >> ~/.env.tmp; mv ~/.env.tmp ~/.env; chmod 600 ~/.env; grep -E '^GOOGLE_' ~/.env | sed -E 's/=.+/=<set>/'"

say "2. Restart staging auth with the new settings"
gcloud compute ssh staging-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="sudo docker compose --env-file ~/.env -f ~/docker-compose.yml up -d auth && sleep 5 && sudo docker compose --env-file ~/.env -f ~/docker-compose.yml ps auth"

say "Done. Now add the redirect URI in Google Cloud Console (see the top of this file), then try Sign in with Google on staging."
