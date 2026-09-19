begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- What IP do we call out from? — the first question when an upstream starts refusing.
--
-- Ported from the DMS engine's `IPCheck` model (67 lines) on 10 Sep 2026. Last
-- of the five zero-row DMS features.
--
-- ─── WHY THIS IS NOT THE LOWEST-VALUE ONE AFTER ALL ──────────────────────────
-- TASKS.md called it "sabse kam value" and reading the two integrations changed
-- my mind. BOTH of them gate on our egress IP, and BOTH fail in a way that does
-- not name it:
--
--   · `lib/resellerclub/index.ts` — "Works only from the whitelisted egress IP
--     (34.14.190.227 — the static NAT)". RC answers a non-allowlisted caller with
--     an error whose text has to be read to tell it from a bad key.
--   · `lib/directadmin/index.ts` — "DA checks the CALLING IP against its own
--     allowlist; our static NAT IP must be on it, or DA answers with an HTML
--     login page". Which is indistinguishable, at a glance, from wrong
--     credentials.
--
-- So when either integration goes dark, the first question is "has our egress IP
-- changed?" — and until now nothing in the app could answer it. That is a
-- diagnosis worth minutes when a paid domain order is failing.
--
-- ─── THE IMPROVEMENT ON DMS: SAY WHETHER IT MATCHES ──────────────────────────
-- DMS recorded the IP and left the comparison to whoever read the JSON. The
-- useful signal is not the address, it is whether the address is the one the
-- upstreams have been told to expect. `expected_ip` and `matched` are on the row
-- so a history answers "when did this change?" rather than "what was it on the
-- 3rd?".
--
-- ─── AND WHY CONSENSUS, NOT THE FIRST ANSWER ─────────────────────────────────
-- DMS probed four services and took the first that replied. A Cloud Run service
-- can legitimately egress from more than one address, and one probe answering
-- differently from another is itself the finding — so a disagreement is recorded
-- as such rather than resolved by whichever service was fastest.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.egress_ip_checks (
  id uuid primary key default gen_random_uuid(),
  /* Nullable: this is infrastructure, not tenant data, and a check run before
     any session exists (a cron, a bring-up script) still belongs in the record. */
  tenant_id uuid references public.tenants(id) on delete set null,

  /* What the probes agreed on. NULL when they disagreed or none answered —
     `verdict` says which. Never a guess. */
  observed_ip inet,
  /* Every distinct address any probe reported, in the order first seen. More
     than one entry IS the interesting case. */
  observed_ips inet[] not null default '{}',

  /* What the upstreams have been told to allow, at the time of the check. Kept on
     the row rather than looked up later, because the answer to "was this right in
     September?" must not change when somebody edits a config in November. */
  expected_ip inet,

  /* 'match'      — one address, and it is the expected one
     'mismatch'   — one address, and it is NOT the expected one. Upstreams will
                    be refusing us; this is the actionable state.
     'disagree'   — probes reported different addresses. Possible on a service
                    with more than one egress path, and worth seeing.
     'unknown'    — no probe answered, so nothing was established. NOT a
                    mismatch: an unreachable probe says nothing about our IP.
     'unverified' — an address was observed but nothing is configured to compare
                    it against, so there is no claim to make about it. */
  verdict text not null check (verdict in ('match', 'mismatch', 'disagree', 'unknown', 'unverified')),

  /* Per-probe detail: which service said what, and how long it took. JSONB
     because the set of probes is a code decision that will change, and a column
     per service would need a migration each time. */
  probes jsonb not null default '[]'::jsonb,

  /* Who asked. NULL for a scheduled check. */
  checked_by uuid references public.users(id) on delete set null,
  checked_at timestamptz not null default now()
);

/* An address with no expectation cannot be a match or a mismatch, and an
   expectation with no address cannot be either. Enforced rather than trusted,
   because `matched` on a screen is the whole output of this feature. */
alter table public.egress_ip_checks drop constraint if exists eic_verdict_consistent;
alter table public.egress_ip_checks add constraint eic_verdict_consistent check (
  (verdict in ('match', 'mismatch') and observed_ip is not null and expected_ip is not null)
  or (verdict = 'unverified' and observed_ip is not null and expected_ip is null)
  or (verdict = 'unknown'    and observed_ip is null)
  or (verdict = 'disagree'   and observed_ip is null and array_length(observed_ips, 1) > 1)
);

/* "When did this change?" — the only query this table is for. */
create index if not exists eic_recent on public.egress_ip_checks (checked_at desc);
/* The actionable ones, for a digest or a banner. */
create index if not exists eic_problems on public.egress_ip_checks (checked_at desc)
  where verdict in ('mismatch', 'disagree');

alter table public.egress_ip_checks enable row level security;

/* Any signed-in staff member may read. Deliberately NOT tenant-scoped for
   reading: the egress IP is a property of the deployment, shared by every
   tenant on it, and a reseller diagnosing a failing domain order should not be
   blocked because the last check happened to be run by somebody else. */
drop policy if exists eic_select on public.egress_ip_checks;
create policy eic_select on public.egress_ip_checks
  for select using (exists (select 1 from public.users where id = auth.uid()));

/* No insert policy: rows are written server-side by the route, which is where
   staff-only is enforced and where the probes actually run. */

comment on table public.egress_ip_checks is
  'History of the outbound IP this deployment calls upstreams from. Both ResellerClub and DirectAdmin gate on it and neither names it when refusing. See lib/ops/egress-ip.ts.';
comment on column public.egress_ip_checks.verdict is
  'match | mismatch | disagree | unknown | unverified. `unknown` means no probe answered and is NOT a mismatch — an unreachable probe says nothing about our IP.';

commit;
