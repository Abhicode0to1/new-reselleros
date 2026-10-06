#!/usr/bin/env bash
# R-165 (6 Oct 2026): server reads of quotes / leads / customers fail on Cloud SQL.
#
# WHY: migration 20260928100000 (28 Sep) made the hierarchy RLS helpers executable by
# authenticated/anon only. On Cloud SQL service_role has no BYPASSRLS, so it evaluates those
# policies and gets "permission denied for function hierarchy_sees_all" — the whole query
# fails. Seen on staging: the invoice PDF came out with no line items and then crashed.
# Anything the SERVER reads from those tables (PDF links, emails, crons) is affected.
#
# Pardeep runs it (Claude may not touch the live DB):
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/live/fix-service-role-grants.sh"
#
# Grants only (EXECUTE on the functions policies call). No data changes, nothing revoked,
# re-runnable. Backup first anyway.
set -euo pipefail
P=resellsubsos-prod; I=resellersos-db; DB=resellersos
B=gs://resellsubsos-prod-rehearsal/golive/live-20261006
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # production/supabase/cloudsql
TMP="$(mktemp -d)"
cat > "$TMP/peek.sql" <<'SQL'
DO $$ DECLARE r text; BEGIN
  select 'missing=' || count(*) || ' [' || coalesce(string_agg(p.proname, ','), '') || ']' into r
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace and ns.nspname = 'public'
   where exists (select 1 from pg_policy pol
                  where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
                        coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ ('\m' || p.proname || '\('))
     and not has_function_privilege('service_role', p.oid, 'execute');
  RAISE EXCEPTION 'PEEK %', r; END $$;
SQL
peek() {
  gcloud storage cp "$TMP/peek.sql" "$B/peek-grants.sql" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/peek-grants.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}
say() { printf '\n== %s\n' "$1"; }

say "0. Account"; gcloud config get-value account
say "1. Backup"
gcloud sql backups create --instance="$I" --project="$P" --description="before service_role grants (R-165) 6 Oct 2026"
say "2. Before (functions service_role cannot run)"; peek
say "3. Grant"
gcloud storage cp "$HERE/10-service-role-policy-functions.sql" "$B/10-grants.sql" --project="$P" -q >/dev/null
gcloud sql import sql "$I" "$B/10-grants.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet
say "4. After (should say missing=0)"; peek
say "DONE — send Claude the two PEEK lines."
