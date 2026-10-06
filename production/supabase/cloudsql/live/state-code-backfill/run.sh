#!/usr/bin/env bash
# R-165 (6 Oct 2026): fill customers.state_code where it is empty, so their invoices can be issued.
#
# WHY: state_code was only ever set by GSTIN verify. Customers without a GSTIN whose state was
# picked or typed by hand have state = "Delhi" and state_code = NULL, and generate_invoice
# refuses them ("has no state on record"). The app now fills it on every save; this fixes the
# rows saved before that.
#
# Pardeep runs it (Claude may not touch the live DB):
#   & "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/live/state-code-backfill/run.sh"
# Staging first is fine too — add the word staging at the end.
#
# What it does, stopping at the first problem:
#   1. Backup (live only — staging is test data).
#   2. Read-only count: how many would get a code, from GSTIN or from the state name, and the
#      spellings it does NOT recognise (it never guesses those — e.g. "New Delhi" stays empty
#      until someone picks "Delhi").
#   3. Asks you to type  haan  before changing anything.
#   4. Fills only empty codes. Every changed row is recorded in backfill_state_code_20261006
#      (old + new value), so it can be undone with one UPDATE (written at the bottom of apply.sql).
#   5. Counts again.
# Safe to run twice: the second run finds nothing left to fill.
set -euo pipefail
P=resellsubsos-prod
DB=resellersos
if [ "${1:-}" = "staging" ]; then I=resellersos-staging-db; ENV=STAGING; else I=resellersos-db; ENV=LIVE; fi
B=gs://resellsubsos-prod-rehearsal/golive/state-code-20261006-$I
HERE="$(cd "$(dirname "$0")" && pwd)"
say() { printf '\n== %s\n' "$1"; }

peek() {
  gcloud storage cp "$HERE/peek.sql" "$B/peek.sql" --project="$P" -q >/dev/null 2>&1
  gcloud sql import sql "$I" "$B/peek.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet >/dev/null 2>&1 || true
  gcloud sql operations list --instance="$I" --project="$P" --limit=1 --format=json | grep -oE 'PEEK[^\\"]*' | head -1
}

say "0. Account and target ($ENV: $I)"
gcloud config get-value account

if [ "$ENV" = "LIVE" ]; then
  say "1. Backup before anything changes"
  gcloud sql backups create --instance="$I" --project="$P" --description="before state_code backfill (R-165) 6 Oct 2026"
fi

say "2. What would change (read-only)"
BEFORE="$(peek)"
[ -n "$BEFORE" ] || { echo "Could not read the database — nothing changed. Send Claude a screenshot."; exit 1; }
echo "$BEFORE"
echo
echo "  gstin = code from a valid GSTIN      name = code from the state name"
echo "  conflict / foreign / unknown = left alone (nothing guessed)"
if echo "$BEFORE" | grep -q "gstin=0 name=0"; then say "Nothing to fill. Done."; exit 0; fi

printf '\nType haan to fill these codes on %s: ' "$ENV"
read -r OK
[ "$OK" = "haan" ] || { echo "Stopped — nothing changed."; exit 0; }

say "4. Filling"
gcloud storage cp "$HERE/apply.sql" "$B/apply.sql" --project="$P" -q >/dev/null
if ! gcloud sql import sql "$I" "$B/apply.sql" --database="$DB" --user=resellersos_migration --project="$P" --quiet; then
  echo "STOPPED — the change runs in one transaction, so nothing was written. Send Claude this screen."
  exit 1
fi

say "5. After"
peek
say "DONE — tell Claude 'state code ho gaya' with the two PEEK lines."
