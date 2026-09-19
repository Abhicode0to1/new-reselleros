-- ============================================================
-- ResellerOS — seed data for development / demo
-- ============================================================
-- Run ONLY in dev/staging. Production starts with empty tables + setup wizard.
--
-- After running this, you need to ALSO create an auth user (Pardeep) via
-- the Supabase dashboard or the signup flow, then UPDATE public.users
-- to link that auth.users.id to the seeded tenant.
--
-- See SETUP.md "Seeding" section.
-- ============================================================

-- Tenant 1: Excel Technologies
insert into public.tenants (id, name, gstin, state, state_code, address, email, phone) values
('11111111-1111-1111-1111-111111111111',
 'Excel Technologies Pvt Ltd',
 '27AABCE9876D1Z3',
 'Maharashtra',
 '27',
 'Mumbai, Maharashtra 400001',
 'pardeep@exceltechnologies.in',
 '+91 98765 00000');

-- Items catalog (from prototype data.js)
insert into public.items (id, tenant_id, name, vendor, hsn, msrp, wholesale) values
('GW-STR',   '11111111-1111-1111-1111-111111111111', 'Google Workspace Starter',     'google',    '998313', 136,  110),
('GW-STD',   '11111111-1111-1111-1111-111111111111', 'Google Workspace Standard',    'google',    '998313', 736,  620),
('GW-PLS',   '11111111-1111-1111-1111-111111111111', 'Google Workspace Plus',        'google',    '998313', 1380, 1150),
('GW-ENT',   '11111111-1111-1111-1111-111111111111', 'Google Workspace Enterprise',  'google',    '998313', 2400, 2050),
('GV-STD',   '11111111-1111-1111-1111-111111111111', 'Google Voice Standard',        'google',    '998313', 800,  680),
('GV-PRM',   '11111111-1111-1111-1111-111111111111', 'Google Voice Premier',         'google',    '998313', 1600, 1380),
('M365-BB',  '11111111-1111-1111-1111-111111111111', 'Microsoft 365 Business Basic',    'microsoft', '998313', 200,  165),
('M365-BS',  '11111111-1111-1111-1111-111111111111', 'Microsoft 365 Business Standard', 'microsoft', '998313', 990,  820),
('M365-BP',  '11111111-1111-1111-1111-111111111111', 'Microsoft 365 Business Premium',  'microsoft', '998313', 1900, 1620),
('ZW-STD',   '11111111-1111-1111-1111-111111111111', 'Zoho Workplace Standard',      'zoho',      '998313', 120,  95),
('ZW-PRO',   '11111111-1111-1111-1111-111111111111', 'Zoho Workplace Professional',  'zoho',      '998313', 280,  220),
('GW-APP-C', '11111111-1111-1111-1111-111111111111', 'AppSheet Core',                'google',    '998313', 830,  720);

-- Customers
insert into public.customers (id, tenant_id, name, domain, gstin, state, state_code, health,
                              contact_name, contact_title, contact_email, contact_phone, since) values
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'Acme Corp Pvt Ltd',     'acmecorp.com',     '27AABCS1234D1Z5', 'Maharashtra', '27', 85, 'Rajesh K',    'CTO',              'rajesh@acmecorp.com',     '+91 98765 43210', '2023-09-15'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'Cosmo Tech',            'cosmotech.in',     '27AABCC3456E2F7', 'Maharashtra', '27', 72, 'Sneha M',     'IT Head',          'sneha@cosmotech.in',      '+91 98123 11111', '2025-05-21'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '11111111-1111-1111-1111-111111111111', 'Delta Pvt Ltd',         'deltapl.com',      '27AABCD5678F3G9', 'Maharashtra', '27', 91, 'Arjun S',     'CTO',              'arjun@deltapl.com',       '+91 99100 22334', '2024-06-22'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', '11111111-1111-1111-1111-111111111111', 'Echo Pharma',           'echopharma.in',    '29AABCE8765H4J1', 'Karnataka',   '29', 95, 'Dr. Verma',   'CEO',              'verma@echopharma.in',     '+91 98765 33445', '2024-01-10'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5', '11111111-1111-1111-1111-111111111111', 'Beta Industries',       'betaind.in',       '27AABCB1234K5L6', 'Maharashtra', '27', 88, 'Priya M',     'Operations Head',  'priya@betaind.in',        '+91 99887 11223', '2024-06-18'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6', '11111111-1111-1111-1111-111111111111', 'Foxtrot Logistics',     'foxtrot.in',       '27AABCF7890M6N7', 'Maharashtra', '27', 82, 'Karan K',     'Director',         'karan@foxtrot.in',        '+91 98765 44556', '2024-04-02'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7', '11111111-1111-1111-1111-111111111111', 'Hotel Royal Group',     'hrgroup.com',      '27AABCH2345P7Q8', 'Maharashtra', '27', 65, 'Anita G',     'GM Operations',    'anita@hrgroup.com',       '+91 99887 88990', '2025-05-24');

-- Leads
insert into public.leads (id, tenant_id, company, plan, seats, value, stage, source) values
('L1',  '11111111-1111-1111-1111-111111111111', 'TechBrand Pvt Ltd',     'Workspace Std',   25, 200000, 'new',      'manual'),
('L2',  '11111111-1111-1111-1111-111111111111', 'Hotel Royal Group',     'Mixed plans',     40, 400000, 'new',      'manual'),
('L3',  '11111111-1111-1111-1111-111111111111', 'Kilo Foods Ltd',        'Starter',         15, 300000, 'new',      'csv'),
('L4',  '11111111-1111-1111-1111-111111111111', 'Maple Studios',         'Workspace Plus',  12, 180000, 'new',      'buy-workspace-v2'),
('L5',  '11111111-1111-1111-1111-111111111111', 'Nova Print Co.',        'Starter',         8,  80000,  'new',      'buy-workspace-v2'),
('L6',  '11111111-1111-1111-1111-111111111111', 'Orbit Logistics',       'Workspace Std',   30, 260000, 'contact',  'manual'),
('L7',  '11111111-1111-1111-1111-111111111111', 'Patel & Sons',          'Voice + Std',     18, 160000, 'contact',  'manual'),
('L8',  '11111111-1111-1111-1111-111111111111', 'Quantum Labs',          'Plus',            22, 320000, 'contact',  'csv'),
('L9',  '11111111-1111-1111-1111-111111111111', 'Riverside Hotels',      'Std',             35, 290000, 'contact',  'manual'),
('L10', '11111111-1111-1111-1111-111111111111', 'Sapphire Exports',      'Plus + Voice',    28, 410000, 'demo',     'manual'),
('L11', '11111111-1111-1111-1111-111111111111', 'Tata Crafts',           'Std',             16, 140000, 'demo',     'manual'),
('L12', '11111111-1111-1111-1111-111111111111', 'Urban Wear Co.',        'Plus',            24, 340000, 'demo',     'csv'),
('L13', '11111111-1111-1111-1111-111111111111', 'Vintage Motors',        'Std',             12, 100000, 'trial',    'buy-workspace-v2'),
('L14', '11111111-1111-1111-1111-111111111111', 'Whitestone Pharma',     'Plus',            32, 460000, 'trial',    'buy-workspace-v2'),
('L15', '11111111-1111-1111-1111-111111111111', 'Xenon Foods',           'Starter',         10, 90000,  'trial',    'buy-workspace-v2'),
('L16', '11111111-1111-1111-1111-111111111111', 'Yara Tea',              'Std',             20, 180000, 'trial',    'buy-workspace-v2'),
('L17', '11111111-1111-1111-1111-111111111111', 'Acme Corp Pvt Ltd',     'Plus (upgrade)',  25, 490644, 'quote',    'manual'),
('L18', '11111111-1111-1111-1111-111111111111', 'Zephyr Networks',       'Plus + Voice',    28, 380000, 'quote',    'manual'),
('L19', '11111111-1111-1111-1111-111111111111', 'Anvil Heavy Industries','Plus',            50, 820000, 'won',      'manual'),
('L20', '11111111-1111-1111-1111-111111111111', 'Beta Industries',       'Std',             15, 132480, 'won',      'manual'),
('L21', '11111111-1111-1111-1111-111111111111', 'Chinar Resorts',        'Std',             22, 240000, 'won',      'manual');

-- Quotes (sample 5)
insert into public.quotes (id, tenant_id, customer_name, plan, seats, amount, status, lead_id, created_date, expires_date) values
('Q-2026-0042', '11111111-1111-1111-1111-111111111111', 'Acme Corp Pvt Ltd',  'Plus + Voice (upgrade)', 30, 490644, 'sent',     'L17', '2026-05-19', '2026-06-18'),
('Q-2026-0041', '11111111-1111-1111-1111-111111111111', 'Beta Industries',    'Workspace Std',          15, 132480, 'accepted', 'L20', '2026-05-12', '2026-06-11'),
('Q-2026-0040', '11111111-1111-1111-1111-111111111111', 'Anvil Heavy',        'Plus',                   50, 820000, 'accepted', 'L19', '2026-05-08', '2026-06-07'),
('Q-2026-0039', '11111111-1111-1111-1111-111111111111', 'Zephyr Networks',    'Plus + Voice',           28, 380000, 'viewed',   'L18', '2026-05-18', '2026-06-17'),
('Q-2026-0038', '11111111-1111-1111-1111-111111111111', 'Sapphire Exports',   'Plus + Voice',           28, 410000, 'draft',    'L10', '2026-05-20', '2026-06-19');

-- Invoices (sample 5)
insert into public.invoices (id, tenant_id, customer_name, amount, status, invoice_date, due_date, overdue_days) values
('INV-2026-0089', '11111111-1111-1111-1111-111111111111', 'Acme Corp',         490644, 'pending', '2026-05-15', '2026-06-15', 0),
('INV-2026-0088', '11111111-1111-1111-1111-111111111111', 'Beta Industries',   132480, 'paid',    '2026-05-14', '2026-06-14', 0),
('INV-2026-0087', '11111111-1111-1111-1111-111111111111', 'Cosmo Tech',        198720, 'pending', '2026-05-12', '2026-06-12', 0),
('INV-2026-0086', '11111111-1111-1111-1111-111111111111', 'Delta Pvt Ltd',     828000, 'paid',    '2026-05-10', '2026-06-10', 0),
('INV-2026-0085', '11111111-1111-1111-1111-111111111111', 'Echo Pharma',       215640, 'overdue', '2026-04-05', '2026-05-05', 14);

-- Subscriptions (sample 5)
insert into public.subscriptions (tenant_id, customer_name, domain, plan, vendor, seats, used, mrr, start_date, renewal_date, status, is_urgent) values
('11111111-1111-1111-1111-111111111111', 'Acme Corp',          'acmecorp.com',  'Workspace Plus', 'google',    25, 22, 34500,  '2023-09-15', '2026-09-15', 'active', false),
('11111111-1111-1111-1111-111111111111', 'Cosmo Tech',         'cosmotech.in',  'Workspace Plus', 'google',    12, 12, 16560,  '2025-05-21', '2026-05-21', 'active', true),
('11111111-1111-1111-1111-111111111111', 'Delta Pvt Ltd',      'deltapl.com',   'Workspace Plus', 'google',    50, 48, 69000,  '2024-06-22', '2026-06-22', 'active', false),
('11111111-1111-1111-1111-111111111111', 'Echo Pharma',        'echopharma.in', 'Enterprise',     'google',    80, 78, 115200, '2024-01-10', '2027-01-10', 'active', false),
('11111111-1111-1111-1111-111111111111', 'Hotel Royal Group',  'hrgroup.com',   'Workspace Std',  'google',    8,  8,  5888,   '2025-05-24', '2026-05-24', 'active', true);

-- ============================================================
-- DEMO SIGN-INS — the two accounts the login page advertises
-- ============================================================
-- Added 9 Sep 2026, because the login page and this file contradicted each other.
--
-- src/app/(auth)/login/page.tsx:38-39 prints a "Dev mode - demo accounts" panel
-- naming pardeep@anutech.in / ResellerOS@2026 and
-- pardeep@exceltechnologies.in / ExcelTech@2026, and offers to autofill them.
-- Neither existed on a local stack: `baseline.sql` is `db dump --schema public`,
-- so it carries no `auth` schema at all, and the header of this file said the
-- auth user was a manual step to do "via the Supabase dashboard or the signup
-- flow". So a developer following `npm run setup` got a login screen advertising
-- credentials that could not work, and an "Invalid login credentials" toast with
-- nothing wrong anywhere. Measured: both failed against a freshly built database.
--
-- Passwords are hashed with bcrypt via pgcrypto because that is what GoTrue
-- reads - an existing GoTrue-created row on this stack stores `$2a$10$...`, and
-- `gen_salt('bf', 10)` produces the same form. LOCAL ONLY: these are the
-- passwords already printed on the page, so they are not a secret being leaked
-- here, and a hosted project never runs this file.

-- Tenant 2: the distributor. Two tenants rather than one is also the only way to
-- exercise tenant isolation locally, and RLS is the thing most likely to be got
-- wrong without a second tenant to get it wrong against.
insert into public.tenants (id, name, gstin, state, state_code, address, email, phone, tier) values
('22222222-2222-2222-2222-222222222222',
 'Anutech Digital Pvt Ltd',
 '06AABCA1234A1Z5',
 'Haryana',
 '06',
 'Gurugram, Haryana 122001',
 'pardeep@anutech.in',
 '+91 98100 00000',
 'distributor')
on conflict (id) do nothing;

do $$
declare
  v_users jsonb := jsonb_build_array(
    jsonb_build_object(
      'id',    'aaaaaaaa-0000-4000-8000-00000000a001',
      'email', 'pardeep@anutech.in',
      'pass',  'ResellerOS@2026',
      'name',  'Pardeep (Anutech Digital)',
      'tenant','22222222-2222-2222-2222-222222222222'
    ),
    jsonb_build_object(
      'id',    'aaaaaaaa-0000-4000-8000-00000000a002',
      'email', 'pardeep@exceltechnologies.in',
      'pass',  'ExcelTech@2026',
      'name',  'Pardeep (Excel Technologies)',
      'tenant','11111111-1111-1111-1111-111111111111'
    )
  );
  u jsonb;
begin
  for u in select * from jsonb_array_elements(v_users) loop
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      /* EMPTY STRINGS, NOT NULL, and this is the whole reason the first attempt
         failed with "Database error querying schema". GoTrue scans these into
         non-nullable Go strings, so a NULL makes every sign-in for the row error
         out - the row looks perfectly fine in psql. Copied from the shape of a
         row GoTrue created itself on this stack rather than guessed. */
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    ) values (
      (u->>'id')::uuid,
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      u->>'email',
      extensions.crypt(u->>'pass', extensions.gen_salt('bf', 10)),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', u->>'name'),
      now(), now(),
      '', '', '', '', '', '', '', ''
    )
    on conflict (id) do nothing;

    /* GoTrue will not sign a user in without the matching identity row. */
    insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    values (
      u->>'email', (u->>'id')::uuid,
      jsonb_build_object('sub', u->>'id', 'email', u->>'email', 'email_verified', true),
      'email', now(), now()
    )
    on conflict do nothing;

    /* The staff row the app actually reads. Without it a signed-in user has no
       tenant and every screen is empty - see lib/domains/authz.ts. */
    insert into public.users (id, tenant_id, email, full_name, role)
    values ((u->>'id')::uuid, (u->>'tenant')::uuid, u->>'email', u->>'name', 'owner')
    on conflict (id) do nothing;
  end loop;
end $$;
