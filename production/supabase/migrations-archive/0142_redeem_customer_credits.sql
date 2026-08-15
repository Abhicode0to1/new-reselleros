-- 0142: redeem_customer_credits — atomically consume a customer's OPEN advance
-- credits (oldest first) up to p_amount, returning the amount actually consumed.
-- Row-locked (FOR UPDATE) so a credit can never be spent twice, even under
-- concurrent record-payment calls. A partially-consumed credit is split: the
-- open row shrinks by the used chunk and a matching 'used' row is logged for the
-- audit trail. The caller (record-payment) consumes credit BEFORE recording the
-- payment, so a later failure can never leave a spent credit still 'open'.

create or replace function public.redeem_customer_credits(
  p_customer_id uuid, p_amount integer, p_note text default null
) returns integer
  language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_tenant    uuid    := public.current_tenant_id();
  v_remaining integer := greatest(0, coalesce(p_amount, 0));
  v_consumed  integer := 0;
  v_take      integer;
  v_row       record;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if v_remaining <= 0 then return 0; end if;

  for v_row in
    select id, amount from public.customer_credits
     where tenant_id = v_tenant and customer_id = p_customer_id and status = 'open'
     order by created_at asc
     for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_row.amount, v_remaining);
    if v_take >= v_row.amount then
      update public.customer_credits set status = 'used' where id = v_row.id;
    else
      update public.customer_credits set amount = amount - v_take where id = v_row.id;
      insert into public.customer_credits (tenant_id, customer_id, amount, source, note, status)
      values (v_tenant, p_customer_id, v_take, 'redeemed_split',
              coalesce(nullif(trim(p_note), ''), 'Partial advance credit applied'), 'used');
    end if;
    v_consumed  := v_consumed + v_take;
    v_remaining := v_remaining - v_take;
  end loop;

  return v_consumed;
end; $function$;

grant execute on function public.redeem_customer_credits(uuid, integer, text) to authenticated;
