-- Regression test: marketing channel on prepaid advances and the invoices booked from them
-- (migration 20260926180000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/prepaid_advance_channel.test.sql
--
-- What it proves:
--   1. A Facebook top-up booked from a bank line gets channel meta-ads from its vendor name.
--   2. The monthly invoice booked against it (consume_prepaid_fifo, across two top-ups)
--      carries meta-ads on every slice — so it counts in Marketing → Spend and ROAS.
--   3. consume_prepaid_advance (single advance) carries it too.
--   4. A non-marketing advance gets no channel, and neither do its invoices.
--   5. A channel chosen by hand is kept, not overwritten by the guess.
--   6. Re-tagging an advance moves its invoices, but not one re-tagged by hand.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000c7', 'CHANNEL TEST', 'ch-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000c0c7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ch-a-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000c0c7', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'ch-a-user@example.in', 'owner');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('aaaaaaaa-0000-0000-0000-0000000bc007', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'Test HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('aaaaaaaa-0000-0000-0000-0000000bc701', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'aaaaaaaa-0000-0000-0000-0000000bc007', '2026-08-01', 'X/PAYUFACEBOOK', 5000, 0, 'manual'),
  ('aaaaaaaa-0000-0000-0000-0000000bc702', 'aaaaaaaa-0000-0000-0000-0000000000c7', 'aaaaaaaa-0000-0000-0000-0000000bc007', '2026-08-15', 'Y/PAYUFACEBOOK', 5000, 0, 'manual');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000c0c7', 'role', 'authenticated')::text, true);

-- 1. Top-ups from the bank line take meta-ads from the vendor name
do $$
declare v_a uuid; v_b uuid; v_ch text;
begin
  v_a := public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000bc701', 'Facebook India', 'Advertising');
  v_b := public.book_bank_txn_as_prepaid('aaaaaaaa-0000-0000-0000-0000000bc702', 'Facebook India', 'Advertising');
  select channel into v_ch from public.prepaid_advances where id = v_a;
  if v_ch is distinct from 'meta-ads' then raise exception 'FAIL 1: advance channel %', v_ch; end if;
end $$;

-- 2. The month-end invoice, spanning both top-ups, is tagged on every slice
do $$
declare v_n int; v_tagged int;
begin
  perform public.consume_prepaid_fifo('Facebook India', 7080, 1080, '2026-08-31', 'Aug invoice');
  select count(*), count(*) filter (where channel = 'meta-ads') into v_n, v_tagged
    from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000c7' and notes = 'Aug invoice';
  if v_n <> 2 or v_tagged <> 2 then raise exception 'FAIL 2: % slices, % tagged', v_n, v_tagged; end if;
end $$;

-- 3. Single-advance consume carries it too
do $$
declare v_adv uuid; v_ch text;
begin
  select id into v_adv from public.prepaid_advances
   where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000c7' and total_amount > consumed_amount limit 1;
  perform public.consume_prepaid_advance(v_adv, 500, '2026-09-05', 'Sep bit');
  select channel into v_ch from public.expenses where notes = 'Sep bit';
  if v_ch is distinct from 'meta-ads' then raise exception 'FAIL 3: %', v_ch; end if;
end $$;

-- 4. A non-marketing advance: no channel, on it or its invoice
do $$
declare v_adv uuid; v_a text; v_e text;
begin
  insert into public.prepaid_advances (tenant_id, vendor_name, category, total_amount, paid_date)
  values ('aaaaaaaa-0000-0000-0000-0000000000c7', 'Google Cloud', 'Hosting', 3000, '2026-08-01')
  returning id, channel into v_adv, v_a;
  if v_a is not null then raise exception 'FAIL 4a: hosting advance got %', v_a; end if;
  perform public.consume_prepaid_advance(v_adv, 1000, '2026-08-31', 'GCP Aug');
  select channel into v_e from public.expenses where notes = 'GCP Aug';
  if v_e is not null then raise exception 'FAIL 4b: hosting invoice got %', v_e; end if;
end $$;

-- 5. A hand-picked channel is kept
do $$
declare v_ch text;
begin
  insert into public.prepaid_advances (tenant_id, vendor_name, category, channel, total_amount, paid_date)
  values ('aaaaaaaa-0000-0000-0000-0000000000c7', 'Facebook India', 'Marketing', 'whatsapp', 1000, '2026-09-01')
  returning channel into v_ch;
  if v_ch is distinct from 'whatsapp' then raise exception 'FAIL 5: %', v_ch; end if;
end $$;

-- 6. Re-tag an advance: its invoices follow, except one re-tagged by hand
do $$
declare v_adv uuid; v_moved int; v_kept text;
begin
  select prepaid_advance_id into v_adv from public.expenses where notes = 'Aug invoice' order by amount desc limit 1;
  update public.expenses set channel = 'google-ads'
   where id = (select id from public.expenses where notes = 'Aug invoice' and prepaid_advance_id = v_adv limit 1);
  -- give the same advance a second, untouched invoice
  update public.prepaid_advances set total_amount = total_amount + 1000 where id = v_adv;
  perform public.consume_prepaid_advance(v_adv, 1000, '2026-09-10', 'Sep follow');

  update public.prepaid_advances set channel = 'linkedin-ads' where id = v_adv;

  select count(*) into v_moved from public.expenses where notes = 'Sep follow' and channel = 'linkedin-ads';
  select channel into v_kept from public.expenses where notes = 'Aug invoice' and prepaid_advance_id = v_adv;
  if v_moved <> 1 then raise exception 'FAIL 6a: untouched invoice did not follow'; end if;
  if v_kept is distinct from 'google-ads' then raise exception 'FAIL 6b: hand tag overwritten → %', v_kept; end if;
end $$;

select 'prepaid_advance_channel: all assertions passed' as result;
rollback;
