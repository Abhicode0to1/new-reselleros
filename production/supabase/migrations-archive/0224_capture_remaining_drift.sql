-- 0224_capture_remaining_drift.sql
--
-- Captures 11 tables that exist in PROD but that NO migration in git creates.
-- They were made directly via Studio/MCP; only later ALTERs were ever committed
-- (`contacts` is ALTERed by 6 migrations and CREATEd by none). This is the same
-- class of drift 0003_freeze_baseline and 0146 captured before.
--
-- WHY IT MATTERS: without this, a fresh DB / CI / disaster-recovery restore has
-- nowhere to put 6 tables' worth of live data — including contacts (58 rows).
-- Found by `npm run backup:check`; see docs/BACKUP.md.
--
-- Everything here is IDEMPOTENT (IF NOT EXISTS / guarded ALTERs / drop-then-create
-- policies), so applying to prod is a no-op — the objects already exist there.
-- Generated from the live catalog 2026-08-13 using format_type(), so enum and
-- array columns round-trip exactly.
--
-- Column defaults are reproduced verbatim, including any that reference other
-- objects; if a fresh DB fails on one, that dependency is itself drift.

-- ── 1. Tables (columns only; constraints added in §2 so ordering is irrelevant) ──

create table if not exists public."campaign_sends" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "campaign_id" text not null,
  "lead_id" text,
  "recipient_email" text not null,
  "recipient_name" text,
  "status" text default 'pending'::text not null,
  "provider_id" text,
  "error_message" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);

create table if not exists public."campaign_templates" (
  "id" text not null,
  "tenant_id" uuid,
  "name" text not null,
  "category" text default 'custom'::text not null,
  "subject" text not null,
  "body_html" text not null,
  "body_text" text,
  "description" text,
  "is_system" boolean default false not null,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

create table if not exists public."campaigns" (
  "id" text not null,
  "tenant_id" uuid not null,
  "name" text not null,
  "subject" text not null,
  "body" text not null,
  "audience_filter" jsonb default '{}'::jsonb not null,
  "offer_code" text,
  "offer_discount_pct" numeric(5,2),
  "offer_expires_at" timestamp with time zone,
  "recipients_count" integer default 0 not null,
  "sent_count" integer default 0 not null,
  "failed_count" integer default 0 not null,
  "status" text default 'draft'::text not null,
  "sent_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "body_html" text
);

create table if not exists public."contacts" (
  "id" text not null,
  "tenant_id" uuid not null,
  "full_name" text not null,
  "email" text,
  "phone" text,
  "company" text,
  "title" text,
  "source" text default 'manual'::text not null,
  "external_id" text,
  "status" text default 'pending'::text not null,
  "promoted_to_lead_id" text,
  "promoted_at" timestamp with time zone,
  "notes" text,
  "tags" text[] default '{}'::text[],
  "imported_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  "whatsapp" text,
  "linkedin" text,
  "instagram" text,
  "facebook" text,
  "twitter" text,
  "website" text,
  "address" text,
  "city" text,
  "customer_id" uuid,
  "emails" jsonb default '[]'::jsonb not null,
  "phones" jsonb default '[]'::jsonb not null,
  "google_etag" text,
  "google_synced_at" timestamp with time zone,
  "relationship" text,
  "birthday" date,
  "anniversary" date,
  "nickname" text,
  "family" text
);

create table if not exists public."employee_documents" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "employee_id" uuid not null,
  "doc_type" text default 'other'::text not null,
  "file_name" text not null,
  "file_path" text not null,
  "mime_type" text,
  "size_bytes" integer,
  "uploaded_by" uuid,
  "uploaded_at" timestamp with time zone default now() not null
);

create table if not exists public."po_bill_allocations" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "purchase_order_id" text not null,
  "vendor_bill_id" text not null,
  "allocated_amount" integer not null,
  "notes" text,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null
);

create table if not exists public."prepaid_advances" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "vendor_name" text not null,
  "vendor_id" uuid,
  "category" text default 'Marketing'::text not null,
  "total_amount" integer not null,
  "consumed_amount" integer default 0 not null,
  "paid_date" date default CURRENT_DATE not null,
  "payment_method" text,
  "bank_account_id" uuid,
  "notes" text,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

create table if not exists public."reimbursements" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "person_name" text not null,
  "purpose" text not null,
  "category" text default 'Other'::text not null,
  "amount" integer not null,
  "gst_paid" integer default 0 not null,
  "incurred_on" date not null,
  "paid_via" text,
  "status" text default 'pending'::text not null,
  "settled_on" date,
  "settled_notes" text,
  "expense_id" text,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "employee_id" uuid,
  "receipt_path" text
);

create table if not exists public."support_plans" (
  "id" text not null,
  "tenant_id" uuid not null,
  "name" text not null,
  "annual_price" integer default 0 not null,
  "sort_order" smallint default 0 not null,
  "is_active" boolean default true not null,
  "updated_at" timestamp with time zone default now() not null
);

create table if not exists public."support_sync_outbox" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "subscription_id" uuid not null,
  "customer_id" uuid not null,
  "payload" jsonb not null,
  "status" text default 'pending'::text not null,
  "attempts" integer default 0 not null,
  "last_error" text,
  "created_at" timestamp with time zone default now() not null,
  "sent_at" timestamp with time zone
);

create table if not exists public."whatsapp_messages" (
  "id" uuid default gen_random_uuid() not null,
  "tenant_id" uuid not null,
  "wamid" text,
  "contact_phone" text not null,
  "direction" text not null,
  "type" text not null,
  "text_body" text,
  "template_name" text,
  "template_lang" text,
  "template_params" jsonb,
  "media_id" text,
  "media_mime" text,
  "media_filename" text,
  "status" text default 'pending'::text not null,
  "error_code" text,
  "error_message" text,
  "related_lead_id" text,
  "related_quote_id" text,
  "related_customer_id" uuid,
  "meta_timestamp" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);

-- ── 2. Constraints (PK / UNIQUE / FK / CHECK) ──────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaign_sends_status_check') then
    alter table public."campaign_sends" add constraint "campaign_sends_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'stubbed'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_sends_campaign_id_fkey') then
    alter table public."campaign_sends" add constraint "campaign_sends_campaign_id_fkey" FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_sends_lead_id_fkey') then
    alter table public."campaign_sends" add constraint "campaign_sends_lead_id_fkey" FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_sends_tenant_id_fkey') then
    alter table public."campaign_sends" add constraint "campaign_sends_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_sends_pkey') then
    alter table public."campaign_sends" add constraint "campaign_sends_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_sends_campaign_id_recipient_email_key') then
    alter table public."campaign_sends" add constraint "campaign_sends_campaign_id_recipient_email_key" UNIQUE (campaign_id, recipient_email);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_templates_category_check') then
    alter table public."campaign_templates" add constraint "campaign_templates_category_check" CHECK ((category = ANY (ARRAY['newsletter'::text, 'offer'::text, 'winback'::text, 'onboarding'::text, 'custom'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_templates_created_by_fkey') then
    alter table public."campaign_templates" add constraint "campaign_templates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_templates_tenant_id_fkey') then
    alter table public."campaign_templates" add constraint "campaign_templates_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaign_templates_pkey') then
    alter table public."campaign_templates" add constraint "campaign_templates_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_status_check') then
    alter table public."campaigns" add constraint "campaigns_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'cancelled'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_created_by_fkey') then
    alter table public."campaigns" add constraint "campaigns_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_tenant_id_fkey') then
    alter table public."campaigns" add constraint "campaigns_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_pkey') then
    alter table public."campaigns" add constraint "campaigns_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_source_check') then
    alter table public."contacts" add constraint "contacts_source_check" CHECK ((source = ANY (ARRAY['manual'::text, 'google_csv'::text, 'google_api'::text, 'outlook'::text, 'linkedin'::text, 'event'::text, 'other'::text, 'enquiry'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_status_check') then
    alter table public."contacts" add constraint "contacts_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'engaged'::text, 'promoted'::text, 'archived'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_customer_id_fkey') then
    alter table public."contacts" add constraint "contacts_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_imported_by_fkey') then
    alter table public."contacts" add constraint "contacts_imported_by_fkey" FOREIGN KEY (imported_by) REFERENCES auth.users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_promoted_to_lead_id_fkey') then
    alter table public."contacts" add constraint "contacts_promoted_to_lead_id_fkey" FOREIGN KEY (promoted_to_lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_tenant_id_fkey') then
    alter table public."contacts" add constraint "contacts_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_pkey') then
    alter table public."contacts" add constraint "contacts_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employee_documents_employee_id_fkey') then
    alter table public."employee_documents" add constraint "employee_documents_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employee_documents_tenant_id_fkey') then
    alter table public."employee_documents" add constraint "employee_documents_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employee_documents_pkey') then
    alter table public."employee_documents" add constraint "employee_documents_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'employee_documents_file_path_key') then
    alter table public."employee_documents" add constraint "employee_documents_file_path_key" UNIQUE (file_path);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_allocated_amount_check') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_allocated_amount_check" CHECK ((allocated_amount > 0));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_created_by_fkey') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_purchase_order_id_fkey') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_purchase_order_id_fkey" FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_tenant_id_fkey') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_vendor_bill_id_fkey') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_vendor_bill_id_fkey" FOREIGN KEY (vendor_bill_id) REFERENCES vendor_bills(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_pkey') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'po_bill_allocations_purchase_order_id_vendor_bill_id_key') then
    alter table public."po_bill_allocations" add constraint "po_bill_allocations_purchase_order_id_vendor_bill_id_key" UNIQUE (purchase_order_id, vendor_bill_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prepaid_advances_bank_account_id_fkey') then
    alter table public."prepaid_advances" add constraint "prepaid_advances_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prepaid_advances_created_by_fkey') then
    alter table public."prepaid_advances" add constraint "prepaid_advances_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prepaid_advances_tenant_id_fkey') then
    alter table public."prepaid_advances" add constraint "prepaid_advances_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prepaid_advances_vendor_id_fkey') then
    alter table public."prepaid_advances" add constraint "prepaid_advances_vendor_id_fkey" FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prepaid_advances_pkey') then
    alter table public."prepaid_advances" add constraint "prepaid_advances_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reimbursements_status_check') then
    alter table public."reimbursements" add constraint "reimbursements_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'settled'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reimbursements_employee_id_fkey') then
    alter table public."reimbursements" add constraint "reimbursements_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reimbursements_expense_id_fkey') then
    alter table public."reimbursements" add constraint "reimbursements_expense_id_fkey" FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reimbursements_tenant_id_fkey') then
    alter table public."reimbursements" add constraint "reimbursements_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'reimbursements_pkey') then
    alter table public."reimbursements" add constraint "reimbursements_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_plans_tenant_id_fkey') then
    alter table public."support_plans" add constraint "support_plans_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_plans_pkey') then
    alter table public."support_plans" add constraint "support_plans_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_sync_outbox_status_check') then
    alter table public."support_sync_outbox" add constraint "support_sync_outbox_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_sync_outbox_customer_id_fkey') then
    alter table public."support_sync_outbox" add constraint "support_sync_outbox_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_sync_outbox_subscription_id_fkey') then
    alter table public."support_sync_outbox" add constraint "support_sync_outbox_subscription_id_fkey" FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_sync_outbox_tenant_id_fkey') then
    alter table public."support_sync_outbox" add constraint "support_sync_outbox_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_sync_outbox_pkey') then
    alter table public."support_sync_outbox" add constraint "support_sync_outbox_pkey" PRIMARY KEY (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_direction_check') then
    alter table public."whatsapp_messages" add constraint "whatsapp_messages_direction_check" CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_type_check') then
    alter table public."whatsapp_messages" add constraint "whatsapp_messages_type_check" CHECK ((type = ANY (ARRAY['text'::text, 'template'::text, 'image'::text, 'document'::text, 'video'::text, 'audio'::text, 'location'::text, 'reaction'::text, 'sticker'::text, 'button'::text, 'interactive'::text, 'unsupported'::text])));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_related_customer_id_fkey') then
    alter table public."whatsapp_messages" add constraint "whatsapp_messages_related_customer_id_fkey" FOREIGN KEY (related_customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_tenant_id_fkey') then
    alter table public."whatsapp_messages" add constraint "whatsapp_messages_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_messages_pkey') then
    alter table public."whatsapp_messages" add constraint "whatsapp_messages_pkey" PRIMARY KEY (id);
  end if;
end $$;

-- ── 3. Indexes (constraint-backed ones are skipped — §2 creates those) ─────────

create index if not exists campaign_sends_campaign_idx ON public.campaign_sends USING btree (campaign_id);
create index if not exists campaign_sends_lead_idx ON public.campaign_sends USING btree (lead_id);
create index if not exists ctmpl_system_idx ON public.campaign_templates USING btree (is_system) WHERE (is_system = true);
create index if not exists ctmpl_tenant_idx ON public.campaign_templates USING btree (tenant_id);
create index if not exists campaigns_status_idx ON public.campaigns USING btree (tenant_id, status);
create index if not exists campaigns_tenant_idx ON public.campaigns USING btree (tenant_id);
create index if not exists contacts_customer_id_idx ON public.contacts USING btree (customer_id) WHERE (customer_id IS NOT NULL);
create index if not exists contacts_email_idx ON public.contacts USING btree (tenant_id, lower(email)) WHERE (email IS NOT NULL);
create index if not exists contacts_external_idx ON public.contacts USING btree (tenant_id, source, external_id) WHERE (external_id IS NOT NULL);
create index if not exists contacts_status_idx ON public.contacts USING btree (tenant_id, status);
create unique index if not exists contacts_tenant_external_uidx ON public.contacts USING btree (tenant_id, external_id) WHERE (external_id IS NOT NULL);
create index if not exists contacts_tenant_idx ON public.contacts USING btree (tenant_id);
create unique index if not exists contacts_unique_email_per_tenant ON public.contacts USING btree (tenant_id, lower(email)) WHERE (email IS NOT NULL);
create index if not exists employee_documents_employee_idx ON public.employee_documents USING btree (employee_id);
create index if not exists employee_documents_tenant_idx ON public.employee_documents USING btree (tenant_id);
create index if not exists po_alloc_bill_idx ON public.po_bill_allocations USING btree (vendor_bill_id);
create index if not exists po_alloc_po_idx ON public.po_bill_allocations USING btree (purchase_order_id);
create index if not exists po_alloc_tenant_idx ON public.po_bill_allocations USING btree (tenant_id);
create index if not exists prepaid_advances_tenant_idx ON public.prepaid_advances USING btree (tenant_id, paid_date DESC);
create index if not exists reimbursements_employee_idx ON public.reimbursements USING btree (employee_id) WHERE (employee_id IS NOT NULL);
create index if not exists reimbursements_status_idx ON public.reimbursements USING btree (tenant_id, status);
create index if not exists reimbursements_tenant_idx ON public.reimbursements USING btree (tenant_id);
create index if not exists idx_support_plans_tenant ON public.support_plans USING btree (tenant_id);
create index if not exists idx_support_sync_outbox_pending ON public.support_sync_outbox USING btree (created_at) WHERE (status = 'pending'::text);
create index if not exists idx_whatsapp_messages_recent ON public.whatsapp_messages USING btree (tenant_id, created_at DESC);
create index if not exists idx_whatsapp_messages_thread ON public.whatsapp_messages USING btree (tenant_id, contact_phone, created_at DESC);
create unique index if not exists idx_whatsapp_messages_wamid_tenant ON public.whatsapp_messages USING btree (tenant_id, wamid) WHERE (wamid IS NOT NULL);

-- ── 4. Row-Level Security ─────────────────────────────────────────────────────

alter table public."campaign_sends" enable row level security;
alter table public."campaign_templates" enable row level security;
alter table public."campaigns" enable row level security;
alter table public."contacts" enable row level security;
alter table public."employee_documents" enable row level security;
alter table public."po_bill_allocations" enable row level security;
alter table public."prepaid_advances" enable row level security;
alter table public."reimbursements" enable row level security;
alter table public."support_plans" enable row level security;
alter table public."support_sync_outbox" enable row level security;
alter table public."whatsapp_messages" enable row level security;

drop policy if exists "campaign_sends_select" on public."campaign_sends";
create policy "campaign_sends_select" on public."campaign_sends"
  for select to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "campaign_sends_service_role" on public."campaign_sends";
create policy "campaign_sends_service_role" on public."campaign_sends"
  for all to service_role
  using (true)
  with check (true);
drop policy if exists "ctmpl_delete" on public."campaign_templates";
create policy "ctmpl_delete" on public."campaign_templates"
  for delete to authenticated
  using (((is_system = false) AND (tenant_id = current_tenant_id())));
drop policy if exists "ctmpl_insert" on public."campaign_templates";
create policy "ctmpl_insert" on public."campaign_templates"
  for insert to authenticated
  with check (((is_system = false) AND (tenant_id = current_tenant_id())));
drop policy if exists "ctmpl_select" on public."campaign_templates";
create policy "ctmpl_select" on public."campaign_templates"
  for select to authenticated
  using (((is_system = true) OR (tenant_id = current_tenant_id())));
drop policy if exists "ctmpl_service_role" on public."campaign_templates";
create policy "ctmpl_service_role" on public."campaign_templates"
  for all to service_role
  using (true)
  with check (true);
drop policy if exists "ctmpl_update" on public."campaign_templates";
create policy "ctmpl_update" on public."campaign_templates"
  for update to authenticated
  using (((is_system = false) AND (tenant_id = current_tenant_id())))
  with check (((is_system = false) AND (tenant_id = current_tenant_id())));
drop policy if exists "campaigns_delete" on public."campaigns";
create policy "campaigns_delete" on public."campaigns"
  for delete to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "campaigns_insert" on public."campaigns";
create policy "campaigns_insert" on public."campaigns"
  for insert to authenticated
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "campaigns_select" on public."campaigns";
create policy "campaigns_select" on public."campaigns"
  for select to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "campaigns_service_role" on public."campaigns";
create policy "campaigns_service_role" on public."campaigns"
  for all to service_role
  using (true)
  with check (true);
drop policy if exists "campaigns_update" on public."campaigns";
create policy "campaigns_update" on public."campaigns"
  for update to authenticated
  using ((tenant_id = current_tenant_id()))
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "contacts_delete" on public."contacts";
create policy "contacts_delete" on public."contacts"
  for delete to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "contacts_insert" on public."contacts";
create policy "contacts_insert" on public."contacts"
  for insert to authenticated
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "contacts_select" on public."contacts";
create policy "contacts_select" on public."contacts"
  for select to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "contacts_service_role" on public."contacts";
create policy "contacts_service_role" on public."contacts"
  for all to service_role
  using (true)
  with check (true);
drop policy if exists "contacts_update" on public."contacts";
create policy "contacts_update" on public."contacts"
  for update to authenticated
  using ((tenant_id = current_tenant_id()))
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "employee_documents tenant all" on public."employee_documents";
create policy "employee_documents tenant all" on public."employee_documents"
  for all to authenticated
  using ((tenant_id = current_tenant_id()))
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "po_alloc_delete" on public."po_bill_allocations";
create policy "po_alloc_delete" on public."po_bill_allocations"
  for delete to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "po_alloc_insert" on public."po_bill_allocations";
create policy "po_alloc_insert" on public."po_bill_allocations"
  for insert to authenticated
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "po_alloc_select" on public."po_bill_allocations";
create policy "po_alloc_select" on public."po_bill_allocations"
  for select to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "po_alloc_service_role" on public."po_bill_allocations";
create policy "po_alloc_service_role" on public."po_bill_allocations"
  for all to service_role
  using (true)
  with check (true);
drop policy if exists "po_alloc_update" on public."po_bill_allocations";
create policy "po_alloc_update" on public."po_bill_allocations"
  for update to authenticated
  using ((tenant_id = current_tenant_id()))
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "prepaid_advances_all" on public."prepaid_advances";
create policy "prepaid_advances_all" on public."prepaid_advances"
  for all to public
  using ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))))
  with check ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
drop policy if exists "reimbursements tenant all" on public."reimbursements";
create policy "reimbursements tenant all" on public."reimbursements"
  for all to authenticated
  using ((tenant_id = current_tenant_id()))
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "support_plans_select_own_tenant" on public."support_plans";
create policy "support_plans_select_own_tenant" on public."support_plans"
  for select to authenticated
  using ((tenant_id = current_tenant_id()));
drop policy if exists "support_plans_write_own_tenant" on public."support_plans";
create policy "support_plans_write_own_tenant" on public."support_plans"
  for all to authenticated
  using ((tenant_id = current_tenant_id()))
  with check ((tenant_id = current_tenant_id()));
drop policy if exists "support_sync_outbox_service_role" on public."support_sync_outbox";
create policy "support_sync_outbox_service_role" on public."support_sync_outbox"
  for all to public
  using ((auth.role() = 'service_role'::text))
  with check ((auth.role() = 'service_role'::text));
drop policy if exists "whatsapp_messages_tenant_read" on public."whatsapp_messages";
create policy "whatsapp_messages_tenant_read" on public."whatsapp_messages"
  for select to public
  using ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));
drop policy if exists "whatsapp_messages_tenant_write" on public."whatsapp_messages";
create policy "whatsapp_messages_tenant_write" on public."whatsapp_messages"
  for all to public
  using ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))))
  with check ((tenant_id = ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = auth.uid()))));

-- ── 4b. Functions that are ALSO drift ─────────────────────────────────────────
-- 9 functions exist in prod with no definition in git. Three of them back
-- triggers created in §5, so without these that section fails on a fresh DB.
-- Note two are money-adjacent RPCs the reimbursements feature calls:
-- settle_reimbursement / delete_reimbursement.

-- campaign_templates_touch
create or replace function public.campaign_templates_touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at := now(); return new; end;
$function$;

-- campaigns_touch_updated_at
create or replace function public.campaigns_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at := now(); return new; end;
$function$;

-- contacts_touch
create or replace function public.contacts_touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at := now(); return new; end;
$function$;

-- delete_reimbursement
create or replace function public.delete_reimbursement(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if v_tenant is not null and v_r.tenant_id is distinct from v_tenant then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  delete from public.reimbursements where id = p_id;
  if v_r.expense_id is not null then
    delete from public.expenses where id = v_r.expense_id and tenant_id = v_r.tenant_id and reconciled_txn_id is null;
  end if;
end;
$function$;

-- handle_quote_status_change
create or replace function public.handle_quote_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Newly accepted → kick off payment workflow
  if new.status = 'accepted' and (old.status is null or old.status != 'accepted') and new.payment_status = 'none' then
    new.payment_status := 'awaiting';
  end if;
  return new;
end;
$function$;

-- purchase_orders_touch_updated_at
create or replace function public.purchase_orders_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

-- queue_support_sync
create or replace function public.queue_support_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer record;
begin
  -- No-op update (something unrelated to plan/status/renewal changed) — skip.
  if tg_op = 'UPDATE'
     and old.plan          is not distinct from new.plan
     and old.status        is not distinct from new.status
     and old.renewal_date  is not distinct from new.renewal_date then
    return new;
  end if;

  select name, contact_name, contact_email, domain, customer_number
    into v_customer
    from public.customers
   where id = new.customer_id;

  -- DSP keys the sync on email (or billing_customer_id) — nothing to send
  -- without one.
  if v_customer.contact_email is null then
    return new;
  end if;

  insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
  values (
    new.tenant_id, new.id, new.customer_id,
    jsonb_build_object(
      'event_type', 'subscription.updated',
      'data', jsonb_build_object(
        'billing_customer_id', coalesce(v_customer.customer_number, new.customer_id::text),
        'name',         coalesce(v_customer.contact_name, v_customer.name),
        'email',        v_customer.contact_email,
        'domain',       coalesce(new.domain, v_customer.domain),
        'plan',         new.plan,
        'plan_status',  new.status,
        'plan_expiry',  new.renewal_date
      )
    )
  );

  return new;
end;
$function$;

-- settle_reimbursement
create or replace function public.settle_reimbursement(p_id uuid, p_settled_on date, p_notes text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_r      public.reimbursements;
begin
  select * into v_r from public.reimbursements where id = p_id;
  if not found then raise exception 'Reimbursement not found'; end if;
  if v_tenant is not null and v_r.tenant_id is distinct from v_tenant then
    raise exception 'Not in your tenant' using errcode = 'insufficient_privilege';
  end if;
  update public.reimbursements
     set status = 'settled', settled_on = coalesce(p_settled_on, current_date),
         settled_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_id;
end;
$function$;

-- tenant_secrets_touch_updated_at
create or replace function public.tenant_secrets_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;


-- ── 5. Triggers ───────────────────────────────────────────────────────────────

drop trigger if exists "trg_ctmpl_updated" on public."campaign_templates";
CREATE TRIGGER trg_ctmpl_updated BEFORE UPDATE ON public.campaign_templates FOR EACH ROW EXECUTE FUNCTION campaign_templates_touch();
drop trigger if exists "trg_campaigns_updated_at" on public."campaigns";
CREATE TRIGGER trg_campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_touch_updated_at();
drop trigger if exists "trg_activity_contacts" on public."contacts";
CREATE TRIGGER trg_activity_contacts AFTER INSERT OR DELETE OR UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION log_row_change();
drop trigger if exists "trg_contacts_updated" on public."contacts";
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION contacts_touch();
drop trigger if exists "trg_contacts_updated_at" on public."contacts";
CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
