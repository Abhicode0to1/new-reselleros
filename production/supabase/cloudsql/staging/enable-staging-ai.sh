#!/usr/bin/env bash
# Give STAGING the same Gemini key as live, so AI Help (and every other AI feature) answers
# there (5 Oct 2026). Staging's Cloud Run service had no GEMINI_API_KEY at all, so AI Help
# only ever showed its "AI Help abhi jawab nahi de pa raha" fallback. Pardeep runs this once:
#
#   bash production/supabase/cloudsql/staging/enable-staging-ai.sh
#
# Live is only READ. If live takes the key from Secret Manager, staging gets the same secret
# reference (no value leaves Google). If live has it as a plain value, it is held in memory
# here, passed straight to staging, and never printed. GEMINI_MODEL is copied too if set.
set -euo pipefail
P=resellsubsos-prod
R=asia-southeast1
say() { printf '\n== %s\n' "$1"; }

envfield() { # $1 = var name, $2 = field under env[] (value | valueFrom.secretKeyRef.name | ...key)
  # `describe` has no --filter: flatten env[] to "NAME|field" lines and pick the name here.
  gcloud run services describe resellersos --region="$R" --project="$P" \
    --flatten="spec.template.spec.containers[].env[]" \
    --format="csv[no-heading,separator='|'](spec.template.spec.containers.env.name,spec.template.spec.containers.env.$2)" \
    | tr -d '\r' | grep "^$1|" | head -1 | cut -d'|' -f2-
}

say "1. How does live get GEMINI_API_KEY? (value not shown)"
SECRET=$(envfield GEMINI_API_KEY valueFrom.secretKeyRef.name)
VERSION=$(envfield GEMINI_API_KEY valueFrom.secretKeyRef.key)
MODEL=$(envfield GEMINI_MODEL value)

if [ -n "$SECRET" ]; then
  echo "live: from Secret Manager secret '$SECRET' (version ${VERSION:-latest})"
  say "2. Point staging at the same secret"
  SA=$(gcloud run services describe resellersos-staging --region="$R" --project="$P" --format="value(spec.template.spec.serviceAccountName)")
  echo "staging runs as: ${SA:-default compute account}"
  [ -n "$SA" ] && gcloud secrets add-iam-policy-binding "$SECRET" --project="$P" \
      --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --quiet >/dev/null && echo "staging may read the secret"
  gcloud run services update resellersos-staging --region="$R" --project="$P" --quiet \
    --update-secrets="GEMINI_API_KEY=$SECRET:${VERSION:-latest}" ${MODEL:+--update-env-vars="GEMINI_MODEL=$MODEL"}
else
  KEY=$(envfield GEMINI_API_KEY value)
  [ -n "$KEY" ] || { echo "live has no GEMINI_API_KEY either — nothing changed."; exit 1; }
  echo "live: plain value, ${#KEY} characters"
  say "2. Give staging the same value"
  gcloud run services update resellersos-staging --region="$R" --project="$P" --quiet \
    --update-env-vars="GEMINI_API_KEY=$KEY${MODEL:+,GEMINI_MODEL=$MODEL}" 2>&1 | grep -v "$KEY"
  unset KEY
fi

say "Done. Staging restarts with the key in about a minute — then open AI Help on staging and ask something."
