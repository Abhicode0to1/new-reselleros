-- 0063_auto_renew_not_customer_facing.sql
-- Product decision: auto-renew is NOT a customer-facing control.
--
-- 0062 added set_subscription_auto_renew so the portal toggle would work. On
-- review, a customer-facing "auto-renew" is wrong for a manual-pay model:
--   • there is no stored-card autopay, so "auto-renew ON" falsely implies
--     auto-charge — a customer relying on it would get suspended on non-payment;
--   • a silent customer toggle to OFF = silent churn the reseller never sees,
--     and (RN-24) the sub doesn't even expire.
-- The portal now shows renewal mode read-only and routes cancellation through an
-- explicit request (ticket). So customers must not be able to flip auto_renew
-- via the API either. Revoke the `authenticated` grant; keep it for service_role
-- (operator tooling / a future real-autopay flow).

revoke execute on function public.set_subscription_auto_renew(uuid, boolean) from authenticated;
