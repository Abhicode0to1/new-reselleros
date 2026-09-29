-- Regression test: list_leads() and list_whatsapp_threads() — keyset list RPCs (S37,
-- migration 20260928200000).
--
-- Self-asserting: RAISEs on failure, one NOTICE "PASS list_rpcs" on success. Runs inside a
-- transaction that ROLLS BACK. LOCAL database only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/list_rpcs.test.sql
--
-- What it proves:
--   1. Grants and shape: anon cannot execute, authenticated can, both are SECURITY INVOKER.
--   2. Cursor correctness: paging A's leads 2 at a time returns EVERY lead exactly once, in
--      (created_at desc, id desc) order — including four leads that share one created_at,
--      which is the case OFFSET-by-timestamp gets wrong. Same for WhatsApp threads 1 at a time.
--   3. A lead inserted "while paging" (newer than page 1) does not shift later pages.
--   4. Tenant isolation both ways, scoped to the OTHER tenant (L7) and guarded: B sees
--      exactly its own rows, so "none of A's" is not a vacuous zero.
--   5. RLS really applies (invoker): a sales rep in A sees only their own + unowned leads,
--      the hierarchy policy's answer — not the whole tenant.
--   6. Filter parity with lib/leads/list-selectors.ts#searchLeads for the server subset:
--      search (case-insensitive, all five fields, % and _ literal), stages, priorities,
--      junk exclude/only/any, owner_ids (+ unowned), owner_id, open_only.
--   7. Slim rows: no `notes` / `requirement` in a row.
--   8. Half a cursor is refused; p_limit is clamped to 1..200; a signed-in user with no
--      workspace gets an empty page, not an error.
--   9. WhatsApp: one row per contact over ALL messages, counts per contact, newest message
--      as last_message.
--
-- ─── WHY THE FUNCTIONS ARE COPIED INTO THIS FILE ────────────────────────────
-- Same rule as today_inbox.test.sql: the test must run against a database the migration has
-- not reached and still roll everything back, so the migration is pasted verbatim between
-- the COPY markers. src/lib/leads/list-rpcs-sql-copy.test.ts (vitest) fails if the copy and
-- the migration ever differ (L8).

begin;

-- >>> BEGIN COPY of supabase/migrations/20260928200000_list_rpcs.sql
-- List RPCs with keyset pagination (S37, 28 Sep 2026).
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- Every list in the app loaded its WHOLE table with select("*") and sorted it in the
-- browser. At 20,000 leads that is megabytes of JSON on every visit, and the WhatsApp inbox
-- grouped the newest 500 MESSAGES into conversations — so a contact whose last message was
-- the 501st simply was not in the inbox, and every unread count was a count of a window.
--
-- These functions return ONE page, newest first, plus the cursor for the next page:
--
--   { "rows": [ … ], "next_cursor": { … } | null }
--
-- Keyset, not OFFSET: the cursor is the (sort key, id) of the last row served, and the next
-- page is "strictly after that" in the same total order. A row inserted while somebody is
-- paging lands on page 1 and never shifts later pages, so paging cannot show a row twice
-- or skip one (OFFSET does both). The id is the tie-breaker that makes the order total —
-- created_at alone is not unique (bulk imports share a timestamp).
--
-- ─── WHO SEES WHAT ──────────────────────────────────────────────────────────
-- SECURITY INVOKER: the tables are read under the caller's own RLS, so a page can never
-- hold a row the caller could not already select (including the leads hierarchy policy).
-- Each also carries `tenant_id = public.current_tenant_id()` explicitly, as today_inbox()
-- does: belt and braces against a policy widened later, and a caller with no workspace
-- gets current_tenant_id() = NULL, which matches nothing — an empty page, not an error.
-- Execute is granted to `authenticated` only. Proven by supabase/tests/list_rpcs.test.sql.
--
-- ─── p_limit ────────────────────────────────────────────────────────────────
-- Clamped to 1..200. NULL means 50. A caller cannot ask for the whole table in one call,
-- which is the point of the exercise.

-- ── list_leads ──────────────────────────────────────────────────────────────
-- One page of leads, (created_at desc, id desc), SLIM columns: everything the list row,
-- the board card and the counts read, and none of the free text (notes, requirement,
-- lost/junk notes, attribution URLs, click ids) that made select("*") heavy.
--
-- p_cursor  — null for the first page, else the next_cursor of the previous one:
--             { "created_at": "<timestamptz as returned>", "id": "<lead id>" }.
--             Half a cursor is refused: silently treating it as "first page" would repeat
--             page 1 forever in a client with a bug.
-- p_filters — every key optional; an absent/empty key means "no constraint". The semantics
--             are the SERVER-EXPRESSIBLE subset of lib/leads/list-selectors.ts#searchLeads
--             (mirrored in lib/leads/list-page.ts, tested both sides):
--   search      text   — case-insensitive substring over company, contact_name,
--                        contact_email, contact_phone, plan. Blank = no search. The text is
--                        matched as typed (not trimmed), exactly like the page; % _ \ are
--                        literal, never wildcards.
--   stages      text[] — any-of.
--   priorities  text[] — any-of.
--   junk        'exclude' (default) | 'only' | 'any'. NOTE: the page's Junk VIEW also
--                        shows heuristic suspects (lib/leads/junk.ts); that heuristic is
--                        not re-implemented in SQL, so 'only' is confirmed junk only.
--   owner_ids   uuid[] — team view: owner in the list, OR unowned (the page keeps unowned
--                        rows visible in every team mode — lib/leads/list-selectors.ts#inWorkspace).
--   owner_id    uuid   — exactly this owner ("Mine").
--   open_only   bool   — not won, not lost, not junk (list-selectors.ts#isOpenLead).
create or replace function public.list_leads(
  p_cursor  jsonb   default null,
  p_limit   integer default 50,
  p_filters jsonb   default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_limit     integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_f         jsonb   := coalesce(p_filters, '{}'::jsonb);
  v_c_at      timestamptz;
  v_c_id      text;
  v_search    text;
  v_pattern   text;
  v_stages    text[];
  v_prios     text[];
  v_junk      text    := coalesce(nullif(v_f->>'junk', ''), 'exclude');
  v_owner_ids uuid[];
  v_owner_id  uuid    := nullif(v_f->>'owner_id', '')::uuid;
  v_open_only boolean := coalesce((v_f->>'open_only')::boolean, false);
  v_rows      jsonb;
  v_count     integer;
  v_last      jsonb;
begin
  if p_cursor is not null and jsonb_typeof(p_cursor) <> 'null' then
    v_c_at := nullif(p_cursor->>'created_at', '')::timestamptz;
    v_c_id := nullif(p_cursor->>'id', '');
    if v_c_at is null or v_c_id is null then
      raise exception 'list_leads: the cursor needs both created_at and id — pass back next_cursor exactly as it was returned, or null for the first page'
        using errcode = '22023';
    end if;
  end if;

  if v_junk not in ('exclude', 'only', 'any') then
    raise exception 'list_leads: junk must be exclude, only or any (got %)', v_junk using errcode = '22023';
  end if;

  if btrim(coalesce(v_f->>'search', '')) <> '' then
    v_search  := lower(v_f->>'search');
    v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  if jsonb_typeof(v_f->'stages') = 'array' and jsonb_array_length(v_f->'stages') > 0 then
    select array_agg(x) into v_stages from jsonb_array_elements_text(v_f->'stages') x;
  end if;
  if jsonb_typeof(v_f->'priorities') = 'array' and jsonb_array_length(v_f->'priorities') > 0 then
    select array_agg(x) into v_prios from jsonb_array_elements_text(v_f->'priorities') x;
  end if;
  if jsonb_typeof(v_f->'owner_ids') = 'array' then
    select coalesce(array_agg(x::uuid), '{}') into v_owner_ids from jsonb_array_elements_text(v_f->'owner_ids') x;
  end if;

  with page as (
    select l.id, l.company, l.contact_name, l.contact_email, l.contact_phone,
           l.plan, l.seats, l.value, l.stage, l.priority, l.owner_id, l.source,
           l.is_junk, l.created_at, l.updated_at, l.follow_up_date, l.expected_close_date,
           l.stage_changed_at, l.enquiry_type, l.project_id, l.customer_id,
           l.requires_human_attention, l.pipeline, l.subscription_type, l.lost_reason
      from public.leads l
     where l.tenant_id = public.current_tenant_id()
       and (v_c_at is null or (l.created_at, l.id) < (v_c_at, v_c_id))
       and (v_junk = 'any' or (v_junk = 'only') = l.is_junk)
       and (v_pattern is null
            or lower(l.company) like v_pattern escape '\'
            or lower(l.contact_name) like v_pattern escape '\'
            or lower(l.contact_email) like v_pattern escape '\'
            or lower(l.contact_phone) like v_pattern escape '\'
            or lower(l.plan) like v_pattern escape '\')
       and (v_stages is null or l.stage::text = any (v_stages))
       and (v_prios is null or l.priority = any (v_prios))
       and (v_owner_ids is null or l.owner_id is null or l.owner_id = any (v_owner_ids))
       and (v_owner_id is null or l.owner_id = v_owner_id)
       and (not v_open_only or (l.stage not in ('won', 'lost') and not l.is_junk))
     order by l.created_at desc, l.id desc
     limit v_limit + 1
  ), numbered as (
    select p.*, row_number() over (order by p.created_at desc, p.id desc) as rn from page p
  )
  select coalesce(jsonb_agg(to_jsonb(n) - 'rn' order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         count(*)::integer
    into v_rows, v_count
    from numbered n;

  if v_count > v_limit then
    v_last := v_rows -> (v_limit - 1);
    return jsonb_build_object(
      'rows', v_rows,
      'next_cursor', jsonb_build_object('created_at', v_last->'created_at', 'id', v_last->'id'));
  end if;
  return jsonb_build_object('rows', v_rows, 'next_cursor', null);
end
$fn$;

comment on function public.list_leads(jsonb, integer, jsonb) is
  'S37: one keyset page of leads (created_at desc, id desc), slim columns, RLS applies (security invoker). Returns {rows, next_cursor}.';

revoke all on function public.list_leads(jsonb, integer, jsonb) from public;
revoke all on function public.list_leads(jsonb, integer, jsonb) from anon;
grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;

-- ── list_whatsapp_threads ───────────────────────────────────────────────────
-- One page of WhatsApp CONVERSATIONS — one row per contact_phone, newest activity first,
-- ordered (last_at desc, contact_phone desc). Grouped over ALL of the tenant's messages,
-- not over a window: the old client grouped the newest 500 messages, so an older contact
-- vanished from the inbox and every count was a count of the window.
--
-- Each row is the shape lib/queries/whatsapp.ts#WhatsAppConversation already had:
--   contact_phone, last_message (the whole newest message row), last_inbound_at,
--   unread_count (= inbound messages; the inbox has no read state yet — same first cut as
--   before), message_count.
--
-- p_cursor — null, or { "last_at": "<timestamptz as returned>", "contact_phone": "…" }.
create or replace function public.list_whatsapp_threads(
  p_cursor jsonb   default null,
  p_limit  integer default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_c_at    timestamptz;
  v_c_phone text;
  v_rows    jsonb;
  v_count   integer;
  v_last    jsonb;
begin
  if p_cursor is not null and jsonb_typeof(p_cursor) <> 'null' then
    v_c_at    := nullif(p_cursor->>'last_at', '')::timestamptz;
    v_c_phone := nullif(p_cursor->>'contact_phone', '');
    if v_c_at is null or v_c_phone is null then
      raise exception 'list_whatsapp_threads: the cursor needs both last_at and contact_phone — pass back next_cursor exactly as it was returned, or null for the first page'
        using errcode = '22023';
    end if;
  end if;

  with threads as (
    select m.contact_phone,
           max(m.created_at)                                         as last_at,
           max(m.created_at) filter (where m.direction = 'inbound') as last_inbound_at,
           (count(*) filter (where m.direction = 'inbound'))::integer as unread_count,
           count(*)::integer                                         as message_count
      from public.whatsapp_messages m
     where m.tenant_id = public.current_tenant_id()
     group by m.contact_phone
  ), page as (
    select t.*, row_number() over (order by t.last_at desc, t.contact_phone desc) as rn
      from threads t
     where v_c_at is null or (t.last_at, t.contact_phone) < (v_c_at, v_c_phone)
     order by t.last_at desc, t.contact_phone desc
     limit v_limit + 1
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'contact_phone',   p.contact_phone,
             'last_at',         p.last_at,
             'last_inbound_at', p.last_inbound_at,
             'unread_count',    p.unread_count,
             'message_count',   p.message_count,
             'last_message',    (select to_jsonb(lm)
                                   from public.whatsapp_messages lm
                                  where lm.tenant_id = public.current_tenant_id()
                                    and lm.contact_phone = p.contact_phone
                                  order by lm.created_at desc, lm.id desc
                                  limit 1))
           order by p.rn) filter (where p.rn <= v_limit), '[]'::jsonb),
         count(*)::integer
    into v_rows, v_count
    from page p;

  if v_count > v_limit then
    v_last := v_rows -> (v_limit - 1);
    return jsonb_build_object(
      'rows', v_rows,
      'next_cursor', jsonb_build_object('last_at', v_last->'last_at', 'contact_phone', v_last->'contact_phone'));
  end if;
  return jsonb_build_object('rows', v_rows, 'next_cursor', null);
end
$fn$;

comment on function public.list_whatsapp_threads(jsonb, integer) is
  'S37: one keyset page of WhatsApp conversations (last_at desc, contact_phone desc), grouped over all messages, RLS applies (security invoker). Returns {rows, next_cursor}.';

revoke all on function public.list_whatsapp_threads(jsonb, integer) from public;
revoke all on function public.list_whatsapp_threads(jsonb, integer) from anon;
grant execute on function public.list_whatsapp_threads(jsonb, integer) to authenticated;
-- <<< END COPY of supabase/migrations/20260928200000_list_rpcs.sql

-- ── Fixtures — own tenants, own users, all rolled back (AGENTS.md L11) ─────────
insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000037a0', 'LIST TEST A', 'list-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000037b0', 'LIST TEST B', 'list-b@example.in', '07');

insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-4000-8000-00000037a001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'list-a-owner@example.in'),
  ('aaaaaaaa-0000-4000-8000-00000037a002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'list-a-rep@example.in'),
  ('bbbbbbbb-0000-4000-8000-00000037b001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'list-b-owner@example.in'),
  ('cccccccc-0000-4000-8000-00000037c001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'list-nobody@example.in');

insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-4000-8000-00000037a001', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'list-a-owner@example.in', 'owner'),
  ('aaaaaaaa-0000-4000-8000-00000037a002', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'list-a-rep@example.in',   'sales'),
  ('bbbbbbbb-0000-4000-8000-00000037b001', 'bbbbbbbb-0000-0000-0000-0000000037b0', 'list-b-owner@example.in', 'owner');

-- A: nine leads. L37-A3..A6 share ONE created_at (the tie the id breaks). Owners: A2/A4 the
-- rep, A1 the owner, the rest unowned. One junk, one won, one lost. Searchable oddities:
-- a literal "100%" in a company, an underscore in an email, upper-case in a plan.
insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, plan, stage, priority, is_junk, owner_id, notes, created_at) values
  ('L37-A1', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Alpha Traders',  'Asha',  'asha@alpha.in',     '+91 90000 00001', 'Business Starter', 'new',     'high',   false, 'aaaaaaaa-0000-4000-8000-00000037a001', 'long notes', '2026-09-20 10:00:00.123456+00'),
  ('L37-A2', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Beta Works',     'Bina',  'bina_t@beta.in',   '+91 90000 00002', null,               'contact', 'medium', false, 'aaaaaaaa-0000-4000-8000-00000037a002', null,         '2026-09-19 10:00:00+00'),
  ('L37-A3', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Gamma 100% Pure', null,   null,                '+91 90000 00003', null,               'quote',   'low',    false, null,                                  null,         '2026-09-18 10:00:00+00'),
  ('L37-A4', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Delta Co',       'Dev',   'dev@delta.in',      null,              'ZOHO Mail Lite',   'demo',    'medium', false, 'aaaaaaaa-0000-4000-8000-00000037a002', null,         '2026-09-18 10:00:00+00'),
  ('L37-A5', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Epsilon',        'Esha',  'esha@eps.in',       '+91 90000 00005', null,               'won',     'medium', false, null,                                  null,         '2026-09-18 10:00:00+00'),
  ('L37-A6', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Zeta',           'Zoya',  'zoya@zeta.in',      '+91 90000 00006', null,               'lost',    'high',   false, null,                                  null,         '2026-09-18 10:00:00+00'),
  ('L37-A7', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'test',           null,    null,                null,              null,               'new',     'medium', true,  null,                                  null,         '2026-09-17 10:00:00+00'),
  ('L37-A8', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Theta Ltd',      'Tara',  'tara@theta.in',     '+91 90000 00008', null,               'trial',   'low',    false, null,                                  null,         '2026-09-16 10:00:00+00'),
  ('L37-A9', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Iota Pvt',       'Isha',  'isha@iota.in',      '+91 90000 00009', null,               'new',     'medium', false, null,                                  null,         '2026-09-15 10:00:00+00');

insert into public.leads (id, tenant_id, company, contact_email, stage, created_at) values
  ('L37-B1', 'bbbbbbbb-0000-0000-0000-0000000037b0', 'Bravo Alpha', 'x@bravo.in', 'new', '2026-09-21 10:00:00+00'),
  ('L37-B2', 'bbbbbbbb-0000-0000-0000-0000000037b0', 'Bravo Two',   'y@bravo.in', 'quote', '2026-09-14 10:00:00+00');

-- WhatsApp: A has three contacts (P1 with 3 messages, newest inbound; P2 with 2, newest
-- outbound; P3 with 1); B has one contact. P1/P2 last_at differ; P3 is oldest.
insert into public.whatsapp_messages (tenant_id, contact_phone, direction, type, text_body, created_at) values
  ('aaaaaaaa-0000-0000-0000-0000000037a0', '+919700000001', 'outbound', 'text', 'hi',          '2026-09-20 09:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-0000000037a0', '+919700000001', 'inbound',  'text', 'price?',      '2026-09-20 09:05:00+00'),
  ('aaaaaaaa-0000-0000-0000-0000000037a0', '+919700000001', 'inbound',  'text', 'hello??',     '2026-09-20 11:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-0000000037a0', '+919700000002', 'inbound',  'text', 'thanks',      '2026-09-19 09:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-0000000037a0', '+919700000002', 'outbound', 'text', 'welcome',     '2026-09-19 10:00:00+00'),
  ('aaaaaaaa-0000-0000-0000-0000000037a0', '+919700000003', 'outbound', 'text', 'old',         '2026-09-01 10:00:00+00'),
  ('bbbbbbbb-0000-0000-0000-0000000037b0', '+919700000009', 'inbound',  'text', 'B only',      '2026-09-25 10:00:00+00');

-- Capture everything that needs the connection role BEFORE the switch (AGENTS.md L14).
do $$ begin
  perform set_config('lt.owner_a', 'aaaaaaaa-0000-4000-8000-00000037a001', true);
  perform set_config('lt.rep_a',   'aaaaaaaa-0000-4000-8000-00000037a002', true);
  perform set_config('lt.owner_b', 'bbbbbbbb-0000-4000-8000-00000037b001', true);
  perform set_config('lt.nobody',  'cccccccc-0000-4000-8000-00000037c001', true);
end $$;

-- ── Grants and shape (as the connection role, via proacl — AGENTS.md §5) ────────
do $$
declare v_fn text;
begin
  foreach v_fn in array array['public.list_leads(jsonb, integer, jsonb)', 'public.list_whatsapp_threads(jsonb, integer)'] loop
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'FAIL grant: anon can execute %', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'FAIL grant: authenticated cannot execute %', v_fn;
    end if;
    if (select prosecdef from pg_proc where oid = v_fn::regprocedure) then
      raise exception 'FAIL shape: % is SECURITY DEFINER — it must be invoker so RLS applies', v_fn;
    end if;
  end loop;
end $$;

-- Helper: every lead id the RPC returns for a filter, walking the cursor to the end.
create function pg_temp.all_lead_ids(p_filters jsonb, p_limit integer) returns text[]
language plpgsql as $$
declare v_cursor jsonb := null; v_page jsonb; v_ids text[] := '{}'; v_guard int := 0;
begin
  loop
    v_page := public.list_leads(v_cursor, p_limit, p_filters);
    v_ids := v_ids || coalesce(array(select r->>'id' from jsonb_array_elements(v_page->'rows') r), '{}');
    v_cursor := v_page->'next_cursor';
    exit when v_cursor is null or jsonb_typeof(v_cursor) = 'null';
    v_guard := v_guard + 1;
    if v_guard > 100 then raise exception 'FAIL cursor: more than 100 pages — the cursor is not advancing'; end if;
  end loop;
  return v_ids;
end $$;

create function pg_temp.expect_ids(p_label text, p_got text[], p_want text[]) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL %: got %, want %', p_label, p_got, p_want;
  end if;
end $$;

grant execute on function pg_temp.all_lead_ids(jsonb, integer) to authenticated;
grant execute on function pg_temp.expect_ids(text, text[], text[]) to authenticated;

set local role authenticated;

do $$
declare
  v_page   jsonb;
  v_ids    text[];
  v_want   text[];
  v_cursor jsonb;
  v_err    text;
begin
  -- ── Owner of A ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('lt.owner_a'), 'role', 'authenticated')::text, true);
  if auth.uid()::text is distinct from current_setting('lt.owner_a') then
    raise exception 'SETUP FAIL: auth.uid() is % — every assertion below would prove nothing', auth.uid();
  end if;

  -- 2. Cursor: 2 at a time over everything (junk any) = the whole tenant, once, in order.
  v_want := array['L37-A1','L37-A2','L37-A6','L37-A5','L37-A4','L37-A3','L37-A7','L37-A8','L37-A9'];
  perform pg_temp.expect_ids('cursor walk, limit 2, junk any', pg_temp.all_lead_ids('{"junk":"any"}', 2), v_want);
  perform pg_temp.expect_ids('cursor walk, limit 1, junk any', pg_temp.all_lead_ids('{"junk":"any"}', 1), v_want);
  perform pg_temp.expect_ids('one page, limit 200, junk any', pg_temp.all_lead_ids('{"junk":"any"}', 200), v_want);

  -- next_cursor is null exactly on the last page, and present when more exist.
  v_page := public.list_leads(null, 9, '{"junk":"any"}');
  if jsonb_array_length(v_page->'rows') <> 9 or jsonb_typeof(v_page->'next_cursor') <> 'null' then
    raise exception 'FAIL cursor: an exactly-full last page must end with next_cursor null (got %)', v_page->'next_cursor';
  end if;
  v_page := public.list_leads(null, 8, '{"junk":"any"}');
  if jsonb_typeof(v_page->'next_cursor') <> 'object' then
    raise exception 'FAIL cursor: 8 of 9 must hand back a cursor';
  end if;

  -- 3. A lead arriving mid-walk lands on page 1 and does not shift page 2.
  v_page := public.list_leads(null, 3, '{"junk":"any"}');
  v_cursor := v_page->'next_cursor';
  reset role;
  insert into public.leads (id, tenant_id, company, stage, created_at)
    values ('L37-A0', 'aaaaaaaa-0000-0000-0000-0000000037a0', 'Newest', 'new', '2026-09-22 10:00:00+00');
  set local role authenticated;
  v_ids := array(select r->>'id' from jsonb_array_elements(public.list_leads(v_cursor, 3, '{"junk":"any"}')->'rows') r);
  perform pg_temp.expect_ids('page 2 after an insert', v_ids, array['L37-A5','L37-A4','L37-A3']);

  -- 7. Slim rows.
  v_page := public.list_leads(null, 200, '{"junk":"any"}');
  if exists (select 1 from jsonb_array_elements(v_page->'rows') r where r ? 'notes' or r ? 'requirement' or r ? 'tenant_id') then
    raise exception 'FAIL slim: a row carries notes / requirement / tenant_id';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_page->'rows') r where r->>'id' = 'L37-A1' and r->>'plan' = 'Business Starter' and r->>'stage' = 'new') then
    raise exception 'FAIL slim: a row lost a column the list reads';
  end if;

  -- 4. Isolation: none of B's rows, whatever the filter.
  if exists (select 1 from unnest(pg_temp.all_lead_ids('{"junk":"any","search":"bravo"}', 50)) x) then
    raise exception 'FAIL isolation: A''s search for "bravo" returned tenant B rows';
  end if;
  if 'L37-B1' = any (pg_temp.all_lead_ids('{"junk":"any"}', 200)) then
    raise exception 'FAIL isolation: A sees L37-B1';
  end if;

  -- 6. Filter parity (expected sets hand-derived from the fixtures above, newest first).
  -- default junk = exclude; A0 is the mid-walk insert.
  perform pg_temp.expect_ids('default excludes junk', pg_temp.all_lead_ids('{}', 3),
    array['L37-A0','L37-A1','L37-A2','L37-A6','L37-A5','L37-A4','L37-A3','L37-A8','L37-A9']);
  perform pg_temp.expect_ids('junk only', pg_temp.all_lead_ids('{"junk":"only"}', 3), array['L37-A7']);
  perform pg_temp.expect_ids('search company, case-insensitive', pg_temp.all_lead_ids('{"search":"ALPHA"}', 2), array['L37-A1']);
  perform pg_temp.expect_ids('search contact name', pg_temp.all_lead_ids('{"search":"bin"}', 2), array['L37-A2']);
  -- As a wildcard, "a_t" would also match "alph(a t)raders" (A1) and "tar(a@t)heta" (A8).
  perform pg_temp.expect_ids('search email, _ is literal', pg_temp.all_lead_ids('{"search":"a_t"}', 2), array['L37-A2']);
  perform pg_temp.expect_ids('search phone', pg_temp.all_lead_ids('{"search":"00008"}', 2), array['L37-A8']);
  perform pg_temp.expect_ids('search plan, case-insensitive', pg_temp.all_lead_ids('{"search":"zoho mail"}', 2), array['L37-A4']);
  perform pg_temp.expect_ids('search % is literal', pg_temp.all_lead_ids('{"search":"100%"}', 2), array['L37-A3']);
  perform pg_temp.expect_ids('search % alone matches only a literal %', pg_temp.all_lead_ids('{"search":"%"}', 2), array['L37-A3']);
  -- Trimmed, "zeta " would match Zeta (A6); the page matches it as typed, and so must this.
  perform pg_temp.expect_ids('search is NOT trimmed (like the page)', pg_temp.all_lead_ids('{"search":"zeta "}', 2), '{}');
  perform pg_temp.expect_ids('search with an inner space', pg_temp.all_lead_ids('{"search":"a t"}', 2), array['L37-A1']);
  perform pg_temp.expect_ids('blank search is no search', pg_temp.all_lead_ids('{"search":"   "}', 50),
    pg_temp.all_lead_ids('{}', 50));
  perform pg_temp.expect_ids('search does not read notes', pg_temp.all_lead_ids('{"search":"long notes"}', 2), '{}');
  perform pg_temp.expect_ids('stages any-of', pg_temp.all_lead_ids('{"stages":["quote","demo"]}', 1), array['L37-A4','L37-A3']);
  perform pg_temp.expect_ids('priorities any-of', pg_temp.all_lead_ids('{"priorities":["high"]}', 1), array['L37-A1','L37-A6']);
  perform pg_temp.expect_ids('stage + priority together', pg_temp.all_lead_ids('{"stages":["new"],"priorities":["high"]}', 5), array['L37-A1']);
  perform pg_temp.expect_ids('open_only', pg_temp.all_lead_ids('{"open_only":true}', 2),
    array['L37-A0','L37-A1','L37-A2','L37-A4','L37-A3','L37-A8','L37-A9']);
  perform pg_temp.expect_ids('owner_id (mine)', pg_temp.all_lead_ids(
    jsonb_build_object('owner_id', current_setting('lt.rep_a')), 5), array['L37-A2','L37-A4']);
  perform pg_temp.expect_ids('owner_ids keeps unowned too', pg_temp.all_lead_ids(
    jsonb_build_object('owner_ids', jsonb_build_array(current_setting('lt.owner_a')), 'stages', jsonb_build_array('new','contact','demo')), 5),
    array['L37-A0','L37-A1','L37-A9']);
  perform pg_temp.expect_ids('empty owner_ids = unowned only', pg_temp.all_lead_ids('{"owner_ids":[],"stages":["new","contact","demo"]}', 5),
    array['L37-A0','L37-A9']);

  -- 8. Half a cursor is refused; limits clamp.
  begin
    perform public.list_leads('{"created_at":"2026-09-20T00:00:00Z"}', 5, '{}');
    raise exception 'FAIL cursor: half a cursor was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.list_leads(null, 5, '{"junk":"maybe"}');
    raise exception 'FAIL filter: junk=maybe was accepted';
  exception when invalid_parameter_value then null;
  end;
  if jsonb_array_length(public.list_leads(null, 0, '{}')->'rows') <> 1 then
    raise exception 'FAIL clamp: p_limit 0 must mean 1';
  end if;
  if jsonb_array_length(public.list_leads(null, null, '{"junk":"any"}')->'rows') <> 10 then
    raise exception 'FAIL clamp: p_limit null must mean 50 (all 10 here)';
  end if;

  -- 9. WhatsApp threads, 1 at a time: every contact once, newest activity first.
  v_ids := '{}';
  v_cursor := null;
  loop
    v_page := public.list_whatsapp_threads(v_cursor, 1);
    v_ids := v_ids || array(select r->>'contact_phone' from jsonb_array_elements(v_page->'rows') r);
    v_cursor := v_page->'next_cursor';
    exit when v_cursor is null or jsonb_typeof(v_cursor) = 'null';
    if cardinality(v_ids) > 10 then raise exception 'FAIL wa cursor: not advancing'; end if;
  end loop;
  perform pg_temp.expect_ids('wa thread walk', v_ids, array['+919700000001','+919700000002','+919700000003']);

  v_page := public.list_whatsapp_threads(null, 50);
  if not exists (
    select 1 from jsonb_array_elements(v_page->'rows') r
     where r->>'contact_phone' = '+919700000001'
       and (r->>'message_count')::int = 3 and (r->>'unread_count')::int = 2
       and r->'last_message'->>'text_body' = 'hello??'
       and (r->>'last_inbound_at')::timestamptz = '2026-09-20 11:00:00+00') then
    raise exception 'FAIL wa shape: P1 should be 3 messages, 2 inbound, last "hello??" (got %)', v_page->'rows'->0;
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_page->'rows') r
     where r->>'contact_phone' = '+919700000003' and r->'last_inbound_at' = 'null'::jsonb and (r->>'unread_count')::int = 0) then
    raise exception 'FAIL wa shape: an outbound-only thread must have no last_inbound_at and 0 unread';
  end if;
  if exists (select 1 from jsonb_array_elements(v_page->'rows') r where r->>'contact_phone' = '+919700000009') then
    raise exception 'FAIL isolation: A sees tenant B''s WhatsApp thread';
  end if;
  begin
    perform public.list_whatsapp_threads('{"last_at":"2026-09-20T00:00:00Z"}', 5);
    raise exception 'FAIL wa cursor: half a cursor was accepted';
  exception when invalid_parameter_value then null;
  end;

  -- ── 5. The rep in A: RLS (hierarchy) applies through the invoker function ──────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('lt.rep_a'), 'role', 'authenticated')::text, true);
  v_ids := pg_temp.all_lead_ids('{"junk":"any"}', 2);
  if 'L37-A1' = any (v_ids) then
    raise exception 'FAIL rls: the rep sees the owner''s lead L37-A1 — the function is bypassing RLS';
  end if;
  if not ('L37-A2' = any (v_ids) and 'L37-A4' = any (v_ids) and 'L37-A9' = any (v_ids)) then
    raise exception 'FAIL rls: the rep should see own (A2, A4) and unowned (A9) leads, got %', v_ids;
  end if;

  -- ── 4. Tenant B sees exactly its own (so the isolation checks above are not vacuous) ─
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('lt.owner_b'), 'role', 'authenticated')::text, true);
  perform pg_temp.expect_ids('tenant B, all', pg_temp.all_lead_ids('{"junk":"any"}', 1), array['L37-B1','L37-B2']);
  v_page := public.list_whatsapp_threads(null, 50);
  if jsonb_array_length(v_page->'rows') <> 1 or v_page->'rows'->0->>'contact_phone' <> '+919700000009' then
    raise exception 'FAIL isolation: B should see exactly its one thread, got %', v_page->'rows';
  end if;

  -- ── 8. Signed in, no workspace → empty, not an error ───────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('lt.nobody'), 'role', 'authenticated')::text, true);
  if jsonb_array_length(public.list_leads(null, 50, '{"junk":"any"}')->'rows') <> 0
     or jsonb_array_length(public.list_whatsapp_threads(null, 50)->'rows') <> 0 then
    raise exception 'FAIL no-workspace: a user with no tenant got rows';
  end if;

  raise notice 'PASS list_rpcs: keyset walks exact (ties, mid-walk insert), slim rows, filter parity, RLS via invoker, tenant isolation both ways, clamps, no-workspace empty, WhatsApp threads grouped over all messages';
end $$;

rollback;
