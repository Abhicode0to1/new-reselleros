-- ============================================================================
-- Support plans are add-ons, not main products — 2 Oct 2026.
--
-- Pardeep: "Support plans add ons hai". 20260817160000_support_tier_skus.sql seeded the six
-- SUP-* items per tenant with kind = 'main', so a support tier sat beside Google Workspace
-- as if it were a product of its own. kind is not cosmetic: the AI sales agent reads every
-- active kind='main' item with a price as something it may offer on its own
-- (lib/ai/sales-agent.server.ts, lib/items/agent-sellable.ts), and it does not filter by
-- vendor — so "Standard Support ₹999" was in its sellable list. Support is sold WITH a
-- product (items.covered_product, 20260817190000), which is what an add-on is.
--
-- Data only; idempotent. Nothing in the app branches on a support item being 'main'.
-- ============================================================================
begin;

update public.items
   set kind = 'addon'
 where vendor = 'support'
   and kind is distinct from 'addon';

commit;
