-- ============================================================================
-- 0162 — Invoice UX (Zoho-Books-style): payment terms + terms & conditions
--
-- `payment_terms_days`  — net days used to compute the invoice DUE DATE
--                          (Due on Receipt = 0, Net 15 / 30 / 45). Null → 30.
--                          Consumed by generate_invoice (migration 0163).
-- `terms_conditions`    — document-level T&C text shown on the quote / invoice
--                          PDF, separate from the customer-facing `notes`.
--
-- Both additive + nullable; no existing behaviour changes until the builder
-- writes them. Money-safe.
-- ============================================================================

alter table quotes
  add column if not exists payment_terms_days integer,
  add column if not exists terms_conditions   text;
