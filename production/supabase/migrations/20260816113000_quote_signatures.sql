-- 20260816113000_quote_signatures
--
-- WHAT THIS ADDS
--   `quote_signatures` — the record of a customer clicking to accept a quote online:
--   who typed their name, from which IP, in which browser, at what time, and exactly
--   what they were looking at when they did it.
--
-- WHAT THIS IS AND IS NOT, STATED PLAINLY
--   This is a CLICK-TO-SIGN ACKNOWLEDGEMENT. It is evidence of assent: a named person
--   confirmed a specific set of figures at a specific moment from a specific address.
--
--   It is NOT a digital signature under the Indian IT Act 2000 — that requires a
--   Digital Signature Certificate from a licensed CA, which nothing here issues or
--   verifies. Calling this an e-signature in the legal sense would be exactly the kind
--   of confident-sounding claim this codebase keeps finding and removing. The UI copy
--   says "confirm", not "legally sign", for the same reason.
--
-- WHY signed_snapshot IS STORED
--   A signature that points at a mutable row proves nothing: the quote can be edited
--   afterwards and the record still says "accepted". The snapshot freezes the lines and
--   the total AS SHOWN, so what was agreed is recoverable even if the quote changes.
--   Same principle as approved_discount_bps on quotes — an approval is for numbers, not
--   for a row.
--
-- WHY THE IP IS KEPT AND WHAT THAT COSTS
--   An IP address is personal data. It is kept because it is the only thing that
--   distinguishes "the buyer confirmed this" from "someone with the link did", and it
--   is the first thing asked for in a dispute. It is never shown to other tenants — RLS
--   scopes every read to the quote's own tenant — and it is deliberately NOT indexed,
--   because nothing should be querying customers by IP address.
--
-- HOW TO VERIFY (SEPARATE run from the DDL — AGENTS.md §5):
--
--   select count(*) from public.quote_signatures;                       -- expect 0
--   select policyname from pg_policies where tablename='quote_signatures';
--   -- expect a tenant-scoped select policy

begin;

create table if not exists public.quote_signatures (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  quote_id       text not null references public.quotes(id) on delete cascade,
  signer_name    text not null,
  signer_email   text,
  signer_title   text,
  /* inet, not text — a malformed address fails at write time rather than sitting in
     the record looking like evidence. */
  signer_ip      inet,
  user_agent     text,
  /* The lines and total exactly as the customer saw them. See the header. */
  signed_snapshot jsonb not null default '{}'::jsonb,
  signed_at      timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

comment on table public.quote_signatures is
  'Click-to-sign acknowledgements on public quote pages. Evidence of assent, NOT a digital signature under the IT Act 2000 (that needs a DSC from a licensed CA). See the migration header.';
comment on column public.quote_signatures.signed_snapshot is
  'The lines and total AS SHOWN at signing. A signature pointing at a mutable row proves nothing — the quote can be edited afterwards and still read "accepted".';
comment on column public.quote_signatures.signer_ip is
  'Deliberately not indexed. Kept because it is the first thing asked for in a dispute; nothing should be querying customers by IP.';

create index if not exists quote_signatures_quote_idx on public.quote_signatures (quote_id);
create index if not exists quote_signatures_tenant_idx on public.quote_signatures (tenant_id, signed_at desc);

alter table public.quote_signatures enable row level security;

-- Read: the owning tenant only. The public page WRITES through the service role (the
-- customer has no session at all), so there is deliberately no public insert policy —
-- an anon-insertable signature table is a table anyone can forge rows in.
drop policy if exists quote_signatures_select on public.quote_signatures;
create policy quote_signatures_select on public.quote_signatures
  for select
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

commit;
