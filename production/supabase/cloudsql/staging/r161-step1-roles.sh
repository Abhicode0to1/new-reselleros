#!/usr/bin/env bash
# R-161 step 1 on STAGING only (5 Oct 2026): backup, then the five app_* login roles from
# db/ops/10-runtime-roles.sql + 20-auth-login.sql, with passwords nobody ever sees.
#
#   bash production/supabase/cloudsql/staging/r161-step1-roles.sh
#
# How the passwords stay unseen:
#   * each is 32 random bytes, generated here, held only in a shell variable;
#   * the database receives a SCRAM-SHA-256 VERIFIER (a salted hash, what Postgres stores
#     anyway), never the password — so even an error that logs the statement leaks no password;
#   * the password itself goes straight into Secret Manager (staging-db-<role>-password) on stdin.
# Re-running rotates all five passwords (new secret versions; the DB gets the new verifiers).
# Production is not touched. The role scripts' own checks (no superuser, no BYPASSRLS, right
# memberships, owns nothing) run inside the import and fail it if anything is off.
set -euo pipefail
P=resellsubsos-prod
I=resellersos-staging-db
DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/r161-step1
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # production/
say() { printf '\n== %s\n' "$1"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

say "1. Backup staging DB"
gcloud sql backups create --instance="$I" --project="$P" --description="before R-161 roles (5 Oct 2026)"

say "2. Make passwords + SCRAM verifiers (nothing is printed)"
declare -A PW VER
for r in runtime jobs anon service auth; do
  PW[$r]="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
  VER[$r]="$(printf '%s' "${PW[$r]}" | node -e '
    const c=require("crypto"); let pw=""; process.stdin.on("data",d=>pw+=d).on("end",()=>{
      const salt=c.randomBytes(16), it=4096, sp=c.pbkdf2Sync(pw,salt,it,32,"sha256");
      const ck=c.createHmac("sha256",sp).update("Client Key").digest(), sk=c.createHmac("sha256",sp).update("Server Key").digest();
      const st=c.createHash("sha256").update(ck).digest();
      process.stdout.write(`SCRAM-SHA-256$${it}:${salt.toString("base64")}$${st.toString("base64")}:${sk.toString("base64")}`);
    });')"
done
echo "5 passwords made."

say "3. Role scripts (Abhishek's db/ops, read from the staging branch) with verifiers in place of the psql variables"
git -C "$ROOT" fetch -q anutech staging
git -C "$ROOT" show anutech/staging:production/db/ops/10-runtime-roles.sql > "$TMP/10.src"
git -C "$ROOT" show anutech/staging:production/db/ops/20-auth-login.sql > "$TMP/20.src"
sed -e "s|:runtime_pw|'${VER[runtime]}'|; s|:jobs_pw|'${VER[jobs]}'|; s|:anon_pw|'${VER[anon]}'|; s|:service_pw|'${VER[service]}'|" \
  "$TMP/10.src" > "$TMP/10.sql"
sed -e "s|:auth_pw|'${VER[auth]}'|" "$TMP/20.src" > "$TMP/20.sql"
grep -q ':runtime_pw\|:jobs_pw\|:anon_pw\|:service_pw' "$TMP/10.sql" && { echo "variable left unreplaced — stopping"; exit 1; }
grep -q ':auth_pw' "$TMP/20.sql" && { echo "variable left unreplaced — stopping"; exit 1; }

run_sql() { # $1 file, $2 name
  gcloud storage cp "$1" "$B/$2" --project="$P" -q >/dev/null
  if ! gcloud sql import sql "$I" "$B/$2" --database="$DB" --user=postgres --project="$P" --quiet; then
    gcloud storage rm "$B/$2" --project="$P" -q >/dev/null 2>&1 || true
    gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format="value(error.errors[0].message)" | tr '\\' '\n' | grep -E "ERROR" | head -3
    echo "STOPPED at $2"; exit 1
  fi
  gcloud storage rm "$B/$2" --project="$P" -q >/dev/null
}
run_sql "$TMP/10.sql" 10-runtime-roles.sql
run_sql "$TMP/20.sql" 20-auth-login.sql
echo "roles created and checked by the scripts' own guards."

say "4. Passwords into Secret Manager (staging-db-<role>-password)"
for r in runtime jobs anon service auth; do
  name="staging-db-app-${r}-password"
  if gcloud secrets describe "$name" --project="$P" >/dev/null 2>&1; then
    printf '%s' "${PW[$r]}" | gcloud secrets versions add "$name" --project="$P" --data-file=- >/dev/null
  else
    printf '%s' "${PW[$r]}" | gcloud secrets create "$name" --project="$P" --replication-policy=automatic --data-file=- >/dev/null
  fi
  echo "  $name: stored"
done
unset PW VER

say "Done — staging has app_runtime, app_jobs, app_anon, app_service, app_auth. Nothing switched yet; the app still runs on the VM."
