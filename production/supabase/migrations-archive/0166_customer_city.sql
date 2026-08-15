-- ============================================================================
-- 0166 — Customer billing city (Pardeep, Aug 2026)
--
-- The billing address only had a free-text `address` line + `state` + `pin_code`
-- — no dedicated city. Add it so the billing address is complete + structured
-- (Address → City → State → PIN/ZIP), matching the shipping block. Additive +
-- nullable; nothing to backfill.
-- ============================================================================

alter table customers
  add column if not exists city text;
