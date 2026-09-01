-- In-app notifications — pehli asli feed (audit B4, 1 Sep 2026).
--
-- Ab tak "notification panel" teen queries se DERIVE hota tha (tasks/leads/
-- birthdays) aur read-state localStorage me thi — doosre device par sab
-- wapas unread, aur payment/quote-accept/ticket jaise asli events ka koi
-- in-app nishaan hi nahi (18 cron unke EMAIL bhejte the, app chup rehti).
--
-- Model: row = ek recipient ke liye ek event. Writer (server) tay karta hai
-- kise dikhe (aam taur par tenant ke owner+manager). read_at row par hai,
-- isliye har device par ek hi sach.

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  /** Recipient — RLS isi par khadi hai. */
  user_id    uuid not null references public.users(id) on delete cascade,
  /** 'payment.received' / 'quote.accepted' / 'lead.created' / 'ticket.created' … */
  kind       text not null,
  title      text not null,
  body       text,
  /** App ke andar ka raasta — §24: har khabar ke saath jaane ki jagah. */
  href       text,
  entity_id  text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index notifications_user_unread
  on public.notifications (user_id, created_at desc)
  where read_at is null;
create index notifications_user_recent
  on public.notifications (user_id, created_at desc);
create index notifications_tenant
  on public.notifications (tenant_id, created_at desc);

alter table public.notifications enable row level security;

-- Apni hi khabar dikhti hai. tenant-scope bhi — belt aur suspenders.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = auth.uid() and tenant_id = public.current_tenant_id());

-- Sirf apni row ka read_at badal sakte ho (poori row nahi — with check wahi row).
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid() and tenant_id = public.current_tenant_id())
  with check (user_id = auth.uid() and tenant_id = public.current_tenant_id());

-- Likhta sirf server hai (admin client) — browser se khabar banana spoofing hota.
drop policy if exists notifications_service on public.notifications;
create policy notifications_service on public.notifications
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
