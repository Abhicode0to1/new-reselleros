#!/usr/bin/env bash
#
# Cloud Monitoring: uptime check + the two alerts that would have caught every silent
# outage this project has had (deep study S9, 27 Sep 2026).
#
#   1. Uptime check on /api/public/health/live (app + database) from 3 regions, every 5 minutes;
#      alert when it fails for 10 minutes.
#   2. Log-based alert on cron failure lines — `[cron/<job>] …` on stderr, which
#      lib/ops/cron-report.ts writes for every failed or partial run.
#   3. Log-based alert on Cloud Run 5xx rate.
#
# This complements, not replaces, the external heartbeat (HEARTBEAT_PING_URL): Monitoring
# lives inside the same GCP project and billing account; the heartbeat lives outside it.
#
# Idempotent: every resource is looked up by display name and skipped if present.
#
#   PROJECT=resellsubsos-prod NOTIFY_EMAIL=pardeep@anutech.in ./scripts/setup-uptime-checks.sh
#
# Before /api/public/health/live is deployed, run with HEALTH_PATH=/login so the check
# watches the page that exists today. After the deploy, run it again without HEALTH_PATH:
# an existing check on a different path is updated in place (same name, same alert).

set -euo pipefail

PROJECT="${PROJECT:-resellsubsos-prod}"
REGION="${REGION:-asia-southeast1}"
SERVICE_NAME="${SERVICE_NAME:-resellersos}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:?Set NOTIFY_EMAIL=someone@anutech.in}"
HEALTH_PATH="${HEALTH_PATH:-/api/public/health/live}"
HOST="${HOST:-$(gcloud run services describe "$SERVICE_NAME" --project "$PROJECT" --region "$REGION" --format='value(status.url)' | sed 's#https://##')}"

echo "Project: $PROJECT · host: $HOST · path: $HEALTH_PATH · notify: $NOTIFY_EMAIL"

# ── Notification channel (email) ─────────────────────────────────────────────
CHANNEL="$(gcloud alpha monitoring channels list --project "$PROJECT" --filter="displayName='ResellerOS ops email' AND type='email'" --format='value(name)' | head -1 || true)"
if [[ -z "$CHANNEL" ]]; then
  CHANNEL="$(gcloud alpha monitoring channels create --project "$PROJECT" --display-name='ResellerOS ops email' --type=email --channel-labels="email_address=$NOTIFY_EMAIL" --format='value(name)')"
  echo "created channel $CHANNEL"
else
  echo "channel exists: $CHANNEL"
fi

# ── 1. Uptime check ──────────────────────────────────────────────────────────
UPTIME_ID="$(gcloud monitoring uptime list-configs --project "$PROJECT" --filter="displayName=\"ResellerOS live\"" --format="value(name.basename())" 2>/dev/null | head -1 || true)"
if [[ -n "$UPTIME_ID" ]]; then
  CUR_PATH="$(gcloud monitoring uptime describe "$UPTIME_ID" --project "$PROJECT" --format="value(httpCheck.path)")"
  if [[ "$CUR_PATH" != "$HEALTH_PATH" ]]; then
    gcloud monitoring uptime update "$UPTIME_ID" --project "$PROJECT" --path="$HEALTH_PATH"
    echo "uptime check path $CUR_PATH -> $HEALTH_PATH"
  else
    echo "uptime check exists ($CUR_PATH)"
  fi
else
  gcloud monitoring uptime create "ResellerOS live" --project "$PROJECT" \
    --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT" \
    --protocol=https --path="$HEALTH_PATH" --port=443 --period=5 --timeout=10 \
    --regions=asia-pacific,europe,usa-oregon --status-codes=200
  echo "created uptime check on $HEALTH_PATH"
fi

# ── 2 + 3. Alert policies ────────────────────────────────────────────────────
mk_policy() {
  local name="$1" file="$2"
  if gcloud alpha monitoring policies list --project "$PROJECT" --filter="displayName='$name'" --format='value(name)' | grep -q .; then
    echo "policy exists: $name"
  else
    gcloud alpha monitoring policies create --project "$PROJECT" --policy-from-file="$file" >/dev/null
    echo "created policy: $name"
  fi
}

TMP="$(mktemp -d)"
cat > "$TMP/uptime.json" <<EOF
{
  "displayName": "ResellerOS live — uptime failing",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "conditions": [{
    "displayName": "uptime check failed from 2+ regions for 10 min",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\"",
      "aggregations": [{"alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_NEXT_OLDER", "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.host"]}],
      "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "600s",
      "trigger": {"count": 1}
    }
  }],
  "documentation": {"content": "The app or its database is not answering /api/public/health/live. Check Cloud Run logs, then the data-plane VM (PostgREST/GoTrue) and Cloud SQL."}
}
EOF
cat > "$TMP/cron.json" <<EOF
{
  "displayName": "ResellerOS cron failure",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "conditions": [{
    "displayName": "a [cron/…] failure line on stderr",
    "conditionMatchedLog": {
      "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE_NAME\" AND logName:\"stderr\" AND textPayload:\"[cron/\""
    }
  }],
  "alertStrategy": {"notificationRateLimit": {"period": "3600s"}, "autoClose": "86400s"},
  "documentation": {"content": "A cron finished with failures. The line names the job and the first reasons; full detail in the route's JSON response in the request log."}
}
EOF
cat > "$TMP/5xx.json" <<EOF
{
  "displayName": "ResellerOS 5xx spike",
  "combiner": "OR",
  "notificationChannels": ["$CHANNEL"],
  "conditions": [{
    "displayName": "more than 20 5xx responses in 5 minutes",
    "conditionThreshold": {
      "filter": "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE_NAME\" AND metric.labels.response_code_class=\"5xx\"",
      "aggregations": [{"alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}],
      "comparison": "COMPARISON_GT", "thresholdValue": 20, "duration": "0s",
      "trigger": {"count": 1}
    }
  }],
  "alertStrategy": {"autoClose": "86400s"}
}
EOF
mk_policy "ResellerOS live — uptime failing" "$TMP/uptime.json"
mk_policy "ResellerOS cron failure" "$TMP/cron.json"
mk_policy "ResellerOS 5xx spike" "$TMP/5xx.json"
rm -rf "$TMP"
echo "done"
