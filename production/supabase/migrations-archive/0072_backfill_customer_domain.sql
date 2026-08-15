-- 0072_backfill_customer_domain.sql
-- Backfill customers.domain ("Company website") from each customer's primary
-- subscription domain, where it is currently empty.
--
-- Why: the Zoho customer import did not carry a website, so customers.domain is
-- blank for everyone, while every subscription DOES carry the Workspace/service
-- domain. For these B2B Google Workspace customers the service domain IS the
-- company domain, so it's the correct value to surface as "Company website" and
-- it lets the Google reconciliation match by domain going forward.
--
-- Safe + idempotent: only fills blanks (never overwrites a real value), picks one
-- domain deterministically per customer (largest/most-recent subscription).
UPDATE customers c
SET domain = sub.domain
FROM (
  SELECT DISTINCT ON (customer_id) customer_id, domain
  FROM subscriptions
  WHERE domain IS NOT NULL AND trim(domain) <> ''
  ORDER BY customer_id, seats DESC NULLS LAST, start_date DESC NULLS LAST
) sub
WHERE c.id = sub.customer_id
  AND (c.domain IS NULL OR trim(c.domain) = '');
