-- Regression test: a refund SUSPENDS hosting and never deletes it.
--   migration 20260911130000 · Pardeep's decision, 11 Sep 2026:
--   "Suspend the hosting but don't delete it. Admin will decide to delete it."
--
-- Kya saabit hota hai (self-asserting, sab rollback):
--   1. Poora refund + ACTIVE hosting → 'suspended', suspended_at, auto_renew
--      false, aur next_action_at set (taaki worker DirectAdmin ko bataye).
--   2. activity_log me domain ka naam ke saath ek row — warna admin ko kabhi
--      pata nahi chalega ki site kis wajah se band hui.
--   3. ADHOORA refund → site CHALU rehti hai. Ye sabse zaroori pehra hai.
--   4. 'terminated' ko kabhi chhua nahi jata. Ye policy hai, na ki ittefaq.
--   5. 'pending' ko chhoda jata hai — wo kabhi provision hua hi nahi.
--   6. Doosre tenant ka wahi quote-id wala hosting nahi chhua jata.
--
-- SAFETY: sab kuch is transaction ke andar, rollback par khatam. Fixture id
-- reserved namespace (7e57e57e-…) me hain — dekho lib/testing/sql-fixture-namespace.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('7e57e57e-8001-4000-8000-000000000001'::uuid, 'HOST REFUND CO', 'hostref@example.in', '07'),
         /* Case 6: ek doosra tenant. Iska hosting neeche JAAN-BOOJH KAR tenant-1
            ke quote-id par baithaya gaya hai — dekho neeche ki tippani. */
         ('7e57e57e-8002-4000-8000-000000000002'::uuid, 'OTHER CO', 'other@example.in', '07');

insert into public.customers (id, tenant_id, name, contact_email)
  values ('7e57e57e-8003-4000-8000-000000000003'::uuid, '7e57e57e-8001-4000-8000-000000000001'::uuid, 'Host Cust', 'h@c.in'),
         ('7e57e57e-8004-4000-8000-000000000004'::uuid, '7e57e57e-8002-4000-8000-000000000002'::uuid, 'Other Cust', 'o@c.in');

insert into public.quotes (id, tenant_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items)
  values
  ('Q-HOST-FULL', '7e57e57e-8001-4000-8000-000000000001'::uuid, 'Host Cust', 10000, 8475, 18, 'sent', 'awaiting', '[]'::jsonb),
  ('Q-HOST-PART', '7e57e57e-8001-4000-8000-000000000001'::uuid, 'Host Cust', 10000, 8475, 18, 'sent', 'awaiting', '[]'::jsonb),
  ('Q-HOST-DEAD', '7e57e57e-8001-4000-8000-000000000001'::uuid, 'Host Cust', 10000, 8475, 18, 'sent', 'awaiting', '[]'::jsonb);
/* Case 6 me doosre tenant ka koi QUOTE nahi hai — `quotes.id` global primary key
   hai, to ek id do tenant me ho hi nahi sakti. Par `hosting_accounts.quote_id`
   par koi foreign key NAHI hai (naapa: sirf customer_id, subscription_id,
   provisioning_request_id, resolved_by, tenant_id par hai) — wo aazad text hai.
   Yaani ek hosting row doosre tenant ke quote-id ko pakad sakti hai, aur us
   soorat me update ka tenant-scope hi ekmatra pehra hai. Neeche wahi banaya
   gaya hai, aur ye asli test isi ka hai. */

insert into public.hosting_accounts (tenant_id, customer_id, domain_name, quote_id, status, auto_renew, da_username)
  values
  -- 1: the case this exists for
  ('7e57e57e-8001-4000-8000-000000000001'::uuid, '7e57e57e-8003-4000-8000-000000000003'::uuid,
   'live-site.in', 'Q-HOST-FULL', 'active', true, 'livesite'),
  -- 5: pending on the same quote — must be left exactly as it is
  ('7e57e57e-8001-4000-8000-000000000001'::uuid, '7e57e57e-8003-4000-8000-000000000003'::uuid,
   'never-built.in', 'Q-HOST-FULL', 'pending', true, null),
  -- 3: partial-refund quote, still live
  ('7e57e57e-8001-4000-8000-000000000001'::uuid, '7e57e57e-8003-4000-8000-000000000003'::uuid,
   'part-paid.in', 'Q-HOST-PART', 'active', true, 'partpaid'),
  -- 4: already gone. The policy line.
  ('7e57e57e-8001-4000-8000-000000000001'::uuid, '7e57e57e-8003-4000-8000-000000000003'::uuid,
   'long-gone.in', 'Q-HOST-DEAD', 'terminated', false, 'longgone'),
  -- 6: another tenant's live site, carrying tenant 1's quote id on purpose
  ('7e57e57e-8002-4000-8000-000000000002'::uuid, '7e57e57e-8004-4000-8000-000000000004'::uuid,
   'someone-else.in', 'Q-HOST-FULL', 'active', true, 'elsesite');

do $$
declare
  rp   jsonb;
  rr   jsonb;
  v    record;
  n    integer;
begin
  -- ══ 1 + 2. Full refund on a quote with a live hosting account ═════════════
  rp := public.record_payment('Q-HOST-FULL', 10000, 'bank_transfer', 'hostref-1', null);
  rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, 'Customer ne hosting cancel ki');

  select status, suspended_at, auto_renew, next_action_at into v
    from public.hosting_accounts
   where tenant_id = '7e57e57e-8001-4000-8000-000000000001'::uuid and domain_name = 'live-site.in';

  if v.status <> 'suspended' then
    raise exception 'FAIL 1a: live-site.in status is % — a fully refunded account must be suspended', v.status;
  end if;
  if v.suspended_at is null then
    raise exception 'FAIL 1b: suspended_at not stamped — nothing records WHEN the site went off';
  end if;
  if v.auto_renew <> false then
    raise exception 'FAIL 1c: auto_renew still true — a refunded service would be quoted for renewal tomorrow';
  end if;
  /* The one that separates "the books say suspended" from "the site is off".
     Without this the customer's website keeps serving and nobody is looking. */
  if v.next_action_at is null then
    raise exception 'FAIL 1d: next_action_at not stamped — /api/cron/hosting-suspend will never tell DirectAdmin, so the site stays UP';
  end if;

  /* The return value must NAME the domain. A bare count does not let the
     operator tell the customer which site just went off. */
  if not (rr->'hosting_suspended' ? 'live-site.in') then
    raise exception 'FAIL 1e: return did not name the suspended domain: %', rr->'hosting_suspended';
  end if;

  -- 2. The admin has to be able to find out why, months later.
  select count(*) into n from public.activity_log
   where tenant_id = '7e57e57e-8001-4000-8000-000000000001'::uuid
     and action = 'hosting.suspended_on_refund'
     and label like '%live-site.in%';
  if n <> 1 then
    raise exception 'FAIL 2: expected 1 activity_log row naming live-site.in, found %', n;
  end if;

  -- ══ 5. `pending` on the SAME quote is untouched ═══════════════════════════
  /* It was never provisioned. Marking it suspended would tell the customer a
     service was withdrawn that was never delivered — and the
     paid-but-undelivered screens select on `pending`, so it would vanish. */
  select status into v from public.hosting_accounts
   where tenant_id = '7e57e57e-8001-4000-8000-000000000001'::uuid and domain_name = 'never-built.in';
  if v.status <> 'pending' then
    raise exception 'FAIL 5: never-built.in became % — a pending account has nothing to suspend', v.status;
  end if;

  -- ══ 6. The other tenant's identically-quoted site is untouched ════════════
  select status into v from public.hosting_accounts
   where tenant_id = '7e57e57e-8002-4000-8000-000000000002'::uuid and domain_name = 'someone-else.in';
  if v.status <> 'active' then
    raise exception 'FAIL 6: another tenant''s hosting became % — the update is not tenant-scoped', v.status;
  end if;

  -- ══ 3. A PARTIAL refund must not take a website down ═════════════════════
  /* Two payments, one refunded: money is still on the quote, so this is a price
     adjustment and not a cancellation. */
  rp := public.record_payment('Q-HOST-PART', 4000, 'bank_transfer', 'hostref-2', null);
  perform public.record_payment('Q-HOST-PART', 6000, 'bank_transfer', 'hostref-3', null);
  rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, 'Extra charge wapas kiya');

  select status, auto_renew into v from public.hosting_accounts
   where tenant_id = '7e57e57e-8001-4000-8000-000000000001'::uuid and domain_name = 'part-paid.in';
  if v.status <> 'active' then
    raise exception 'FAIL 3a: part-paid.in became % after a PARTIAL refund — ₹6,000 is still paid and the site must stay up', v.status;
  end if;
  if v.auto_renew <> true then
    raise exception 'FAIL 3b: auto_renew was switched off by a partial refund';
  end if;
  if jsonb_array_length(coalesce(rr->'hosting_suspended', '[]'::jsonb)) <> 0 then
    raise exception 'FAIL 3c: a partial refund reported suspending %', rr->'hosting_suspended';
  end if;

  -- ══ 4. `terminated` is never rewritten. This is the policy. ══════════════
  rp := public.record_payment('Q-HOST-DEAD', 10000, 'bank_transfer', 'hostref-4', null);
  rr := public.refund_payment(nullif(rp->>'payment_id','')::uuid, 'Purana account ka refund');

  select status into v from public.hosting_accounts
   where tenant_id = '7e57e57e-8001-4000-8000-000000000001'::uuid and domain_name = 'long-gone.in';
  if v.status <> 'terminated' then
    raise exception 'FAIL 4: long-gone.in went from terminated to % — a terminated account is gone, nothing to do', v.status;
  end if;

  -- ══ THE LINE NOTHING MAY CROSS ═══════════════════════════════════════════
  /* Not a paraphrase of the checks above: this asks the whole table. If any
     future edit to refund_payment ever writes 'terminated', this fails no
     matter which quote or status it came from. Deleting is an admin decision;
     this function must never make it. */
  select count(*) into n from public.hosting_accounts
   where tenant_id = '7e57e57e-8001-4000-8000-000000000001'::uuid
     and status = 'terminated'
     and domain_name <> 'long-gone.in';
  if n <> 0 then
    raise exception 'FAIL POLICY: refund_payment terminated % hosting account(s). It must only ever SUSPEND.', n;
  end if;
end $$;

rollback;
