-- ============================================================================
-- 0170 — Optional proof-of-payment attachment on a payment row.
--
-- Stores the storage PATH (not a public URL) of an uploaded receipt
-- (screenshot / PDF) in the private `documents` bucket, tenant-foldered at
--   {tenant_id}/payments/{payment_id}-{name}
-- Nullable; an audit/reference aid only. The bucket + its tenant-isolating RLS
-- already exist (0107_documents_vault.sql) — reused as-is, no new bucket.
-- Viewers mint a short-lived signed URL (bucket is private).
--
-- Upload is best-effort: the record-payment flow only attaches AFTER
-- record_payment has succeeded, so a failed upload never blocks the money.
-- ============================================================================

alter table public.payments
  add column if not exists receipt_file_path text;

comment on column public.payments.receipt_file_path is
  'Optional proof-of-payment file path in the private documents bucket ({tenant_id}/payments/{payment_id}-{name}). Nullable; view via signed URL.';
