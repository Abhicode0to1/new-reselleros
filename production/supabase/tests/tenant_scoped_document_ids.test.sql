-- Regression test: tenant-scoped document IDs prevent cross-tenant collisions (migration 0054)
-- Run on a dev/test DB. Self-asserting; rolled back.
--   psql "$DATABASE_URL" -f tenant_scoped_document_ids.test.sql
--
-- Proves two tenants issuing the SAME sequence number get GLOBALLY-UNIQUE ids
-- (the per-tenant doc_code differentiates them), and a tenant with no doc_code
-- still gets a non-null, unique fallback code.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('cafe0000-0000-0000-0000-000000000a01', 'Tenant Alpha', 'a@example.in', '07', 'ALFA'),
  ('cafe0000-0000-0000-0000-000000000b02', 'Tenant Beta',  'b@example.in', '27', 'BETA'),
  ('cafe0000-0000-0000-0000-000000000c03', 'No Code Co',   'c@example.in', '07', null);

do $$
declare a text; b text; c text; n integer;
begin
  a := public.next_document_number('quote', 'cafe0000-0000-0000-0000-000000000a01');
  b := public.next_document_number('quote', 'cafe0000-0000-0000-0000-000000000b02');
  c := public.next_document_number('quote', 'cafe0000-0000-0000-0000-000000000c03');

  -- both fresh tenants are on sequence 0001, but ids differ (different codes)
  if a = b then raise exception 'FAIL: two tenants got identical quote id % (collision!)', a; end if;
  /* R-015 (29 Sep 2026) shortened the shape from Q-ALFA-2026-27-0001 to Q-ALFA-27-0001:
     CGST Rule 46(b) allows 16 characters and the old one was 21. The financial year is
     its END year now. The tenant code is unchanged and is the point of this file —
     invoices.id is a bare GLOBAL primary key, so it is the code that keeps two tenants'
     first document of a year apart. */
  if a !~ '^Q-ALFA-\d{2}-0001$' then raise exception 'FAIL: Alpha id wrong format: %', a; end if;
  if b !~ '^Q-BETA-\d{2}-0001$' then raise exception 'FAIL: Beta id wrong format: %', b; end if;
  -- tenant with null doc_code still gets a non-null, unique fallback code
  if c is null or c = a or c = b then raise exception 'FAIL: no-code tenant id bad: %', c; end if;
  if c !~ '^Q-[A-Z0-9]{1,4}-\d{2}-0001$' then raise exception 'FAIL: fallback id wrong format: %', c; end if;
  -- The limit itself, so this file fails if the shape ever grows back.
  if length(a) > 16 then raise exception 'FAIL: % is % characters (Rule 46(b) allows 16)', a, length(a); end if;

  -- invoice doc type also carries the code
  if public.next_document_number('invoice','cafe0000-0000-0000-0000-000000000a01') !~ '^INV-ALFA-' then
    raise exception 'FAIL: invoice missing tenant code';
  end if;

  raise notice 'PASS: tenant-scoped ids unique across tenants (% vs % vs %)', a, b, c;
end $$;
rollback;
