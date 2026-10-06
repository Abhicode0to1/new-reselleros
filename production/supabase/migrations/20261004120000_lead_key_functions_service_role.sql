-- 4 Oct 2026 — public forms could not create a lead on Cloud SQL.
--
-- 20260929130000_lead_counts and 20260930200000_deal_totals_billing_cycle_dup_check built
-- expression indexes on public.leads that call lead_norm_phone / _company / _email /
-- _gstin, and granted those functions to `authenticated` only. Inserting a row evaluates
-- every index expression AS THE INSERTING ROLE, and the website's enquiry, trial and
-- call-back routes insert as `service_role`, which on Cloud SQL has no BYPASSRLS and no
-- blanket function grants. Result on live:
--   "permission denied for function lead_norm_phone" -> HTTP 500, lead not saved
--   (and, once that was granted, the same for lead_norm_email).
-- Found by Pardeep's trial-form test, 4 Oct 2026 09:44 UTC (the only failures in 10 days).
--
-- Only the pure key helpers are granted — the user-facing RPCs that authenticated can
-- call (list_leads, reports …) read auth.uid() and are NOT meant for service_role.
-- ⚠ A new expression index on leads must grant its function to service_role too.
grant execute on function public.lead_norm_phone(text) to service_role;
grant execute on function public.lead_norm_company(text) to service_role;
grant execute on function public.lead_norm_email(text) to service_role;
grant execute on function public.lead_norm_gstin(text) to service_role;
grant execute on function public.lead_looks_like_junk(text, text, text, text) to service_role;
