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
DO $$ DECLARE r text; BEGIN
  select concat_ws(' ',
    'missing='  || count(*),
    'gstin='    || count(*) filter (where source = 'gstin'),
    'name='     || count(*) filter (where source = 'name'),
    'conflict=' || count(*) filter (where source = 'conflict'),
    'foreign='  || count(*) filter (where source = 'foreign'),
    'unknown='  || count(*) filter (where source = 'unknown'),
    'unknown_spellings=[' || coalesce((select string_agg(s || ' x' || n, ' | ' order by n desc) from (
        select coalesce(nullif(btrim(state), ''), '(blank)') as s, count(*) as n
          from need where source = 'unknown' group by 1 order by 2 desc limit 8) t), '') || ']')
  into r from need;
  RAISE EXCEPTION 'PEEK %', r;
END $$;
