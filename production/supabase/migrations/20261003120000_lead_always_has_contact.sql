-- R-135 (3 Oct 2026): a lead whose email or phone is added AFTER it was saved gets its contact.
--
-- trg_leads_autolink_contact ran on INSERT only. A lead saved with just a name, whose phone or
-- email was typed in later (the usual path for a phone enquiry that becomes a deal), never got
-- a contact_id — so its channels never reached the contact book's identity record, and the
-- same person arriving again by mail or WhatsApp was not recognised.
--
-- Now the same trigger, unchanged in body, also fires when contact_email / contact_phone
-- change, and still only while the lead has no contact. resolve_or_create_contact is unchanged:
-- it needs an email or a 10-digit phone, and reuses an existing contact before creating one.
-- A lead with neither stays without a contact — matching people by name alone would merge two
-- different "Rahul"s. (Such a lead is still shown in Contacts by its own row; see
-- lib/queries/contacts.ts.)

create or replace function public.leads_autolink_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.contact_id is null then
    begin
      new.contact_id := public.resolve_or_create_contact(new.tenant_id, new.contact_email, new.contact_phone, new.contact_name, new.company);
    exception when others then new.contact_id := null; end;
  end if;
  return new;
end; $$;

drop trigger if exists trg_leads_autolink_contact on public.leads;
create trigger trg_leads_autolink_contact
  before insert or update of contact_email, contact_phone
  on public.leads
  for each row execute function public.leads_autolink_contact();

-- One-time: leads that already have an email or phone but no contact (their channel came after
-- the save) get one now, through the trigger above (a no-op write to contact_email fires it).
-- updated_at is held still — a repair, not an edit someone made — and the activity log writes
-- nothing because a migration has no signed-in user.
alter table public.leads disable trigger trg_leads_updated_at;
update public.leads
   set contact_email = contact_email
 where contact_id is null
   and (nullif(trim(coalesce(contact_email, '')), '') is not null
        or length(regexp_replace(coalesce(contact_phone, ''), '\D', '', 'g')) >= 10);
alter table public.leads enable trigger trg_leads_updated_at;
