#!/usr/bin/env bash
# R-106 (3 Oct 2026) — one-time secrets for the STAGING stack. Pardeep runs this once:
#
#   bash production/supabase/cloudsql/staging/setup-staging-secrets.sh
#
# It generates fresh random passwords and keys, puts them where they belong, and prints
# NONE of them (only the public anon key, which ships to every browser anyway):
#   1. postgres password on resellersos-staging-db           (Cloud SQL users API)
#   2. authenticator / supabase_auth_admin / supabase_storage_admin passwords on the
#      staging DB (one-shot SQL file, deleted from the bucket right after the import)
#   3. JWT secret + anon / service_role keys (HS256, signed here with node)
#   4. the gateway .env written straight onto VM staging-gateway, then the stack started
#   5. app secrets in Secret Manager: staging-service-role-key, staging-cron-secret,
#      staging-secrets-master-key (Cloud Run staging reads them by name)
# Only touches *staging* resources — every name below is hard-coded, and step 0 refuses
# unless the DB carries the zz_staging_marker table (the live DB never has it).
set -euo pipefail

P=resellsubsos-prod
INST=resellersos-staging-db
ZONE=asia-southeast1-a
VM=staging-gateway
BUCKET=gs://resellsubsos-prod-rehearsal/staging-tmp
API_URL=https://35-240-252-6.sslip.io   # sslip.io maps this name to 35.240.252.6; no DNS record needed
APP_URL=https://resellersos-staging-njvk4nxhdq-as.a.run.app
HERE="$(cd "$(dirname "$0")" && pwd)"
# gcloud on Windows is a native program: it cannot read Git Bash paths like /tmp/x or
# /c/Users/x. Every file it touches goes through win() (cygpath) and lives under %TEMP%.
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

TMP="$(mktemp -d -p "${TEMP:-/tmp}" 2>/dev/null || mktemp -d)"
cleanup() { rm -rf "$TMP"; gcloud storage rm -q "$BUCKET/roles.sql" "$BUCKET/check.sql" >/dev/null 2>&1 || true; }
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
# Passwords: the clone carries live's password policy (lower + upper + digit + symbol),
# so each gets a fixed "Aa1_" tail. "_" is URL-safe, so they work inside postgres:// URLs.
rnd() { printf "%sAa1_" "$(openssl rand -hex 24)"; }

say "0. Checking this really is the staging database"
cat > "$TMP/check.sql" <<'SQL'
do $$ begin
  if to_regclass('public.zz_staging_marker') is null then
    raise exception 'ABORT: zz_staging_marker missing - not the staging clone';
  end if;
end $$;
SQL
gcloud storage cp -q "$(win "$TMP/check.sql")" "$BUCKET/check.sql"
gcloud sql import sql "$INST" "$BUCKET/check.sql" --database=resellersos --user=resellersos_migration --project="$P" --quiet >/dev/null

say "1. postgres password (staging only)"
PG_PW="$(rnd)"
gcloud sql users set-password postgres --instance="$INST" --project="$P" --password="$PG_PW" >/dev/null
unset PG_PW

say "2. Service role passwords on the staging DB"
AUTHN_PW="$(rnd)"; AUTHADM_PW="$(rnd)"; STOR_PW="$(rnd)"
cat > "$TMP/roles.sql" <<SQL
alter role authenticator password '$AUTHN_PW';
alter role supabase_auth_admin password '$AUTHADM_PW';
alter role supabase_storage_admin password '$STOR_PW';
SQL
gcloud storage cp -q "$(win "$TMP/roles.sql")" "$BUCKET/roles.sql"
gcloud sql import sql "$INST" "$BUCKET/roles.sql" --database=resellersos --user=postgres --project="$P" --quiet >/dev/null
gcloud storage rm -q "$BUCKET/roles.sql"
rm -f "$TMP/roles.sql"

say "3. JWT secret and keys"
JWT_SECRET="$(openssl rand -hex 32)"
mint() {
  node -e '
    const c = require("crypto");
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const h = b({ alg: "HS256", typ: "JWT" });
    const p = b({ role: process.argv[1], iss: "supabase", iat: now, exp: now + 10 * 365 * 86400 });
    const s = c.createHmac("sha256", process.argv[2]).update(h + "." + p).digest("base64url");
    process.stdout.write(h + "." + p + "." + s);
  ' "$1" "$JWT_SECRET"
}
ANON_KEY="$(mint anon)"
SERVICE_KEY="$(mint service_role)"

say "4. Gateway .env onto the VM, then start the stack"
umask 077
cat > "$TMP/.env" <<ENV
CLOUDSQL_CONNECTION_NAME=$P:asia-southeast1:$INST
DB_NAME=resellersos
AUTHENTICATOR_PW=$AUTHN_PW
AUTH_ADMIN_PW=$AUTHADM_PW
STORAGE_ADMIN_PW=$STOR_PW
JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_KEY
API_EXTERNAL_URL=$API_URL
SITE_URL=$APP_URL
ADDITIONAL_REDIRECT_URLS=$APP_URL,$APP_URL/*
GOOGLE_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_SECRET=
MAILER_AUTOCONFIRM=true
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_ADMIN_EMAIL=
SMTP_SENDER_NAME=ResellerOS Staging
POSTGREST_IMAGE=postgrest/postgrest:v12.2.3
GOTRUE_IMAGE=supabase/gotrue:v2.151.0
STORAGE_IMAGE=supabase/storage-api:v1.11.13
PROXY_IMAGE=gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.13.0
CADDY_IMAGE=caddy:2.8
ENV
unset AUTHN_PW AUTHADM_PW STOR_PW
gcloud compute scp --zone="$ZONE" --project="$P" --strict-host-key-checking=no \
  "$(win "$TMP/.env")" "$(win "$HERE/Caddyfile")" "$(win "$HERE/../phase2/docker-compose.yml")" "$VM":. >/dev/null
rm -f "$TMP/.env"
gcloud compute ssh "$VM" --zone="$ZONE" --project="$P" --strict-host-key-checking=no \
  --command="chmod 600 ~/.env && sudo docker compose --env-file ~/.env -f ~/docker-compose.yml up -d" >/dev/null

say "5. App secrets in Secret Manager"
gcloud services enable secretmanager.googleapis.com --project="$P" >/dev/null
put() {  # name value  (create, or add a new version)
  if gcloud secrets describe "$1" --project="$P" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project="$P" >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project="$P" >/dev/null
  fi
}
put staging-service-role-key "$SERVICE_KEY"
put staging-cron-secret "$(rnd)"
put staging-secrets-master-key "$(openssl rand -hex 32)"
unset SERVICE_KEY JWT_SECRET

say "Done. Nothing secret was printed."
echo "Public anon key for the staging build (safe to share, it ships to browsers):"
echo "$ANON_KEY"
