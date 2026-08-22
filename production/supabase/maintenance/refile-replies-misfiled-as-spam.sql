-- Re-file inbound replies that the pre-8357df8 webhook misrouted to Spam / System
-- ============================================================================
-- 22 Aug 2026. Approved by the operator ("haan theek kar do") after being shown the
-- exact rows.
--
-- WHY THESE ROWS ARE WRONG
-- api/webhooks/inbound-email used to ask "is this a sales enquiry?" BEFORE "does this
-- sender already have an open lead?". A mid-thread reply is correctly judged "not an
-- enquiry", so it was stored as `skipped_non_enquiry` — which lib/inbound/folders.ts
-- files under Spam / System, out of the Inbox. Commit 8357df8 reorders the two
-- questions (see lib/inbound/disposition.ts). This repairs the rows already written.
--
-- SCOPE — deliberately narrow
-- Only rows that the FIXED code would have appended: a real sender, and an OPEN lead
-- in the same tenant with that contact_email. A `skipped_non_enquiry` row with no
-- matching open lead is a genuine skip (a newsletter, a security alert) and is left
-- exactly where it is. That is the whole point of the classifier and this must not
-- undo it.
--
-- WHAT IS NOT REPLAYED, AND WHY
-- The append path also appends to leads.notes, writes a lead_activities row, and can
-- create a follow-up task. None of that is replayed here. Re-running side effects days
-- later produces duplicate notes and a task for a conversation already handled — noise
-- that looks like a second event. Status + lead_id is what makes the message VISIBLE,
-- in the Inbox and in the lead's Conversation tab, which is the actual complaint.
--
-- SAFE TO RE-RUN: the WHERE clause stops matching once a row is fixed.

begin;

do $$
declare
  n_before int;
  n_after  int;
  n_fixed  int;
begin
  -- ── What we are about to touch ────────────────────────────────────────────
  select count(*) into n_before
    from public.inbound_emails e
   where e.status = 'skipped_non_enquiry'
     and e.from_email is not null
     and exists (
       select 1 from public.leads l
        where l.tenant_id = e.tenant_id
          and lower(l.contact_email) = lower(e.from_email)
          and l.stage not in ('won','lost')
     );

  raise notice 'candidates: %', n_before;

  /* A blunt upper bound, not a guess at the number. Two rows were shown to the
     operator and approved; if this file is ever re-run against a backlog nobody has
     looked at, it stops rather than silently re-filing a hundred messages. Raise it
     deliberately after re-reading the SCOPE note above. */
  if n_before > 25 then
    raise exception 'REFUSING: % candidates is more than this script was reviewed for. Re-read the SCOPE note and run the SELECT by hand first.', n_before;
  end if;

  -- ── The repair ────────────────────────────────────────────────────────────
  with matched as (
    select e.id as email_id,
           (select l.id
              from public.leads l
             where l.tenant_id = e.tenant_id
               and lower(l.contact_email) = lower(e.from_email)
               and l.stage not in ('won','lost')
             order by l.created_at desc
             limit 1) as lead_id
      from public.inbound_emails e
     where e.status = 'skipped_non_enquiry'
       and e.from_email is not null
  )
  update public.inbound_emails e
     set status  = 'appended_to_lead',
         lead_id = m.lead_id
    from matched m
   where e.id = m.email_id
     and m.lead_id is not null;

  get diagnostics n_fixed = row_count;

  -- ── Prove it ──────────────────────────────────────────────────────────────
  select count(*) into n_after
    from public.inbound_emails e
   where e.status = 'skipped_non_enquiry'
     and e.from_email is not null
     and exists (
       select 1 from public.leads l
        where l.tenant_id = e.tenant_id
          and lower(l.contact_email) = lower(e.from_email)
          and l.stage not in ('won','lost')
     );

  if n_fixed <> n_before then
    raise exception 'FAIL: % candidates but % updated — aborting rather than half-fixing', n_before, n_fixed;
  end if;
  if n_after <> 0 then
    raise exception 'FAIL: % candidates still misfiled after the update', n_after;
  end if;

  raise notice 'PASS: % replies re-filed onto their leads, 0 left misfiled', n_fixed;
end $$;

select 'PASS' as refile_replies_misfiled_as_spam;

commit;
