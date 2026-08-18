-- 20260819130000_backfill_feedback_from_tickets
--
-- Move the four real reports out of the customer support queue and into the feedback
-- queue where they belong.
--
-- ─── WHAT IS ACTUALLY IN support_tickets RIGHT NOW ──────────────────────────
-- Measured before writing this: the table has 4 rows, and all 4 of them are internal
-- bug reports filed by the team through the Ctrl+Shift+B dialog. There has never been a
-- real customer ticket. Every one of them therefore sits in a table that carries an SLA
-- clock (20260817170000) and a per-tier call allowance (20260817180000), aimed at
-- answering a paying customer — which is not what any of them is.
--
-- ─── NOTHING IS DELETED ─────────────────────────────────────────────────────
-- The `support_tickets` rows are left exactly as they are. Two reasons, and the second
-- is the one that matters:
--
--   1. This runs against production. A copy is reversible by deleting what it copied;
--      a move is not reversible at all if the extraction below turns out to be wrong.
--   2. Closing or removing a ticket is a decision about a queue somebody may be
--      watching, and that is Pardeep's call, not a migration's. The duplication is
--      visible and easy to resolve later; a deletion is neither.
--
-- ─── THE EXTRACTION, AND WHY IT IS position() AND NOT A REGEX ───────────────
-- The old dialog wrote a fixed-shape text blob:
--
--     REPORTER: Darshan (Sales) (sales@anutech.in)
--     PAGE URL: /quotes/Q-ADPL-2026-27-0002
--     TYPE: bug
--     PRIORITY: medium
--     ...
--     DESCRIPTION:
--     NOT JENERATED INVIOCE
--
--     ATTACHMENT_1: BILLING 6 MONTH.png
--     DATA_URL_1: data:image/png;base64,iVBORw0…
--
-- Two things were got wrong on the first attempt at parsing it, both caught by running
-- the SELECT before the INSERT:
--
--   * `REPORTER: ([^(]*) \(` pulled the email as **"Sales"**, because the display name
--     is itself "Darshan (Sales)" and the first bracket is not the address. The email is
--     the LAST parenthesised group on the line, so that is what is matched.
--   * A non-greedy `.*?` up to `ATTACHMENT_1:` swallowed the whole base64 payload and
--     returned a 45,127-character "description". Postgres decides greediness from the
--     first quantifier in the expression, so mixing greedy and non-greedy there does not
--     do what it looks like it does. `position()` has no such subtlety, and a reader can
--     see exactly where the cut lands.
--
-- ─── SCREENSHOTS ARE NOT CARRIED OVER ───────────────────────────────────────
-- The images exist only as base64 inside the old ticket bodies. SQL cannot decode one
-- and push it into Supabase Storage, so no `feedback_screenshots` rows are created here.
-- The originals remain in the ticket rows and nothing is lost; the backfilled reports
-- simply show no thumbnail. Stated rather than left to be discovered, because a report
-- whose screenshot silently vanished looks like a broken feature.
--
-- ─── TRIAGE IS LEFT PENDING, DELIBERATELY ───────────────────────────────────
-- `triage_status` stays 'pending'. The triage engine lives in TypeScript, not in the
-- database, so writing a directive here would mean maintaining a second copy of the
-- scoring rules in SQL — a second source of truth for the number that decides queue
-- order. /admin/feedback triages them on demand instead.

begin;

with parsed as (
  select
    st.id,
    st.tenant_id,
    st.created_at,
    split_part(split_part(st.body, 'REPORTER: ',    2), E'\n', 1) as reporter_line,
    split_part(split_part(st.body, E'PAGE URL: ',   2), E'\n', 1) as page_path,
    lower(split_part(split_part(st.body, E'\nTYPE: ',     2), E'\n', 1)) as rtype,
    lower(split_part(split_part(st.body, E'\nPRIORITY: ', 2), E'\n', 1)) as rsev,
    /* 13 = length('DESCRIPTION:') + 1, i.e. start just past the newline after it. */
    substr(st.body, position('DESCRIPTION:' in st.body) + 13) as after_desc
  from public.support_tickets st
  where position('DESCRIPTION:' in st.body) > 0
    and position(E'\nPAGE URL: ' in st.body) > 0   -- shape check: it came from the dialog
), cut as (
  select
    p.*,
    btrim(
      case when position(E'\nATTACHMENT_' in p.after_desc) > 0
           then left(p.after_desc, position(E'\nATTACHMENT_' in p.after_desc) - 1)
           else p.after_desc
      end
    ) as description
  from parsed p
)
insert into public.feedback (
  id, tenant_id, reported_type, reported_severity, title, body,
  page_path, reported_by, reporter_name, reporter_email,
  triage_status, status, created_at, updated_at
)
select
  /* The ticket's own id, so re-running this cannot create a second copy and so the two
     rows can always be matched back to each other. support_tickets.id is `text` but
     every value is a uuid; a row that is not would fail the cast loudly rather than
     land somewhere wrong. */
  c.id::uuid,
  c.tenant_id,
  case when c.rtype in ('bug', 'feature', 'ui_improvement') then c.rtype else 'bug' end,
  case when c.rsev  in ('low', 'medium', 'high', 'critical') then c.rsev  else 'medium' end,
  left(split_part(c.description, E'\n', 1), 200),
  c.description,
  nullif(btrim(c.page_path), ''),
  u.id,
  nullif(btrim(regexp_replace(c.reporter_line, '\s*\([^()]*\)\s*$', '')), ''),
  lower(nullif(btrim(substring(c.reporter_line from '\(([^()]*)\)\s*$')), '')),
  'pending',
  'open',
  c.created_at,
  now()
from cut c
/* Match the reporter to a login by email so the queue can say who to go back to.
   Left join: a report from someone with no users row still lands, with a null link. */
left join public.users u
  on lower(u.email) = lower(btrim(substring(c.reporter_line from '\(([^()]*)\)\s*$')))
 and u.tenant_id = c.tenant_id
where btrim(c.description) <> ''
on conflict (id) do nothing;

commit;

-- ─── VERIFY (run separately — a SELECT inside the same transaction reports on a
--     change that has not committed yet; CLAUDE.md §25.6) ─────────────────────
-- select count(*) as backfilled from public.feedback;                 -- expect 4
-- select count(*) as still_in_tickets from public.support_tickets;    -- expect 4, untouched
-- select title, page_path, reporter_email, length(body) as len
--   from public.feedback order by created_at;                         -- no len in the 45,000s
