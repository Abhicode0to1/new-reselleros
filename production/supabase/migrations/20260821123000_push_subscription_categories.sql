-- ============================================================================
-- 20260821123000 — Push categories: work alerts and offers are not one permission
-- ============================================================================
--
-- ─── WHY THIS IS A SEPARATE COLUMN AND NOT A SEPARATE THOUGHT ───────────────
-- A browser grants ONE notification permission per site. It has no idea that an
-- attendance reminder and a promotional offer are different things, so a person annoyed
-- by an offer does not turn off offers — they turn off notifications, and the payment
-- alert and the attendance reminder die with them. Chrome also demotes sites whose
-- notifications get dismissed or blocked, so the damage outlives the one offer.
--
-- The fix has to live in the data, not in good intentions: each device records which
-- categories it agreed to, and the send path filters on it. Asked and decided before the
-- first notification was ever sent, which is the only cheap time to decide it.
--
-- `offers` is deliberately NOT in the default. A default-on marketing channel is
-- consent by omission, and the person who notices is the person who leaves.
--
-- ─── WHY THE ARRAY CANNOT BE EMPTY ──────────────────────────────────────────
-- An empty array is a subscribed device that receives nothing: it looks enabled in the
-- UI, costs a row, and is silent. If somebody wants nothing, the subscription is
-- deleted — that is a state you can see. `cardinality > 0` makes the invisible version
-- impossible.
--
-- Applied as a follow-up rather than by editing 20260821120000, which is already in the
-- ledger. Editing an applied migration is the git-vs-prod drift this repo has been
-- burned by before (0003 consolidated 19 ad-hoc prod changes).

begin;

alter table public.push_subscriptions
  add column if not exists categories text[] not null default array['operational']::text[];

alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_categories_known;

alter table public.push_subscriptions
  add constraint push_subscriptions_categories_known
  check (
    categories <@ array['operational', 'offers']::text[]
    and cardinality(categories) > 0
  );

comment on column public.push_subscriptions.categories is
  'Which kinds of push this device consented to. operational = attendance, payments, quotes, leads. offers = promotional. One browser permission covers both, so a device that never opted into offers must never receive one — otherwise the person revokes everything and the operational alerts go too. Never empty: no-consent means delete the row.';

commit;
