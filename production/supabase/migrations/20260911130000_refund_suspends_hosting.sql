-- Refunding hosting money now SUSPENDS the hosting. It never deletes it.
--
-- ─── THE DECISION, AND WHOSE IT WAS ─────────────────────────────────────────
-- Asked on 11 Sep 2026 whether a refund should shut the hosting down. Pardeep:
-- "Suspend the hosting but don't delete it. Admin will decide to delete it."
--
-- That is the whole policy, and it is the right way round. Suspending is
-- reversible — `daUnsuspendAccount` exists and the customer's files, databases
-- and mailboxes are all still there, so a refund raised in error costs nothing
-- but a click to undo. Deleting is not reversible by anything in this system or
-- at DirectAdmin, so it stays a decision a person makes on purpose.
--
-- `terminated` is a valid value of `hosting_accounts.status` and NOTHING in this
-- function will ever write it. If you are reading this while adding an automatic
-- termination, that is the line you are crossing.
--
-- ─── ONLY WHEN THE MONEY IS ACTUALLY GONE ───────────────────────────────────
-- The trigger is `v_remaining <= 0` — no `received` payment left on the quote —
-- and not merely "a refund happened". A ₹500 refund against a ₹5,000 hosting
-- payment is a price adjustment, and taking a live website down over it would be
-- the function inventing a consequence nobody asked for. The site stays up until
-- the last rupee has gone back.
--
-- ─── ONLY FROM `active`, AND THE OTHER STATES ARE NOT AN OVERSIGHT ──────────
--   active      → suspended. The case this exists for.
--   pending     → left alone. Never provisioned, so there is nothing to suspend,
--                 and marking it suspended would tell the customer a service was
--                 withdrawn when it was never delivered — the paid-but-undelivered
--                 screens exist for exactly that row and would lose it.
--   suspended   → left alone. Makes a webhook redelivery or a second refund
--                 attempt harmless, and keeps the original `suspended_at`.
--   expired     → left alone. Already off; re-stamping it loses when it lapsed.
--   terminated  → left alone. Gone. Nothing to do and nothing to say.
--   failed      → left alone. Provisioning never succeeded.
--
-- ─── WHY IT ALSO STAMPS `next_action_at` ────────────────────────────────────
-- This function can only change OUR RECORD. The customer's website is still being
-- served by DirectAdmin, and taking it offline is a network call that cannot
-- happen inside a database transaction. So the row is marked and dated, and
-- `/api/cron/hosting-suspend` performs the actual suspension and clears the date.
-- Setting the status without that worker would be the worst of the three possible
-- outcomes: the books would say suspended, the site would stay up, and nobody
-- would be looking.
--
-- `auto_renew` goes to false in the same breath. Money has just gone back; a
-- renewal quote for the same service the next morning would be absurd.
--
-- ─── AND IT SAYS SO OUT LOUD ────────────────────────────────────────────────
-- `hosting_accounts` is not one of the thirteen tables carrying the generic
-- `log_row_change` audit trigger, so this suspension would otherwise leave no
-- trace anywhere a person looks. The explicit `activity_log` row is what makes
-- "why is this customer's site off?" answerable six months from now — and it is
-- what the admin reads before deciding whether to delete.

create or replace function public.refund_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_pay        record;
  v_quote      record;
  v_remaining  integer;
  v_expected   integer;
  v_new_status public.payment_status;
  v_rfv        text;
  v_bank_cnt   integer;
  v_credits    integer := 0;
  v_actor      uuid;
  v_hosts      text[] := '{}';
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if v_tenant is not null and v_pay.tenant_id is distinct from v_tenant then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_pay.status = 'refunded' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = 'invalid_parameter_value';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, customer_id, customer_name
    into v_quote from public.quotes where id = v_pay.quote_id;

  if v_quote.invoice_id is not null then
    raise exception 'Is quote par GST invoice jaari hai — pehle us invoice ka CREDIT NOTE banaiye (invoice ke page se), phir refund book kariye. Tax-invoice ke against seedha refund GSTR ka milaan tod deta hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  if v_bank_cnt > 0 then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then refund.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'Ye add-seats ki payment hai — pehle subscription par seats ghataiye, phir refund; warna seats mile hue aur paisa wapas dono ho jate.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_rfv := public.next_document_number('refund_voucher', v_pay.tenant_id);

  update public.payments
     set status = 'refunded',
         refunded_at = now(),
         refund_reason = trim(p_reason),
         refund_voucher_no = v_rfv
   where id = p_payment_id;

  /* Isi payment ki tairti overpayment-credit band — paisa wapas ja raha hai,
     credit ke roop me dobara kharch nahi ho sakta. */
  update public.customer_credits
     set status = 'refunded'
   where source_payment_id = p_payment_id and status = 'open';
  get diagnostics v_credits = row_count;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);
  v_new_status := case
    when v_remaining <= 0          then 'none'
    when v_remaining >= v_expected then 'received'
    else                                'partial' end::public.payment_status;

  update public.quotes
     set payment_status = v_new_status,
         payment_amount = v_remaining
   where id = v_pay.quote_id;

  update public.subscriptions
     set outstanding_amount = greatest(0, v_expected - v_remaining)
   where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;

  /* ─── HOSTING: SUSPEND, NEVER DELETE ─────────────────────────────────────
     See the header for every choice here. Guarded on the money being fully
     gone and the account being live, and it collects the domains it touched so
     the operator is told rather than finding out from the customer. */
  if v_remaining <= 0 and v_pay.quote_id is not null then
    with suspended as (
      update public.hosting_accounts
         set status         = 'suspended',
             suspended_at   = now(),
             auto_renew     = false,
             /* Due now: the site is still up until the worker acts. */
             next_action_at = now()
       where tenant_id = v_pay.tenant_id
         and quote_id  = v_pay.quote_id
         and deleted_at is null
         and status = 'active'
      returning domain_name
    )
    select coalesce(array_agg(domain_name order by domain_name), '{}')
      into v_hosts from suspended;

    if array_length(v_hosts, 1) > 0 then
      /* `activity_log.user_id` references `users`, which holds STAFF. A refund
         is a staff action, so this is normally their id — but the function can
         also run as service_role with no auth.uid(), and pointing the column at
         a staff id that is not there raises 23503 and would roll the whole
         refund back. Same rule as log_row_change(). */
      select u.id into v_actor from public.users u where u.id = auth.uid();

      insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
      values (
        v_pay.tenant_id,
        v_actor,
        'hosting.suspended_on_refund',
        'hosting_account',
        null,
        left('Refund ' || v_rfv || ' returned the last of the money on quote ' ||
             coalesce(v_pay.quote_id, '—') || ', so hosting was SUSPENDED (not deleted) for: ' ||
             array_to_string(v_hosts, ', ') || '. Deleting is a separate decision.', 500)
      );
    end if;
  end if;

  return jsonb_build_object(
    'refund_voucher_no', v_rfv,
    'payment_id', p_payment_id,
    'amount', v_pay.amount,
    'quote_id', v_pay.quote_id,
    'new_payment_status', v_new_status,
    'credits_closed', v_credits,
    'gateway_refunded', false,
    /* Named, not just counted: the operator has to be able to tell the customer
       which site just went off, and "1 account suspended" does not let them. */
    'hosting_suspended', to_jsonb(v_hosts)
  );
end $$;

comment on function public.refund_payment(uuid, text) is
  'Books a refund in one transaction: RFV voucher, closes the overpayment credit, recomputes the quote and the subscription. When the refund leaves NO money on the quote, any ACTIVE hosting on it is SUSPENDED (never terminated — Pardeep, 11 Sep 2026: deleting stays an admin decision) and stamped next_action_at so /api/cron/hosting-suspend tells DirectAdmin. Refuses when a GST invoice exists (credit note first) or the payment is bank-reconciled.';
