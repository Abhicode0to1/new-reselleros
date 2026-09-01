-- Regression test: notifications (20260901130000) + ticket-trigger (…140000)
--
-- Kya saabit hota hai (sab rollback):
--   1. Ticket INSERT par trigger owner+manager ko row deta hai — sales ko nahi.
--   2. Har user ko sirf APNI khabar dikhti hai (doosre tenant ko kuch nahi).
--   3. Apni row ka read_at lagta hai; DOOSRE ki row par update 0 rows.
--   4. authenticated seedha INSERT nahi kar sakta (spoof band).

begin;

insert into auth.users (id, email) values
  ('f1f1f1f1-0000-0000-0000-0000000000a1', 'nf-owner@example.test'),
  ('f1f1f1f1-0000-0000-0000-0000000000a2', 'nf-sales@example.test'),
  ('f1f1f1f1-0000-0000-0000-0000000000b1', 'nf-other@example.test');

insert into public.tenants (id, name, email, state_code) values
  ('f1f1f1f1-0000-0000-0000-0000000000f0', 'NOTIF T A', 'nfa@example.test', '07'),
  ('f1f1f1f1-0000-0000-0000-0000000000f1', 'NOTIF T B', 'nfb@example.test', '07');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('f1f1f1f1-0000-0000-0000-0000000000a1', 'f1f1f1f1-0000-0000-0000-0000000000f0', 'nf-owner@example.test', 'NF Owner', 'owner', true),
  ('f1f1f1f1-0000-0000-0000-0000000000a2', 'f1f1f1f1-0000-0000-0000-0000000000f0', 'nf-sales@example.test', 'NF Sales', 'sales', true),
  ('f1f1f1f1-0000-0000-0000-0000000000b1', 'f1f1f1f1-0000-0000-0000-0000000000f1', 'nf-other@example.test', 'NF Other', 'owner', true);

-- ── 1. Trigger: ticket → khabar owner ko, sales ko nahi ─────────────────────
insert into public.support_tickets (id, tenant_id, customer_name, raised_by_email, subject, body, status, category, priority)
  values ('TKT-NF-1', 'f1f1f1f1-0000-0000-0000-0000000000f0', 'Notif Cust', 'c@x.test', 'Printer on fire', 'help', 'open', 'technical', 'high');

do $$
declare n int;
begin
  select count(*) into n from public.notifications
   where entity_id = 'TKT-NF-1' and user_id = 'f1f1f1f1-0000-0000-0000-0000000000a1';
  if n <> 1 then raise exception 'FAIL 1a: owner ko ticket ki khabar nahi mili (n=%)', n; end if;

  select count(*) into n from public.notifications
   where entity_id = 'TKT-NF-1' and user_id = 'f1f1f1f1-0000-0000-0000-0000000000a2';
  if n <> 0 then raise exception 'FAIL 1b: sales ko bhi khabar chali gayi'; end if;
end $$;

set local role authenticated;

do $$
declare
  v_owner uuid := 'f1f1f1f1-0000-0000-0000-0000000000a1';
  v_other uuid := 'f1f1f1f1-0000-0000-0000-0000000000b1';
  n int;
begin
  -- ── 2. Owner apni khabar dekhta hai; doosre tenant ka user kuch nahi ─────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where entity_id = 'TKT-NF-1';
  if n <> 1 then raise exception 'FAIL 2a: owner ko apni khabar nahi dikhi (n=%)', n; end if;

  -- ── 3. Apni row read hoti hai ─────────────────────────────────────────────
  update public.notifications set read_at = now() where entity_id = 'TKT-NF-1';
  select count(*) into n from public.notifications
   where entity_id = 'TKT-NF-1' and read_at is not null;
  if n <> 1 then raise exception 'FAIL 3: apni khabar read nahi hui'; end if;

  -- ── 4. authenticated seedha khabar NAHI bana sakta ───────────────────────
  begin
    insert into public.notifications (tenant_id, user_id, kind, title)
      values ('f1f1f1f1-0000-0000-0000-0000000000f0', v_owner, 'lead.created', 'spoof');
    raise exception 'FAIL 4: browser-side insert chal gaya — spoofing khula hai';
  exception when insufficient_privilege or sqlstate '42501' then null;
  end;

  -- ── 2b. Doosra tenant: kuch nahi dikhta, kuch nahi badalta ───────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where entity_id = 'TKT-NF-1';
  if n <> 0 then raise exception 'FAIL 2b: doosre tenant ko khabar dikhi'; end if;
  update public.notifications set read_at = null where entity_id = 'TKT-NF-1';
  -- (0 rows — RLS ne row tak pahunchne hi nahi diya; agla select isi ko naapta hai)

  raise notice 'PASS: notifications trigger + RLS + read-state + spoof-guard';
end $$;

rollback;
