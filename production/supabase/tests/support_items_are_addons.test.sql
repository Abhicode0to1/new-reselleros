-- Support items are add-ons after 20261002140000. Rolled back; exit 0 = pass.
begin;
insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000140a0', 'SUPADD', 'supadd@example.in', '07');
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, item_type, kind) values
  ('SUP-STANDARD-MO-T140', 'aaaaaaaa-0000-0000-0000-0000000140a0', 'Standard Support', 'support', 999, 0, 'subscription', 'main'),
  ('GW-STR-T140',          'aaaaaaaa-0000-0000-0000-0000000140a0', 'Google Workspace Business Starter', 'google', 136, 110, 'subscription', 'main');

update public.items set kind = 'addon' where vendor = 'support' and kind is distinct from 'addon';

do $$ begin
  if (select kind from public.items where id = 'SUP-STANDARD-MO-T140') <> 'addon' then
    raise exception 'FAIL 1: support item is not an add-on';
  end if;
  if (select kind from public.items where id = 'GW-STR-T140') <> 'main' then
    raise exception 'FAIL 2: a product that is not support was changed';
  end if;
end $$;
rollback;
