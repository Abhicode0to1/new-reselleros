-- Merge brick #4: hosting and domain sales can now reach the provisioning queue.
--
-- Bricks #1/#2 made hosting and domains sellable from this app's own catalogue,
-- and #3 put them through the quote → payment → invoice spine. What happened
-- next was nothing: `provisioning_requests.vendor` only permitted google,
-- microsoft, zoho and other, so a paid hosting or domain order was filed under
-- 'other' and told the desk it is "activated in the vendor's own console" —
-- which is wrong. There IS an engine for these (DirectAdmin for hosting,
-- ResellerClub for domains, both behind app.anutech.in); it is simply not
-- connected to this app yet. Naming the vendor correctly is what lets the queue
-- say the true next step instead of a misleading one.
--
-- This ONLY widens the allowed set. It does not provision anything: a paid
-- hosting/domain order is still queued for a person (see
-- lib/provisioning/provisioning.ts). Registering a domain spends real money and
-- cannot be undone, so nothing here moves that decision closer to automatic —
-- the test-mode payment gate in that module applies to these vendors too.

alter table public.provisioning_requests
  drop constraint if exists provisioning_requests_vendor_check;

alter table public.provisioning_requests
  add constraint provisioning_requests_vendor_check
  check (vendor = any (array[
    'google'::text, 'microsoft'::text, 'zoho'::text,
    'hosting'::text, 'domain'::text,
    'other'::text
  ]));
