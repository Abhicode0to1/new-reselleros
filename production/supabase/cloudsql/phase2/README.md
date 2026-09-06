# Phase 2 · Stand up the Supabase data plane (PostgREST + Auth + Storage) on a VM

The app talks to Supabase's **Data API (PostgREST)** and **Auth (GoTrue)**; Cloud SQL has
neither. This runs both (plus Storage) on a small VM against Cloud SQL, fronted by Caddy at
`https://api.anutech.in`. Then the app just repoints `NEXT_PUBLIC_SUPABASE_URL` (Phase 3).

Run **Phase 1 (01a + 01b) first** — the roles/schemas/`auth.uid()` must already exist.

Files here: `docker-compose.yml`, `Caddyfile`, `.env.example`. Fill `.env` only on the VM.

---

## A. Create the VM + firewall + Cloud SQL access  (Cloud Shell)

```bash
# 1. The VM
gcloud compute instances create supabase-gateway \
  --project=resellsubsos-prod --zone=asia-southeast1-a \
  --machine-type=e2-small --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=20GB --tags=http-server,https-server

# 2. Open 80/443 to the internet (for Caddy + Let's Encrypt)
gcloud compute firewall-rules create allow-web \
  --project=resellsubsos-prod --allow=tcp:80,tcp:443 \
  --target-tags=http-server,https-server --direction=INGRESS || true

# 3. Let the VM's service account reach Cloud SQL
PROJNUM=$(gcloud projects describe resellsubsos-prod --format='value(projectNumber)')
gcloud projects add-iam-policy-binding resellsubsos-prod \
  --member="serviceAccount:${PROJNUM}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# 4. Note the VM's external IP (for DNS)
gcloud compute instances describe supabase-gateway --zone=asia-southeast1-a \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
```

## B. DNS — point api.anutech.in at the VM  (Cloudflare)

Add an **A record**: name `api`, value = the VM external IP from A.4, **Proxy status = DNS only
(grey cloud)**. Grey cloud is required so Caddy can complete the Let's Encrypt HTTP challenge.

Verify (wait a minute): `nslookup api.anutech.in` → the VM IP.

## C. Put the config on the VM

From Cloud Shell, upload the three files here (⋮ → Upload: `docker-compose.yml`, `Caddyfile`,
`.env.example`), then copy them to the VM:

```bash
gcloud compute scp docker-compose.yml Caddyfile .env.example \
  supabase-gateway:~/ --zone=asia-southeast1-a --project=resellsubsos-prod
```

## D. Install Docker on the VM

```bash
gcloud compute ssh supabase-gateway --zone=asia-southeast1-a --project=resellsubsos-prod
# on the VM:
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER && exit          # re-login so docker works without sudo
```
Re-SSH after this (`gcloud compute ssh supabase-gateway ...`).

## E. Fill `.env` on the VM

```bash
cp .env.example .env
```
Then fill every `__PLACEHOLDER__` in `.env` (`nano .env`):
- The 3 DB passwords — from the Phase-1 secrets note (authenticator / auth_admin / storage_admin).
- `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` — the Supabase dashboard values you copied.
- `GOOGLE_CLIENT_ID` / `GOOGLE_SECRET` — from Supabase → Auth → Providers → Google.
- SMTP — leave as-is for now (`MAILER_AUTOCONFIRM=true` skips confirm emails; existing users
  log in with their password regardless).

These secrets live ONLY in this file on the VM — never in git, never in chat.

## F. Bring it up — STAGED (so we catch any issue one service at a time)

```bash
# 1) Cloud SQL proxy alone — must reach the DB
docker compose up -d cloudsql-proxy
docker compose logs cloudsql-proxy      # expect "ready for new connections"

# 2) PostgREST — the data API
docker compose up -d rest
docker compose logs rest                # expect "Listening on port 3000", "Config reloaded"

# 3) Auth — creates the auth.* tables on first boot (its migrations)
docker compose up -d auth
docker compose logs auth                # expect "GoTrue API started", migrations ran

# 4) Storage — creates the storage.* tables on first boot
docker compose up -d storage
docker compose logs storage

# 5) Caddy — TLS + routing (gets the cert for api.anutech.in)
docker compose up -d caddy
docker compose logs caddy               # expect "certificate obtained successfully"
```

**Paste me any errors after each step** — bring-up quirks (a version/env mismatch, a missing
grant) are normal on first run and we fix them one at a time.

## G. Verify from Cloud Shell (or anywhere)

```bash
# PostgREST is up and behind TLS:
curl -s https://api.anutech.in/rest/v1/ -H "apikey: <ANON_KEY>" | head

# Auth is up:
curl -s https://api.anutech.in/auth/v1/health

# A real table read as anon (RLS applies — a public table should answer, e.g. items catalog):
curl -s "https://api.anutech.in/rest/v1/items?select=name&limit=1" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```

When these answer, the data plane works. **Then:**
- **Phase 1b** — import `auth.users` (+ identities) rows from Supabase so existing people can
  log in and the `public.users.id → auth.users.id` links resolve. (GoTrue has now created the
  auth tables; we load the data into them.)
- **Phase 3** — repoint the app: `NEXT_PUBLIC_SUPABASE_URL=https://api.anutech.in` +
  anon/service keys, rebuild, deploy. Keep Supabase live in parallel until verified.
- **Phase 4** — money-spine test (login, tenant isolation, quote→pay→invoice) before cutover.
