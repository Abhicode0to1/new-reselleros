begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- Remove `tenants.markup_bps` — this app had already solved the problem, better.
--
-- Added yesterday (20260910120000) as part of porting DMS's `Reseller` model,
-- and removed today before anything used it, because wiring it up would have
-- CORRUPTED CUSTOMER TOTALS rather than filled a gap.
--
-- ─── WHAT THE MEASUREMENT SHOWED ─────────────────────────────────────────────
-- `items` is tenant-scoped and carries BOTH prices per item:
--
--     wholesale   what the item costs this tenant
--     msrp        what this tenant sells it for
--     margin_pct  GENERATED from the two
--
-- A real row on this database:
--
--     Google Workspace Enterprise — wholesale ₹2,050, msrp ₹2,400, margin 14%
--
-- So a reseller's margin is already expressed, PER ITEM, which is strictly more
-- granular than one percentage across a whole catalogue. And when a reseller
-- imports a distributor's partner-visible item, the distributor's
-- `partner_price` becomes the reseller's `wholesale` — the reseller then sets
-- `msrp` themselves. The loop is closed without a markup anywhere in it.
--
-- Quotes and invoices price from `items.msrp`, which is ALREADY RETAIL. Applying
-- 2.5% on top of that Enterprise line would have charged the customer ₹2,460
-- while the reseller's intended ₹350 was already inside the ₹2,400. Not a
-- rounding argument — a double count, on every line, silently.
--
-- The public storefront could not have used it either: it is pinned to a single
-- tenant (`BUY_PAGE_TENANT_ID`), so a public request has no reseller context to
-- take a markup from.
--
-- ─── WHY DMS NEEDED IT AND WE DO NOT ─────────────────────────────────────────
-- DMS had ONE shared catalogue. A reseller there could not set their own price,
-- so a percentage was the only way to express their cut. This app gave every
-- tenant its own catalogue, which makes the percentage redundant. The column was
-- ported faithfully without first checking whether the problem it solved still
-- existed. That check is the missing step, and it is recorded here rather than
-- quietly reverted.
--
-- ─── AND WHY DROPPING BEATS LEAVING IT INERT ─────────────────────────────────
-- An unused column that looks like a price control is worse than no column: it
-- reads as a lever somebody has, and the next person to find it will wire it up.
-- Same reasoning as `compliance.send` being removed from AI_ACTIONS rather than
-- declared and ignored — "a registry entry nobody enforces is worse than no
-- entry". Nothing outside its own module and tests ever read this, so there is
-- no data to preserve and no caller to migrate.
--
-- If a flat-percentage model is ever wanted — for a reseller who does not want
-- to maintain a catalogue at all — it needs the per-reseller storefront that
-- `tenants.slug` was added for and which does not exist yet. That is a feature
-- decision with a surface to build, not a column to leave lying around.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tenants drop column if exists markup_bps;

commit;
