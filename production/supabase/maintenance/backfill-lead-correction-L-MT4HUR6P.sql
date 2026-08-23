-- Apply the correction the customer sent twice, to the lead that never recorded it
-- ============================================================================
-- 23 Aug 2026, approved by the operator. This is the ONE row that predates Phase 1
-- (commit 76ee5be) — from here on the webhook does this itself, on arrival.
--
-- WHAT THE CUSTOMER SAID, and where it is stored:
--   inbound_emails.acf87053-4410-4db4-bb5f-764d91d9b6ee (22 Aug 16:29 UTC)
--     "Actually, I need the quotation for 20 users of Google Workspace Business
--      Standard, not 50 users of Starter. Please adjust that."
--   and again, less formally, in 7f4cd701 (16:04 UTC).
--
-- The lead still reads seats = 50, plan = Google Workspace Business Starter. Every
-- quote, draft and renewal derived from that row would be wrong, which is why this is
-- worth a script rather than waiting for the next reply to trigger the new code.
--
-- The values below are NOT retyped from the operator's message — they are what
-- lib/leads/apply-correction.ts produces from that stored body, asserted in
-- apply-correction.test.ts against the exact bytes ("seats:50->20",
-- "plan:…Starter->…Standard"). This script is the same decision, applied by hand once.
--
-- REVERSIBLE: the old values are in the activity rows this writes, and in
-- activity_log via trg_activity_leads.
--
-- SAFE TO RE-RUN: the update is a no-op once applied, and the guard below refuses to
-- write a second pair of activity rows.

begin;

do $$
declare
  v_lead    text := 'L-MT4HUR6P';
  v_tenant  uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  v_source  text := 'Actually, I need the quotation for 20 users of Google Workspace Business Standard, not 50 users of Starter. Please adjust that.';
  v_seats   int;
  v_plan    text;
  v_already int;
begin
  select seats, plan into v_seats, v_plan
    from public.leads where id = v_lead and tenant_id = v_tenant;

  if not found then
    raise exception 'REFUSING: lead % not found in tenant % — check both before running this', v_lead, v_tenant;
  end if;

  /* Idempotency. Without this a second run appends another pair of "Seats: 50 -> 20"
     rows, and a timeline that reports the same correction twice is a timeline nobody
     trusts. */
  select count(*) into v_already
    from public.lead_activities
   where lead_id = v_lead and kind = 'correction_in';
  if v_already > 0 then
    raise notice 'SKIP: % already carries % correction row(s) — nothing to do', v_lead, v_already;
    return;
  end if;

  /* The row must still hold the WRONG values. If somebody has already corrected it by
     hand, this must not quietly rewrite their work — and must not log the customer as
     the source of a change that did not happen here. */
  if v_seats is distinct from 50 then
    raise exception 'REFUSING: expected seats = 50, found % — the lead has changed since this script was written', v_seats;
  end if;
  if v_plan is distinct from 'Google Workspace Business Starter' then
    raise exception 'REFUSING: expected plan = Google Workspace Business Starter, found % — the lead has changed', v_plan;
  end if;

  update public.leads
     set seats = 20,
         plan  = 'Google Workspace Business Standard'
   where id = v_lead and tenant_id = v_tenant;

  /* One row per field, each quoting the customer. Matches correctionDetail() in
     lib/leads/apply-correction.ts, so this row and the ones the webhook writes from
     now on read identically on the timeline. */
  insert into public.lead_activities (tenant_id, lead_id, kind, detail) values
    (v_tenant, v_lead, 'correction_in',
     'Seats: 50 → 20 · from the customer''s reply: "' || v_source || '"'),
    (v_tenant, v_lead, 'correction_in',
     'Plan: Google Workspace Business Starter → Google Workspace Business Standard · from the customer''s reply: "' || v_source || '"');

  -- Prove it before committing.
  select seats, plan into v_seats, v_plan
    from public.leads where id = v_lead and tenant_id = v_tenant;
  if v_seats <> 20 or v_plan <> 'Google Workspace Business Standard' then
    raise exception 'FAIL: after the update the lead reads % / % — aborting', v_seats, v_plan;
  end if;

  raise notice 'PASS: % now reads 20 seats / Business Standard, with 2 sourced activity rows', v_lead;
end $$;

select 'PASS' as backfill_lead_correction;

commit;
