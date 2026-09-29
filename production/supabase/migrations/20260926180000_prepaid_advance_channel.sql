-- ============================================================================
-- Marketing channel on prepaid advances, carried onto the invoices booked from them.
--
-- THE CASE (Pardeep, 26 Sep 2026): Facebook is paid in advance and sends a monthly
-- invoice for what the ads used. The top-up is a prepaid asset (20260925160000); the
-- invoice becomes the expense, through consume_prepaid_fifo / consume_prepaid_advance.
-- Those expenses were written with no `channel`, so every Facebook invoice landed on
-- Marketing → Spend as "Channel nahi chuna" and was left out of ROAS & CAC.
--
-- WHAT THIS ADDS
--   1. prepaid_advances.channel — the channel the advance pays for.
--   2. ad_channel_guess(text) — the vendor name → channel rule. Mirrors the first rules of
--      suggestAdChannel (src/lib/marketing/ad-channels.ts); change them together.
--   3. A marketing-category advance with no channel takes the guess from its vendor name,
--      on insert and on update — so book_bank_txn_as_prepaid (bank line → advance) and the
--      Prepaid page both get it without their signatures changing.
--   4. An expense inserted with a prepaid_advance_id and no channel takes the advance's
--      channel. A trigger rather than an edit to the two consume RPCs: either RPC, and any
--      future one, is covered, and neither function body is copied here to go stale.
--   5. Changing an advance's channel moves its invoices that still carried the old value
--      (or none); an invoice someone re-tagged by hand keeps its own tag.
--   6. Backfill: existing advances and the invoices booked from them.
--
-- Only marketing-category rows get a channel (same test as the report:
-- market / advert / ads). Everything else stays NULL, as migration 0232 specifies.
-- ============================================================================

alter table public.prepaid_advances add column if not exists channel text;

comment on column public.prepaid_advances.channel is
  'Marketing channel this advance pays for (meta-ads, google-ads, …). Copied onto each expense booked from it. NULL for non-marketing advances.';

-- ── 2. Vendor name → channel ────────────────────────────────────────────────
create or replace function public.ad_channel_guess(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_text ~* '\m(google|adwords|gads)\M'                    then 'google-ads'
    when p_text ~* '\m(facebook|fb|meta|instagram|insta)\M'       then 'meta-ads'
    when p_text ~* '\mlinked ?in\M'                               then 'linkedin-ads'
    when p_text ~* '\m(whatsapp|wati|interakt|aisensy|gupshup)\M' then 'whatsapp'
    when p_text ~* '\m(mailchimp|sendgrid|brevo|sendinblue)\M'    then 'email-outreach'
    else null
  end
$$;

-- ── 3. Advance: default its channel from the vendor ─────────────────────────
create or replace function public.tg_prepaid_advance_channel()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.category, '') !~* '(market|advert|ads)' then
    new.channel := null;
  elsif new.channel is null then
    new.channel := public.ad_channel_guess(new.vendor_name);
  end if;
  return new;
end $$;

drop trigger if exists trg_prepaid_advance_channel on public.prepaid_advances;
create trigger trg_prepaid_advance_channel
  before insert or update of vendor_name, category, channel on public.prepaid_advances
  for each row execute function public.tg_prepaid_advance_channel();

-- ── 4. Expense booked from an advance: take the advance's channel ───────────
create or replace function public.tg_expense_channel_from_advance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.channel is null
     and new.prepaid_advance_id is not null
     and coalesce(new.category, '') ~* '(market|advert|ads)' then
    select a.channel into new.channel
      from public.prepaid_advances a
     where a.id = new.prepaid_advance_id and a.tenant_id = new.tenant_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_expense_channel_from_advance on public.expenses;
create trigger trg_expense_channel_from_advance
  before insert on public.expenses
  for each row execute function public.tg_expense_channel_from_advance();

-- ── 5. Advance re-tagged: its invoices follow ───────────────────────────────
create or replace function public.tg_prepaid_advance_channel_sync()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.expenses e
     set channel = new.channel, updated_at = now()
   where e.prepaid_advance_id = new.id
     and e.tenant_id = new.tenant_id
     and coalesce(e.category, '') ~* '(market|advert|ads)'
     and (e.channel is null or e.channel = old.channel);
  return null;
end $$;

drop trigger if exists trg_prepaid_advance_channel_sync on public.prepaid_advances;
create trigger trg_prepaid_advance_channel_sync
  after update of channel on public.prepaid_advances
  for each row when (new.channel is distinct from old.channel)
  execute function public.tg_prepaid_advance_channel_sync();

-- ── 6. Backfill ─────────────────────────────────────────────────────────────
update public.prepaid_advances
   set channel = public.ad_channel_guess(vendor_name)
 where channel is null
   and category ~* '(market|advert|ads)'
   and public.ad_channel_guess(vendor_name) is not null;

update public.expenses e
   set channel = a.channel
  from public.prepaid_advances a
 where e.prepaid_advance_id = a.id
   and e.tenant_id = a.tenant_id
   and e.channel is null
   and a.channel is not null
   and coalesce(e.category, '') ~* '(market|advert|ads)';
