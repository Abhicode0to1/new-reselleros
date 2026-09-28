-- Regression test: today_inbox() — the /today ranked list (S29, migration 20260928160000).
--
-- Self-asserting: RAISEs on failure, one NOTICE "PASS today_inbox" on success. Runs inside
-- a transaction that ROLLS BACK. LOCAL database only:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/today_inbox.test.sql
--
-- What it proves:
--   1. The owner of A gets exactly the rows that want them today — one per queue fixture —
--      and not: someone else's task, a task next week, a done task, a paid invoice, a
--      booked purchase, machine mail, an ANSWERED WhatsApp thread, a renewal 90 days out.
--   2. Ranking: priority never rises down the list; a failed activation leads; a 45-day
--      overdue invoice outranks a 5-day one. Every row carries an in-app link.
--   3. Tenant isolation both ways, scoped to the OTHER tenant (L7) and guarded: B sees
--      exactly its own invoice (so "none of A's" is not a vacuous zero).
--   4. Role filters: a manager is not offered an owner-tier quote (nor one they raised);
--      a rep sees their own task and no decisions.
--   5. A signed-in user with no workspace gets an empty list, not an error.
--   6. anon cannot execute it; authenticated can; it is SECURITY INVOKER.
--
-- ─── WHY THE FUNCTION IS COPIED INTO THIS FILE ──────────────────────────────
-- Tests here run against a database that may not have the migration applied yet, and the
-- rule for this repo is that a test changes nothing it does not roll back. So the
-- migration's text is pasted verbatim between the two COPY markers and created inside the
-- transaction. `src/lib/today/today-inbox-sql-copy.test.ts` (vitest) fails if the copy and
-- the migration ever differ — a copy that drifted would prove a function nobody runs (L8).

begin;

-- >>> BEGIN COPY of supabase/migrations/20260928160000_today_inbox.sql
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

-- <<< END COPY of supabase/migrations/20260928160000_today_inbox.sql

-- ── Fixtures — own tenants, own users, all rolled back (AGENTS.md L11) ─────────
insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000d9', 'TODAY TEST A', 'today-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000d9', 'TODAY TEST B', 'today-b@example.in', '07');

insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-4000-8000-0000000d9a01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'today-a-owner@example.in'),
  ('aaaaaaaa-0000-4000-8000-0000000d9a02', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'today-a-mgr@example.in'),
  ('aaaaaaaa-0000-4000-8000-0000000d9a03', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'today-a-rep@example.in'),
  ('bbbbbbbb-0000-4000-8000-0000000d9b01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'today-b-owner@example.in'),
  -- Signed in, but a member of NO workspace (a portal customer / stranded sign-in).
  ('cccccccc-0000-4000-8000-0000000d9c01', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'today-nobody@example.in');

insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-4000-8000-0000000d9a01', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'today-a-owner@example.in', 'owner'),
  ('aaaaaaaa-0000-4000-8000-0000000d9a02', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'today-a-mgr@example.in',   'manager'),
  ('aaaaaaaa-0000-4000-8000-0000000d9a03', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'today-a-rep@example.in',   'sales'),
  ('bbbbbbbb-0000-4000-8000-0000000d9b01', 'bbbbbbbb-0000-0000-0000-0000000000d9', 'today-b-owner@example.in', 'owner');

insert into public.customers (id, tenant_id, name) values
  ('aaaaaaaa-0000-4000-8000-00000d9c0001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'Acme A'),
  ('bbbbbbbb-0000-4000-8000-00000d9c0001', 'bbbbbbbb-0000-0000-0000-0000000000d9', 'Bravo B');

-- A: my overdue task (owner), a task due today for the rep, and one due next week (not today).
insert into public.tasks (id, tenant_id, owner_id, title, due_at, status) values
  ('aaaaaaaa-0000-4000-8000-0000d9a70001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-0000000d9a01', 'Owner overdue call', now() - interval '2 hours', 'pending'),
  ('aaaaaaaa-0000-4000-8000-0000d9a70002', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-0000000d9a03', 'Rep call',           now() - interval '1 minute', 'pending'),
  ('aaaaaaaa-0000-4000-8000-0000d9a70003', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-0000000d9a01', 'Next week',          now() + interval '7 days', 'pending'),
  ('aaaaaaaa-0000-4000-8000-0000d9a70004', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-0000000d9a01', 'Already done',       now() - interval '3 hours', 'done');

-- A: two overdue invoices (45 days → 80, 5 days → 72) and one paid. B: one overdue invoice.
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date) values
  ('INV-TD-A-OLD',  'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 490644, 'pending',
     (now() at time zone 'Asia/Kolkata')::date - 60, (now() at time zone 'Asia/Kolkata')::date - 45),
  ('INV-TD-A-NEW',  'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 1200, 'overdue',
     (now() at time zone 'Asia/Kolkata')::date - 20, (now() at time zone 'Asia/Kolkata')::date - 5),
  ('INV-TD-A-PAID', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 999, 'paid',
     (now() at time zone 'Asia/Kolkata')::date - 60, (now() at time zone 'Asia/Kolkata')::date - 45),
  ('INV-TD-B-OLD',  'bbbbbbbb-0000-0000-0000-0000000000d9', 'bbbbbbbb-0000-4000-8000-00000d9c0001', 'Bravo B', 5000, 'pending',
     (now() at time zone 'Asia/Kolkata')::date - 60, (now() at time zone 'Asia/Kolkata')::date - 10);

-- A: a quote waiting on OWNER approval, raised by the manager; and a paid quote whose
-- activation failed.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, approval_status, approval_tier, approval_requested_by, approval_requested_at) values
  ('Q-TD-A-APPR', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 25000, 'pending', 'owner',
     'aaaaaaaa-0000-4000-8000-0000000d9a02', now() - interval '1 hour');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount) values
  ('Q-TD-A-PROV', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 3300);
insert into public.provisioning_requests (id, tenant_id, quote_id, vendor, seats, plan, amount_paid, payment_mode, status) values
  ('aaaaaaaa-0000-4000-8000-0000d9a90001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'Q-TD-A-PROV', 'google', 5, 'Business Starter', 3300, 'live', 'failed');

insert into public.join_requests (id, tenant_id, email, full_name, matched_by, status) values
  ('aaaaaaaa-0000-4000-8000-0000d9a50001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'newbie@example.in', 'New Bie', 'domain', 'pending_approval');

insert into public.inbound_purchases (id, tenant_id, source, subject, total, status) overriding system value values
  (-990001, 'aaaaaaaa-0000-0000-0000-0000000000d9', 'amazon', 'Your order', 1499, 'pending'),
  (-990002, 'aaaaaaaa-0000-0000-0000-0000000000d9', 'amazon', 'Booked already', 10, 'imported');

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date) values
  ('aaaaaaaa-0000-4000-8000-0000d9a60001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 'Business Starter', 'google', 5, 1350, 'active',
     (now() at time zone 'Asia/Kolkata')::date + 2),
  ('aaaaaaaa-0000-4000-8000-0000d9a60002', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 'Acme A', 'Far Away', 'google', 5, 1350, 'active',
     (now() at time zone 'Asia/Kolkata')::date + 90);

-- test_mode defaults to TRUE; a sandbox mandate halting is not a customer's money.
insert into public.payment_mandates (id, tenant_id, customer_id, requested_amount, status, status_note, test_mode) values
  ('aaaaaaaa-0000-4000-8000-0000d9a80001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 1350, 'paused', 'Razorpay subscription.halted', false),
  ('aaaaaaaa-0000-4000-8000-0000d9a80002', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'aaaaaaaa-0000-4000-8000-00000d9c0001', 1350, 'paused', 'sandbox', true);

insert into public.inbound_emails (id, tenant_id, message_id, from_email, subject, status) values
  ('aaaaaaaa-0000-4000-8000-0000d9ae0001', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'td-msg-1', 'buyer@example.in', 'Need 10 seats', 'received'),
  ('aaaaaaaa-0000-4000-8000-0000d9ae0002', 'aaaaaaaa-0000-0000-0000-0000000000d9', 'td-msg-2', 'noreply@example.in', 'Security alert', 'ignored');

insert into public.whatsapp_messages (tenant_id, contact_phone, direction, type, text_body, created_at) values
  ('aaaaaaaa-0000-0000-0000-0000000000d9', '+919800000001', 'outbound', 'text', 'Hello',           now() - interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-0000000000d9', '+919800000001', 'inbound',  'text', 'Price kya hai?',  now() - interval '1 hour'),
  -- Answered: last word is ours, so it is not work.
  ('aaaaaaaa-0000-0000-0000-0000000000d9', '+919800000002', 'inbound',  'text', 'Thanks',          now() - interval '2 hours'),
  ('aaaaaaaa-0000-0000-0000-0000000000d9', '+919800000002', 'outbound', 'text', 'Welcome',         now() - interval '1 hour');

-- Capture everything that needs the connection role BEFORE the switch (AGENTS.md L14).
do $$ begin
  perform set_config('td.owner_a', 'aaaaaaaa-0000-4000-8000-0000000d9a01', true);
  perform set_config('td.mgr_a',   'aaaaaaaa-0000-4000-8000-0000000d9a02', true);
  perform set_config('td.rep_a',   'aaaaaaaa-0000-4000-8000-0000000d9a03', true);
  perform set_config('td.owner_b', 'bbbbbbbb-0000-4000-8000-0000000d9b01', true);
  perform set_config('td.nobody',  'cccccccc-0000-4000-8000-0000000d9c01', true);
end $$;

-- ── Grants and shape (checked as the connection role, via proacl — AGENTS.md §5) ──
do $$
declare v_def boolean;
begin
  if has_function_privilege('anon', 'public.today_inbox()', 'execute') then
    raise exception 'FAIL grant: anon can execute today_inbox()';
  end if;
  if not has_function_privilege('authenticated', 'public.today_inbox()', 'execute') then
    raise exception 'FAIL grant: authenticated cannot execute today_inbox()';
  end if;
  select prosecdef into v_def from pg_proc where oid = 'public.today_inbox()'::regprocedure;
  if v_def then
    raise exception 'FAIL shape: today_inbox() is SECURITY DEFINER — it must be invoker so RLS applies';
  end if;
end $$;

set local role authenticated;

do $$
declare
  v_keys  text;
  v_cnt   int;
  v_first text;
  v_bad   int;
  v_old   int;
  v_new   int;
begin
  -- ── 1. Owner of A — the full list, ranked ─────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('td.owner_a'), 'role', 'authenticated')::text, true);
  if auth.uid()::text is distinct from current_setting('td.owner_a') then
    raise exception 'SETUP FAIL: auth.uid() is % — every assertion below would prove nothing', auth.uid();
  end if;

  select string_agg(kind || ':' || id, ',' order by kind, id), count(*)
    into v_keys, v_cnt
    from public.today_inbox();

  if v_keys is distinct from
       'approval:Q-TD-A-APPR,'
    || 'enquiry:aaaaaaaa-0000-4000-8000-0000d9ae0001,'
    || 'invoice_overdue:INV-TD-A-NEW,invoice_overdue:INV-TD-A-OLD,'
    || 'join_request:aaaaaaaa-0000-4000-8000-0000d9a50001,'
    || 'payment_failed:aaaaaaaa-0000-4000-8000-0000d9a80001,'
    || 'provisioning:aaaaaaaa-0000-4000-8000-0000d9a90001,'
    || 'purchase_inbox:-990001,'
    || 'renewal:aaaaaaaa-0000-4000-8000-0000d9a60001,'
    || 'task:aaaaaaaa-0000-4000-8000-0000d9a70001,'
    || 'whatsapp:+919800000001'
  then
    raise exception 'FAIL owner A: unexpected set [%] (% rows)', v_keys, v_cnt;
  end if;

  -- Ranking: the list comes back already ordered, priority never rises going down.
  select count(*) into v_bad from (
    select priority, lag(priority) over (order by rn) as prev
      from (select priority, row_number() over () as rn from public.today_inbox()) r
  ) x where prev is not null and priority > prev;
  if v_bad > 0 then
    raise exception 'FAIL ranking: % row(s) outrank the row above them', v_bad;
  end if;

  select kind into v_first from public.today_inbox() limit 1;
  if v_first is distinct from 'provisioning' then
    raise exception 'FAIL ranking: a failed activation (paid, not delivered) must lead; got %', v_first;
  end if;

  select priority into v_old from public.today_inbox() where id = 'INV-TD-A-OLD';
  select priority into v_new from public.today_inbox() where id = 'INV-TD-A-NEW';
  if not (v_old > v_new) then
    raise exception 'FAIL ranking: 45-day overdue (%) must outrank 5-day overdue (%)', v_old, v_new;
  end if;

  select count(*) into v_bad from public.today_inbox() where href is null or href not like '/%';
  if v_bad > 0 then
    raise exception 'FAIL: % row(s) with no in-app action link', v_bad;
  end if;

  if (select href from public.today_inbox() where id = 'INV-TD-A-OLD') <> '/invoices/INV-TD-A-OLD' then
    raise exception 'FAIL: overdue invoice must link to the invoice itself';
  end if;
  if (select title from public.today_inbox() where id = 'INV-TD-A-OLD') not like '%₹4,90,644%' then
    raise exception 'FAIL: rupees must be whole-rupee Indian grouping, got %',
      (select title from public.today_inbox() where id = 'INV-TD-A-OLD');
  end if;

  -- ── 2. Isolation, scoped to the OTHER tenant (AGENTS.md L7) ────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('td.owner_b'), 'role', 'authenticated')::text, true);
  select string_agg(kind || ':' || id, ','), count(*) into v_keys, v_cnt from public.today_inbox();
  -- Guard the guard: B must see ITS OWN invoice, or "no A rows" proves nothing.
  if v_keys is distinct from 'invoice_overdue:INV-TD-B-OLD' then
    raise exception 'FAIL owner B: expected only own overdue invoice, got [%] (% rows)', v_keys, v_cnt;
  end if;

  -- And A never sees B's.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('td.owner_a'), 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.today_inbox() where id like '%-B-%';
  if v_cnt <> 0 then
    raise exception 'FAIL isolation: owner A sees % of tenant B''s rows', v_cnt;
  end if;

  -- ── 3. Manager of A — cannot clear an OWNER-tier quote; can decide join requests ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('td.mgr_a'), 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.today_inbox() where kind = 'approval';
  if v_cnt <> 0 then
    raise exception 'FAIL manager: sees % approval(s) — the only one is owner-tier AND raised by them', v_cnt;
  end if;
  select count(*) into v_cnt from public.today_inbox() where kind = 'join_request';
  if v_cnt <> 1 then
    raise exception 'FAIL manager: should see the join request, got %', v_cnt;
  end if;
  select count(*) into v_cnt from public.today_inbox() where kind = 'task';
  if v_cnt <> 0 then
    raise exception 'FAIL manager: sees % task(s) that belong to other people', v_cnt;
  end if;

  -- ── 4. Rep of A — their own task; no decisions that are not theirs ─────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('td.rep_a'), 'role', 'authenticated')::text, true);
  select string_agg(id, ',') into v_keys from public.today_inbox() where kind = 'task';
  if v_keys is distinct from 'aaaaaaaa-0000-4000-8000-0000d9a70002' then
    raise exception 'FAIL rep: expected exactly their own task due today, got [%]', v_keys;
  end if;
  select count(*) into v_cnt from public.today_inbox() where kind in ('approval', 'join_request');
  if v_cnt <> 0 then
    raise exception 'FAIL rep: offered % decision(s) their role cannot take', v_cnt;
  end if;

  -- ── 5. Signed in, member of no workspace → nothing, not an error ───────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('td.nobody'), 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.today_inbox();
  if v_cnt <> 0 then
    raise exception 'FAIL no-workspace caller: got % row(s), expected none', v_cnt;
  end if;

  raise notice 'PASS today_inbox: ranked set for owner, tenant B isolated both ways, manager/rep role filters, no-workspace caller empty';
end $$;

rollback;
