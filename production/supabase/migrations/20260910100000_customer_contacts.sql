-- ============================================================================
-- A customer's contacts become the single home for "who do I ring" — 10 Sep 2026.
--
-- WHY
--   Three places held the same fact, and two were dead:
--     · customers.contact_name / email / phone / mobile / title / salutation
--       — the flat fields the whole app actually reads
--     · customers.contact_persons  (jsonb)   — 0 customers used it
--     · contacts  (already has customer_id)  — 0 rows
--   Three representations of one fact is how the next person gets it wrong: a
--   number corrected in one is stale in the other two, and nobody can say which
--   one the invoice used.
--
--   Abhishek's decision (10 Sep 2026): ONE identity. A customer has contacts —
--   several, with roles (owner / accountant / IT head / point of contact) — and at
--   least one is mandatory. Prospects who are not customers belong in `leads`,
--   which already has a pipeline for exactly that.
--
-- WHAT THIS MIGRATION DOES
--   Reshapes `contacts` into that home, and backfills the flat fields into it so
--   no customer loses their contact person. It does NOT drop the flat columns:
--   16 files still read them, and they are converted in the application layer
--   first. Dropping them here would break invoices and dunning in the same breath.
--
-- WHY NOT A MIRROR
--   The cheaper option was to keep customers.contact_email auto-synced from the
--   primary contact so those 16 readers never change. Abhishek chose the proper
--   conversion instead — one truth, no cached copy that can drift.
-- ============================================================================

-- ── The role a person plays for this customer ───────────────────────────────
-- Text + check rather than an enum: adding a role later is then an ALTER of one
-- constraint, not a type migration with a rewrite behind it.
alter table public.contacts
  add column if not exists role text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.contacts'::regclass
       and conname  = 'contacts_role_check'
  ) then
    alter table public.contacts
      add constraint contacts_role_check
      check (role is null or role in ('owner','accountant','it_head','poc','other'));
  end if;
end $$;

-- ── Exactly one primary per customer ────────────────────────────────────────
-- The primary is who gets the invoice and the payment reminder, so "which one?"
-- must never be a guess. A partial unique index makes a second primary
-- impossible rather than merely discouraged.
alter table public.contacts
  add column if not exists is_primary boolean not null default false;

create unique index if not exists contacts_one_primary_per_customer
  on public.contacts (customer_id)
  where is_primary and customer_id is not null;

create index if not exists contacts_customer_idx
  on public.contacts (tenant_id, customer_id)
  where customer_id is not null;

comment on column public.contacts.role is
  'What this person does for the customer: owner / accountant / it_head / poc / '
  'other. NULL on rows that predate 10 Sep 2026 or are not customer contacts.';
comment on column public.contacts.is_primary is
  'The one contact who receives invoices and payment reminders. At most one per '
  'customer — enforced by contacts_one_primary_per_customer.';

-- ── Backfill: every customer that has a contact detail gets a contact row ───
-- Idempotent by design: skips a customer that already has contacts, so re-running
-- cannot duplicate anybody. Named `-- ZZ` nothing; these are real records.
insert into public.contacts (
  id, tenant_id, customer_id, full_name, email, phone, company, title,
  role, is_primary, source, status, created_at
)
select
  gen_random_uuid()::text,
  c.tenant_id,
  c.id,
  /* A name we can actually address them by. coalesce down to the company name:
     an unnamed contact is still better than an empty row, and the operator can
     correct it — whereas a NULL name shows a blank line nobody understands. */
  coalesce(
    nullif(trim(coalesce(c.contact_name, '')), ''),
    nullif(trim(coalesce(c.contact_first_name, '') || ' ' || coalesce(c.contact_last_name, '')), ''),
    c.name
  ),
  nullif(trim(coalesce(c.contact_email, '')), ''),
  coalesce(nullif(trim(coalesce(c.contact_phone, '')), ''),
           nullif(trim(coalesce(c.contact_mobile, '')), '')),
  c.name,
  nullif(trim(coalesce(c.contact_title, '')), ''),
  'poc',
  true,
  /* `source` and `status` are both CHECK-constrained to existing vocabularies
     (manual/google_csv/google_api/outlook/linkedin/event/other/enquiry, and
     pending/engaged/promoted/archived). A first attempt used 'backfill_20260910'
     and 'active' — neither exists, and the whole INSERT was refused. Reusing the
     vocabulary rather than widening it: a one-off source value would outlive the
     one day it described. 'engaged' is right for a paying customer's contact. */
  'other',
  'engaged',
  now()
from public.customers c
where not exists (
  select 1 from public.contacts x where x.customer_id = c.id
);

-- contact_persons (jsonb) is NOT migrated: it is empty on every customer, so
-- there is nothing in it to move. It is left in place for the application step
-- to drop, alongside the flat columns, once nothing reads either.
