-- ═══════════════════════════════════════════════════════════════════════════
-- ai_telecall_logs — move the "a call is about something" rule from a CHECK to
-- a BEFORE INSERT trigger, because as a CHECK it broke DELETE.
--
-- ─── THE BUG, AND HOW IT WAS FOUND ──────────────────────────────────────────
-- 20260825120000 shipped both of these, one page apart, without noticing they fight:
--
--   constraint ai_telecall_logs_has_subject
--     check (lead_id is not null or subscription_id is not null)
--
--   constraint ai_telecall_logs_lead_fk ... on delete set null (lead_id)
--
-- Delete a lead that has been rung and Postgres runs
-- `UPDATE ai_telecall_logs SET lead_id = NULL`. For a lead-only call that leaves BOTH
-- subject columns null, the CHECK fires, and the DELETE is **refused outright**:
--
--   23514: new row for relation "ai_telecall_logs" violates check constraint
--          "ai_telecall_logs_has_subject"
--   CONTEXT: SQL statement "UPDATE ONLY ... SET lead_id = NULL"
--
-- Which is the exact failure the column list on SET NULL exists to prevent — the same
-- shape, reintroduced through a different door, one screen below the comment explaining it.
-- Caught by `supabase/tests/ai_telecalling_tenant_isolation.test.sql` test 3 on the first
-- run against production, before any row existed. It would otherwise have appeared the first
-- time somebody deleted a lead that had been called, as a DELETE that simply refuses.
--
-- ─── WHY A TRIGGER AND NOT JUST DROPPING THE RULE ───────────────────────────
-- The rule is still worth having: a row with no lead and no subscription, written that way,
-- is a call nobody can act on. What was wrong is WHEN it was enforced. A CHECK is a statement
-- about the row for the rest of its life; the actual requirement is about the moment it is
-- written. After the lead is deleted, a row with neither is not a mistake — it is the
-- intended end state, and `phone_number` and `transcript` are still on it. That was the
-- design all along ("a record of a phone call placed to a real person is not deletable
-- bookkeeping"); the CHECK contradicted it.
--
-- So: BEFORE INSERT only. UPDATE is deliberately not covered — the FK's SET NULL is an
-- UPDATE, and covering it would recreate the bug exactly.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table public.ai_telecall_logs
  drop constraint if exists ai_telecall_logs_has_subject;

create or replace function public.ai_telecall_logs_require_subject()
returns trigger language plpgsql as $$
begin
  if new.lead_id is null and new.subscription_id is null then
    /* Phrased as a next step, per CLAUDE.md §24 — a guard that only says "not allowed"
       leaves the caller with nowhere to go. */
    raise exception
      'A call must be about a lead or a subscription. Pass lead_id for a qualification call '
      'or subscription_id for a renewal call — a row with neither cannot be shown on any '
      'screen or acted on.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_telecall_logs_require_subject_trg on public.ai_telecall_logs;
create trigger ai_telecall_logs_require_subject_trg
  before insert on public.ai_telecall_logs
  for each row execute function public.ai_telecall_logs_require_subject();

comment on function public.ai_telecall_logs_require_subject() is
  'Enforced at INSERT only, never on UPDATE. The composite FKs null lead_id / subscription_id '
  'when their target is deleted, and that is an UPDATE — a rule covering it would refuse the '
  'DELETE, which is the bug this migration fixes.';

commit;
