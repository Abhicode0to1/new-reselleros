-- ═══════════════════════════════════════════════════════════════════════════
-- AI Telecalling — what the voice agent was asked to do, and what it said
--
-- FILE NAME. The brief asked for `0252_ai_telecalling.sql`. Every migration in this
-- directory is `YYYYMMDDHHMMSS_name.sql` and `supabase migration list --linked` orders and
-- tracks by that version string, so a `0252` file would sort BEFORE every 2026 migration and
-- `migration repair` would have to be handed a version that does not describe when it ran.
-- The number was the intent; the ordering is the requirement.
--
-- ─── WHAT THIS IS FOR ───────────────────────────────────────────────────────
-- The app can now write to a customer (email, WhatsApp) and answer them. It cannot RING
-- them. Two jobs want that and neither has anywhere to record itself today:
--
--   1. Qualifying a lead — how many seats, which product, when do they decide. That is
--      three questions a person answers in ninety seconds on the phone and ignores in an
--      email for a week.
--   2. Reminding a customer that a subscription renews. `api/cron/renewals` already mails
--      them; the ones who let mail rot are exactly the ones who lapse.
--
-- ─── WHY A CALL LOG IS NOT lead_activities, AND NOT ai_sales_conversations ──
-- Checked before writing, because a third overlapping log is worse than none.
--   · lead_activities is the TIMELINE A PERSON READS — one line per notable event. A 400-line
--     call transcript there drowns the thing the operator actually looks at.
--   · ai_sales_conversations is a TEXT thread: one row per message, ordered, replayed into
--     the next prompt. A call is not a sequence of rows — it is one event with a duration, a
--     phone number, an outcome and a cost. Forcing it into a message table would mean
--     `channel = 'voice'` rows with no sender and a `content` holding an entire conversation,
--     and every existing transcript query would then have to exclude them.
-- So: one row per CALL here, and a one-line note on lead_activities pointing at it.
--
-- ─── THE COLUMN THE BRIEF DID NOT ASK FOR, AND WHY IT IS THE IMPORTANT ONE ──
-- `provider_call_id`, UNIQUE per tenant. Retell and Vapi both retry a post-call webhook when
-- our response is slow or non-2xx. Without a claim, one retried call becomes two rows, two
-- summaries, and — because the webhook can trigger a quote — TWO QUOTES for one conversation.
-- `inbound_emails` learned this with message ids; the fix is the same and belongs in the
-- schema, not in an if-statement someone can forget. See also `ai_sales_loops`'s
-- one-pending-per-lead index: same class of defect, same class of guard.
--
-- ─── NOTHING DIALS BECAUSE THIS RAN ─────────────────────────────────────────
-- The table starts empty and the new autonomy action `telecall.place` declares itself
-- `hold` in lib/ai/autonomy.ts. At `hold` the app builds the whole call — number, script
-- context, dynamic variables — writes it here with status `held`, and dials nothing. Adding
-- the capability must not be the same event as switching it on: same discipline as
-- ai_autonomy, ai_sales_agent and ai_support_agent before it.
--
-- A VOICE call deserves that posture more than any send so far. An email with a wrong price
-- can be followed by a correction the customer reads next to the original. A sentence spoken
-- down a phone line cannot be edited, cannot be retracted, and is what the customer will
-- quote back. It is also the first thing this app would do that rings a stranger's phone,
-- where India's unsolicited-commercial-call rules apply to us and not to our vendor.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. The key the composite FK needs ──────────────────────────────────────
-- `leads` already got this from 20260824120000_ai_sales_agent.sql. `subscriptions` has only
-- PRIMARY KEY (id) — measured, not assumed. Additive and cannot fail on existing data: id is
-- already unique alone, so any pair containing it is unique too.
alter table public.subscriptions
  drop constraint if exists subscriptions_tenant_id_key;
alter table public.subscriptions
  add constraint subscriptions_tenant_id_key unique (tenant_id, id);

-- ── 2. The call log ────────────────────────────────────────────────────────
create table if not exists public.ai_telecall_logs (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,

  -- TEXT, matching leads.id — the ids here are human-readable ('L-0007'), not uuids. A uuid
  -- column would have been unlinkable, which is how ai_sales_conversations phrased it too.
  -- Nullable: a renewal call is about a SUBSCRIPTION and may have no lead at all.
  lead_id           text,
  subscription_id   uuid,

  call_type         text        not null
                    check (call_type in ('lead_qualification', 'renewal_reminder')),

  -- E.164, normalised before insert (lib/ai/telecall.ts → normaliseIndianPhone). Stored as
  -- the app dialled it rather than as the lead recorded it: "98765 43210" and "+919876543210"
  -- are the same customer, and a log that keeps the typed form cannot answer "did we already
  -- ring this number today".
  phone_number      text        not null check (phone_number ~ '^\+[1-9][0-9]{7,14}$'),

  -- The lifecycle, and `held` is the one that carries the design.
  --   held      — the dial said do not dial. The row IS the artifact: an operator reads the
  --               context and rings by hand, or moves the dial. See the header.
  --   queued    — accepted by the provider, not yet connected.
  --   completed / no_answer / busy / failed — as reported by the post-call webhook.
  --   refused   — we declined before the provider was ever asked (no number, outside calling
  --               hours, already rung today). Distinct from `failed`: nothing broke.
  status            text        not null default 'held'
                    check (status in ('held', 'queued', 'completed', 'no_answer',
                                      'busy', 'failed', 'refused')),

  duration_sec      integer     check (duration_sec is null or duration_sec >= 0),
  transcript        text,
  summary           text,

  -- What the call led to, in the app's vocabulary — not the model's prose. `summary` is for a
  -- person; this is what a query filters on.
  action_taken      text        not null default 'none'
                    check (action_taken in ('none', 'quote_requested', 'callback_requested',
                                            'renewal_confirmed', 'not_interested',
                                            'handed_to_human')),

  -- The model's read of the customer's tone. Free text on purpose: pinning a vocabulary here
  -- would make it a schema change every time a provider renames a label, and nothing branches
  -- on this — it is read by people.
  sentiment         text,

  provider          text        not null default 'retell'
                    check (provider in ('retell', 'vapi', 'none')),

  -- See the header. UNIQUE per tenant, so a provider retry updates one row instead of
  -- creating a second. Nullable because a `held` or `refused` row never reached a provider
  -- and has no id to claim — and Postgres lets NULLs repeat under a unique index, which is
  -- exactly the behaviour wanted here.
  provider_call_id  text,

  -- Everything the call was told: customer_name, subscription_expiry_date, pending_amount,
  -- and the catalogue lines the agent was allowed to quote. Kept because at `hold` this is
  -- what the operator reads, and after a bad call it is the only record of what the agent was
  -- WORKING FROM as opposed to what it then said.
  call_plan         jsonb       not null default '{}'::jsonb,

  -- Why the dial let this through, or did not — resolveAutonomy's own sentence, stored beside
  -- the row it decided. A refusal with no reason is indistinguishable from an outage.
  autonomy_mode     text        check (autonomy_mode is null
                                       or autonomy_mode in ('off', 'hold', 'auto')),
  refusal_reason    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- ── Tenant-safe links (CLAUDE.md §4) ────────────────────────────────────
  -- A plain `lead_id references leads(id)` would happily let tenant A's call point at tenant
  -- B's lead, and RLS would not catch it because the row's own tenant_id looks right.
  --
  -- `SET NULL (lead_id)` — THE COLUMN LIST IS NOT OPTIONAL. On a COMPOSITE foreign key
  -- Postgres sets EVERY referencing column, so a bare `on delete set null` would try to null
  -- `tenant_id` too, which is NOT NULL. It does not fail now; it fails the first time someone
  -- deletes a lead that was called, and it fails as the DELETE being refused. Requires PG 15+
  -- — this database is 17.6.
  --
  -- SET NULL and not CASCADE, on both: a record of a phone call placed to a real person is
  -- not deletable bookkeeping. `phone_number` stays on the row, so the call remains
  -- answerable after the lead or the subscription is gone.
  constraint ai_telecall_logs_lead_fk
    foreign key (tenant_id, lead_id)
    references public.leads (tenant_id, id)
    on delete set null (lead_id),

  constraint ai_telecall_logs_subscription_fk
    foreign key (tenant_id, subscription_id)
    references public.subscriptions (tenant_id, id)
    on delete set null (subscription_id),

  -- A call is about a lead or about a subscription. Both empty is a row nobody can act on;
  -- the app would rather refuse to write it than file an orphan.
  constraint ai_telecall_logs_has_subject
    check (lead_id is not null or subscription_id is not null)
);

comment on table public.ai_telecall_logs is
  'One row per outbound AI voice call: who was rung, what was said, and what it led to. '
  'Written by api/v1/telecalling/make-call (the attempt) and updated by '
  'api/v1/telecalling/webhook (the outcome). Rows with status=held were never dialled — the '
  'autonomy dial telecall.place was not on auto, and the row is the operator''s to act on.';

comment on column public.ai_telecall_logs.provider_call_id is
  'The provider''s own call id, UNIQUE per tenant so a retried post-call webhook updates one '
  'row instead of writing a second — and, because the webhook can trigger a quote, so one '
  'conversation cannot produce two quotes.';

comment on column public.ai_telecall_logs.call_plan is
  'What the agent was working FROM: dynamic variables and the catalogue lines it was allowed '
  'to quote. Distinct from the transcript, which is what it then said.';

-- One row per provider call, per tenant. The claim described in the header.
create unique index if not exists ai_telecall_logs_provider_call_idx
  on public.ai_telecall_logs (tenant_id, provider_call_id)
  where provider_call_id is not null;

-- "What is waiting on me" — the queue a held row joins. Partial, because completed calls are
-- history and the operator's list must not walk them.
create index if not exists ai_telecall_logs_held_idx
  on public.ai_telecall_logs (tenant_id, created_at desc)
  where status = 'held';

-- The lead / subscription timeline reads: this subject's calls, newest first.
create index if not exists ai_telecall_logs_lead_idx
  on public.ai_telecall_logs (tenant_id, lead_id, created_at desc);

create index if not exists ai_telecall_logs_subscription_idx
  on public.ai_telecall_logs (tenant_id, subscription_id, created_at desc);

-- The don't-ring-them-twice query: this number, recently. Without it the guard in
-- lib/ai/telecall.ts would be a sequential scan on every call attempt.
create index if not exists ai_telecall_logs_number_recent_idx
  on public.ai_telecall_logs (tenant_id, phone_number, created_at desc);

-- ── 3. RLS — every table, no exceptions (CLAUDE.md §4) ─────────────────────
alter table public.ai_telecall_logs enable row level security;

-- Read: anyone in the tenant. The sales user working the lead is exactly who needs to know
-- what was already said on the phone; a transcript only the owner can read is one nobody reads.
drop policy if exists ai_telecall_logs_select on public.ai_telecall_logs;
create policy ai_telecall_logs_select on public.ai_telecall_logs
  for select using (tenant_id = public.current_tenant_id());

-- Writes are service-role only. Every row is written by an API route or a cron, none of which
-- is a logged-in user — and an invented transcript row would become a record of something the
-- company never said to a customer.
drop policy if exists ai_telecall_logs_service on public.ai_telecall_logs;
create policy ai_telecall_logs_service on public.ai_telecall_logs
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── 4. updated_at ──────────────────────────────────────────────────────────
-- The webhook updates a queued row in place; without this, `updated_at` would report the
-- moment the call was PLACED as the moment it finished.
create or replace function public.ai_telecall_logs_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ai_telecall_logs_touch_trg on public.ai_telecall_logs;
create trigger ai_telecall_logs_touch_trg
  before update on public.ai_telecall_logs
  for each row execute function public.ai_telecall_logs_touch();

commit;
