-- 0103: split the catalog into subscription vs one-time items.
--
-- Until now every `items` row was a recurring cloud subscription (per-seat/mo).
-- We also sell one-off products/services (custom software, setup, AMC, data
-- migration…). A new item_type separates the two so the Items screen can show
-- a "Subscription catalog" and a "One-time items" catalog, and so project
-- quotations can pull from the one-time list.
--
-- All existing rows are subscriptions.

alter table public.items
  add column if not exists item_type text not null default 'subscription'
    check (item_type in ('subscription', 'one_time'));

-- Existing rows stay 'subscription' via the default. One-time items will carry
-- item_type='one_time', vendor='other', kind='main', prices={} (flat price in
-- msrp/wholesale), and an HSN/SAC code.
