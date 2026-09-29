-- today_inbox() — every queue that wants a person today, as ONE ranked list (S29).
--
-- ─── WHY ────────────────────────────────────────────────────────────────────
-- The work of a day was spread over ten screens: tasks, enquiries, WhatsApp, support,
-- automation (held actions), activation queue, purchases inbox, quote approvals, join
-- requests, renewals — plus overdue invoices and stopped autopays that nothing surfaced at
-- all. /today reads this one function and links each row to the screen that already does
-- the work. It is READ-ONLY: it never changes a row, and it never decides anything a
-- queue's own page does not already decide.
--
-- ─── WHO SEES WHAT ──────────────────────────────────────────────────────────
-- SECURITY INVOKER, so every table below is read under the caller's own RLS — the
-- function can never show a row the caller could not already select. On top of that each
-- branch carries `tenant_id = public.current_tenant_id()` explicitly:
--   * belt and braces — a table whose policy is ever widened (e.g. invoices already has a
--     second `select_own_customer` policy for the customer portal) still cannot leak
--     another tenant's row through here;
--   * a caller with no public.users row (a portal customer, a stranded sign-in) gets
--     current_tenant_id() = NULL, and `= NULL` matches nothing, so they get an empty list
--     rather than their portal invoices dressed up as work.
-- Proven by supabase/tests/today_inbox.test.sql.
--
-- Items that are a DECISION only some roles may take (quote approvals, join requests) are
-- filtered to the roles that can take them — the same rules the rest of the app uses
-- (lib/quotes/approval.ts: owner clears both tiers, manager clears 'manager';
-- join_requests_decide policy: owner/manager). Showing a rep a button they cannot press
-- is noise, not transparency.
--
-- ─── RANKING ────────────────────────────────────────────────────────────────
-- `priority` is 0–100, higher first; ties by `due_at` ascending (oldest / soonest first),
-- NULL due dates last. The scale, so a new branch can be placed honestly:
--   90  money taken, service not delivered   provisioning failed
--   85  money at risk                        autopay stopped; activation queued > 24h
--   75–80  a customer is waiting / owes      support SLA breached; overdue invoice > 30d;
--                                            renewal within 3 days; activation queued
--   70  somebody is blocked on YOU           quote approval; my task overdue
--   55–65  should be answered today          join request; enquiry; WhatsApp; support; task due today
--   40–50  today, but nothing breaks         renewal in 8–14 days; automation held; expense claim
--   30  housekeeping                         purchases inbox
-- GST/TDS deadlines are NOT here: their dates come from the code-owned catalog in
-- src/lib/compliance/obligations.ts, and a second copy of that calendar in SQL would be a
-- second source that drifts (AGENTS.md L106). The page merges them in on the same scale.
--
-- Each branch is capped at 50 rows so one flooded queue cannot bury the others; the page
-- links to the queue's own screen for the full list.
--
-- Money is whole rupees (AGENTS.md §1). Titles show the invoice's own amount, never a
-- derived "outstanding" figure — that belongs to the invoice page, which knows about
-- advances and part-payments.
--
-- "Today" is the IST calendar day (AGENTS.md §6), not the UTC one.

create or replace function public.today_inbox()
returns table (
  kind     text,
  id       text,
  title    text,
  due_at   timestamptz,
  priority int,
  href     text
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  with me as (
    select u.id as uid, u.tenant_id, u.role::text as role,
           (now() at time zone 'Asia/Kolkata')::date as today_ist,
           /* End of the IST day, as an instant. */
           (((now() at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata') as eod
      from public.users u
     where u.id = auth.uid()
       and u.tenant_id = public.current_tenant_id()
  ),
  items (kind, id, title, due_at, priority, href) as (
    -- 1. My tasks — overdue or due by the end of today.
    (select 'task'::text, t.id::text, t.title, t.due_at,
            case when t.due_at < now() then 70 else 55 end, '/tasks'::text
       from public.tasks t, me
      where t.tenant_id = me.tenant_id
        and t.owner_id = me.uid
        and t.status in ('pending', 'snoozed')
        and t.due_at < me.eod
      order by t.due_at
      limit 50)

    union all
    -- 2. Enquiries — unread, still in the Inbox (not done, not snoozed, not machine mail).
    (select 'enquiry', e.id::text,
            'Enquiry: ' || coalesce(nullif(e.subject, ''), '(no subject)')
              || ' — ' || coalesce(nullif(e.from_name, ''), e.from_email, 'unknown sender'),
            e.created_at, 60, '/enquiries'
       from public.inbound_emails e, me
      where e.tenant_id = me.tenant_id
        and e.status in ('received', 'lead_created', 'appended_to_lead')
        and e.read_at is null
        and e.archived_at is null
        and (e.snoozed_until is null or e.snoozed_until <= now())
        and e.created_at > now() - interval '14 days'
      order by e.created_at
      limit 50)

    union all
    -- 3. WhatsApp — conversations whose LAST message is theirs, in the last 7 days.
    (select 'whatsapp', w.contact_phone,
            'WhatsApp from ' || w.contact_phone || coalesce(': ' || left(w.text_body, 60), ''),
            w.created_at, 60, '/whatsapp'
       from (select distinct on (m.contact_phone) m.contact_phone, m.direction, m.text_body, m.created_at
               from public.whatsapp_messages m, me
              where m.tenant_id = me.tenant_id
                and m.created_at > now() - interval '7 days'
              order by m.contact_phone, m.created_at desc) w
      where w.direction = 'inbound'
      order by w.created_at
      limit 50)

    union all
    -- 4. Support tickets we owe a move on (awaiting_customer is THEIR move).
    (select 'support', s.id,
            'Ticket ' || s.id || ': ' || coalesce(s.subject, '') || coalesce(' — ' || s.customer_name, ''),
            s.sla_due_at,
            case when s.sla_due_at < now() then 80
                 when s.priority in ('urgent', 'high') then 65
                 else 55 end,
            '/support'
       from public.support_tickets s, me
      where s.tenant_id = me.tenant_id
        and s.status in ('open', 'in_progress')
      order by s.sla_due_at nulls last
      limit 50)

    union all
    -- 5. Automation held for a human, last 7 days (the /automation "waiting on you" list).
    (select 'automation', a.id::text,
            'Held for you: ' || a.action || coalesce(' — ' || a.reason, ''),
            a.created_at, 50, '/automation'
       from public.ai_action_log a, me
      where a.tenant_id = me.tenant_id
        and a.outcome = 'held'
        and a.created_at > now() - interval '7 days'
      order by a.created_at
      limit 50)

    union all
    -- 6. Activation queue — paid for, not switched on.
    (select 'provisioning', p.id::text,
            case when p.status = 'failed' then 'Activation FAILED: ' else 'Activate: ' end
              || p.seats || ' × ' || coalesce(p.plan, p.vendor) || coalesce(' for ' || p.domain, ''),
            p.created_at,
            case when p.status = 'failed' then 90
                 when p.created_at < now() - interval '24 hours' then 85
                 else 75 end,
            '/provisioning'
       from public.provisioning_requests p, me
      where p.tenant_id = me.tenant_id
        and p.status in ('queued', 'failed')
      order by p.created_at
      limit 50)

    union all
    -- 7. Purchases inbox — vendor order mails not yet booked.
    (select 'purchase_inbox', ip.id::text,
            'Book purchase: ' || coalesce(nullif(ip.subject, ''), ip.source)
              || coalesce(' · ₹' || to_char(ip.total, 'FM99,99,99,99,999'), ''),
            ip.created_at, 30, '/purchases/inbox'
       from public.inbound_purchases ip, me
      where ip.tenant_id = me.tenant_id
        and ip.status = 'pending'
      order by ip.created_at
      limit 50)

    union all
    -- 8a. Quotes waiting on MY approval — mirrors useNavBadges / awaitsMyApproval:
    --     pending, not raised by me, and a tier my role may clear.
    (select 'approval', q.id,
            'Approve quote ' || q.id || coalesce(' — ' || q.customer_name, '')
              || coalesce(' · ₹' || to_char(q.amount, 'FM99,99,99,99,999'), ''),
            q.approval_requested_at, 70, '/quotes/' || q.id
       from public.quotes q, me
      where q.tenant_id = me.tenant_id
        and q.approval_status = 'pending'
        and q.approval_requested_by is distinct from me.uid
        and ( (q.approval_tier = 'owner'   and me.role = 'owner')
           or (q.approval_tier = 'manager' and me.role in ('owner', 'manager')) )
      order by q.approval_requested_at
      limit 50)

    union all
    -- 8b. Seat-change requests from customers (decided on /subscriptions).
    (select 'approval', sr.id::text,
            'Seat change: ' || coalesce(sr.customer_name, 'customer') || ' '
              || sr.current_seats || ' → ' || sr.requested_seats,
            sr.created_at, 60, '/subscriptions'
       from public.seat_requests sr, me
      where sr.tenant_id = me.tenant_id
        and sr.status = 'pending'
        and me.role in ('owner', 'manager', 'billing')
      order by sr.created_at
      limit 50)

    union all
    -- 8c. Expense claims against an advance, waiting for a decision.
    (select 'approval', ec.id::text,
            'Expense claim: ₹' || to_char(ec.amount, 'FM99,99,99,99,999') || coalesce(' — ' || ec.purpose, ''),
            ec.created_at, 40, '/accounting/loans'
       from public.expense_claims ec, me
      where ec.tenant_id = me.tenant_id
        and ec.status = 'pending'
        and me.role in ('owner', 'manager')
      order by ec.created_at
      limit 50)

    union all
    -- 9. Join requests — somebody signed up with our domain and is waiting to be let in.
    (select 'join_request', jr.id::text,
            'Join request: ' || coalesce(nullif(jr.full_name, ''), jr.email) || ' (' || jr.email || ')',
            jr.created_at, 65, '/team'
       from public.join_requests jr, me
      where jr.tenant_id = me.tenant_id
        and jr.status = 'pending_approval'
        and me.role in ('owner', 'manager')
      order by jr.created_at
      limit 50)

    union all
    -- 10. Renewals in the next 14 days (or already past) that nobody has renewed.
    (select 'renewal', su.id::text,
            'Renewal: ' || coalesce(su.customer_name, '') || ' · ' || coalesce(su.plan, '')
              || coalesce(' · ' || su.domain, '') || ' on ' || to_char(su.renewal_date, 'DD Mon'),
            (su.renewal_date::timestamp at time zone 'Asia/Kolkata'),
            case when su.renewal_date <= me.today_ist + 3 then 75
                 when su.renewal_date <= me.today_ist + 7 then 60
                 else 45 end,
            '/renewals'
       from public.subscriptions su, me
      where su.tenant_id = me.tenant_id
        and su.status = 'active'
        and su.renewal_date <= me.today_ist + 14
        and su.renewal_state is distinct from 'renewed'
      order by su.renewal_date
      limit 50)

    union all
    -- 11. Overdue invoices — unpaid and past their due date (IST).
    (select 'invoice_overdue', i.id,
            'Overdue ' || (me.today_ist - i.due_date) || 'd: ' || i.id || coalesce(' — ' || i.customer_name, '')
              || ' (invoice ₹' || to_char(i.amount, 'FM99,99,99,99,999') || ')',
            (i.due_date::timestamp at time zone 'Asia/Kolkata'),
            case when i.due_date < me.today_ist - 30 then 80 else 72 end,
            '/invoices/' || i.id
       from public.invoices i, me
      where i.tenant_id = me.tenant_id
        and i.status in ('pending', 'overdue')
        and i.due_date < me.today_ist
      order by i.due_date
      limit 50)

    union all
    -- 12. Autopay stopped — Razorpay halted the mandate (repeated failed charges) or it is
    --     stuck pending. The only durable record of a failed payment this schema keeps:
    --     the webhook ignores one-off `payment.failed` events (webhooks/razorpay/route.ts).
    (select 'payment_failed', pm.id::text,
            'Autopay stopped: ' || coalesce(c.name, 'customer') || coalesce(' — ' || pm.status_note, ''),
            pm.updated_at, 85, '/subscriptions'
       from public.payment_mandates pm
       join me on pm.tenant_id = me.tenant_id
       left join public.customers c on c.id = pm.customer_id and c.tenant_id = pm.tenant_id
      where pm.status = 'paused'
        and coalesce(pm.test_mode, false) = false
      order by pm.updated_at
      limit 50)
  )
  select i.kind, i.id, i.title, i.due_at, i.priority, i.href from items i
   order by i.priority desc, i.due_at asc nulls last, i.kind, i.id;
$fn$;

comment on function public.today_inbox() is
  'S29 /today: one ranked, read-only list of every queue that wants a person today. SECURITY INVOKER — RLS of each table applies; explicit tenant_id = current_tenant_id() on every branch. See migration 20260928160000.';

revoke all on function public.today_inbox() from public;
revoke all on function public.today_inbox() from anon;
grant execute on function public.today_inbox() to authenticated;
