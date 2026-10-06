#!/usr/bin/env bash
# Turn on "Sign in with Google" on STAGING (5 Oct 2026). Pardeep runs this once:
#
#   bash production/supabase/cloudsql/staging/enable-staging-google.sh
#
# It reuses LIVE's Google OAuth client: reads the client id + secret from the live auth
# container (supabase-gateway) and writes them into staging-gateway's ~/.env, sets
# GOOGLE_ENABLED=true and restarts staging's auth service. Nothing secret is printed or
# written to disk on this machine (held in memory between the two ssh calls only).
# ~/.env is backed up on the staging VM as ~/.env.bak-google first. Live is only READ.
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

say "0. Connect once to each server (answer 'y' if asked to store the host key)"
# On Windows gcloud uses PuTTY's plink. The first connection to a VM asks "Store key in
# cache? (y/n)" and reads the answer from STDIN. Answering it here, with nothing piped,
# caches both keys so step 1 runs without a question.
gcloud compute ssh supabase-gateway --zone="$Z" --project="$P" --command="true"
gcloud compute ssh staging-gateway  --zone="$Z" --project="$P" --command="true"

say "1. Copy live's Google client to staging (values are not shown)"
# The remote scripts travel base64-encoded (5 Oct 2026, second run): quotes, pipes and {{ }}
# sent through gcloud -> plink on Windows came back with nothing. Diagnostics (container
# name, how many settings, their NAMES) go to this screen on stderr — never the values.
LIVE_SH='set -o pipefail
C=$(sudo docker ps --format "{{.Names}}" | grep -E "auth" | head -1)
echo "live: auth container = ${C:-NONE FOUND}" >&2
[ -n "$C" ] || exit 1
ENVS=$(sudo docker inspect "$C" --format "{{range .Config.Env}}{{println .}}{{end}}")
echo "live: Google settings = $(printf "%s\n" "$ENVS" | grep -cE "^GOTRUE_EXTERNAL_GOOGLE_(CLIENT_ID|SECRET)=") of 2" >&2
printf "%s\n" "$ENVS" | grep -E "^GOTRUE_EXTERNAL_GOOGLE_(CLIENT_ID|SECRET)=" | sed -E "s/^GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=/GOOGLE_CLIENT_ID=/; s/^GOTRUE_EXTERNAL_GOOGLE_SECRET=/GOOGLE_SECRET=/"'
STAGING_SH='set -e
new=$(cat)
n=$(printf "%s\n" "$new" | grep -c "^GOOGLE_" || true)
echo "staging: received $n of 2 Google lines" >&2
[ "$n" = 2 ] || { echo "Nothing changed on staging."; exit 1; }
cp ~/.env ~/.env.bak-google
grep -vE "^GOOGLE_(ENABLED|CLIENT_ID|SECRET)=" ~/.env > ~/.env.tmp || true
printf "%s\nGOOGLE_ENABLED=true\n" "$new" >> ~/.env.tmp
mv ~/.env.tmp ~/.env; chmod 600 ~/.env
grep -E "^GOOGLE_" ~/.env | sed -E "s/=.+/=<set>/"'
L64=$(printf '%s' "$LIVE_SH" | base64 -w0)
S64=$(printf '%s' "$STAGING_SH" | base64 -w0)
# Not a live->staging pipe (5 Oct 2026, third run): live sent 2 lines, staging read 0 —
# plink on Windows does not hand a piped stdin to the remote side. So the two values are
# held in a shell variable here (memory only: never on disk, never printed), passed to
# staging base64-encoded inside the command, and cleared straight after.
VALS=$(gcloud compute ssh supabase-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="echo $L64 | base64 -d > \$HOME/.rl.sh && bash \$HOME/.rl.sh; rc=\$?; rm -f \$HOME/.rl.sh; exit \$rc" | tr -d '\r')
V64=$(printf '%s\n' "$VALS" | base64 -w0); unset VALS
gcloud compute ssh staging-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="echo $S64 | base64 -d > \$HOME/.rs.sh && echo $V64 | base64 -d | bash \$HOME/.rs.sh; rc=\$?; rm -f \$HOME/.rs.sh; exit \$rc"
unset V64

say "2. Restart staging auth with the new settings"
gcloud compute ssh staging-gateway --zone="$Z" --project="$P" --strict-host-key-checking=no --quiet \
  --command="sudo docker compose --env-file ~/.env -f ~/docker-compose.yml up -d auth && sleep 5 && sudo docker compose --env-file ~/.env -f ~/docker-compose.yml ps auth"

say "Done. Now add the redirect URI in Google Cloud Console (see the top of this file), then try Sign in with Google on staging."
