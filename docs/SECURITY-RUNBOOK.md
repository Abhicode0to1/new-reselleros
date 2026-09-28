# Security runbook — S20 (rate limit, Turnstile, PDF links, secrets)

_Written 28 Sep 2026 with the S20 code. Everything below is a step for a person with GCP
access (Pardeep). The code is already safe to deploy BEFORE any of these steps: every new
knob defaults to today's behaviour or to "no-op"._

Project `resellsubsos-prod` · Cloud Run service `resellersos` · region `asia-southeast1` ·
runtime SA `1005662057478-compute@developer.gserviceaccount.com`.

**Rule from cloudbuild.yaml:** add env with `--update-env-vars` / `--update-secrets`, **never**
`--set-env-vars` (that replaces all eleven existing vars, including the service-role key).

---

## What changed in code, and what it does on deploy with NO env changes

| Change | Default behaviour after deploy |
|---|---|
| `clientIp()` reads X-Forwarded-For from the **right** (`TRUSTED_PROXY_HOPS`, default 1) | Spoofed `X-Forwarded-For: 1.2.3.4` no longer creates a fresh rate-limit bucket per request. Same fix in `/api/attendance/mark` + `/network` (office-IP gate was bypassable from home) and the vault audit IP. |
| `rateLimitShared()` + migration `20260928140000` (`rate_limit_hit` RPC, service_role only) | Off until `RATE_LIMIT_STORE=postgres`. Per-instance memory, as before. |
| `lib/security/turnstile.ts` | No-op until `TURNSTILE_SECRET_KEY` is set. **Not wired into any route yet** — see "Turnstile" below. |
| PDF tokens `<exp>.<hmac>` (default 30 days, `PDF_TOKEN_TTL_DAYS`) | New links expire. Old links (no exp) keep working until `SIGNING_LEGACY_UNTIL` (default **31 Dec 2026**). |
| `PDF_SIGNING_SECRET` dual-verify (PDF + expense-claim links) | Setting the secret no longer breaks existing links: links signed with the service-role key still verify until `SIGNING_LEGACY_UNTIL`. |

### ⚠ Attendance: re-lock the office network after deploy (check first)

The office allowlist was captured with the OLD (left-most) XFF entry. For a normal office
connection the left-most and right-most entry are the same single IP, so nothing changes.
If the office sits behind a proxy that adds its own `X-Forwarded-For` (some corporate
firewalls do), the stored IP may be an internal one (10.x / 192.168.x) and marking would now
fail from the office. Check:

```sql
-- read-only
select tenant_id, allowed_ips from public.attendance_settings where cardinality(allowed_ips) > 0;
```

Any private-range IP in that list → the owner
opens Attendance → "Lock to this network" once from the office after the deploy.

---

## 1. Rate limit — shared store (optional, measure first)

```bash
# 1. Apply the migration on Cloud SQL, as the migration role (same as cloudsql/07):
gcloud sql connect resellersos-db --user=postgres --database=resellersos --project=resellsubsos-prod
#    resellersos=> SET ROLE resellersos_migration;
#    resellersos=> \i production/supabase/migrations/20260928140000_rate_limit_shared_store.sql
#    resellersos=> RESET ROLE;  notify pgrst, 'reload schema';
# 2. Verify in a SEPARATE run (never in the same run as the DDL):
#    production/supabase/tests/rate_limit_shared_store.test.sql  → must print PASS
# 3. Turn it on:
gcloud run services update resellersos --region=asia-southeast1 \
  --update-env-vars=RATE_LIMIT_STORE=postgres
# 4. Watch for "[rate-limit] shared store unavailable" in logs; if it appears constantly the
#    RPC is not reachable (PostgREST schema cache? grant?) and the app is on memory fallback.
gcloud logging read 'resource.labels.service_name="resellersos" AND textPayload:"shared store unavailable"' \
  --project=resellsubsos-prod --freshness=1h --limit=20
# Off again = remove the var:
gcloud run services update resellersos --region=asia-southeast1 --remove-env-vars=RATE_LIMIT_STORE
```

Cost: one extra PostgREST call (≤300 ms timeout) per `/api/public/*` and `/api/auth/signup`
request. If PostgREST needs a schema reload after the migration: `notify pgrst, 'reload schema';`.

### If a proxy is ever put in front of Cloud Run

Cloudflare orange-cloud or an HTTPS Load Balancer each append one more XFF hop. Then:

```bash
gcloud run services update resellersos --region=asia-southeast1 --update-env-vars=TRUSTED_PROXY_HOPS=2
```

Wrong value too LOW → everyone shares the proxy's bucket (429 storms). Too HIGH → spoofing
works again. Test after any change: `curl -H "X-Forwarded-For: 9.9.9.9" …/api/public/catalog/workspace`
a few times with a changing value — the limit must still trip.

### Cloud Armor (the edge layer, not done — needs an LB)

Cloud Armor attaches to an external HTTPS Load Balancer, not to a Cloud Run domain mapping.
Today traffic goes Cloudflare (DNS-only) → Cloud Run domain mapping, so there is no place to
attach a policy. Options, cheapest first: (a) Cloudflare orange-cloud + a Cloudflare rate-limit
rule on `/api/public/agent/*` and `/api/public/enquiry/*` (then `TRUSTED_PROXY_HOPS=2`);
(b) serverless NEG + external LB + Cloud Armor `rate-based-ban` — an infra project (~$18/mo LB).

---

## 2. Turnstile (CAPTCHA) — order matters

1. Cloudflare dashboard → Turnstile → add site `reselleros.anutech.in` (+ `anutech.in` if the
   public forms live there) → get **site key** (public) and **secret key**.
2. **Pawan** adds the widget to the enquiry forms, the chat box and signup, and wires
   `verifyTurnstile` into their API routes (request in the S20 report / CROSS-TEAM board):
   ```ts
   import { verifyTurnstile, readTurnstileToken } from "@/lib/security/turnstile";
   import { clientIp } from "@/lib/security/rate-limit";
   const body = await req.json();
   const ts = await verifyTurnstile(readTurnstileToken(req.headers, body), clientIp(req.headers));
   if (!ts.ok) return NextResponse.json({ error: "Verification fail hui — page reload karke dobara bhejiye." }, { status: 403 });
   ```
   Client sends the widget token as header `x-turnstile-token` or body field `cf-turnstile-response`.
   The site key is `NEXT_PUBLIC_TURNSTILE_SITE_KEY` → it is inlined at BUILD time (L42), so it
   goes into cloudbuild.yaml substitutions, not `run services update`.
3. **Only after that deploy is live**, set the secret (Secret Manager, not a plain env var):
   ```bash
   printf '%s' '<secret-from-cloudflare>' | gcloud secrets create turnstile-secret \
     --project=resellsubsos-prod --replication-policy=automatic --data-file=-
   gcloud secrets add-iam-policy-binding turnstile-secret --project=resellsubsos-prod \
     --member=serviceAccount:1005662057478-compute@developer.gserviceaccount.com \
     --role=roles/secretmanager.secretAccessor
   gcloud run services update resellersos --region=asia-southeast1 \
     --update-secrets=TURNSTILE_SECRET_KEY=turnstile-secret:latest
   ```
   Setting it before step 2 makes every real enquiry/signup fail with 403.

Cloudflare down → verify fails OPEN (logged `[turnstile] … fail-open`); an explicit
`success:false` fails closed.

---

## 3. PDF / claim link signing secret

Safe to do any day — old links keep verifying with the service-role key until
`SIGNING_LEGACY_UNTIL` (default `2026-12-31T18:30:00Z`).

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create pdf-signing-secret \
  --project=resellsubsos-prod --replication-policy=automatic --data-file=-
gcloud secrets add-iam-policy-binding pdf-signing-secret --project=resellsubsos-prod \
  --member=serviceAccount:1005662057478-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
gcloud run services update resellersos --region=asia-southeast1 \
  --update-secrets=PDF_SIGNING_SECRET=pdf-signing-secret:latest
```

Before `SIGNING_LEGACY_UNTIL`:
- Tell tenant owners to re-copy their **expense-claim link** (Settings → the claim link card)
  and re-share it with employees. Old claim links stop on that date.
- Links in already-sent order-confirmation emails stop on that date too (they would anyway
  after 30 days once re-issued with exp).

To extend the grace: `--update-env-vars=SIGNING_LEGACY_UNTIL=2027-03-31T18:30:00Z`.
To change link lifetime: `--update-env-vars=PDF_TOKEN_TTL_DAYS=90` (1..400).

**Do not rotate `pdf-signing-secret` by adding a new version** — there is only one "previous"
slot (the service-role key) and it closes at the grace date. Rotation = a code change that
adds a `PDF_SIGNING_SECRET_PREVIOUS`; not built.

---

## 4. Move the other plaintext env secrets into Secret Manager (not done)

Today these are plain Cloud Run env vars, readable by anyone with `run.services.get`:
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `SECRETS_MASTER_KEY`, `VAPID_PRIVATE_KEY`,
`INBOUND_EMAIL_SECRET`, Resend/Gemini keys. Per var, same pattern as above:

```bash
# read the current value WITHOUT printing it, straight into a secret
gcloud run services describe resellersos --region=asia-southeast1 --format=json \
  | node -e 'const s=JSON.parse(require("fs").readFileSync(0));const e=s.spec.template.spec.containers[0].env.find(x=>x.name===process.argv[1]);process.stdout.write(e.value)' CRON_SECRET \
  | gcloud secrets create cron-secret --project=resellsubsos-prod --replication-policy=automatic --data-file=-
gcloud secrets add-iam-policy-binding cron-secret --project=resellsubsos-prod \
  --member=serviceAccount:1005662057478-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor
gcloud run services update resellersos --region=asia-southeast1 --update-secrets=CRON_SECRET=cron-secret:latest
```

`--update-secrets` on a name that is currently a plain env var replaces it in one revision.
Do one var at a time and check `/api/public/health/live` + one cron after each.

---

## 5. OAuth tokens at rest (not done — too big for S20)

Google (Gmail, Contacts, Business Profile, Ads) refresh/access tokens are stored in plaintext.
`lib/crypto/vault.ts` (`encryptSecret` / `decryptSecret`, plaintext pass-through on read)
fits, but there are **~49 read/write sites** across `api/integrations/*`, `api/cron/*`,
`lib/google/*` and `lib/email/*`, owned by more than one person. Plan when picked up:
wrap every write in `encryptSecretIfPossible`, every read in `decryptSecret` (pass-through
keeps old rows working), then a one-off re-save sweep; test = round-trip + "plaintext row
still reads". Needs `SECRETS_MASTER_KEY` present (it is, per `set-cloudrun-master-key.mjs`).
