-- 0115 — opaque public token for customer-facing quote links (SEC-1).
--
-- The public quote pages (/quote/[id]/accept + POST /api/public/quote/[id]/accept)
-- used the quote's own id as the "secret". But quote ids are SEQUENTIAL document
-- numbers (Q-ET-2026-27-0001, -0002, …), so anyone who received one link could
-- enumerate a reseller's other quotes — read customers' amounts/line-items AND
-- force-accept them — with no auth. This adds an unguessable per-quote token;
-- the public routes now require ?t=<token> and match it to this column.
--
-- gen_random_uuid() is volatile → each existing row gets its own distinct token
-- on the rewrite. New rows default to a fresh token.

alter table public.quotes
  add column if not exists public_token uuid not null default gen_random_uuid();

create unique index if not exists quotes_public_token_key
  on public.quotes(public_token);
