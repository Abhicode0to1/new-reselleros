# Rollback runbook — a bad deploy, back in two minutes

> Canonical rollback runbook (S18, 28 Sep 2026). Replaces the body of
> `docs/DEPLOY-ROLLBACK.md` (1 Sep, audit B6), which now points here because the Cloud
> Monitoring "ResellerOS down" alert names that file. That version said `asia-south1`; the
> service moved to **`asia-southeast1`** with the Cloud SQL move (`cloudbuild.yaml`
> `_REGION`), so its commands would now fail with "service not found".

**Service:** `resellersos` · **Region:** `asia-southeast1` · **Project:** `resellsubsos-prod`
· **Public host:** `https://reselleros.anutech.in` (`_APP_URL` in `cloudbuild.yaml`)

## When

The app is returning 500s, a page is blank, or `npm run verify:deploy` cannot read the new
build, and the cause is not obvious within two minutes. **Roll back first, debug after.**
Cloud Run keeps every previous revision; moving traffic back is instant and changes no code
and no data.

A red build never gets this far: `cloudbuild.yaml` step `gate` (npm ci, tsc, vitest) fails
the build before the image is made. Rollback is for what the tests did not catch.

## 1. Find the revision to go back to

Which revision is serving now, and the last few before it (newest first). The image tag is
the commit's short SHA, so each row tells you which commit it runs:

```bash
gcloud run services describe resellersos --region=asia-southeast1 \
  --format='value(status.traffic)'

gcloud run revisions list --service=resellersos --region=asia-southeast1 --limit=5 \
  --format='table(metadata.name, status.conditions[0].status:label=READY, spec.containers[0].image.basename(), metadata.creationTimestamp)'
```

Pick the newest revision **older than the bad one** that shows `READY = True`. A revision
that never became ready (failed startup probe) never served traffic — skip it.

To match a SHA to a commit: `git log --oneline -1 <sha>`. To see what is live right now:
`curl -s https://reselleros.anutech.in/api/version` → `{"sha": "...", "buildId": "..."}`.

## 2. Move all traffic to it

```bash
gcloud run services update-traffic resellersos --region=asia-southeast1 \
  --to-revisions=<prev>=100
# e.g. --to-revisions=resellersos-00123-abc=100
```

## 3. Confirm (after ~30 s)

```bash
curl -s https://reselleros.anutech.in/api/version   # sha must be the OLD one now
```

Then open the login page and one money page (an invoice) in a browser.

## 4. Afterwards — un-pin, or the next deploy will not go live

`update-traffic --to-revisions` **pins** traffic to that revision. While it is pinned, a new
deploy from Cloud Build creates a revision but it gets **no traffic** — check with the
`describe` command in step 1 after the fix deploys. To try the new revision before it takes
traffic, give it a tag, which gives it its own URL at 0% traffic:
`gcloud run services update-traffic resellersos --region=asia-southeast1 --set-tags=candidate=<new-revision>`.
When it is good, send all traffic back to the latest:

```bash
gcloud run services update-traffic resellersos --region=asia-southeast1 --to-latest
```

Post one line in `#deploy` on the team board: what broke, which revision you went back to,
and when you un-pinned.

## Migrations: never rolled back — forward-fix only

- A rollback moves **code** only. The database stays as the new deploy left it.
- We do **not** write or run "down" migrations. Undoing a schema change is a **new**
  migration with a newer timestamp (`npm run migration:new`), reviewed like any other. An
  edited old migration never reaches the database — CI's migration check
  (`scripts/migration-order-check.mjs`) fails on one.
- So every migration must keep the **previous** code working (expand → deploy → contract):
  add columns/tables/functions first; drop or rename only in a later deploy, once no live
  revision uses the old shape. A changed RPC signature keeps the old overload until the
  code that calls it is gone. This is what makes a code-only rollback safe.
- If the bad deploy included a money-RPC or trigger change, check the old code against the
  new schema before declaring it fixed (the SQL regression tests: `npm run test:sql --
  --local` against a local stack — never against production).
- Data damaged, not just code? That is a restore, not a rollback: Cloud SQL point-in-time
  recovery (7 days) restores to a **new** instance — see `docs/BACKUP.md`. It affects every
  tenant, so it is a human decision (Pardeep), never an agent's.

## Two things that surprise people

- **Env vars are frozen per revision.** Rolling back also rolls back any env var changed
  since that revision. If you changed a var in between, re-apply it with
  `gcloud run services update --update-env-vars` (never `--set-env-vars`, which replaces
  all of them — see `cloudbuild.yaml`).
- **Build-time public values** (`NEXT_PUBLIC_*`) are baked into the image, so the old
  revision also carries the old Supabase URL / anon key. After the Cloud SQL move, do not
  roll back to a revision built before that move — it would talk to the old database.

## Rehearsal log

| Date | Who | Result |
|---|---|---|
| 1 Sep 2026 | Claude (audit B6) | ✅ 00460→00458→latest, `/api/version` alive both ways; ~1 min round trip. Same day a revision with a bad startup probe (00459) never became READY and traffic stayed on the old one — the health gate working live. (Region then: asia-south1.) |
| — | — | Not yet rehearsed in asia-southeast1. Next quiet deploy: do steps 1–4 once and add a row. |
