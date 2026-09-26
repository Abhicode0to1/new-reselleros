-- ═══════════════════════════════════════════════════════════════════════════
-- Provisioning: one request per PRODUCT in a paid quote, not one per quote.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 24 Sep 2026, enabling the site cart (owner decisions 19-21). A single cart
-- payment can buy a domain AND a hosting account — the site sells exactly that
-- bundle. With one request per quote, the webhook had to pick one vendor, and it
-- picked hosting: the paid domain was queued for nobody. A registration that was
-- paid for and never made is the worst failure available here, because the
-- customer believes they own the name.
--
-- The index keeps what the old one was for. A re-delivered Razorpay event still
-- produces the SAME (quote, vendor, domain) key and still hits 23505, so nothing
-- is ever activated twice. It only stops two DIFFERENT products in one quote
-- from colliding. `coalesce(lower(domain), '')` makes a request with no domain
-- (e.g. a Workspace licence before the customer has named one) a single key too.
--
-- Run in small batches (AGENTS.md §5). Verify in a SEPARATE run, not here.

begin;

drop index if exists public.provisioning_requests_one_per_quote;

create unique index if not exists provisioning_requests_one_per_product
  on public.provisioning_requests (tenant_id, quote_id, vendor, (coalesce(lower(domain), '')));

comment on index public.provisioning_requests_one_per_product is
  'One activation per product in a paid quote: (quote, vendor, domain). A re-delivered '
  'payment event maps to the same key and is refused (23505), so nothing is provisioned '
  'twice; a domain and a hosting account bought together each get their own request.';

commit;
