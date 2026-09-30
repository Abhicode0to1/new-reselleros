-- 20260930200000_deal_totals_billing_cycle_dup_check
--
-- WHAT THIS CHANGES (R-070 / R-071 / R-072, 30 Sep 2026 — Pardeep's leads/deals area)
--   R-070  lead_counts() gains `stage_totals` (per stage: count, ₹ value, probability-weighted
--          ₹) so the Deals Kanban header shows the column's TRUE total, not the sum of the
--          newest 200 cards it happens to hold ("total ≈ (sirf dikhne wale cards)"). Its View
--          menu counts honour a new optional `page_stages` key, so /deals counts deals only.
--          The "Won this month" view (won-mtd) now reads the WIN date
--          (coalesce(stage_changed_at, created_at)) in the IST month — in BOTH lead_counts()
--          and list_leads(), so the chip and the list still agree. The TS twin
--          (list-selectors.ts#wonThisMonth) already used the win date.
--   R-071  leads.billing_cycle ('monthly' | 'yearly', nullable) and leads.current_provider
--          (free text, nullable). `value` stays the ANNUAL deal value whatever the cycle —
--          the forecast, dashboard and every pipeline sum add `value` up, and a mix of
--          monthly and yearly numbers in one sum would be wrong without anyone noticing.
--   R-072  find_lead_duplicates(p_phone, p_email, p_gstin, p_company, p_exclude_id) — the
--          Add-lead form's warning widened from phone + company to email and GSTIN, with
--          the owner's name. SECURITY INVOKER: RLS decides what it can see, like list_leads.
--          Two key functions (lead_norm_email / lead_norm_gstin) and their indexes.
--
-- WHY
--   Without R-070 a capped column's ₹ total silently undercounts (it said so, with "≈").
--   Without the won-mtd fix an August lead won on 3 September is not September's win.
--   Without R-072 the same customer re-entered with a different phone but the same email or
--   GSTIN becomes a second lead, and two reps chase one company.
--
-- ADDITIVE ONLY: two nullable columns, three new functions, two indexes; the two re-created
-- functions keep their signatures, grants and every existing output key. A caller that sends
-- no `page_stages` gets the old View-menu counts.
--
-- VERIFY (local): node scripts/test-sql.mjs --local deal_totals_billing_dup
--   supabase/tests/deal_totals_billing_dup.test.sql carries this file verbatim (vitest
--   src/lib/leads/deal-totals-sql-copy.test.ts fails if the copy drifts).

-- ── R-071: billing cycle + current provider ────────────────────────────────
alter table public.leads add column if not exists billing_cycle text;
alter table public.leads add column if not exists current_provider text;

do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'leads_billing_cycle_check' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_billing_cycle_check
      check (billing_cycle is null or billing_cycle in ('monthly', 'yearly'));
  end if;
end $$;

comment on column public.leads.billing_cycle is
  'R-071: how the customer will be billed — monthly | yearly. Descriptive: leads.value stays the ANNUAL deal value either way.';
comment on column public.leads.current_provider is
  'R-071: who the prospect buys from today (another reseller, direct, …) — free text.';

-- ── list_leads (S40's body, re-created: ONE change — won-mtd reads the win date) ──
-- Everything below is 20260929130000's list_leads verbatim except the `won-mtd` predicate.
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
                and coalesce(l.stage_changed_at, l.created_at) >= (date_trunc('month', v_today)::timestamp at time zone 'Asia/Kolkata'))
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
  'S37+S40+R-070: one keyset page of leads, slim columns, RLS applies (security invoker). Filters incl. owners / smart_view / folder; sort created|wait. Returns {rows, next_cursor}.';

revoke all on function public.list_leads(jsonb, integer, jsonb) from public;
revoke all on function public.list_leads(jsonb, integer, jsonb) from anon;
grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;

-- ── lead_counts (S40's body, re-created with R-070's three changes) ─────────
-- Everything below is 20260929130000's lead_counts verbatim except:
--   • won-mtd reads the win date (coalesce(stage_changed_at, created_at)), as list_leads;
--   • views honours the new optional key page_stages (text[]) — the stages the PAGE shows
--     (lib/leads/page-scope.ts#pageStages), not the user's stage pick, which views never
--     read. /deals sends quote/demo/trial/won/lost, so its View menu counts deals only;
--   • stage_totals — per stage of the searched set: count, value (sum of value > 0) and
--     weighted (each deal's value × its stage probability, rounded per deal, then summed —
--     lib/leads/forecast.ts#STAGE_PROBABILITY / weightedValue). The Kanban header reads it,
--     so a capped column shows its true ₹ total instead of the visible cards' sum.
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
--   stage_totals — the searched set per stage: { stage: { count, value, weighted } } (R-070).
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
  v_page_stages text[];
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
  if jsonb_typeof(v_f->'page_stages') = 'array' and jsonb_array_length(v_f->'page_stages') > 0 then
    select array_agg(x) into v_page_stages from jsonb_array_elements_text(v_f->'page_stages') x;
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
            or (v_view = 'won-mtd'  and f.stage = 'won' and coalesce(f.stage_changed_at, f.created_at) >= v_month_at)
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
        from flagged f where f.open and (v_page_stages is null or f.stage = any (v_page_stages))),
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
        from ws w where not w.is_junk),
    'stage_totals', (
      select coalesce(jsonb_object_agg(t.stage, jsonb_build_object(
               'count', t.n, 'value', t.total, 'weighted', t.weighted)), '{}'::jsonb)
        from (select s.stage,
                     count(*) as n,
                     coalesce(sum(greatest(coalesce(s.value, 0), 0)), 0) as total,
                     /* forecast.ts#STAGE_PROBABILITY — lead-counts-sql-copy.test.ts holds the
                        two tables equal. round() per deal, as weightedValue does. */
                     coalesce(sum(case when coalesce(s.value, 0) > 0 then
                       round(s.value::numeric * (case s.stage
                         when 'new' then 10 when 'contact' then 20 when 'demo' then 40
                         when 'trial' then 60 when 'quote' then 80 when 'won' then 100
                         else 0 end) / 100) else 0 end), 0)::bigint as weighted
                from searched s
               group by s.stage) t)
  ) into v_out;

  return v_out;
end
$fn$;

comment on function public.lead_counts(jsonb) is
  'S40+R-070: every count on the Sales & Pipeline screen (pool, workspace, views, folders, list, kpi, stage_totals) for the given filters. RLS applies (security invoker).';

revoke all on function public.lead_counts(jsonb) from public;
revoke all on function public.lead_counts(jsonb) from anon;
grant execute on function public.lead_counts(jsonb) to authenticated;

-- ── R-072: find_lead_duplicates ─────────────────────────────────────────────
-- Two more duplicate keys, same shape as lead_norm_phone / lead_norm_company (immutable,
-- `set search_path = ''`, COST 1000 so the planner reads them from the index rather than
-- recomputing them over every lead).
--   email: lower + trim; '' when there is no '@' after the first character.
--   GSTIN: upper, every whitespace removed; '' unless it is 15 characters (a half-typed
--          GSTIN must not match anything).
-- Company keeps lead_norm_company (20260929130000): lower, punctuation out, "pvt ltd" and the
-- other noise words out — the same key the Duplicates view uses.
create or replace function public.lead_norm_email(e text)
returns text
language sql
immutable
cost 1000
set search_path = ''
as $fn$
  select case when position('@' in btrim(coalesce(e, ''))) > 1 then lower(btrim(e)) else '' end
$fn$;

create or replace function public.lead_norm_gstin(g text)
returns text
language sql
immutable
cost 1000
set search_path = ''
as $fn$
  select case when length(regexp_replace(coalesce(g, ''), '\s', '', 'g')) = 15
              then upper(regexp_replace(g, '\s', '', 'g')) else '' end
$fn$;

revoke all on function public.lead_norm_email(text) from public;
revoke all on function public.lead_norm_email(text) from anon;
grant execute on function public.lead_norm_email(text) to authenticated;
revoke all on function public.lead_norm_gstin(text) from public;
revoke all on function public.lead_norm_gstin(text) from anon;
grant execute on function public.lead_norm_gstin(text) to authenticated;

-- Same INCLUDE rule as leads_dup_*_idx (20260929130000): the raw column is in the index so
-- an index-only scan can serve the expression.
create index if not exists leads_dup_email_idx
  on public.leads (tenant_id, public.lead_norm_email(contact_email)) include (owner_id, id, contact_email);
create index if not exists leads_dup_gstin_idx
  on public.leads (tenant_id, public.lead_norm_gstin(gstin)) include (owner_id, id, gstin);

-- The leads a lead being TYPED would duplicate, strongest match first (GSTIN, email, phone,
-- company), then newest. Every key is optional; a key that normalises to '' matches nothing.
-- p_exclude_id = the lead being edited, which must not warn about itself.
--
-- Keys are selected as a COLUMN of an `offset 0` subquery and compared outside it, never in
-- the WHERE of the leads scan: RLS keeps a non-LEAKPROOF function behind the policy quals,
-- so "key = x" there would recompute the key for every lead (see list_leads' dup_of note).
--
-- Never blocks anything: it only reads. Junk leads are included (a junk row with the same
-- GSTIN is still worth a look) and carry is_junk so the caller can say so.
create or replace function public.find_lead_duplicates(
  p_phone      text default null,
  p_email      text default null,
  p_gstin      text default null,
  p_company    text default null,
  p_exclude_id text default null
)
returns table (
  id           text,
  company      text,
  contact_name text,
  stage        text,
  is_junk      boolean,
  owner_id     uuid,
  owner_name   text,
  matched_on   text[],
  created_at   timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
declare
  v_p  text := public.lead_norm_phone(p_phone);
  v_e  text := public.lead_norm_email(p_email);
  v_g  text := public.lead_norm_gstin(p_gstin);
  v_c  text := public.lead_norm_company(p_company);
  v_x  text := coalesce(nullif(p_exclude_id, ''), '');
begin
  if v_p = '' and v_e = '' and v_g = '' and v_c = '' then
    return;
  end if;

  return query
  with hits as (
    select k.id, 'gstin'::text as why, 1 as rnk
      from (select g.id, public.lead_norm_gstin(g.gstin) as key
              from public.leads g
             where g.tenant_id = public.current_tenant_id() and v_g <> ''
            offset 0) k
     where k.key = v_g
    union all
    select k.id, 'email', 2
      from (select g.id, public.lead_norm_email(g.contact_email) as key
              from public.leads g
             where g.tenant_id = public.current_tenant_id() and v_e <> ''
            offset 0) k
     where k.key = v_e
    union all
    select k.id, 'phone', 3
      from (select g.id, public.lead_norm_phone(g.contact_phone) as key
              from public.leads g
             where g.tenant_id = public.current_tenant_id() and v_p <> ''
            offset 0) k
     where k.key = v_p
    union all
    select k.id, 'company', 4
      from (select g.id, public.lead_norm_company(g.company) as key
              from public.leads g
             where g.tenant_id = public.current_tenant_id() and v_c <> ''
            offset 0) k
     where k.key = v_c
  ), agg as (
    select h.id, array_agg(h.why order by h.rnk) as matched_on, min(h.rnk) as best
      from hits h
     where h.id <> v_x
     group by h.id
  )
  select l.id, l.company, l.contact_name, l.stage::text, l.is_junk, l.owner_id,
         u.full_name, a.matched_on, l.created_at
    from agg a
    join public.leads l on l.id = a.id and l.tenant_id = public.current_tenant_id()
    left join public.users u on u.id = l.owner_id and u.tenant_id = l.tenant_id
   order by a.best, l.created_at desc, l.id desc
   limit 10;
end
$fn$;

comment on function public.find_lead_duplicates(text, text, text, text, text) is
  'R-072: leads a typed lead would duplicate — GSTIN, email, phone or company key; strongest match first; RLS applies (security invoker). Warning only, never blocks.';

revoke all on function public.find_lead_duplicates(text, text, text, text, text) from public;
revoke all on function public.find_lead_duplicates(text, text, text, text, text) from anon;
grant execute on function public.find_lead_duplicates(text, text, text, text, text) to authenticated;
