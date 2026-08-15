-- ============================================================================
-- 0164 — Customer form parity with Zoho Books (Pardeep, Aug 2026)
--
-- Adds, all additive + nullable (no behaviour change until the form writes them):
--   contact_salutation / contact_first_name / contact_last_name / contact_mobile
--       — split the primary contact person (Zoho stores name in parts). The
--         existing `contact_name` stays as the combined display value.
--   contact_persons jsonb  — ADDITIONAL people at the customer (array of
--         {salutation, first_name, last_name, email, phone, mobile, designation}).
--   payment_terms_days integer — the customer's DEFAULT invoice due terms
--         (Net 15/30/45); the invoice builder pre-fills from this.
--   shipping_address jsonb — a separate shipping address
--         {attention, address, city, state, zip, country}; billing stays the
--         existing flat columns (address / state / pin_code / country).
-- ============================================================================

alter table customers
  add column if not exists contact_salutation text,
  add column if not exists contact_first_name  text,
  add column if not exists contact_last_name   text,
  add column if not exists contact_mobile      text,
  add column if not exists contact_persons     jsonb not null default '[]'::jsonb,
  add column if not exists payment_terms_days  integer,
  add column if not exists shipping_address    jsonb;
