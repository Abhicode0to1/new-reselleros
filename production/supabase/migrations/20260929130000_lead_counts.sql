-- Leads list, server-side: lead_counts() for every number on the screen, and list_leads()
-- taught the rest of the page's filters (S40, 29 Sep 2026).
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- S37 (20260928200000_list_rpcs.sql) gave list_leads() keyset pages, but the Sales &
-- Pipeline screen could not use them: every number on it — the View menu's counts, the
-- folder counts, Duplicates / Junk, the "Kiska" owner counts, the team-toggle note, the KPI
-- tiles, the hot-lead card — was computed in the browser over `select *` of EVERY lead. At
-- 20,000 leads that is megabytes on every visit, and paging only the list would have added
-- requests and removed none (the page would still need the full set for its counts).
--
-- So this migration moves the counting to the server and gives list_leads() the remaining
-- filters, so the list can page and every chip can be a server count:
--
--   lead_counts(p_filters)  → one jsonb with every count the page shows (see its header).
--   list_leads(…)           → same signature as S37; new OPTIONAL p_filters keys
--                             (owners, smart_view, folder, sort, dup_of, dup_like) and three
--                             more row fields (domain, human_attention_reason, is_duplicate).
--                             A caller that sends none of the new keys gets S37's rows and
--                             order — lead_counts.test.sql re-checks S37's cases against it.
--   leads_dup_phone_idx / leads_dup_company_idx → the duplicate keys, indexed (see below).
--
-- Measured on the local stack with 20,000 leads in one tenant: lead_counts() ≈ 230 ms, one
-- list page ≈ 40 ms (created order) / ≈ 140 ms (wait order).
--
-- The two functions share their WHERE rules by COPY, not by a shared row function: a
-- per-row plpgsql helper would run 20,000 times per call, and the page asks for counts on
-- every filter change. lead_counts.test.sql pins the copy — for every view and folder, the
-- count lead_counts() reports equals the number of rows list_leads() pages out.
--
-- ─── THE RULES ARE THE PAGE'S RULES ─────────────────────────────────────────
-- Each predicate mirrors one TypeScript rule, named beside it. Where the TS read the
-- browser's clock, SQL reads the IST day: `today` = (now() at time zone 'Asia/Kolkata')::date
-- (AGENTS.md §6). One deliberate difference, fixed on BOTH sides in the same commit: the
-- "Today" view compared created_at's UTC date prefix with the IST date, so a lead that
-- arrived between 00:00 and 05:30 IST was not "today" until tomorrow. Both sides now use
-- created_at's IST date.
--
-- ─── WHO SEES WHAT ──────────────────────────────────────────────────────────
-- SECURITY INVOKER, `tenant_id = public.current_tenant_id()` on every read, execute to
-- `authenticated` only — the same contract as S37. A count can therefore never include a
-- lead the caller could not select, including under the leads hierarchy policy.

-- ── Pure helpers — the TS heuristics, byte for byte ────────────────────────
-- Immutable, no table access. Granted to authenticated because the invoker functions below
-- call them as the caller.
--
-- The two KEY functions are indexed (leads_dup_*_idx below), so a query reads their values
-- from the index and only ever computes them for a handful of rows. They carry
-- `set search_path = ''` and COST 1000 on purpose: the SET stops Postgres inlining them into
-- bare regexp calls, and the cost tells the planner a call is expensive — at the defaults
-- it priced the phone key at almost nothing and recomputed it over every lead (2.9 s for
-- one page's duplicate flags at 20,000 leads) instead of probing the index.
--
-- lead_looks_like_junk is NOT indexed and runs on every lead in lead_counts(), so it has
-- NO SET clause, deliberately: a SET makes every call pay a GUC save/restore and blocks
-- inlining (measured locally at 20,000 leads: 690 ms per lead_counts() call with it, 530 ms
-- without). It reads only pg_catalog built-ins (always searched first) and no table, so
-- there is nothing a caller's search_path could redirect.

-- lib/leads/duplicates.ts#normPhone — digits only, last 10; '' when fewer than 10 digits.
create or replace function public.lead_norm_phone(p text)
returns text
language sql
immutable
cost 1000
set search_path = ''
as $fn$
  select case
           when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 10
             then right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10)
           else ''
         end
$fn$;

-- lib/leads/duplicates.ts#normCompany — lower, punctuation → space, noise words out (whole
-- words only, so "soft" does not eat "Softaid"), spaces collapsed; '' when shorter than 3.
--
-- Written as "split into words, drop the noise words, join with one space" rather than the
-- TS's four regex passes. It is the same function — after punctuation becomes a space, a
-- `\b…\b` word IS a run of [a-z0-9] — and it is cheaper: measured locally over 20,000
-- company names, 129 ms against 489 ms for the literal regex port, and lead_counts() runs it
-- on every lead on every call. The SQL test pins it against the TS cases.
create or replace function public.lead_norm_company(c text)
returns text
language sql
immutable
/* COST: at the default (100) the planner recomputed the key over every lead (≈450 ms at
   20,000) instead of reading it from leads_dup_company_idx (≈8 ms, index-only). */
cost 1000
set search_path = ''
as $fn$
  select case when length(k) >= 3 then k else '' end
    from (
      select array_to_string(array(
               select u.w
                 from unnest(string_to_array(regexp_replace(lower(coalesce(c, '')), '[^a-z0-9]+', ' ', 'g'), ' '))
                      with ordinality as u(w, o)
                where u.w <> ''
                  and u.w <> all ('{pvt,private,ltd,limited,llp,inc,co,company,corp,corporation,technologies,technology,solutions,systems,services,enterprises,india,the}'::text[])
                order by u.o), ' ') as k
    ) s
$fn$;

-- lib/leads/junk.ts#looksLikeJunk(...).suspect — no phone AND no email; company shorter than
-- 2; test/placeholder words in company or contact name; gibberish company.
create or replace function public.lead_looks_like_junk(
  p_company text, p_contact_name text, p_contact_email text, p_contact_phone text
)
returns boolean
language sql
immutable
as $fn$
  select
       (regexp_replace(coalesce(p_contact_phone, ''), '^\s+|\s+$', '', 'g') = ''
        and regexp_replace(coalesce(p_contact_email, ''), '^\s+|\s+$', '', 'g') = '')
    or length(regexp_replace(coalesce(p_company, ''), '^\s+|\s+$', '', 'g')) < 2
    or coalesce(p_company, '')      ~* '\y(test|testing|asdf|qwerty|dummy|sample|placeholder|demo123|xxx+)\y'
    or coalesce(p_contact_name, '') ~* '\y(test|testing|asdf|qwerty|dummy|sample|placeholder|demo123|xxx+)\y'
    or regexp_replace(coalesce(p_company, ''), '\s', '', 'g') ~* '^(.)\1{3,}$|^[a-z]{1,2}[0-9]{2,}$'
$fn$;

revoke all on function public.lead_norm_phone(text) from public;
revoke all on function public.lead_norm_phone(text) from anon;
grant execute on function public.lead_norm_phone(text) to authenticated;
revoke all on function public.lead_norm_company(text) from public;
revoke all on function public.lead_norm_company(text) from anon;
grant execute on function public.lead_norm_company(text) to authenticated;
revoke all on function public.lead_looks_like_junk(text, text, text, text) from public;
revoke all on function public.lead_looks_like_junk(text, text, text, text) from anon;
grant execute on function public.lead_looks_like_junk(text, text, text, text) to authenticated;

-- ── Duplicate keys, indexed ────────────────────────────────────────────────
-- The duplicate rule compares two derived keys across the whole workspace. Deriving them
-- per row is the expensive part of every count (a regex pass over every lead), so they are
-- indexed once, at write time. With these, "which keys are shared" is an index-only scan,
-- "is this row a duplicate?" is one probe, and the 50 rows of a page carry their flag for
-- free. INCLUDE: owner_id because the team cut and the leads hierarchy policy read it; id
-- because that is what the scan returns; and the raw column because Postgres will only
-- plan an index-only scan over an expression index when the expression's input column is
-- in the index too.
--
-- ⚠ If lead_norm_phone / lead_norm_company are ever changed, REINDEX these two: an
-- expression index keeps the keys the OLD function computed.
create index if not exists leads_dup_phone_idx
  on public.leads (tenant_id, public.lead_norm_phone(contact_phone)) include (owner_id, id, contact_phone);
create index if not exists leads_dup_company_idx
  on public.leads (tenant_id, public.lead_norm_company(company)) include (owner_id, id, company);

-- ── list_leads (replaces S37's body; same signature, same grants) ───────────
-- p_filters — S37's keys unchanged (search, stages, priorities, junk, owner_ids, owner_id,
-- open_only), plus:
--   owners      text[] — "Kiska": owner id any-of; the element '__unassigned' keeps leads
--                        with no owner (list-selectors.ts#searchLeads step 3b, UNASSIGNED).
--   smart_view  text   — the View menu (list-selectors.ts#searchLeads step 4). When PRESENT
--                        it also decides the junk cut exactly as the page does: 'junk' shows
--                        confirmed junk + heuristic suspects, every other view hides junk
--                        (the `junk` key is then ignored). Absent = S37 behaviour.
--   folder      text   — the folder cut (list-selectors.ts#listCut + folders.ts#inSalesFolder).
--                        Only applied together with smart_view. Default 'all'.
--   sort        text   — 'created' (default; created_at desc, id desc — S37's order) or
--                        'wait' (lib/leads/waiting.ts#waitPriority: leads still waiting for
--                        our first reply first, longest wait first; then answered leads,
--                        slowest reply first). The cursor carries the key of the order in use:
--                        { created_at, id } for 'created', { wait_key, id } for 'wait'.
--   dup_of      text   — a lead id: only the OTHER workspace leads that share its phone key
--                        or company key (the page's matchesOf — the merge dialog's cluster).
--   dup_like    object — { company, contact_phone, exclude_id }: the same match for a lead
--                        being typed into the Add-lead form (its duplicate warning).
--
-- Each row also carries `is_duplicate` (another workspace lead shares its phone or company
-- key — the page's "Duplicate?" flag), computed for the rows of the page only.
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
  v_sort      text    := coalesce(nullif(v_f->>'sort', ''), 'created');
  v_view      text    := nullif(v_f->>'smart_view', '');
  v_folder    text    := coalesce(nullif(v_f->>'folder', ''), 'all');
  v_today     date    := (now() at time zone 'Asia/Kolkata')::date;
  v_c_at      timestamptz;
  v_c_key     numeric;
  v_c_id      text;
  v_search    text;
  v_pattern   text;
  v_stages    text[];
  v_prios     text[];
  v_junk      text    := coalesce(nullif(v_f->>'junk', ''), 'exclude');
  v_owner_ids uuid[];
  v_owner_id  uuid    := nullif(v_f->>'owner_id', '')::uuid;
  v_owners    text[];
  v_open_only boolean := coalesce((v_f->>'open_only')::boolean, false);
  v_dup_of    text    := nullif(v_f->>'dup_of', '');
  v_like      jsonb   := case when jsonb_typeof(v_f->'dup_like') = 'object' then v_f->'dup_like' end;
  v_of_p      text;
  v_of_c      text;
  v_of_ids    text[];
  v_rows      jsonb;
  v_keys      jsonb;
  v_count     integer;
  v_last      integer;
begin
  if v_sort not in ('created', 'wait') then
    raise exception 'list_leads: sort must be created or wait (got %)', v_sort using errcode = '22023';
  end if;
  if v_view is not null and v_view not in ('everything', 'all', 'mine', 'waiting', 'today', 'overdue', 'hot', 'new',
                                          'won-mtd', 'closing', 'stalled', 'duplicates', 'junk') then
    raise exception 'list_leads: unknown smart_view %', v_view using errcode = '22023';
  end if;
  if v_folder not in ('all', 'inbox', 'talks', 'quoted', 'proving', 'won', 'lost', 'hot', 'followup') then
    raise exception 'list_leads: unknown folder %', v_folder using errcode = '22023';
  end if;

  if p_cursor is not null and jsonb_typeof(p_cursor) <> 'null' then
    v_c_id := nullif(p_cursor->>'id', '');
    if v_sort = 'wait' then
      v_c_key := nullif(p_cursor->>'wait_key', '')::numeric;
      if v_c_key is null or v_c_id is null then
        raise exception 'list_leads: the cursor needs both wait_key and id — pass back next_cursor exactly as it was returned, or null for the first page'
          using errcode = '22023';
      end if;
    else
      v_c_at := nullif(p_cursor->>'created_at', '')::timestamptz;
      if v_c_at is null or v_c_id is null then
        raise exception 'list_leads: the cursor needs both created_at and id — pass back next_cursor exactly as it was returned, or null for the first page'
          using errcode = '22023';
      end if;
    end if;
  end if;

  if v_junk not in ('exclude', 'only', 'any') then
    raise exception 'list_leads: junk must be exclude, only or any (got %)', v_junk using errcode = '22023';
  end if;
  /* A smart view decides the junk cut, as searchLeads step 0 does. */
  if v_view is not null then
    v_junk := case when v_view = 'junk' then 'view' else 'exclude' end;
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
  if jsonb_typeof(v_f->'owners') = 'array' and jsonb_array_length(v_f->'owners') > 0 then
    select array_agg(x) into v_owners from jsonb_array_elements_text(v_f->'owners') x;
  end if;

  /* dup_of — the other leads that make THIS one a duplicate (the page's matchesOf), for the
     merge dialog: same workspace, same keys, not the lead itself.

     Why the keys are read through "offset 0" and never compared in a WHERE on the leads
     scan: leads has RLS, and Postgres will not evaluate a non-LEAKPROOF function (these
     key functions) ahead of the policy quals — so "key = x" can never be an index
     condition, and a filter on it recomputes the key for every lead (2.9 s for one page at
     20,000 leads, measured). Selecting the key as a COLUMN lets the planner read it from
     leads_dup_*_idx with an index-only scan instead (≈13 ms). LEAKPROOF itself needs a
     superuser, which a migration on hosted Supabase is not.

     dup_like — the same match for a lead that does not exist yet: the Add-lead form's "this
     company / phone is already a lead" warning. { company, contact_phone, exclude_id } —
     exclude_id is the lead being edited, which must not warn about itself. */
  if v_dup_of is not null then
    select public.lead_norm_phone(me.contact_phone), public.lead_norm_company(me.company)
      into v_of_p, v_of_c
      from public.leads me
     where me.id = v_dup_of and me.tenant_id = public.current_tenant_id();
  elsif v_like is not null then
    v_of_p   := public.lead_norm_phone(v_like->>'contact_phone');
    v_of_c   := public.lead_norm_company(v_like->>'company');
    v_dup_of := coalesce(nullif(v_like->>'exclude_id', ''), '');
  end if;
  if v_dup_of is not null then
    select coalesce(array_agg(distinct x.id), '{}') into v_of_ids from (
      select k.id
        from (select g.id, public.lead_norm_phone(g.contact_phone) as key
                from public.leads g
               where g.tenant_id = public.current_tenant_id()
                 and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
                 and (v_owner_id is null or g.owner_id = v_owner_id)
              offset 0) k
       where coalesce(v_of_p, '') <> '' and k.key = v_of_p and k.id <> v_dup_of
      union
      select k.id
        from (select g.id, public.lead_norm_company(g.company) as key
                from public.leads g
               where g.tenant_id = public.current_tenant_id()
                 and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
                 and (v_owner_id is null or g.owner_id = v_owner_id)
              offset 0) k
       where coalesce(v_of_c, '') <> '' and k.key = v_of_c and k.id <> v_dup_of
    ) x;
  end if;

  with dup as materialized (
    /* computeDuplicates(workspaceLeads) — every workspace lead (team cut only, junk
       included) whose phone key or company key ANOTHER workspace lead shares. Keys come
       from leads_dup_*_idx through index-only scans, counted with a window (see dup_of
       above for why it is never a WHERE). Read lazily: only the 'duplicates' view and the
       page's own rows ask for it. */
    select s.id
      from (select g.id, public.lead_norm_phone(g.contact_phone) as k,
                   count(*) over (partition by public.lead_norm_phone(g.contact_phone)) as n
              from public.leads g
             where g.tenant_id = public.current_tenant_id()
               and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
               and (v_owner_id is null or g.owner_id = v_owner_id)) s
     where s.n > 1 and s.k <> ''
    union
    select s.id
      from (select g.id, public.lead_norm_company(g.company) as k,
                   count(*) over (partition by public.lead_norm_company(g.company)) as n
              from public.leads g
             where g.tenant_id = public.current_tenant_id()
               and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
               and (v_owner_id is null or g.owner_id = v_owner_id)) s
     where s.n > 1 and s.k <> ''
  ), cand as (
    select l.id, l.company, l.contact_name, l.contact_email, l.contact_phone,
           l.plan, l.seats, l.value, l.stage, l.priority, l.owner_id, l.source,
           l.is_junk, l.created_at, l.updated_at, l.follow_up_date, l.expected_close_date,
           l.stage_changed_at, l.enquiry_type, l.project_id, l.customer_id,
           l.requires_human_attention, l.pipeline, l.subscription_type, l.lost_reason,
           l.domain, l.human_attention_reason,
           /* waitPriority as one stable number: still waiting → 1e12 − arrival epoch (older
              = bigger, and it does not drift with the clock, so a cursor stays valid);
              answered → seconds to first reply (≥ 0). Every waiting key is above every
              answered one, which is waitPriority's "waiting beats any answered lead". */
           case when v_sort = 'wait' then
             case when fr.at is null
                  then 1000000000000::numeric - extract(epoch from l.created_at)
                  else greatest(0::numeric, extract(epoch from fr.at) - extract(epoch from l.created_at))
             end
           end as wait_key
      from public.leads l
      /* lib/queries/lead-first-reply.ts: the first OUTBOUND touch (waiting.ts#OUTBOUND_KINDS),
         per lead through lead_activities_lead_idx. A grouped CTE joined back was planned as
         a nested loop — 22 s for one page at 20,000 leads; this is one index probe per lead.
         Skipped outright for the 'created' order. */
      left join lateral (
        select min(a.created_at) as at
          from public.lead_activities a
         where v_sort = 'wait'
           and a.lead_id = l.id
           and a.tenant_id = public.current_tenant_id()
           and a.kind in ('email', 'email_out', 'call', 'whatsapp', 'quote')
      ) fr on true
     where l.tenant_id = public.current_tenant_id()
       -- S37 keys
       and (v_junk in ('any', 'view') or (v_junk = 'only') = l.is_junk)
       and (v_junk <> 'view' or l.is_junk
            or public.lead_looks_like_junk(l.company, l.contact_name, l.contact_email, l.contact_phone))
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
       -- Kiska (searchLeads 3b)
       and (v_owners is null
            or (l.owner_id is null and '__unassigned' = any (v_owners))
            or l.owner_id::text = any (v_owners))
       -- smart view (searchLeads 4)
       and (v_view is null or v_view in ('everything', 'all', 'junk')
            or (v_view = 'mine'     and l.owner_id = auth.uid())
            or (v_view = 'waiting'  and l.requires_human_attention and l.stage not in ('won', 'lost'))
            or (v_view = 'today'    and (l.created_at at time zone 'Asia/Kolkata')::date = v_today)
            or (v_view = 'overdue'  and l.follow_up_date < v_today and l.stage not in ('won', 'lost'))
            or (v_view = 'hot'      and (l.priority = 'high' or l.stage in ('demo', 'trial', 'quote')))
            or (v_view = 'new'      and l.stage = 'new')
            or (v_view = 'won-mtd'  and l.stage = 'won'
                and l.created_at >= (date_trunc('month', v_today)::timestamp at time zone 'Asia/Kolkata'))
            or (v_view = 'closing'  and l.expected_close_date <= (date_trunc('month', v_today) + interval '1 month - 1 day')::date
                and l.stage not in ('won', 'lost'))
            or (v_view = 'stalled'  and l.stage not in ('won', 'lost')
                and l.stage_changed_at is not null and l.stage_changed_at <= now() - interval '7 days')
            or (v_view = 'duplicates' and l.id in (select d.id from dup d)))
       and (v_dup_of is null or l.id = any (v_of_ids))
       -- folder cut (listCut + inSalesFolder), only alongside a smart view
       and (v_view is null or v_view = 'junk'
            or (v_folder = 'all' and v_view = 'everything')
            or (v_folder = 'all'      and l.stage not in ('won', 'lost') and not l.is_junk)
            or (v_folder = 'inbox'    and not l.is_junk and l.stage = 'new')
            or (v_folder = 'talks'    and not l.is_junk and l.stage = 'contact')
            or (v_folder = 'quoted'   and not l.is_junk and l.stage = 'quote')
            or (v_folder = 'proving'  and not l.is_junk and l.stage in ('demo', 'trial'))
            or (v_folder = 'won'      and l.stage = 'won')
            or (v_folder = 'lost'     and l.stage = 'lost')
            or (v_folder = 'hot'      and not l.is_junk and l.stage not in ('won', 'lost')
                and (l.priority = 'high' or coalesce(l.value, 0) >= 100000))
            or (v_folder = 'followup' and not l.is_junk and l.stage not in ('won', 'lost')
                and l.follow_up_date <= v_today))
  ), page as (
    select c.*
      from cand c
     where v_c_id is null
        or (v_sort = 'wait'    and (c.wait_key, c.id) < (v_c_key, v_c_id))
        or (v_sort = 'created' and (c.created_at, c.id) < (v_c_at, v_c_id))
     order by case when v_sort = 'wait' then c.wait_key end desc,
              case when v_sort = 'created' then c.created_at end desc,
              c.id desc
     limit v_limit + 1
  ), numbered as (
    select p.*,
           /* The row's "Duplicate?" flag — only for the ≤ 51 rows of this page. */
           (p.id in (select d.id from dup d)) as is_duplicate,
           row_number() over (
             order by case when v_sort = 'wait' then p.wait_key end desc,
                      case when v_sort = 'created' then p.created_at end desc,
                      p.id desc) as rn
      from page p
  )
  select coalesce(jsonb_agg(to_jsonb(n) - 'rn' - 'wait_key' order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('wait_key', n.wait_key::text, 'id', n.id, 'created_at', n.created_at)
                            order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         count(*)::integer
    into v_rows, v_keys, v_count
    from numbered n;

  if v_count > v_limit then
    v_last := v_limit - 1;
    return jsonb_build_object(
      'rows', v_rows,
      'next_cursor', case when v_sort = 'wait'
                          then jsonb_build_object('wait_key', v_keys->v_last->'wait_key', 'id', v_keys->v_last->'id')
                          else jsonb_build_object('created_at', v_rows->v_last->'created_at', 'id', v_rows->v_last->'id')
                     end);
  end if;
  return jsonb_build_object('rows', v_rows, 'next_cursor', null);
end
$fn$;

comment on function public.list_leads(jsonb, integer, jsonb) is
  'S37+S40: one keyset page of leads, slim columns, RLS applies (security invoker). Filters incl. owners / smart_view / folder; sort created|wait. Returns {rows, next_cursor}.';

revoke all on function public.list_leads(jsonb, integer, jsonb) from public;
revoke all on function public.list_leads(jsonb, integer, jsonb) from anon;
grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;

-- ── lead_counts ─────────────────────────────────────────────────────────────
-- Every number the Sales & Pipeline screen shows, in one round trip.
--
-- p_filters — the SAME keys list_leads() reads (owner_ids / owner_id = the team toggle;
-- search, stages, priorities, owners, smart_view = the list's filters; folder = the folder
-- in force). Each section is counted over the base the page used for it:
--
--   pool       — every lead the caller can see, no filter at all (the page's `leads`):
--                total, unassigned, high_priority, by_owner { owner_id: n }.
--                → team-toggle note, "Kiska" counts, KPI "High Priority" / "Total Inquiries".
--   workspace  — the team cut only (`workspaceLeads`): junk, everything (non-junk), suspects
--                (non-junk the heuristic flags). → "All leads", Junk entry.
--   views      — open leads in the workspace (`leadsForTab`): all, mine, waiting, today,
--                overdue, hot, new, stalled, closing, duplicates. → the View menu.
--   folders    — the searched set (`searched`: every filter + the smart view):
--                inbox, talks, quoted, proving, won, lost, hot, followup. → folder rows.
--   list       — the list itself (`filtered` = searched + folder cut): matching,
--                hot (quote/trial rows), hot_top (the highest-value one of those, newest
--                first on a tie — the page's stable sort over a newest-first list).
--   kpi        — non-junk workspace (`pipelineTotals`): open_count, open_value,
--                open_value_project, won, lost.
--   today      — the IST date every date rule used, so the client can show it.
create or replace function public.lead_counts(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_f         jsonb   := coalesce(p_filters, '{}'::jsonb);
  v_view      text    := coalesce(nullif(v_f->>'smart_view', ''), 'everything');
  v_folder    text    := coalesce(nullif(v_f->>'folder', ''), 'all');
  v_today     date    := (now() at time zone 'Asia/Kolkata')::date;
  v_month_end date;
  v_month_at  timestamptz;
  v_pattern   text;
  v_stages    text[];
  v_prios     text[];
  v_owner_ids uuid[];
  v_owner_id  uuid    := nullif(v_f->>'owner_id', '')::uuid;
  v_owners    text[];
  v_me        uuid    := auth.uid();
  v_out       jsonb;
begin
  if v_view not in ('everything', 'all', 'mine', 'waiting', 'today', 'overdue', 'hot', 'new',
                    'won-mtd', 'closing', 'stalled', 'duplicates', 'junk') then
    raise exception 'lead_counts: unknown smart_view %', v_view using errcode = '22023';
  end if;
  if v_folder not in ('all', 'inbox', 'talks', 'quoted', 'proving', 'won', 'lost', 'hot', 'followup') then
    raise exception 'lead_counts: unknown folder %', v_folder using errcode = '22023';
  end if;

  v_month_end := (date_trunc('month', v_today) + interval '1 month - 1 day')::date;
  v_month_at  := date_trunc('month', v_today)::timestamp at time zone 'Asia/Kolkata';

  if btrim(coalesce(v_f->>'search', '')) <> '' then
    v_pattern := '%' || replace(replace(replace(lower(v_f->>'search'), '\', '\\'), '%', '\%'), '_', '\_') || '%';
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
  if jsonb_typeof(v_f->'owners') = 'array' and jsonb_array_length(v_f->'owners') > 0 then
    select array_agg(x) into v_owners from jsonb_array_elements_text(v_f->'owners') x;
  end if;

  with pool as (
    select l.id, l.company, l.contact_name, l.contact_email, l.contact_phone, l.plan, l.value,
           l.stage::text as stage, l.priority, l.owner_id, l.is_junk, l.created_at,
           l.follow_up_date, l.expected_close_date, l.stage_changed_at, l.enquiry_type,
           l.requires_human_attention
      from public.leads l
     where l.tenant_id = public.current_tenant_id()
  ), ws as (
    select p.*,
           public.lead_looks_like_junk(p.company, p.contact_name, p.contact_email, p.contact_phone) as suspect
      from pool p
     where (v_owner_ids is null or p.owner_id is null or p.owner_id = any (v_owner_ids))
       and (v_owner_id is null or p.owner_id = v_owner_id)
  ), dup_ids as (
    /* computeDuplicates(workspaceLeads): every workspace lead whose phone key or company key
       another workspace lead shares. One index-only pass per key over leads_dup_*_idx
       (≈13 ms each at 20,000 leads), counted with a window rather than joined back — the
       join was planned as "recompute the key for every lead" (≈330 ms). */
    select s.id
      from (select g.id, public.lead_norm_phone(g.contact_phone) as k,
                   count(*) over (partition by public.lead_norm_phone(g.contact_phone)) as n
              from public.leads g
             where g.tenant_id = public.current_tenant_id()
               and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
               and (v_owner_id is null or g.owner_id = v_owner_id)) s
     where s.n > 1 and s.k <> ''
    union
    select s.id
      from (select g.id, public.lead_norm_company(g.company) as k,
                   count(*) over (partition by public.lead_norm_company(g.company)) as n
              from public.leads g
             where g.tenant_id = public.current_tenant_id()
               and (v_owner_ids is null or g.owner_id is null or g.owner_id = any (v_owner_ids))
               and (v_owner_id is null or g.owner_id = v_owner_id)) s
     where s.n > 1 and s.k <> ''
  ), flagged as (
    select w.*,
           (w.id in (select id from dup_ids)) as dup,
           (w.stage not in ('won', 'lost') and not w.is_junk) as open
      from ws w
  ), searched as (
    select f.*
      from flagged f
     where (case when v_view = 'junk' then (f.is_junk or f.suspect) else not f.is_junk end)
       and (v_pattern is null
            or lower(f.company) like v_pattern escape '\'
            or lower(f.contact_name) like v_pattern escape '\'
            or lower(f.contact_email) like v_pattern escape '\'
            or lower(f.contact_phone) like v_pattern escape '\'
            or lower(f.plan) like v_pattern escape '\')
       and (v_stages is null or f.stage = any (v_stages))
       and (v_prios is null or f.priority = any (v_prios))
       and (v_owners is null
            or (f.owner_id is null and '__unassigned' = any (v_owners))
            or f.owner_id::text = any (v_owners))
       and (v_view in ('everything', 'all', 'junk')
            or (v_view = 'mine'     and f.owner_id = v_me)
            or (v_view = 'waiting'  and f.requires_human_attention and f.stage not in ('won', 'lost'))
            or (v_view = 'today'    and (f.created_at at time zone 'Asia/Kolkata')::date = v_today)
            or (v_view = 'overdue'  and f.follow_up_date < v_today and f.stage not in ('won', 'lost'))
            or (v_view = 'hot'      and (f.priority = 'high' or f.stage in ('demo', 'trial', 'quote')))
            or (v_view = 'new'      and f.stage = 'new')
            or (v_view = 'won-mtd'  and f.stage = 'won' and f.created_at >= v_month_at)
            or (v_view = 'closing'  and f.expected_close_date <= v_month_end and f.stage not in ('won', 'lost'))
            or (v_view = 'stalled'  and f.stage not in ('won', 'lost')
                and f.stage_changed_at is not null and f.stage_changed_at <= now() - interval '7 days')
            or (v_view = 'duplicates' and f.dup))
  ), listed as (
    select s.*
      from searched s
     where v_view = 'junk'
        or (v_folder = 'all' and v_view = 'everything')
        or (v_folder = 'all'      and s.open)
        or (v_folder = 'inbox'    and not s.is_junk and s.stage = 'new')
        or (v_folder = 'talks'    and not s.is_junk and s.stage = 'contact')
        or (v_folder = 'quoted'   and not s.is_junk and s.stage = 'quote')
        or (v_folder = 'proving'  and not s.is_junk and s.stage in ('demo', 'trial'))
        or (v_folder = 'won'      and s.stage = 'won')
        or (v_folder = 'lost'     and s.stage = 'lost')
        or (v_folder = 'hot'      and s.open and (s.priority = 'high' or coalesce(s.value, 0) >= 100000))
        or (v_folder = 'followup' and s.open and s.follow_up_date <= v_today)
  )
  select jsonb_build_object(
    'today', v_today,
    'pool', (
      select jsonb_build_object(
        'total',         count(*),
        'unassigned',    count(*) filter (where p.owner_id is null),
        'high_priority', count(*) filter (where p.priority = 'high'),
        'by_owner',      coalesce((select jsonb_object_agg(o.owner_id, o.n)
                                     from (select owner_id, count(*) as n from pool
                                            where owner_id is not null group by owner_id) o), '{}'::jsonb))
        from pool p),
    'workspace', (
      select jsonb_build_object(
        'junk',       count(*) filter (where w.is_junk),
        'everything', count(*) filter (where not w.is_junk),
        'suspects',   count(*) filter (where not w.is_junk and w.suspect))
        from ws w),
    'views', (
      select jsonb_build_object(
        'all',        count(*),
        'mine',       count(*) filter (where v_me is not null and f.owner_id = v_me),
        'waiting',    count(*) filter (where f.requires_human_attention),
        'today',      count(*) filter (where (f.created_at at time zone 'Asia/Kolkata')::date = v_today),
        'overdue',    count(*) filter (where f.follow_up_date < v_today),
        'hot',        count(*) filter (where f.priority = 'high' or f.stage in ('demo', 'trial', 'quote')),
        'new',        count(*) filter (where f.stage = 'new'),
        'stalled',    count(*) filter (where f.stage_changed_at is not null and f.stage_changed_at <= now() - interval '7 days'),
        'closing',    count(*) filter (where f.expected_close_date <= v_month_end),
        'duplicates', count(*) filter (where f.dup))
        from flagged f where f.open),
    'folders', (
      select jsonb_build_object(
        'inbox',    count(*) filter (where not s.is_junk and s.stage = 'new'),
        'talks',    count(*) filter (where not s.is_junk and s.stage = 'contact'),
        'quoted',   count(*) filter (where not s.is_junk and s.stage = 'quote'),
        'proving',  count(*) filter (where not s.is_junk and s.stage in ('demo', 'trial')),
        'won',      count(*) filter (where s.stage = 'won'),
        'lost',     count(*) filter (where s.stage = 'lost'),
        'hot',      count(*) filter (where s.open and (s.priority = 'high' or coalesce(s.value, 0) >= 100000)),
        'followup', count(*) filter (where s.open and s.follow_up_date <= v_today))
        from searched s),
    'list', (
      select jsonb_build_object(
        'matching', count(*),
        'hot',      count(*) filter (where t.stage in ('quote', 'trial')),
        'hot_top',  (select jsonb_build_object(
                              'id', h.id, 'company', h.company, 'contact_name', h.contact_name,
                              'contact_email', h.contact_email, 'contact_phone', h.contact_phone,
                              'plan', h.plan, 'value', h.value, 'stage', h.stage)
                       from listed h
                      where h.stage in ('quote', 'trial')
                      order by coalesce(h.value, 0) desc, h.created_at desc, h.id desc
                      limit 1))
        from listed t),
    'kpi', (
      select jsonb_build_object(
        'open_count',         count(*) filter (where w.stage not in ('won', 'lost')),
        'open_value',         coalesce(sum(coalesce(w.value, 0)) filter (where w.stage not in ('won', 'lost')), 0),
        'open_value_project', coalesce(sum(coalesce(w.value, 0)) filter (where w.stage not in ('won', 'lost')
                                                                        and w.enquiry_type = 'project'), 0),
        'won',                count(*) filter (where w.stage = 'won'),
        'lost',               count(*) filter (where w.stage = 'lost'))
        from ws w where not w.is_junk)
  ) into v_out;

  return v_out;
end
$fn$;

comment on function public.lead_counts(jsonb) is
  'S40: every count on the Sales & Pipeline screen (pool, workspace, views, folders, list, kpi) for the given filters. RLS applies (security invoker).';

revoke all on function public.lead_counts(jsonb) from public;
revoke all on function public.lead_counts(jsonb) from anon;
grant execute on function public.lead_counts(jsonb) to authenticated;
