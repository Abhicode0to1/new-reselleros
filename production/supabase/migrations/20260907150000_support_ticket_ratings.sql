-- ============================================================================
-- CSAT: one rating per support ticket — DSP-merge brick 3 (7 Sep 2026).
--
-- DSP proved the shape in production: the CUSTOMER rates a finished ticket
-- once (1–5 + an optional line), agents read it, nobody edits it. Ported here
-- tenant-scoped. The rating is the customer's word, so:
--   · INSERT is open only to the PORTAL customer the ticket belongs to, and
--     only once the ticket is actually resolved/closed — an agent cannot rate
--     their own work, and a mid-flight ticket cannot be scored.
--   · No UPDATE/DELETE for anyone but service_role: an editable rating is a
--     negotiation, not a measurement.
--   · UNIQUE (tenant_id, ticket_id): one ticket, one verdict (DSP's rule).
-- Same Cloud SQL rules as brick 1: composite FK against cross-tenant links,
-- explicit grants (default privileges are deferred there), and the apply
-- script must end with NOTIFY pgrst so PostgREST can see the table at all.
-- ============================================================================

create table if not exists public.support_ticket_ratings (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants(id) on delete cascade,
  ticket_id      text        not null,
  score          int         not null check (score between 1 and 5),
  comment        text        check (comment is null or length(comment) <= 2000),
  rated_by_email text        not null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, ticket_id),
  foreign key (tenant_id, ticket_id)
    references public.support_tickets (tenant_id, id) on delete cascade
);

alter table public.support_ticket_ratings enable row level security;

-- Agents/owners of the tenant read their customers' verdicts.
drop policy if exists support_ticket_ratings_tenant_select on public.support_ticket_ratings;
create policy support_ticket_ratings_tenant_select on public.support_ticket_ratings
  for select to authenticated using (tenant_id = public.current_tenant_id());

-- The portal customer sees the rating they gave.
drop policy if exists support_ticket_ratings_customer_select on public.support_ticket_ratings;
create policy support_ticket_ratings_customer_select on public.support_ticket_ratings
  for select to authenticated using (
    exists (
      select 1 from public.support_tickets t
      where t.tenant_id = support_ticket_ratings.tenant_id
        and t.id        = support_ticket_ratings.ticket_id
        and t.customer_id = public.current_customer_id()
    )
  );

-- Only the ticket's own portal customer may rate, and only a finished ticket.
drop policy if exists support_ticket_ratings_customer_insert on public.support_ticket_ratings;
create policy support_ticket_ratings_customer_insert on public.support_ticket_ratings
  for insert to authenticated with check (
    exists (
      select 1 from public.support_tickets t
      where t.tenant_id = support_ticket_ratings.tenant_id
        and t.id        = support_ticket_ratings.ticket_id
        and t.customer_id = public.current_customer_id()
        and (t.resolved_at is not null or t.status in ('resolved', 'closed'))
    )
  );

drop policy if exists zzz_service_role_all on public.support_ticket_ratings;
create policy zzz_service_role_all on public.support_ticket_ratings
  as permissive for all to service_role using (true) with check (true);

create index if not exists idx_support_ticket_ratings_tenant
  on public.support_ticket_ratings (tenant_id, created_at);

-- Explicit grants — Cloud SQL default privileges were deferred (01b).
grant select, insert                 on public.support_ticket_ratings to authenticated;
grant select, insert, update, delete on public.support_ticket_ratings to service_role;
