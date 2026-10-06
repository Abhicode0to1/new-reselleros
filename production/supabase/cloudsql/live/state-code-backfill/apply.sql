-- Shared by peek.sql and apply.sql (R-165, 6 Oct 2026). Session-only helpers (pg_temp): nothing
-- here is left behind in the database.
--
-- The rule is the app's own (src/lib/gst/gstin-state.ts withStateCode + utils.isValidGstin):
--   a valid GSTIN (format + mod-36 checksum) gives its first two digits; otherwise the state
--   NAME gives a code only when it matches a GST state exactly (case, spacing and "&" vs "and"
--   ignored). Foreign customers get nothing. If GSTIN and name point at DIFFERENT states the
--   row is left alone and counted as a conflict — a human decides that one.
create function pg_temp.gst_checksum_ok(g text) returns boolean language plpgsql immutable as $f$
declare chars text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; s int := 0; fac int := 2; c int; p int; i int;
begin
  if g is null or g !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then return false; end if;
  for i in reverse 14..1 loop
    c := strpos(chars, substr(g, i, 1)) - 1;
    p := c * fac; s := s + p / 36 + p % 36;
    fac := case when fac = 2 then 1 else 2 end;
  end loop;
  return substr(chars, (36 - s % 36) % 36 + 1, 1) = substr(g, 15, 1);
end $f$;

create function pg_temp.gst_states() returns table(code text, name text) language sql immutable as $f$
  values ('01','Jammu and Kashmir'),('02','Himachal Pradesh'),('03','Punjab'),('04','Chandigarh'),
    ('05','Uttarakhand'),('06','Haryana'),('07','Delhi'),('08','Rajasthan'),('09','Uttar Pradesh'),
    ('10','Bihar'),('11','Sikkim'),('12','Arunachal Pradesh'),('13','Nagaland'),('14','Manipur'),
    ('15','Mizoram'),('16','Tripura'),('17','Meghalaya'),('18','Assam'),('19','West Bengal'),
    ('20','Jharkhand'),('21','Odisha'),('22','Chhattisgarh'),('23','Madhya Pradesh'),('24','Gujarat'),
    ('26','Dadra and Nagar Haveli and Daman and Diu'),('27','Maharashtra'),('29','Karnataka'),
    ('30','Goa'),('31','Lakshadweep'),('32','Kerala'),('33','Tamil Nadu'),('34','Puducherry'),
    ('35','Andaman and Nicobar Islands'),('36','Telangana'),('37','Andhra Pradesh'),('38','Ladakh'),
    ('97','Other Territory'),('99','Centre Jurisdiction')
$f$;

create function pg_temp.norm(s text) returns text language sql immutable as $f$
  select regexp_replace(replace(lower(coalesce(s, '')), '&', 'and'), '[^a-z]', '', 'g')
$f$;

-- One row per customer that has no state_code today, with what it WOULD get and why.
create temp view need as
with base as (
  select c.id, c.tenant_id, c.name, c.state, upper(btrim(coalesce(c.gstin, ''))) as g,
         lower(btrim(coalesce(c.country, ''))) in ('', 'in', 'ind', 'india') as indian
    from public.customers c
   where coalesce(btrim(c.state_code), '') = ''
), d as (
  select b.*,
    case when pg_temp.gst_checksum_ok(b.g) and exists (select 1 from pg_temp.gst_states() s where s.code = left(b.g, 2))
         then left(b.g, 2) end as from_gstin,
    case when btrim(coalesce(b.state, '')) ~ '^[0-9]{1,2}$'
         then (select s.code from pg_temp.gst_states() s where s.code = lpad(btrim(b.state), 2, '0'))
         else (select s.code from pg_temp.gst_states() s where pg_temp.norm(s.name) = pg_temp.norm(b.state) and pg_temp.norm(b.state) <> '')
    end as from_name
  from base b
)
select d.*,
  case
    when not indian then 'foreign'
    when from_gstin is not null and from_name is not null and from_gstin <> from_name then 'conflict'
    when from_gstin is not null then 'gstin'
    when from_name is not null then 'name'
    else 'unknown'
  end as source,
  coalesce(from_gstin, from_name) as new_code
from d;
begin;
-- Undo record: every row this changes, with what it held before. Server-only (no grants, RLS on).
create table if not exists public.backfill_state_code_20261006 (
  customer_id uuid primary key, tenant_id uuid not null, old_state_code text,
  new_state_code text not null, source text not null, at timestamptz not null default now());
alter table public.backfill_state_code_20261006 enable row level security;
revoke all on public.backfill_state_code_20261006 from anon, authenticated;

insert into public.backfill_state_code_20261006 (customer_id, tenant_id, old_state_code, new_state_code, source)
select n.id, n.tenant_id, c.state_code, n.new_code, n.source
  from need n join public.customers c on c.id = n.id
 where n.source in ('gstin', 'name')
on conflict (customer_id) do nothing;

update public.customers c
   set state_code = b.new_state_code
  from public.backfill_state_code_20261006 b
 where b.customer_id = c.id and coalesce(btrim(c.state_code), '') = '';
commit;
-- Undo, if ever needed:
--   update public.customers c set state_code = b.old_state_code
--     from public.backfill_state_code_20261006 b where b.customer_id = c.id;
