# Staging environment — plan and runbook

*27 Sep 2026. Deep-study S8 ("local dev runs on production") is only half solved by pointing
`.env.local` elsewhere; the other half is a place where all three of us can SEE each other's
work before it reaches customers. This is that place.*

## What we have today

| Piece | Production | Staging today |
|---|---|---|
| App | Cloud Run `resellersos`, `asia-southeast1`, built by Cloud Build on push to `deploy` | none |
| Database + Data API | Self-hosted: Cloud SQL + PostgREST/GoTrue/Storage on an e2-small VM, `https://api.anutech.in` | **none yet.** The `resellerosv3-staging` project the old README named no longer exists. Decision 27 Sep 2026: reuse the OLD hosted prod project `ontpnqjoysjgrlsukecm` (`resellersos`, ap-south-1, paused since the Cloud SQL move) as staging — restore it, wipe it, rebuild from migrations |
| Crons | 15 Cloud Scheduler jobs (Singapore) | none |
| Email / WhatsApp / Razorpay | live keys | — |
| Who can see a branch before deploy | nobody | nobody |

So the database half of staging already exists and is kept in step with `supabase/migrations`.
What is missing is an app in front of it, and a branch that feeds it.

## Target (cheapest thing that works)

```
git push origin <my-branch>:staging  ──►  Cloud Build trigger (branch: staging)
                                          │  same Dockerfile, build-args point at staging
                                          ▼
                              Cloud Run service `resellersos-staging`  (scale-to-zero)
                                          │
                                          ▼
                     hosted Supabase `ontpnqjoysjgrlsukecm`  (free tier; schema = migrations; demo tenant)
```

- **One service, one branch.** `staging` is a throwaway integration branch: anyone pushes to it,
  it deploys in ~6 minutes, everyone opens `https://resellersos-staging-….a.run.app`. Force-push is
  fine; it is never merged from, only into (via the normal branches).
- **No real customers, no real money.** Staging Supabase holds the demo tenant from `seed.sql` plus
  whatever we type. Razorpay in test mode, email to a sandbox, WhatsApp off, crons off.
- **Cost:** Cloud Run scale-to-zero ≈ ₹0–300/month; Supabase free tier ₹0 (pauses after 7 idle
  days — `db:rebuild` wakes it). Nothing else.

## Setup — one time (about an hour, needs Cloud project + Supabase access)

### 1. Staging database (restore the old project, wipe, rebuild)

1. supabase.com → project **resellersos** (`ontpnqjoysjgrlsukecm`) → **Restore** (a paused free
   project; takes a few minutes). Only the dashboard can do this.
2. Settings → Database → **reset the database password**; Settings → API → copy the anon key
   and the service_role key. Keep both out of chat.
3. From `production/`, after `npx supabase login` with a fresh access token:

```bash
node scripts/rebuild-db.mjs ontpnqjoysjgrlsukecm   # WIPES it, then baseline.sql + baseline-storage.sql + supabase/migrations
```

The wipe is the point: that project holds a stale pre-September copy of production, and staging
must never be mistaken for a source of real data.

Then seed one demo tenant so the app is not empty on first open. `supabase/seed.sql` is written
for the local stack; the demo tenant, owner user and catalogue rows from it can be applied to
staging through the SQL editor of the staging project (never the prod project — see
`supabase/migrations/README.md` for how to tell them apart). Create the owner login in the
staging project's Auth → Users with a throwaway password and share it in the board's
`#deploy` channel.

### 2. Staging secrets

Secret Manager is not enabled on the project yet (checked 27 Sep 2026). Enable it once at
https://console.developers.google.com/apis/api/secretmanager.googleapis.com/overview?project=resellsubsos-prod
— or, for staging only, pass these as plain env vars on the service; nothing on staging guards
real money. If Secret Manager is enabled:

```bash
P=resellsubsos-prod
for s in STAGING_SUPABASE_SERVICE_ROLE_KEY STAGING_CRON_SECRET STAGING_SECRETS_MASTER_KEY; do
  gcloud secrets create $s --project $P --replication-policy=automatic 2>/dev/null || true
done
printf '%s' '<staging service_role key>' | gcloud secrets versions add STAGING_SUPABASE_SERVICE_ROLE_KEY --project $P --data-file=-
openssl rand -hex 32 | gcloud secrets versions add STAGING_CRON_SECRET --project $P --data-file=-
openssl rand -hex 32 | gcloud secrets versions add STAGING_SECRETS_MASTER_KEY --project $P --data-file=-
```

Everything else (Razorpay test keys, Resend test key, Gemini key) can be plain env vars on the
staging service — none of them touch a real customer.

### 3. Cloud Build trigger for the `staging` branch

`cloudbuild.yaml` already takes `_REGION`; add `_SERVICE` and the Supabase build-args as
substitutions so the same file serves both services. Then:

```bash
gcloud builds triggers create github --project $P --name resellersos-staging \
  --repo-owner <owner> --repo-name <repo> --branch-pattern '^staging$' \
  --build-config cloudbuild.yaml \
  --substitution _REGION=asia-southeast1,_SERVICE=resellersos-staging,_SUPABASE_URL=https://ontpnqjoysjgrlsukecm.supabase.co,_SUPABASE_ANON_KEY=<staging anon key>
```

First deploy of the service (after that the trigger updates it):

```bash
gcloud run deploy resellersos-staging --project $P --region asia-southeast1 \
  --image <image the trigger built> --allow-unauthenticated --min-instances 0 --max-instances 2 \
  --memory 1Gi --timeout 600 \
  --update-secrets SUPABASE_SERVICE_ROLE_KEY=STAGING_SUPABASE_SERVICE_ROLE_KEY:latest,CRON_SECRET=STAGING_CRON_SECRET:latest,SECRETS_MASTER_KEY=STAGING_SECRETS_MASTER_KEY:latest \
  --update-env-vars NEXT_PUBLIC_SUPABASE_URL=https://ontpnqjoysjgrlsukecm.supabase.co,NEXT_PUBLIC_APP_URL=https://resellersos-staging-<hash>-as.a.run.app,APP_ENV=staging,RAZORPAY_MODE=test,EMAIL_PROVIDER=log,WHATSAPP_BSP=off
```

`--timeout 600` on purpose: the scheduler's attempt deadline is 540s and prod still runs the
300s default (deep study S22) — staging is where that gets fixed first.

### 4. Guard rails so staging cannot bite

- **No scheduler jobs on staging.** Crons are run by hand when testing them:
  `curl -H "Authorization: Bearer $STAGING_CRON_SECRET" https://…/api/cron/renewals`.
- **Outbound off by default:** email provider `log` (writes to Cloud Logging instead of sending),
  WhatsApp BSP `off`, Razorpay test keys, no Google OAuth client (Contacts/Gmail/GBP/Ads connect
  will say "not configured" — that is correct; those need prod redirect URIs).
- **A banner.** The topbar shows "STAGING" when `APP_ENV=staging`, so a screenshot can never be
  mistaken for production. (Small change in `components/layout/topbar.tsx`; ~10 lines.)
- **Supabase staging project: Auth → Google provider off**, email/password only.

### 5. Local dev points at staging (S8)

Every laptop's `production/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://ontpnqjoysjgrlsukecm.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon>
SUPABASE_SERVICE_ROLE_KEY=<staging service_role>
```

Production keys leave the laptops entirely. The one script that still needs prod
(`scripts/apply-migration.mjs`) reads its token from `~/.claude.json`, not `.env.local`.

## How we use it (the daily loop)

1. Work on your own branch as now (`manager-pardeep`, `billing-abhishek`, `website-pawan`).
2. Want the others to see it? `git push origin HEAD:staging` (force is fine). Six minutes later
   it is live at the staging URL; say so in the board's `#deploy` channel.
3. Two people pushing the same day: the second one merges the first's branch into their push
   (`git merge origin/<their-branch>` before pushing to `staging`). That is also a free
   pre-merge conflict check.
4. Migrations: a migration committed on any branch reaches staging on the next
   `npm run db:rebuild` (schema only, so it is safe to run any time). Run it before pushing
   code that needs the new table.
5. Prod deploy stays as it is: `git push anutech HEAD:deploy`, after the migrations are applied
   there in order — and only after the same commit has been seen working on staging.

## What this does not solve, and what it enables next

- It is **not** a copy of production data. When a bug needs real data, reproduce it with a
  demo row; if it truly needs prod, that is a read-only query on prod, not a staging refresh.
- With staging in place, three later items become cheap: CI can deploy to staging on every
  merge and gate prod on it (S18), Playwright's auth-gated specs get a real target
  (`PLAYWRIGHT_BASE_URL` = staging), and the Next 15 upgrade (S3) can soak there for a week.

## Effort

| Step | Who | Time |
|---|---|---|
| 1 Seed staging DB | Pardeep | 20 min |
| 2 Secrets | Pardeep (needs Secret Manager admin) | 10 min |
| 3 Trigger + first deploy | Pardeep; Cloud Build needs GitHub connected once | 30 min |
| 4 Banner + env switches | Pardeep (code, ~1 hr incl. tests) | 1 hr |
| 5 `.env.local` on each laptop | each of us | 5 min |
