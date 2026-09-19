begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- White-label sub-reseller economics: identity, lifecycle, markup, prepaid wallet.
--
-- Ported from the DMS engine's `Reseller` model (103 lines) on 10 Sep 2026 —
-- third of the five zero-row DMS features, and the one TASKS.md called "sabse
-- bada gap".
--
-- ─── NOT A NEW TABLE, BECAUSE A RESELLER IS ALREADY A TENANT ─────────────────
-- DMS modelled a Reseller as a separate document pointing at a login `User` with
-- role "reseller", because its tenancy was implicit. Here it is explicit:
-- `tenants.tier` is already ('distributor' | 'reseller') and `parent_tenant_id`
-- already links a sub-reseller to whoever signed them up, with a self-parent
-- check. A second table would give a reseller two identities and invite the two
-- to disagree. Same call as `PendingDomain` earlier today.
--
-- What was genuinely missing, measured against the whole schema: no `slug`, no
-- `markup`, no `wallet` column anywhere. (`items.margin_pct` and
-- `quotes.approved_margin_bps` are PRODUCT margin — what we make on a sale — not
-- what a sub-reseller adds on top of our price. Different number, different
-- payer.)
--
-- ─── THE WALLET IS A LEDGER, NOT A COLUMN. THIS IS THE ONE REAL DEPARTURE ────
-- DMS has `walletBalance: { type: Number, default: 0, min: 0 }` — a single
-- mutable number. That is the oldest bug in accounting software: the running
-- total and the transactions that produced it drift apart, and when they do there
-- is no way to tell which one is wrong. A top-up that half-applied, a debit
-- written twice by a retried request, a concurrent update that lost one side —
-- all of them leave a balance nobody can defend to the reseller whose money it is.
--
-- So the balance is DERIVED from an append-only ledger. Every movement is a row
-- with a reason and a source, the balance is their sum, and a disagreement is
-- impossible rather than merely unlikely. This is the same instinct the rest of
-- this codebase already follows — `record_payment` is atomic and idempotent, and
-- overpayment credit is created INSIDE it (migration 20260901110000) rather than
-- by a second write that can fail on its own.
--
-- Deriving is affordable here: a reseller's ledger is tens of rows a year, not
-- millions. If that ever changes, the fix is a materialised balance kept by
-- trigger and RECONCILED against the ledger — not a column the app writes.
--
-- ─── MARKUP IS STORED AND CORRECT, BUT NOT YET APPLIED ANYWHERE ──────────────
-- DMS's own header says the commercial fields are "DORMANT until later phases".
-- Same here, and said plainly: this migration gives markup a home and
-- lib/resellers/economics.ts gives it tested arithmetic. Threading it through
-- every price surface (quotes, the shop, invoices, the portal) is a separate
-- piece of work — a markup applied in three places out of five is worse than one
-- applied nowhere, because the customer sees two different prices for one thing.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Identity and lifecycle on the tenant itself ─────────────────────────

alter table public.tenants
  /* URL-safe handle, for white-label routing later. Nullable: every existing
     tenant predates this and backfilling a guessed slug would claim a URL
     nobody asked for. */
  add column if not exists slug text,

  /* The reseller lifecycle, which is NOT `tier`. Tier says what kind of tenant
     this is; status says whether they may trade yet. A reseller signed up five
     minutes ago and one suspended for non-payment are both tier='reseller'. */
  add column if not exists reseller_status text not null default 'approved'
    check (reseller_status in ('pending', 'approved', 'suspended')),

  /* Basis points, matching `quotes.approved_margin_bps` — not percent as DMS had
     it. 250 = 2.5%. Integer bps rather than a decimal percent because a markup
     of 2.5% on ₹899 must land on the same rupee every time it is computed, and
     a float percent is how two screens come to disagree by ₹1.
     Capped at 100% (10000 bps): a markup above that is far more likely a typo
     (someone typing 2500 meaning 25%) than an intention, and the refusal is
     cheaper than the invoice. */
  add column if not exists markup_bps integer not null default 0
    check (markup_bps >= 0 and markup_bps <= 10000),

  /* Light white-label branding. `logo_url` already exists on this table. */
  add column if not exists display_name text,
  add column if not exists support_email text,

  /* Who let them trade, and when. A reseller that can sell in our name is a
     decision, and a decision with nobody's name on it is not one. */
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.users(id) on delete restrict;

/* Slug is a URL: unique across all tenants, and only in the shape a URL allows.
   Lowercase alphanumeric with single hyphens, not starting or ending with one. */
alter table public.tenants drop constraint if exists tenants_slug_shape;
alter table public.tenants add constraint tenants_slug_shape check (
  slug is null or (slug = lower(slug) and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 63)
);

create unique index if not exists tenants_slug_unique
  on public.tenants (slug) where slug is not null;

/* Approval, like the resolution on `domains`, is both halves or neither. */
alter table public.tenants drop constraint if exists tenants_approval_complete;
alter table public.tenants add constraint tenants_approval_complete check (
  (approved_at is null and approved_by is null) or (approved_at is not null and approved_by is not null)
);

comment on column public.tenants.reseller_status is
  'pending | approved | suspended. NOT the same as `tier`: tier is what kind of tenant this is, status is whether they may trade. See lib/resellers/economics.ts.';
comment on column public.tenants.markup_bps is
  'Basis points a sub-reseller adds over OUR price. 250 = 2.5%. Distinct from items.margin_pct and quotes.approved_margin_bps, which are product margin. Stored and arithmetic-tested; not yet applied to any price surface.';

-- ─── 2. The wallet, as a ledger ─────────────────────────────────────────────

create table if not exists public.reseller_wallet_entries (
  id        uuid primary key default gen_random_uuid(),
  /* Whose wallet. The sub-reseller's own tenant. */
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  /* ₹ WHOLE RUPEES, SIGNED (AGENTS.md §13 for the unit). Positive = money into
     the wallet, negative = spent. Signed rather than a separate direction column
     so the balance is `sum(amount)` and cannot be got wrong by reading the
     direction the wrong way round. Never 0: an entry that moves nothing is not
     an event, and allowing it invites rows written to "mark" something. */
  amount integer not null check (amount <> 0),

  /* Why it moved.
       topup       — the reseller paid us, in advance
       spend       — a registration/renewal drawn against the balance
       refund      — money returned to the wallet (a failed registration)
       adjustment  — a correction somebody made deliberately, with a note
       reversal    — undoing a specific earlier entry (see reverses_entry_id)
     `adjustment` and `reversal` are separate because they answer different
     questions in an audit: one is "we agreed to change the number", the other is
     "that entry should never have existed". */
  reason text not null check (reason in ('topup', 'spend', 'refund', 'adjustment', 'reversal')),

  /* What caused it, where there is something to point at. All nullable — a
     manual top-up points at nothing but a note. */
  payment_id  uuid references public.payments(id) on delete set null,
  domain_id   uuid references public.domains(id)  on delete set null,
  hosting_id  uuid references public.hosting_accounts(id) on delete set null,

  /* A reversal names the entry it undoes, so the pair can be read together and
     neither can be mistaken for an independent movement. */
  reverses_entry_id uuid references public.reseller_wallet_entries(id) on delete restrict,

  /* Free text, and required for the two reasons a human invents. */
  note text,

  /* Who did it. NULL for machine-written entries (a spend during provisioning);
     REQUIRED for the two a person is responsible for, enforced below. */
  created_by uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

/* An adjustment or a reversal is somebody's decision about somebody else's
   money. Both need a name and a reason on the row — without them the ledger
   still balances and nobody can say why. */
alter table public.reseller_wallet_entries drop constraint if exists rwe_manual_needs_author;
alter table public.reseller_wallet_entries add constraint rwe_manual_needs_author check (
  reason not in ('adjustment', 'reversal')
  or (created_by is not null and note is not null and length(btrim(note)) > 0)
);

/* A reversal must name what it reverses; nothing else may. */
alter table public.reseller_wallet_entries drop constraint if exists rwe_reversal_names_target;
alter table public.reseller_wallet_entries add constraint rwe_reversal_names_target check (
  (reason = 'reversal' and reverses_entry_id is not null)
  or (reason <> 'reversal' and reverses_entry_id is null)
);

/* One reversal per entry. Reversing the same entry twice would double the
   correction, and the second one always looks reasonable in isolation. */
create unique index if not exists rwe_one_reversal_per_entry
  on public.reseller_wallet_entries (reverses_entry_id)
  where reverses_entry_id is not null;

/* The balance query: every entry for one wallet. */
create index if not exists rwe_tenant on public.reseller_wallet_entries (tenant_id, created_at desc);

/* A spend drawn against a specific asset, at most once. Provisioning retries —
   `provision-domain` re-claims and re-orders a failed registration — and a
   retried spend would charge the reseller twice for one domain. */
create unique index if not exists rwe_one_spend_per_domain
  on public.reseller_wallet_entries (domain_id, reason)
  where domain_id is not null and reason = 'spend';
create unique index if not exists rwe_one_spend_per_hosting
  on public.reseller_wallet_entries (hosting_id, reason)
  where hosting_id is not null and reason = 'spend';

alter table public.reseller_wallet_entries enable row level security;

/* A reseller may READ their own ledger — it is their money and they are entitled
   to the detail, not just the total. */
drop policy if exists rwe_select on public.reseller_wallet_entries;
create policy rwe_select on public.reseller_wallet_entries
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

/* No insert, update or delete policy, and none is coming. An append-only ledger
   that the app can edit is not append-only. Entries are written server-side by
   the service role, where the reason, the author and the idempotency indexes
   above are all enforced together. */

comment on table public.reseller_wallet_entries is
  'Append-only prepaid wallet ledger for sub-resellers. The BALANCE IS THE SUM of these rows and is never stored — DMS kept a mutable walletBalance number, which is how a running total drifts from the movements that produced it. See lib/resellers/economics.ts.';

commit;
