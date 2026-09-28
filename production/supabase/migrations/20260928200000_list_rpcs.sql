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
