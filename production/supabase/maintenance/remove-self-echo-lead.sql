-- Remove the lead my own regression created from our own outgoing address
-- ============================================================================
-- 23 Aug 2026. The operator: "anutech lead ab bhi show ho raha hai jabki ise banna hi
-- nahi chahiye email ke through." Correct — commit 935201e stops NEW ones being created;
-- this removes the one already made.
--
-- HOW IT GOT THERE
-- Every reply on a thread arrives twice: once at the customer-facing address and once at
-- the address we send FROM, because that address is in the thread. Those echoes were
-- filed as spam until L26 made an absent classification (Gemini did not run) resolve to
-- `create`, so a real first email could not vanish during an outage. That turned each
-- echo into a lead named from the domain fallback — "anutech", no seats, no plan.
--
-- WHAT THIS DOES
--   1. Re-files the inbound email exactly as the FIXED code now would: status
--      skipped_non_enquiry, lead_id null. Not deleted — it is a real message that
--      really arrived, and the row is the evidence.
--   2. Deletes the lead's single activity row and then the lead.
--
-- SAFETY
-- Refuses unless the lead is precisely what this describes: that id, that tenant,
-- company 'anutech', source 'email-inbound', and — the ones that matter — NO quotes, NO
-- payments and NO tasks. If anybody has since done real work on this row, this stops
-- rather than destroying it.

begin;

do $$
declare
  v_lead    text := 'L-MT55LP2Y';
  v_tenant  uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  v_company text;
  v_source  text;
  v_n       int;
begin
  select company, source into v_company, v_source
    from public.leads where id = v_lead and tenant_id = v_tenant;

  if not found then
    raise notice 'SKIP: lead % not present — already removed', v_lead;
    return;
  end if;

  if v_company is distinct from 'anutech' or v_source is distinct from 'email-inbound' then
    raise exception 'REFUSING: lead % is company=%, source=% — not the self-echo row this script describes', v_lead, v_company, v_source;
  end if;

  /* The three that would mean real work has happened on this lead. Any of them and the
     row is no longer junk, whatever created it. */
  select count(*) into v_n from public.quotes where lead_id = v_lead;
  if v_n > 0 then raise exception 'REFUSING: % has % quote(s)', v_lead, v_n; end if;

  select count(*) into v_n from public.payments p
    join public.quotes q on q.id = p.quote_id where q.lead_id = v_lead;
  if v_n > 0 then raise exception 'REFUSING: % has % payment(s)', v_lead, v_n; end if;

  select count(*) into v_n from public.tasks where lead_id = v_lead;
  if v_n > 0 then raise exception 'REFUSING: % has % task(s)', v_lead, v_n; end if;

  /* 1. The email stays, re-filed the way the fixed code would file it. Deleting it
        would remove the evidence of a message that genuinely arrived — and the row is
        how anybody checks this later. */
  update public.inbound_emails
     set status = 'skipped_non_enquiry', lead_id = null
   where lead_id = v_lead and tenant_id = v_tenant;

  -- 2. Then the lead and its activity trail.
  delete from public.lead_activities where lead_id = v_lead and tenant_id = v_tenant;
  delete from public.leads          where id      = v_lead and tenant_id = v_tenant;

  -- Prove it before committing.
  select count(*) into v_n from public.leads where id = v_lead;
  if v_n <> 0 then raise exception 'FAIL: lead % still present after delete', v_lead; end if;

  select count(*) into v_n from public.inbound_emails
   where tenant_id = v_tenant and lead_id is null and status = 'skipped_non_enquiry';
  raise notice 'PASS: % removed; its email re-filed (tenant now has % skipped rows)', v_lead, v_n;
end $$;

select 'PASS' as remove_self_echo_lead;

commit;
