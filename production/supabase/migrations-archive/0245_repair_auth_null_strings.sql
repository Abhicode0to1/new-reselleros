-- ============================================================================
-- 0245 — repair NULLs in auth.users string columns (the Admin API killer)
-- ============================================================================
--
-- ─── ONE NULL BREAKS THE WHOLE LIST, NOT ONE ROW ────────────────────────────
-- `supabase.auth.admin.listUsers()` was returning:
--
--     Database error finding users
--
-- for EVERY call. Not slow, not partial — a hard failure, caused by exactly two
-- rows out of twenty-four having `email_change IS NULL`. GoTrue scans that column
-- into a non-nullable Go string, so a single NULL fails the query that backs the
-- entire endpoint. The blast radius of the bad data is the whole API, and nothing
-- in the error names the column, the row, or even the table.
--
-- ─── WHERE THE NULLS CAME FROM ──────────────────────────────────────────────
-- The two rows are e2e-tenant-a/b@resellersos.test, inserted directly by a seed
-- script on 23 May 2026. `admin.createUser()` writes '' into these columns; a
-- hand-written INSERT leaves them NULL because the schema permits it. Anything
-- that inserts into auth.users by hand can reintroduce this.
--
-- ─── WHAT IT HAD BEEN SILENTLY COSTING ──────────────────────────────────────
-- /api/platform/signups calls listUsers() wrapped in `.catch(() => ({ data: {
-- users: [] } }))`. So the founder's cross-tenant signup page has been rendering
-- with NO auth data for months and looking fine — the catch turned a total API
-- failure into "no phone numbers found". That catch should be revisited: it is
-- the same disease as `if (error) return null`, one layer out.
--
-- ─── WHY ALL THE COLUMNS, NOT JUST THE ONE THAT BIT ─────────────────────────
-- Only `email_change` was NULL today. The others are the same shape, scanned the
-- same way, and NULLable for the same reason, so fixing one and waiting for the
-- next is not worth the second outage. '' is what GoTrue itself writes.
--
-- ⚠️ Data repair only — no DDL, no schema change to `auth`.
-- ============================================================================

begin;

update auth.users set
  confirmation_token         = coalesce(confirmation_token, ''),
  recovery_token             = coalesce(recovery_token, ''),
  email_change               = coalesce(email_change, ''),
  email_change_token_new     = coalesce(email_change_token_new, ''),
  email_change_token_current = coalesce(email_change_token_current, ''),
  phone_change               = coalesce(phone_change, ''),
  phone_change_token         = coalesce(phone_change_token, ''),
  reauthentication_token     = coalesce(reauthentication_token, '')
where confirmation_token is null
   or recovery_token is null
   or email_change is null
   or email_change_token_new is null
   or email_change_token_current is null
   or phone_change is null
   or phone_change_token is null
   or reauthentication_token is null;

commit;


-- ============================================================================
-- VERIFY — RUN THIS AS A SEPARATE EDITOR RUN
--
-- Expect every count to be 0. The real proof is behavioural, not this query:
-- call listUsers() and confirm it returns rows instead of
-- "Database error finding users".
-- ============================================================================
/*
select
  count(*) filter (where confirmation_token is null)         as confirmation_token,
  count(*) filter (where recovery_token is null)             as recovery_token,
  count(*) filter (where email_change is null)               as email_change,
  count(*) filter (where email_change_token_new is null)     as email_change_token_new,
  count(*) filter (where email_change_token_current is null) as email_change_token_current,
  count(*) filter (where phone_change is null)               as phone_change,
  count(*) filter (where phone_change_token is null)         as phone_change_token,
  count(*) filter (where reauthentication_token is null)     as reauthentication_token
from auth.users;
*/
