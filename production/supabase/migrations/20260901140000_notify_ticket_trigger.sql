-- Ticket ki in-app khabar DB-trigger se (audit B4 ka hissa).
--
-- Ticket teen raaste se banta hai: portal (customer ka BROWSER — wahan se
-- server-only notify nahi bulaya ja sakta), support-email inbound, aur AI
-- agent. Route-level emitter teeno me alag-alag lagta aur ek na ek chhoot
-- jata (wahi bimari jisme 8 cron chup the). Trigger table par baithta hai —
-- ticket kahin se bhi aaye, khabar banti hai.

create or replace function public.notify_ticket_created()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
begin
  insert into public.notifications (tenant_id, user_id, kind, title, body, href, entity_id)
  select new.tenant_id, u.id, 'ticket.created',
         left('Support ticket — ' || coalesce(new.subject, '(no subject)'), 200),
         left(coalesce(new.customer_name, '') ||
              case when new.priority is not null then ' · ' || new.priority else '' end, 500),
         '/support', new.id
    from public.users u
   where u.tenant_id = new.tenant_id
     and u.role in ('owner', 'manager')
     and u.is_active;
  return null;
end $$;

drop trigger if exists support_tickets_notify on public.support_tickets;
create trigger support_tickets_notify
  after insert on public.support_tickets
  for each row execute function public.notify_ticket_created();
