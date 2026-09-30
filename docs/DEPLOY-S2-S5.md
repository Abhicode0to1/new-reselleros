# Deploy day: S2 + S5 checklist

> Pardeep ke liye. 29 Sep 2026 ko repo padh kar likha. Production = **Cloud SQL `resellersos-db`**
> (`docs/adr/0001-database-on-cloud-sql.md`), hosted Supabase ab staging hai.
> AI is file ka koi step production par nahi chalata — neeche "Kaun kya karega" dekho.

## ⚠ Pehle ye padho — docs aapas me nahi milte

1. `AGENTS.md` §5 kehta hai migration `scripts/apply-migration.mjs` se lagao. Wo script
   `~/.claude.json` ke Supabase MCP ka token/project-ref leta hai = **hosted Supabase (staging)**, prod nahi.
   Aur usko `begin; … commit;` blocks chahiye — in 41 files me ek bhi nahi. **Prod ke liye use mat karo.**
2. `npm run migrations:verify` (drift-check) `supabase db query --linked` chalata hai. ADR 0001 kehta hai
   ye ab prod ka check **nahi** hai. Iska result prod ka sach mat maano.
3. Prod par migration ka jo tareeka repo me abhi likha hai (`docs/BACKUP.md`, `docs/SECURITY-RUNBOOK.md`):
   `gcloud sql connect` → `SET ROLE resellersos_migration` → `\i <file>` → `RESET ROLE` → `notify pgrst, 'reload schema';`
4. ~~`scripts/verify-deploy.mjs` me `PROD_URL = https://anutech.in`~~ — **theek hua 30 Sep (WC-ci):** ab
   `https://reselleros.anutech.in`, jo `ROLLBACK.md`, `cloudbuild.yaml` `_APP_URL` aur Dockerfile
   `NEXT_PUBLIC_APP_URL` bhi kehte hain (commit 23eecf13, 7 Sep: anutech.in wahan 301 karta hai).
5. R-013 kehta hai `definer_rpc_hardening.test.sql` "production par green" ho. `ROLLBACK.md` kehta hai SQL
   tests production par **kabhi nahi**. Neeche read-only SQL diya hai; test prod par chalana tumhara faisla.
6. ~~`cloudbuild.yaml` kehta hai `git push anutech HEAD:deploy`~~ — **theek hua 30 Sep (WC-ci):** remote ka
   naam machine par nirbhar hai; jo remote `github.com/Abhicode0to1/new-reselleros` ko point kare wahi
   (is machine par `origin`). `git remote -v` se pakka karo. (`.agents/AGENTS.md`,
   `production/docs/STAGING.md`, `TASKS.md` me abhi bhi `anutech` likha hai — un files ke maalik badlein.)

## Pehle (1 din pehle)

1. **R-013:** Abhishek `20260927100000_definer_rpc_hardening.sql` review kare (uske 12+ RPC rewrite hote hain).
   Wo bataye koi function sach me `anon` chahta hai ya nahi. Uska "OK" board par ho, tabhi S2.
2. **Backup:** Cloud SQL backup + PITR on hai (`docs/BACKUP.md`). Deploy se pehle ek on-demand backup lo:
   ```bash
   gcloud sql backups create --instance=resellersos-db --project=resellsubsos-prod
   gcloud sql backups list --instance=resellersos-db --project=resellsubsos-prod --limit=3
   ```
   (Ye command repo me nahi likhi — `gcloud sql backups --help` se confirm karo.)
3. **Kya prod par already hai?** Drift-check prod nahi dekhta (upar #2). Isliye seedha prod par read-only:
   ```sql
   select to_regclass('public.marketing_tools')  as s5_pehli_file,     -- NULL = 20260926190000 nahi laga
          to_regclass('public.rate_limit_buckets') as s20_file,
          exists(select 1 from information_schema.columns
                  where table_name='prepaid_advances' and column_name='channel') as file_20260926180000;
   select to_regclass('supabase_migrations.schema_migrations');         -- ledger hai bhi? pakka nahi
   ```
   `file_20260926180000` = true aur baaki NULL → neeche wali 39 files pending hain.
4. **Table owner check** (Cloud SQL par sirf owner policy/trigger badal sakta hai — `cloudsql/01b`):
   ```sql
   select tablename, tableowner from pg_tables
    where schemaname='public' and tableowner <> 'resellersos_migration';   -- 0 rows chahiye
   ```
   Rows aaye to S13 (`ALTER POLICY`) aur S2 (users trigger) fail ho sakte hain — Abhishek se baat karo.
5. **Git-only check** (AI bhi chala sakta hai): `cd production && node scripts/migration-order-check.mjs --base origin/manager-pardeep`
6. **Numbers note karo (S17):** Balance Sheet, P&L (is FY), ek customer ka Ledger — totals ka screenshot.
7. **Kaun kab:** Pardeep apply + deploy. Abhishek on-call (R-013, money RPCs). Hitesh deploy ke baad QA.
   Shaant time chuno (crons: renewals 09:00, backup 00:00 IST — `scripts/setup-cloud-scheduler.sh`).

## Step 1 — S2 akeli (security)

```bash
cd C:/Users/mso50/new-reselleros
gcloud sql connect resellersos-db --user=postgres --database=resellersos --project=resellsubsos-prod
```
```sql
\set ON_ERROR_STOP on
SET ROLE resellersos_migration;
\i production/supabase/migrations/20260927100000_definer_rpc_hardening.sql
RESET ROLE;
notify pgrst, 'reload schema';
```
Verify **alag run me** (DDL ke saath SELECT nahi — AGENTS.md §5):
```sql
select tgname from pg_trigger where tgname = 'trg_users_insert_server_only';          -- 1 row
select has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can
  from pg_proc p where p.proname = 'refund_payment';                                  -- false
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prosecdef
   and pg_get_functiondef(p.oid) ~* 'if v_tenant is not null and ';                   -- 0
```
Phir haath se ek baar: signup → /welcome → join-approval flow (R-013 "done when").
Migration fail ho to baaki mat lagao — Abhishek ko bulao.

## Step 2 — S5: baaki 41 files, file-order me

Har file ke liye Step 1 wala hi tareeka (`SET ROLE` → `\i` → `RESET ROLE`), ek-ek karke, order mat todo.
Aakhir me ek baar `notify pgrst, 'reload schema';`. Error aaye → ruko, aage mat badho (forward-fix, `ROLLBACK.md`).

| File | Kya karti hai | Dhyaan |
|---|---|---|
| 20260926190000_marketing_hub | marketing_tools, tracking_links, email_suppressions | naye table + service_role policy |
| 20260926200000_campaign_template_seed | system email templates seed | data insert (upsert, dobara chala sakte ho) |
| 20260926210000_referral_partner_code | referral_partners.code + trigger | **backfill** har partner ka code, phir unique index |
| 20260926220000_review_requests | review_link + review_requests | — |
| 20260926230000_whatsapp_broadcast | WA templates, opt-outs, broadcasts | — |
| 20260926240000_marketing_campaigns | marketing_campaigns + expenses.campaign_id | — |
| 20260926250000_lead_customer | leads.customer_id + same-tenant trigger | — |
| 20260927110000_money_history_restrict | employee/bank FK CASCADE→RESTRICT, delete guards | FK dobara banti hai = table scan (chhote tables) |
| 20260927120000_books_lock | tenants.books_locked_until + lock triggers | Billing tables bhi lock — Abhishek review (board) |
| 20260927130000_tds_deductor | vendors.pan, challan/period; 2 RPC nayi signature | **backfill** PAN GSTIN se; purani signature drop |
| 20260927140000_undo_sale_credit_note | issued invoice undo = credit note, void nahi | money behaviour badla |
| 20260927150000_audit_log_values | activity_log.changes + audit triggers | — |
| 20260927160000_employee_pf_wage | employees Basic/DA | — |
| 20260927170000_salary_expense_by_period | pay_salary accrual; purane overload drop | **backfill: purane salary expense ki date badalti hai** → purane mahino ka P&L badlega |
| 20260927180000_pf_wage_on_payslip | salary_payments.pf_wage; pay_salary 18 arg | purani signature drop |
| 20260927190000_book_bank_txn_as_bill_commission | bill/commission bank line se book | CHECK constraint dobara (bank_transactions scan) |
| 20260927200000_month_close | month_close_checks | — |
| 20260927210000_prepaid_invoice_details | consume_prepaid_fifo tax facts | purani 6-arg signature drop |
| 20260927220000_expense_rcm | expenses.rcm / rcm_tax | — |
| 20260927230000_fixed_assets | fixed asset register | — |
| 20260927240000_employee_assets | employee ke paas company ka saamaan | — |
| 20260927250000_gbp | Google Business Profile tables | GBP sync ke liye Google connect chahiye |
| 20260927260000_ad_platforms | Google/Meta ad spend tables | Meta token DB me; ads-sync cron |
| 20260927270000_lead_finder | AI lead finder tables | Gemini key chahiye (pakka nahi — `src/app/api/cron/lead-finder` dekho) |
| 20260927280000_anon_default_privileges | anon ko default kuch nahi + sweep | **role-dependent**: `SET ROLE resellersos_migration` me "for role postgres" wala hissa skip hota hai — pakka nahi, Abhishek se confirm |
| 20260928100000_rls_initplan_wrap (S13) | har policy `(select current_tenant_id())` | saari public policies ALTER — owner check (Pehle #4) |
| 20260928101000_hot_tenant_date_indexes (S14) | 15 index | plain CREATE INDEX = writes rukte hain build tak; >100k rows ho to file ke header wala CONCURRENTLY pehle |
| 20260928110000_report_functions (S17) | report_* RPC | **app deploy se pehle** lagni chahiye |
| 20260928120000_trial_balance_daybook_msme | day book, 26AS, MSME aging; vendors.udyam | — |
| 20260928130000_nav_badges | sidebar badges ek RPC | app se pehle |
| 20260928140000_rate_limit_shared_store | UNLOGGED rate_limit_buckets | env `RATE_LIMIT_STORE=postgres` optional (`SECURITY-RUNBOOK.md` §1) |
| 20260928141000_backup_per_tenant (S15) | backup_tenant(), retention 30→7 | agli backup run par 7 se purane in-DB snapshot **delete** (wapas nahi aate) |
| 20260928150000_whatsapp_reminders | WA reminder settings/log | default OFF |
| 20260928151000_indiamart_tally | IndiaMART import + tenant_secrets key | key na ho to cron skip |
| 20260928160000_today_inbox | today_inbox() | app se pehle |
| 20260928190000_report_fixes_ist_ledger_trend_cn | ledger IST, P&L trend me credit note | 110000 ke baad hi |
| 20260928200000_list_rpcs | list_leads, list_whatsapp_threads | app se pehle |
| 20260929100000_revoke_anon_can_see_record | can_see_record anon se hata | **100000 (S13) ke baad hi** |
| 20260929130000_lead_counts (S40) | lead_counts() + list_leads naye filter; 3 helper fn; 2 index | **app se pehle** (leads page inhe bulata hai); 2 plain CREATE INDEX on leads — chhoti table, theek |
| 20260929185929_day_book_salary_journal | report_day_book: salary kharcha = Journal voucher | sirf function badla, data nahi; kabhi bhi |
| 20260930110000_scale_indexes (S43) | pg_trgm + leads/lead_activities/subscriptions index | **prod par har CREATE INDEX ko CONCURRENTLY, transaction ke bahar, pehle chalao** (file header dekho); phir file |

Order ka niyam: pehle saari migrations, phir app (expand → deploy, `ROLLBACK.md`). Beech ka waqt chhota rakho.

## Step 3 — App deploy

```bash
git log --oneline -1                          # ye SHA live hona chahiye
git push origin HEAD:deploy                   # origin = github.com/Abhicode0to1/new-reselleros (git remote -v)
cd production && npm run verify:deploy -- <short-sha>
curl -s https://reselleros.anutech.in/api/version
```
Gate (`cloudbuild.yaml` step `gate`: npm ci, tsc, vitest) red ho to deploy hota hi nahi.

## Step 4 — Har card ka check

| Card | Kya dekhna hai | Pass kab |
|---|---|---|
| S3 (Next 15.5.26) | `/api/version` naya SHA; prod + staging par login, ek dialog (quote/invoice) khol ke band karo | login chale, dialog me console error nahi |
| S13 | Supabase advisor Cloud SQL par nahi chalta. Ye SQL chalao ↓ | 0 rows |
| S14 | 15 index query ↓ + `select indexrelid::regclass from pg_index where not indisvalid;` | 15 rows, invalid 0 |
| S15 | `docs/BACKUP.md` "Steps for Pardeep" #3: `gcloud scheduler jobs run resellersos-backup …`, phir `daily/<aaj>/_manifest.json` | `tenant_count` = tenants, `"missing": []`, naya format (purana `daily/DATE.json` nahi) |
| S17 | /accounting/balance-sheet, /pnl, /ledger kholo; DevTools Network | numbers "Pehle #6" jaise; Balance Sheet par ek `rpc/report_balance_sheet` |
| S18 | `gcloud builds list --limit=3` → build ke steps me `gate` SUCCESS | gate pehle, phir build/deploy |
| S22 | `gcloud scheduler jobs run resellersos-renewals --location=asia-southeast1`; logs ↓ | < 540s, koi 504 nahi; service timeout 600 |

```sql
-- S13: koi policy bina (select …) wale current_tenant_id() ke na bache (pakka nahi ki text exact yahi ho)
select tablename, policyname from pg_policies
 where schemaname='public'
   and (coalesce(qual,'') || coalesce(with_check,'')) ~ 'current_tenant_id\(\)'
   and (coalesce(qual,'') || coalesce(with_check,'')) !~* 'select current_tenant_id\(\)';
select count(*) from pg_policies where (coalesce(qual,'')||coalesce(with_check,'')) ~ 'can_see_record';  -- 0
-- S14
select tablename, indexname from pg_indexes where schemaname='public' and indexname in (
 'leads_tenant_created_idx','invoices_tenant_invoice_date_idx','payments_tenant_received_idx',
 'quotes_tenant_created_date_idx','lead_activities_tenant_time_idx','project_sales_tenant_time_idx',
 'project_tasks_tenant_time_idx','project_milestones_tenant_time_idx','project_payments_tenant_time_idx',
 'project_labour_tenant_time_idx','emi_payments_tenant_time_idx','business_loan_payments_tenant_time_idx',
 'employee_loan_repayments_tenant_time_idx','leave_entries_tenant_time_idx','renewal_email_log_tenant_time_idx');
```
```bash
# S22
gcloud run services describe resellersos --region=asia-southeast1 --format='value(spec.template.spec.timeoutSeconds)'   # 600
gcloud logging read 'resource.labels.service_name="resellersos" AND httpRequest.status=504' --project=resellsubsos-prod --freshness=1d --limit=20
gcloud logging read 'resource.labels.service_name="resellersos" AND httpRequest.requestUrl:"/api/cron/renewals"' --project=resellsubsos-prod --freshness=1h --limit=5 --format='value(httpRequest.status,httpRequest.latency)'
```
Naye crons (gbp-sync, ads-sync, lead-finder, indiamart-leads) ke Scheduler jobs bane hain ya nahi — pakka nahi,
`gcloud scheduler jobs list --location=asia-southeast1 --project=resellsubsos-prod` se dekho.

**Local data notes (S5):** repo me "note 22" nahi mila — board par note 22 dekho aur deploy ke baad dobara karo.

## Kuch toote to

- App kharab: **[`ROLLBACK.md`](ROLLBACK.md)** — `gcloud run services update-traffic … --to-revisions=<prev>=100`, baad me `--to-latest`.
- Migration kharab: rollback nahi, **forward-fix** (nayi migration). Data kharab = Cloud SQL PITR, sirf Pardeep ka faisla.
- 6 Sep se purani revision par mat jao (purana DB).

## Kaun kya karega

| Kaam | AI | Sirf Pardeep |
|---|---|---|
| Files padhna, order-check, local SQL tests, board update | ✅ | |
| Prod par read-only SQL / backup / migration apply | ❌ | ✅ |
| `deploy` branch push, rollback, Scheduler/env var | ❌ | ✅ |
| R-013 review | | Abhishek |
| Deploy ke baad browser QA (S3, S17) | madad | Hitesh / Pardeep |

AI kabhi deploy nahi karta aur prod migration nahi lagata.
