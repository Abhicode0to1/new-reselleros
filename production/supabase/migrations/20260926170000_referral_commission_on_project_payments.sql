-- Referral commission on PROJECT payments.
--
-- A referral agreement (Sales & CRM → Referrals: partner × customer, percent or fixed, one-time
-- or recurring, TDS) accrues commission through trg_accrue_referral_commission — on `payments`
-- only, i.e. subscription / quote receipts. A customer who buys custom software pays through
-- `project_payments`, so a partner who brought Excel Technologies' ₹59L project would earn
-- nothing, however the agreement read.
--
-- This adds the same accrual for project payments:
--   • base = the payment's pre-GST value at the project's GST rate (same rule as payments);
--   • percent → base × percent; fixed → the fixed amount, but only on bank / cash payments —
--     a project instalment settled "bank ₹5,40,000 + TDS ₹50,000" is two rows, and a fixed fee
--     must not be paid twice for one instalment (percent is taken on both, which adds up right);
--   • one_time agreements accrue once across payments AND project payments;
--   • TDS at the agreement's rate — defaulting to 2% (s.194H since 1 Oct 2024), not the old 5%;
--   • deleting a project payment cancels its unpaid commission.
-- Linked by a new referral_commissions.project_payment_id (payment_id stays for `payments`).

-- s.194H has been 2% since 1 Oct 2024; the partner / agreement default was still the old 5%.
-- Existing rows keep whatever rate was agreed; only new ones default to 2.
alter table public.referral_partners   alter column tds_rate set default 2;
alter table public.referral_agreements alter column tds_rate set default 2;

alter table public.referral_commissions
  add column if not exists project_payment_id uuid;

create unique index if not exists referral_commissions_unique_project_payment
  on public.referral_commissions (agreement_id, project_payment_id) where project_payment_id is not null;

comment on column public.referral_commissions.project_payment_id is
  'The project_payments row this commission was earned on (payment_id is for payments).';

create or replace function public.fn_accrue_referral_commission_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proj   public.project_sales;
  v_agr    public.referral_agreements%rowtype;
  v_base   integer;
  v_rate   numeric;
  v_gross  integer;
  v_tds    integer;
begin
  select * into v_proj from public.project_sales where id = new.project_id;
  if not found or v_proj.customer_id is null or coalesce(new.amount, 0) <= 0 then return new; end if;

  begin
    select * into v_agr from public.referral_agreements
     where tenant_id = new.tenant_id and customer_id = v_proj.customer_id and status = 'active'
     limit 1;
    if not found then return new; end if;

    if v_agr.scope = 'one_time' and exists (
      select 1 from public.referral_commissions where agreement_id = v_agr.id and status <> 'cancelled'
    ) then
      return new;
    end if;

    v_base := round(new.amount::numeric * 100.0 / (100.0 + coalesce(v_proj.gst_rate, 18)))::integer;

    if v_agr.basis = 'percent' then
      v_rate  := coalesce(v_agr.percent, 0);
      v_gross := round(v_base::numeric * v_rate / 100.0)::integer;
    else
      if new.method = 'tds' then return new; end if;   -- one fixed fee per instalment
      v_rate  := null;
      v_gross := coalesce(v_agr.fixed_amount, 0);
    end if;
    if v_gross <= 0 then return new; end if;

    v_tds := case when v_agr.deduct_tds then round(v_gross::numeric * coalesce(v_agr.tds_rate, 2) / 100.0)::integer else 0 end;

    insert into public.referral_commissions (
      tenant_id, agreement_id, partner_id, customer_id, project_payment_id,
      base_amount, basis, rate, gross_commission, tds_amount, net_payable, status, earned_date, notes
    ) values (
      new.tenant_id, v_agr.id, v_agr.partner_id, v_proj.customer_id, new.id,
      v_base, v_agr.basis, v_rate, v_gross, v_tds, v_gross - v_tds, 'earned', coalesce(new.received_at, current_date),
      format('Project "%s"%s', v_proj.title, case when new.method = 'tds' then ' — TDS part of the instalment' else '' end)
    )
    on conflict (agreement_id, project_payment_id) where project_payment_id is not null do nothing;
  exception when others then
    raise warning 'referral commission accrual failed for project payment %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists trg_accrue_referral_commission_project on public.project_payments;
create trigger trg_accrue_referral_commission_project
  after insert on public.project_payments
  for each row execute function public.fn_accrue_referral_commission_project();

create or replace function public.fn_cancel_referral_commission_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.referral_commissions
     set status = 'cancelled', notes = coalesce(notes, '') || ' | project payment removed'
   where project_payment_id = old.id and status = 'earned';
  return old;
end;
$$;

drop trigger if exists trg_cancel_referral_commission_project on public.project_payments;
create trigger trg_cancel_referral_commission_project
  after delete on public.project_payments
  for each row execute function public.fn_cancel_referral_commission_project();
