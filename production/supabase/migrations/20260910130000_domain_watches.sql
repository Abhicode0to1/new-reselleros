begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- "Tell me if this domain becomes free."
--
-- Ported from the DMS engine's `DomainWatch` model (30 lines) on 10 Sep 2026 —
-- fourth of the five zero-row DMS features, and the only one that is a customer
-- feature rather than an operational one.
--
-- ─── WHY IT IS WORTH HAVING ──────────────────────────────────────────────────
-- The name a customer actually wants is usually taken. Today the search says
-- "TAKEN" and the conversation ends there; the customer goes away, and if the
-- name is ever released somebody else registers it within hours. A watch turns a
-- dead end into a reason to come back, and it costs one availability check a day
-- against an API this app already talks to (`rcAvailability`).
--
-- ─── THE WHOLE RISK IS THE EMAIL ─────────────────────────────────────────────
-- "acme.com is available!" sent about a domain that is NOT available is worse
-- than silence: the customer tries to buy it, fails, and trusts nothing else we
-- send. So:
--   · `notified_at` is set ONCE and the row stops being checked — a watch is a
--     one-shot alert, not a subscription to a mailing list;
--   · `last_status` keeps 'unknown' as a real value, distinct from 'taken', so a
--     failed check can never be the thing that triggers an email;
--   · the notify path requires a POSITIVE 'available' reading, never the absence
--     of a 'taken' one. That rule lives in lib/domains/watch.ts, because it is
--     arithmetic about evidence and belongs somewhere testable.
--
-- ─── ONE WATCH PER CUSTOMER PER NAME ─────────────────────────────────────────
-- DMS had `{ userId, domainName }` unique, and the same here scoped to the
-- customer. Two customers watching the same name is normal and both get told;
-- one customer with two rows for it is a double email.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.domain_watches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id)   on delete cascade,
  /* The customer who asked. CASCADE: a deleted customer's watch is not evidence
     of anything, and emailing them later would be worse than losing the row. */
  customer_id uuid not null references public.customers(id) on delete cascade,

  /* Lowercase, like `domains.domain_name` — the registrar keys on the exact
     string and a watch on "Acme.com" that never matches "acme.com" is a silent
     dead feature. */
  domain_name text not null check (domain_name = lower(domain_name) and domain_name <> ''),

  last_checked_at timestamptz,
  /* 'available' | 'taken' | 'unknown'. `unknown` is a REAL value and the default:
     until a check has actually succeeded we do not know, and reading "not taken"
     as "available" is the one mistake that sends a wrong email. */
  last_status text not null default 'unknown'
              check (last_status in ('available', 'taken', 'unknown')),

  /* Set once, when the customer has been told. A non-null value takes the row
     out of the sweep for good. */
  notified_at timestamptz,

  /* How many times the check has failed in a row. A name whose TLD we cannot
     read at all should stop being retried rather than being asked forever. */
  consecutive_errors integer not null default 0 check (consecutive_errors >= 0),
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* One watch per customer per name — see the header. */
create unique index if not exists domain_watches_unique
  on public.domain_watches (customer_id, domain_name);

/* The sweep's query: not yet notified, least recently checked first, so a
   backlog drains fairly instead of starving the oldest rows. */
create index if not exists domain_watches_due
  on public.domain_watches (last_checked_at nulls first)
  where notified_at is null;

create index if not exists domain_watches_tenant
  on public.domain_watches (tenant_id, created_at desc);

alter table public.domain_watches enable row level security;

/* Staff of the owning tenant see all of them. */
drop policy if exists domain_watches_staff on public.domain_watches;
create policy domain_watches_staff on public.domain_watches
  for all  using      (tenant_id = (select tenant_id from public.users where id = auth.uid()))
           with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* A portal customer manages their OWN watches: they may see them, add them and
   remove them. This is the only customer-writable table in the domain area, and
   it is safe to be: a watch spends nothing and provisions nothing.

   Note what the INSERT check does NOT allow — setting `notified_at` or
   `last_status` is not prevented here because a customer inserting
   `last_status: 'available'` would only affect their own row's sweep bookkeeping,
   never the email, which requires a POSITIVE check performed server-side. If
   that ever stops being true, this policy needs columns pinned. */
drop policy if exists domain_watches_own_select on public.domain_watches;
create policy domain_watches_own_select on public.domain_watches
  for select using (customer_id in (
    select customer_id from public.customer_users where auth_user_id = auth.uid()
  ));

drop policy if exists domain_watches_own_insert on public.domain_watches;
create policy domain_watches_own_insert on public.domain_watches
  for insert with check (customer_id in (
    select customer_id from public.customer_users where auth_user_id = auth.uid()
  ));

drop policy if exists domain_watches_own_delete on public.domain_watches;
create policy domain_watches_own_delete on public.domain_watches
  for delete using (customer_id in (
    select customer_id from public.customer_users where auth_user_id = auth.uid()
  ));

/* No customer UPDATE policy: there is nothing on this row a customer should
   change. Changing their mind means deleting the watch and adding another. */

comment on table public.domain_watches is
  'One-shot "tell me when this name is free" alerts. `notified_at` is set once and retires the row. See lib/domains/watch.ts — an email requires a POSITIVE availability reading, never the absence of a taken one.';
comment on column public.domain_watches.last_status is
  'available | taken | unknown. `unknown` is real and is the default: a failed check must never be able to trigger the email.';

commit;
