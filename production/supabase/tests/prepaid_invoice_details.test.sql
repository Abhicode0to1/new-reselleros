-- Regression test: vendor invoice from advances carries vendor, heads, bill no, TDS (migration 20260927210000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/prepaid_invoice_details.test.sql
--
-- What it proves:
--   1. An IGST invoice across two top-ups: heads pro rata and summing exactly; TDS and
--      bill no on the last slice; vendor_id on every slice; the advances learn the vendor.
--   2. Heads that do not add up to the GST are refused.
--   3. Without heads the GST is split CGST/SGST (the old assumption, now written down).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000e7', 'PREPAID A', 'pp-a@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000e7a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pp-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000e7a1', 'aaaaaaaa-0000-0000-0000-0000000000e7', 'pp-owner@example.in', 'owner');
insert into public.vendors (id, tenant_id, name, gstin) values
  ('aaaaaaaa-0000-0000-0000-00000000e7f1', 'aaaaaaaa-0000-0000-0000-0000000000e7', 'Facebook', '06AABCF1234A1Z5');
insert into public.prepaid_advances (id, tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date) values
  ('aaaaaaaa-0000-0000-0000-00000000e7d1', 'aaaaaaaa-0000-0000-0000-0000000000e7', 'Facebook', 'Advertising', 6000, 0, '2026-07-01'),
  ('aaaaaaaa-0000-0000-0000-00000000e7d2', 'aaaaaaaa-0000-0000-0000-0000000000e7', 'Facebook', 'Advertising', 6000, 0, '2026-08-01');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000e7a1', 'role', 'authenticated')::text, true);

do $$
declare r record; n int; s_igst int; s_gst int; s_tds int; s_amt int;
begin
  -- 1: ₹11,800 invoice (10,000 + 1,800 IGST), TDS 194C 2% = 200, spans 6,000 + 5,800
  perform public.consume_prepaid_fifo('Facebook', 11800, 1800, '2026-08-31', 'Aug bill', null,
                                      'aaaaaaaa-0000-0000-0000-00000000e7f1', 'FB-AUG-26', 1800, 0, 0, '194C', 200);
  select count(*), sum(igst), sum(gst_paid), sum(tds_amount), sum(amount) into n, s_igst, s_gst, s_tds, s_amt
    from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e7' and payment_method = 'advance';
  if n <> 2 then raise exception 'FAIL 1a: expected 2 slices, got %', n; end if;
  if s_amt <> 11800 or s_gst <> 1800 or s_igst <> 1800 then raise exception 'FAIL 1b: amounts/heads do not add up (% / % / %)', s_amt, s_gst, s_igst; end if;
  if s_tds <> 200 then raise exception 'FAIL 1c: TDS not 200 (%)', s_tds; end if;
  select count(*) into n from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e7' and payment_method = 'advance' and tds_amount > 0;
  if n <> 1 then raise exception 'FAIL 1d: TDS should sit on one slice only'; end if;
  select * into r from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e7' and payment_method = 'advance' and tds_amount > 0;
  if r.tds_section <> '194C' or r.bill_no <> 'FB-AUG-26' or r.cgst <> 0 then raise exception 'FAIL 1e: last slice fields wrong'; end if;
  select count(*) into n from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e7' and payment_method = 'advance' and vendor_id = 'aaaaaaaa-0000-0000-0000-00000000e7f1';
  if n <> 2 then raise exception 'FAIL 1f: vendor_id missing on a slice'; end if;
  select count(*) into n from public.prepaid_advances where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e7' and vendor_id = 'aaaaaaaa-0000-0000-0000-00000000e7f1';
  if n <> 2 then raise exception 'FAIL 1g: advances did not learn their vendor'; end if;

  -- 2
  begin
    perform public.consume_prepaid_fifo('Facebook', 118, 18, '2026-09-01', null, null, null, null, 9, 9, 9, null, 0);
    raise exception 'FAIL 2: heads that do not add up were accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- 3
  perform public.consume_prepaid_fifo('Facebook', 118, 18, '2026-09-01');
  select * into r from public.expenses where tenant_id = 'aaaaaaaa-0000-0000-0000-0000000000e7' and amount = 118;
  if r.igst <> 0 or r.cgst <> 9 or r.sgst <> 9 then raise exception 'FAIL 3: default split not CGST/SGST (% / % / %)', r.igst, r.cgst, r.sgst; end if;
end $$;

select 'prepaid_invoice_details: all assertions passed' as result;
rollback;
