/**
 * Database types — hand-maintained to match supabase/migrations/0001_init.sql.
 *
 * In production, regenerate with:
 *   npx supabase gen types typescript --project-id YOUR_REF > src/lib/supabase/database.types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ============================================================
// Standalone row interfaces (avoid circular references)
// ============================================================
/**
 * Cached GSTIN verification payload (provider-normalised).
 * Whatever the upstream API (Sandbox.co.in / ClearTax / NIC) returns, the
 * /api/gstin/verify route maps it onto this shape before persisting.
 */
export type GstinVerification = {
  status:            "Active" | "Cancelled" | "Suspended" | "Provisional" | "Inactive" | string;
  legal_name:        string | null;
  trade_name:        string | null;
  constitution:      string | null;            // Proprietorship / Pvt Ltd / Partnership / ...
  registration_type: string | null;            // Regular / Composition / SEZ / Casual / ...
  valid_from:        string | null;            // ISO date
  valid_upto:        string | null;            // ISO date (typically null for non-Casual)
  last_return_filed: string | null;            // ISO date or null
  jurisdiction:      string | null;
  state_code:        string | null;
  /** Principal place of business — structured form, ready to push into
   *  the Company form. Composed flat line is in `address` for one-shot
   *  textarea fills. */
  principal_address: {
    building:   string | null;
    street:     string | null;
    locality:   string | null;
    city:       string | null;
    district:   string | null;
    state:      string | null;
    pin_code:   string | null;
  } | null;
  address:           string | null;            // flat one-liner of principal_address
  source:            "sandbox" | "cleartax" | "nic" | "mock";
  raw?:              unknown;                  // original provider payload, for debugging
};

// Reseller hierarchy tier (migration 0040)
//   distributor → can have child tenants buying wholesale from it
//   reseller    → independent tenant OR child of a distributor (parent_tenant_id set)
export type TenantTier = "distributor" | "reseller";

type TenantRow = {
  id: string;
  name: string;
  logo_url: string | null;
  gstin: string | null;
  state: string | null;
  state_code: string | null;
  address: string | null;
  pin_code: string | null;
  contact_name: string | null;
  email: string;
  phone: string | null;
  lut_number: string | null;       // migration 0185 — LUT for zero-rated exports
  lut_valid_upto: string | null;   // LUT validity end date
  /**
   * Migration 0227 — the reseller's own UPI ID, used to print a scan-to-pay QR
   * on invoices. NULL means no QR is drawn. `upi_payee_name` is separate from
   * `name` because the name shown in the payer's UPI app must match the bank
   * account the VPA belongs to, which for a proprietor is often a personal name.
   */
  upi_vpa: string | null;
  upi_payee_name: string | null;
  grace_period_days: number;
  /** Opt-in: pause a subscription automatically when its invoice is 14 days overdue.
   *  FALSE by default on purpose — suspension means a customer cannot read email, and
   *  driving it from an INVOICE clock can cut off a subscription over an unrelated
   *  one-off bill. See migration 20260816114500. */
  auto_suspend_on_overdue: boolean;
  setup_completed_at: string | null;
  gstin_verified_at: string | null;
  gstin_verification: GstinVerification | null;
  parent_tenant_id: string | null;
  tier: TenantTier;
  attendance_ingest_key: string | null;   // migration 0215 — biometric bridge key
  /** Migration 0235 — which transport outbound mail uses. Defaults to resend
   *  because Gmail reports no bounces: a dead address fails silently and the
   *  app would record "sent". */
  email_provider: "resend" | "gmail";
  /** Whose connected Google account sends for this tenant. Required when
   *  email_provider = gmail, because Gmail sends AS somebody and a cron has no
   *  session. */
  gmail_sender_user_id: string | null;
  created_at: string;
  updated_at: string;
}
type TenantInsert = {
  id?: string;
  name: string;
  logo_url?: string | null;
  gstin?: string | null;
  state?: string | null;
  state_code?: string | null;
  address?: string | null;
  pin_code?: string | null;
  contact_name?: string | null;
  email: string;
  phone?: string | null;
  lut_number?: string | null;
  lut_valid_upto?: string | null;
  upi_vpa?: string | null;          // migration 0227
  upi_payee_name?: string | null;
  auto_suspend_on_overdue?: boolean;
  grace_period_days?: number;
  setup_completed_at?: string | null;
  gstin_verified_at?: string | null;
  gstin_verification?: GstinVerification | null;
  parent_tenant_id?: string | null;
  tier?: TenantTier;
  attendance_ingest_key?: string | null;
  created_at?: string;
  updated_at?: string;
}
type TenantUpdate = Partial<TenantInsert>;

// View exposed by migration 0040 — `tenants` joined with its parent's
// display-only fields. Backing view is `public.v_tenant_with_parent`.
export type TenantWithParent = {
  id: string;
  name: string;
  tier: TenantTier;
  parent_tenant_id: string | null;
  parent_name: string | null;
  parent_tier: TenantTier | null;
  parent_gstin: string | null;
};

// ============================================================
// tenant_secrets — owner-only credential storage (migration 0035)
// ============================================================
export type WhatsAppProvider = "meta" | "gupshup" | "twilio";

export type TenantSecretsRow = {
  tenant_id:           string;
  sandbox_api_key:     string | null;
  sandbox_api_secret:  string | null;
  sandbox_api_base:    string | null;
  // WhatsApp — migration 0037
  whatsapp_provider:            WhatsAppProvider | null;
  whatsapp_phone_number_id:     string | null;
  whatsapp_access_token:        string | null;
  whatsapp_business_account_id: string | null;
  whatsapp_app_secret:          string | null;
  whatsapp_verify_token:        string | null;
  // Razorpay — migration 0039
  razorpay_mode:           "test" | "live" | null;
  razorpay_key_id:         string | null;
  razorpay_key_secret:     string | null;
  razorpay_webhook_secret: string | null;
  // Gemini (AI) — migration 0070
  gemini_api_key:          string | null;
  gemini_model:            string | null;
  created_at:          string;
  updated_at:          string;
};
type TenantSecretsInsert = {
  tenant_id:           string;
  sandbox_api_key?:    string | null;
  sandbox_api_secret?: string | null;
  sandbox_api_base?:   string | null;
  whatsapp_provider?:            WhatsAppProvider | null;
  whatsapp_phone_number_id?:     string | null;
  whatsapp_access_token?:        string | null;
  whatsapp_business_account_id?: string | null;
  whatsapp_app_secret?:          string | null;
  whatsapp_verify_token?:        string | null;
  razorpay_mode?:           "test" | "live" | null;
  razorpay_key_id?:         string | null;
  razorpay_key_secret?:     string | null;
  razorpay_webhook_secret?: string | null;
  gemini_api_key?:          string | null;
  gemini_model?:            string | null;
  created_at?:         string;
  updated_at?:         string;
};
type TenantSecretsUpdate = Partial<Omit<TenantSecretsInsert, "tenant_id">>;

// ============================================================
// team_invites — owner pre-authorizes an email to join the tenant (migration 0073)
// ============================================================
export type TeamInviteRole = "owner" | "manager" | "sales" | "sales_senior" | "billing" | "accountant" | "delivery" | "support";
export type TeamInviteRow = {
  id:          string;
  tenant_id:   string;
  email:       string;
  role:        TeamInviteRole;
  invited_by:  string | null;
  created_at:  string;
  accepted_at: string | null;
};
type TeamInviteInsert = {
  id?:          string;
  tenant_id:    string;
  email:        string;
  role?:        TeamInviteRole;
  invited_by?:  string | null;
  created_at?:  string;
  accepted_at?: string | null;
};
type TeamInviteUpdate = Partial<TeamInviteInsert>;

// ============================================================
// tenant_domains — which email domain belongs to which tenant (migration 0242)
//
// `verified_at` is the gate, not the row's existence: an unverified claim routes
// nobody. See the migration header for why (exceltechnologies.in is currently
// claimed by two accidentally-created tenants).
// ============================================================
export type TenantDomainRow = {
  id:          string;
  tenant_id:   string;
  domain:      string;
  verified_at: string | null;
  created_by:  string | null;
  created_at:  string;
};
type TenantDomainInsert = {
  id?:          string;
  tenant_id:    string;
  domain:       string;
  verified_at?: string | null;
  created_by?:  string | null;
  created_at?:  string;
};
type TenantDomainUpdate = Partial<TenantDomainInsert>;

// ============================================================
// join_requests — someone waiting for an owner to let them in (migration 0242)
//
// Holds NO access of its own. Approving it is what creates the users row.
// ============================================================
export type JoinRequestStatus = "pending_approval" | "approved" | "rejected";
export type JoinRequestMatchedBy = "domain" | "manual";
export type JoinRequestRow = {
  id:             string;
  tenant_id:      string;
  auth_user_id:   string | null;
  email:          string;
  full_name:      string | null;
  requested_role: TeamInviteRole;
  status:         JoinRequestStatus;
  matched_by:     JoinRequestMatchedBy;
  note:           string | null;
  created_at:     string;
  decided_at:     string | null;
  decided_by:     string | null;
};
type JoinRequestInsert = {
  id?:             string;
  tenant_id:       string;
  auth_user_id?:   string | null;
  email:           string;
  full_name?:      string | null;
  requested_role?: TeamInviteRole;
  status?:         JoinRequestStatus;
  matched_by:      JoinRequestMatchedBy;
  note?:           string | null;
  created_at?:     string;
  decided_at?:     string | null;
  decided_by?:     string | null;
};
type JoinRequestUpdate = Partial<JoinRequestInsert>;

// ============================================================
// customer_domains — a customer can own many domains (migration 0074)
// ============================================================
export type CustomerDomainRow = {
  id:          string;
  tenant_id:   string;
  customer_id: string;
  domain:      string;
  created_at:  string;
};
type CustomerDomainInsert = {
  id?:          string;
  tenant_id:    string;
  customer_id:  string;
  domain:       string;
  created_at?:  string;
};
type CustomerDomainUpdate = Partial<CustomerDomainInsert>;

// ============================================================
// inbound_emails — inbound-email → lead audit + idempotency (migration 0069)
// ============================================================
/** What the router decided for a message (migration 0246). 'unknown' is only
 *  ever on rows that predate routing — the code never writes it. */
export type InboundEmailRoute = "sales" | "support" | "billing" | "ignored" | "unknown";

export type InboundEmailRow = {
  id:         string;
  tenant_id:  string;
  message_id: string;
  from_email: string | null;
  from_name:  string | null;
  /** The address it was sent TO — what routing keys on (0246). */
  to_email:   string | null;
  route:      InboundEmailRoute;
  subject:    string | null;
  status:     string;
  lead_id:    string | null;
  /** Support ticket opened from this message — the twin of lead_id (0246). */
  ticket_id:  string | null;
  /** The attached bill, kept so the extraction can be checked (0247). */
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_mime: string | null;
  /** What Gemini read. A SUGGESTION — never posted to the books on its own. */
  extracted_bill:  Json | null;
  /** Set only once a human reviewed the extraction and created the bill. */
  bill_id:    string | null;
  body_text:  string | null;
  body_html:  string | null;
  created_at: string;
  // ── Mailbox state (migration 20260817140000) ───────────────────────────────
  // What a PERSON did, kept apart from `status`, which is what the webhook did.
  // They move independently: an email can be lead_created AND unread AND starred.
  /** When a human first opened it. NULL = unread — what `is:unread` filters on. */
  read_at:       string | null;
  /** Flagged by a rep. Not a status value; a mail can be starred and converted. */
  starred:       boolean;
  /** Hidden from the Inbox until this instant, then it returns of its own accord. */
  snoozed_until: string | null;
  /** Marked done. Leaves the Inbox, stays searchable — nothing is ever deleted. */
  archived_at:   string | null;
};
type InboundEmailInsert = {
  id?:         string;
  tenant_id:   string;
  message_id:  string;
  from_email?: string | null;
  from_name?:  string | null;
  to_email?:   string | null;
  route?:      InboundEmailRoute;
  subject?:    string | null;
  status?:     string;
  lead_id?:    string | null;
  ticket_id?:  string | null;
  attachment_path?: string | null;
  attachment_name?: string | null;
  attachment_mime?: string | null;
  extracted_bill?:  Json | null;
  bill_id?:    string | null;
  body_text?:  string | null;
  body_html?:  string | null;
  created_at?: string;
  read_at?:       string | null;
  starred?:       boolean;
  snoozed_until?: string | null;
  archived_at?:   string | null;
};
type InboundEmailUpdate = Partial<Omit<InboundEmailInsert, "tenant_id" | "message_id">>;

// ============================================================
// api_keys — per-tenant keys for the public integration API (migration 0081)
// key_hash is NEVER selected client-side.
// ============================================================
export type ApiKeyRow = {
  id:           string;
  tenant_id:    string;
  label:        string;
  key_prefix:   string;
  key_hash:     string;
  scopes:       string[];
  last_used_at: string | null;
  revoked_at:   string | null;
  created_by:   string | null;
  created_at:   string;
};
type ApiKeyInsert = {
  id?:           string;
  tenant_id:     string;
  label:         string;
  key_prefix:    string;
  key_hash:      string;
  scopes?:       string[];
  last_used_at?: string | null;
  revoked_at?:   string | null;
  created_by?:   string | null;
  created_at?:   string;
};
type ApiKeyUpdate = Partial<Omit<ApiKeyInsert, "tenant_id">>;

// ============================================================
// whatsapp_messages — conversation history (migration 0038)
// ============================================================
export type WhatsAppDirection = "inbound" | "outbound";
export type WhatsAppMessageType =
  | "text" | "template" | "image" | "document" | "video" | "audio"
  | "location" | "reaction" | "sticker" | "button" | "interactive" | "unsupported";
export type WhatsAppMessageStatus =
  | "pending" | "sent" | "delivered" | "read" | "failed" | "received";

export type WhatsAppMessageRow = {
  id:                  string;
  tenant_id:           string;
  wamid:               string | null;
  contact_phone:       string;
  direction:           WhatsAppDirection;
  type:                WhatsAppMessageType;
  text_body:           string | null;
  template_name:       string | null;
  template_lang:       string | null;
  template_params:     unknown;
  media_id:            string | null;
  media_mime:          string | null;
  media_filename:      string | null;
  status:              WhatsAppMessageStatus;
  error_code:          string | null;
  error_message:       string | null;
  related_lead_id:     string | null;
  related_quote_id:    string | null;
  related_customer_id: string | null;
  meta_timestamp:      string | null;
  created_at:          string;
};
type WhatsAppMessageInsert = Partial<WhatsAppMessageRow> & {
  tenant_id:     string;
  contact_phone: string;
  direction:     WhatsAppDirection;
  type:          WhatsAppMessageType;
};
type WhatsAppMessageUpdate = Partial<Omit<WhatsAppMessageInsert, "id" | "tenant_id">>;

// ============================================================
// Banking — bank_accounts + bank_transactions (migration 0048)
// ============================================================
export type BankAccountType =
  | "current" | "savings" | "overdraft" | "fixed_deposit" | "cash" | "other"
  | "credit_card";   // liability account — balance goes negative as you spend (0151)

export type BankTransactionSource =
  | "manual" | "csv_upload" | "api_fetch";

export type BankMatchToType =
  | "payment" | "project" | "expense" | "vendor_bill" | "transfer" | "salary" | "split" | "manual" | "statutory";

export type BankMatchConfidence =
  | "exact" | "high" | "low" | "manual";

type BankAccountRow = {
  id:                   string;
  tenant_id:            string;
  name:                 string;
  bank_name:            string;
  account_number_last4: string | null;   // null for a cash / petty-cash account
  ifsc:                 string | null;   // null for a cash / petty-cash account
  account_type:         BankAccountType;
  opening_balance:      number;
  opening_balance_date: string;
  is_active:            boolean;
  notes:                string | null;
  created_at:           string;
  updated_at:           string;
};
type BankAccountInsert = Partial<BankAccountRow> & {
  tenant_id:            string;
  name:                 string;
  bank_name:            string;
  opening_balance_date: string;
};
type BankAccountUpdate = Partial<Omit<BankAccountInsert, "id" | "tenant_id">>;

/** Which layer decided a bank line's category. Mirrors the DB check constraint. */
export type TxnCategorySource = "rule" | "ai" | "manual";
/** Which side of the statement a rule may fire on. Mirrors the DB check constraint. */
export type TxnRuleDirection = "debit" | "credit" | "any";

type TxnCategoryRuleRow = {
  id:                  string;
  tenant_id:           string;
  /** Matched case-insensitively as a SUBSTRING of the narration. Never blank (DB check). */
  pattern:             string;
  category:            string;
  direction:           TxnRuleDirection;
  hit_count:           number;
  created_from_txn_id: string | null;
  created_by:          string | null;
  created_at:          string;
  updated_at:          string;
};
type TxnCategoryRuleInsert = Partial<TxnCategoryRuleRow> & {
  tenant_id: string;
  pattern:   string;
  category:  string;
};
type TxnCategoryRuleUpdate = Partial<Omit<TxnCategoryRuleInsert, "id" | "tenant_id">>;

type BankTransactionRow = {
  id:               string;
  tenant_id:        string;
  bank_account_id:  string;
  txn_date:         string;
  description:      string;
  debit:            number;
  credit:           number;
  balance_after:    number | null;
  reference:        string | null;
  source:           BankTransactionSource;
  matched_to_type:  BankMatchToType | null;
  matched_to_id:    string | null;
  matched_at:       string | null;
  matched_by:       string | null;
  match_confidence: BankMatchConfidence | null;
  /* Categorisation (20260822090000). Nullable on purpose: null means "no category yet",
     which is a real state and must stay distinguishable from a category. The DB enforces
     that category and category_source are set together — a category with no stated source
     is an unattributable number in the books. */
  category:            string | null;
  category_source:     TxnCategorySource | null;
  category_confidence: number | null;
  imported_at:      string;
  created_at:       string;
  updated_at:       string;
};
type BankTransactionInsert = Partial<BankTransactionRow> & {
  tenant_id:       string;
  bank_account_id: string;
  txn_date:        string;
  description:     string;
};
type BankTransactionUpdate = Partial<Omit<BankTransactionInsert, "id" | "tenant_id">>;

// AA connection (migration 0050)
export type BankAaProvider = "setu" | "finvu" | "onemoney";
export type BankAaStatus =
  | "initiated" | "pending_approval" | "active" | "expired" | "revoked" | "rejected" | "error";

type BankAaConnectionRow = {
  id:                  string;
  tenant_id:           string;
  bank_account_id:     string;
  provider:            BankAaProvider;
  vua:                 string;
  consent_handle_id:   string | null;
  consent_id:          string | null;
  linked_account_ref:  string | null;
  status:              BankAaStatus;
  status_reason:       string | null;
  consent_expires_at:  string | null;
  fetch_window_from:   string | null;
  fetch_window_to:     string | null;
  last_fetch_at:       string | null;
  last_fetch_status:   string | null;
  last_fetch_count:    number;
  next_fetch_after:    string | null;
  consent_payload:     unknown;
  notes:               string | null;
  created_at:          string;
  updated_at:          string;
};
type BankAaConnectionInsert = Partial<BankAaConnectionRow> & {
  tenant_id:       string;
  bank_account_id: string;
  vua:             string;
};
type BankAaConnectionUpdate = Partial<Omit<BankAaConnectionInsert, "id" | "tenant_id">>;

// Suggestion row returned by suggest_bank_transaction_matches RPC
export type BankMatchSuggestionRow = {
  match_type:       "payment" | "project" | "expense" | "salary";
  match_id:         string;
  match_label:      string;
  match_amount:     number;
  match_date:       string;
  match_confidence: "exact" | "high" | "low";
};

type UserRow = {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string | null;
  initials: string | null;
  role: "owner" | "manager" | "sales" | "sales_senior" | "billing" | "accountant" | "delivery" | "support";
  color: string | null;
  avatar_url: string | null;
  is_active: boolean;
  /** Migration 0045 — sales-role extension: when true, user also sees /deals. */
  can_view_deals: boolean;
  employee_id: string | null;   // migration 0216 — self check-in link
  /** Who this user reports to. NULL at the top of the tree. Applied 18 Aug 2026. */
  manager_id: string | null;
  /** Migration 20260819150000 — attendance check-in / check-out popup. */
  attendance_reminders_enabled: boolean;
  /** Wall-clock `time` in Asia/Kolkata, e.g. "18:00:00". */
  attendance_checkout_reminder_at: string;
  created_at: string;
}
type UserInsert = {
  id: string;
  tenant_id: string;
  email: string;
  full_name?: string | null;
  initials?: string | null;
  role?: "owner" | "manager" | "sales" | "sales_senior" | "billing" | "accountant" | "delivery" | "support";
  color?: string | null;
  avatar_url?: string | null;
  is_active?: boolean;
  can_view_deals?: boolean;
  employee_id?: string | null;
  manager_id?: string | null;
  attendance_reminders_enabled?: boolean;
  attendance_checkout_reminder_at?: string;
  created_at?: string;
}
type UserUpdate = Partial<UserInsert>;

/** An additional person at a customer (migration 0164 — Zoho-style contact persons). */
export type ContactPerson = {
  salutation?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  designation?: string;
};

/** Separate shipping address (migration 0164). Billing stays the flat customer columns. */
export type ShippingAddress = {
  attention?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
};

/** Customer classification (migration 0165). Individuals have no company. */
export type CustomerType = "business" | "individual";

type CustomerRow = {
  id: string;
  tenant_id: string;
  name: string;
  // Migration 0165 — Zoho-style type + display label. `name` stays the legal /
  // invoice name; `display_name` is the optional friendly UI label.
  customer_type: CustomerType;
  display_name: string | null;
  customer_number: string | null;
  domain: string | null;
  gstin: string | null;
  state: string | null;
  state_code: string | null;
  country: string;                             // migration 0152 — 'India' default; anything else = export (zero-rated)
  health: number;
  contact_name: string | null;
  contact_title: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  // Migration 0164 — Zoho-style split primary contact + extras.
  contact_salutation: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_mobile: string | null;
  contact_persons: ContactPerson[];
  payment_terms_days: number | null;
  shipping_address: ShippingAddress | null;
  account_manager_id: string | null;
  since: string;
  notes: string | null;
  // Added in migration 0014 — TDS profile for B2B customers who deduct TDS
  tan: string | null;                          // Tax Account Number (different from GSTIN)
  tds_default_section: string | null;          // '194J' (services) / '194C' (contracts) / etc.
  tds_default_rate_pct: number | null;         // 10.00 / 2.00 / 0.10
  // Added in migration 0036 — billing address + cached GSTIN verification
  address: string | null;
  city: string | null;                         // migration 0166 — billing city
  pin_code: string | null;
  gstin_verified_at: string | null;
  gstin_verification: GstinVerification | null;
  // Added in migration 0043 — distributor-side flag: this customer is also
  // a tenant in ResellerOS (a sub-reseller child). When set, invoices
  // issued to this customer auto-mirror into the linked tenant's vendor_bills.
  linked_tenant_id: string | null;
  // Migration 0168 — optional parent account (customer_groups). Links companies
  // routed by one common reseller/coordinator; does NOT affect this customer's own invoicing.
  group_id: string | null;
  // Migration 0172 — Zoho-style archive flag. false = inactive/archived (hidden
  // from the default list; all money records retained). Reversible.
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
type CustomerInsert = {
  id?: string;
  tenant_id: string;
  name: string;
  customer_type?: CustomerType;
  display_name?: string | null;
  customer_number?: string | null;
  domain?: string | null;
  gstin?: string | null;
  state?: string | null;
  state_code?: string | null;
  country?: string;                            // migration 0152 — defaults to 'India' if omitted
  health?: number;
  contact_name?: string | null;
  contact_title?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_salutation?: string | null;
  contact_first_name?: string | null;
  contact_last_name?: string | null;
  contact_mobile?: string | null;
  contact_persons?: ContactPerson[];
  payment_terms_days?: number | null;
  shipping_address?: ShippingAddress | null;
  account_manager_id?: string | null;
  since?: string;
  notes?: string | null;
  tan?: string | null;
  tds_default_section?: string | null;
  tds_default_rate_pct?: number | null;
  address?: string | null;
  city?: string | null;
  pin_code?: string | null;
  gstin_verified_at?: string | null;
  gstin_verification?: GstinVerification | null;
  linked_tenant_id?: string | null;
  group_id?: string | null;
  is_active?: boolean;
}
type CustomerUpdate = Partial<CustomerInsert>;

// Migration 0168 — Customer Groups / Parent Accounts. Umbrella linking multiple
// customer companies routed by one common reseller/coordinator. Reporting layer
// only — each member company keeps its own GSTIN + invoices.
type CustomerGroupRow = {
  id: string;
  tenant_id: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_partner: boolean;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};
type CustomerGroupInsert = {
  id?: string;
  tenant_id: string;
  name: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  is_partner?: boolean;
  notes?: string | null;
  is_active?: boolean;
  created_by?: string | null;
};
type CustomerGroupUpdate = Partial<CustomerGroupInsert>;

/**
 * Per-commitment pricing for an item. Only 2 underlying prices — annual commit
 * has the SAME ₹/seat/month rate regardless of billing frequency (monthly invoice
 * vs single yearly invoice). The form shows 3 rows but row 2 (annual monthly bill)
 * and row 3 (annual yearly bill) bind to the same `annual` value.
 *
 *  - monthly — no commitment, monthly bill (highest rate, max flexibility)
 *  - annual  — 1-yr commit, ₹/seat/month (billed monthly OR yearly = same total)
 */
export type ItemPriceTier = "monthly" | "annual";
export type ItemPrices = Partial<Record<ItemPriceTier, { msrp: number; wholesale: number }>> & {
  /**
   * Real USD list price (USD per seat per MONTH) for international/export deals.
   * A SaaS product's USD price is its own number, NOT an INR→USD conversion
   * (e.g. Google Workspace ₹136/mo vs $7/mo). Optional — when set, USD quotes/
   * invoices use it; otherwise they fall back to converting the ₹ price.
   */
  usd?: { msrp: number; wholesale: number };
  /**
   * Seat-slab volume pricing — "1-10 seats ₹270, 11-50 ₹250, 51+ ₹230".
   * ₹/seat/MONTH like the tiers above. VOLUME pricing (one rate for all seats),
   * deliberately not graduated — see lib/quotes/volume-tiers.ts for why that
   * distinction is a money decision and not a detail.
   * Absent on most rows; `slabPricing()` falls back to the flat tiers.
   */
  slabs?: Array<{ minSeats: number; maxSeats: number | null; msrp: number; wholesale: number }>;
};

type ItemRow = {
  id: string;
  tenant_id: string;
  name: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  /** "main" = core plan offered standalone · "addon" = upsell paired with a main plan */
  kind: "main" | "addon";
  /** "subscription" = recurring per-seat/mo · "one_time" = one-off product/service */
  item_type: "subscription" | "one_time";
  /** For a SUPPORT SKU: which product it covers (migration 20260817190000).
   *  Same spellings as `vendor` so the entitlement check is a direct comparison,
   *  plus "all". NULL means nobody classified it — entitlement reports that as
   *  UNKNOWN, never as "all", because a plan silently covering products it was never
   *  sold for is how a customer is promised support nobody agreed to. */
  covered_product: "google" | "microsoft" | "zoho" | "hosting" | "domain" | "other" | "all" | null;
  hsn: string | null;
  /** Default price (typically annual_upfront — kept as the headline number) */
  msrp: number;
  wholesale: number;
  /** Per-commitment pricing matrix */
  prices: ItemPrices;
  margin_pct: number;
  is_active: boolean;
  // Partner Catalog (migration 0041) ───────────────────────────────────────
  /** Distributor marks this row visible to sub-reseller children. */
  is_partner_visible: boolean;
  /** ₹/seat/MONTH the distributor charges children. Nullable when not partner-visible. */
  partner_price: number | null;
  /** On a child's row: the parent item id this row was synced from. */
  synced_from_partner_id: string | null;
  created_at: string;
}
type ItemInsert = {
  id: string;
  tenant_id: string;
  name: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  kind?: "main" | "addon";
  item_type?: "subscription" | "one_time";
  covered_product?: "google" | "microsoft" | "zoho" | "hosting" | "domain" | "other" | "all" | null;
  hsn?: string | null;
  msrp: number;
  wholesale: number;
  prices?: ItemPrices;
  is_active?: boolean;
  is_partner_visible?: boolean;
  partner_price?: number | null;
  synced_from_partner_id?: string | null;
}
type ItemUpdate = Partial<ItemInsert>;

/** Row returned by get_partner_metrics() RPC (migration 0044). */
export type PartnerMetricsRow = {
  tenant_id:            string;
  tenant_name:          string;
  tenant_gstin:         string | null;
  active_subscriptions: number;
  total_seats_sold:     number;
  mrr:                  number;
  invoiced_this_month:  number;
  paid_this_month:      number;
  renewals_due_30d:     number;
  renewal_revenue_30d:  number;
  last_invoice_date:    string | null;
};

/** Row returned by get_partner_catalog() RPC (migration 0041). */
export type PartnerCatalogRow = {
  id: string;
  tenant_id: string;
  name: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  kind: "main" | "addon";
  hsn: string | null;
  msrp: number;
  partner_price: number | null;
  prices: ItemPrices;
  is_active: boolean;
  /** True when the calling child tenant already has a row with synced_from_partner_id = this row's id. */
  already_synced: boolean;
};

export type LeadPriority = "low" | "medium" | "high";

type LeadRow = {
  id: string;
  tenant_id: string;
  company: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  plan: string | null;
  seats: number | null;
  value: number | null;
  stage: "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";
  is_junk: boolean;                 // migration 0187 — spam/fake; hidden from working views
  /** WHY it was binned (migration 20260817200000). NULL on leads binned before
   *  reasons existed — deliberately not backfilled. Matches JunkReasonId in
   *  lib/leads/qualification.ts. Recoverability hangs off this: "fake_phone" is a
   *  live enquiry again the moment a real number arrives, "not_commercial" never is. */
  junk_reason: "fake_phone" | "spam_email" | "not_commercial" | "unresponsive" | "other" | null;
  junk_note:   string | null;
  junked_at:   string | null;
  /**
   * Migration 0225 — why a deal was lost, captured at the moment it's marked
   * lost. `lost_reason` is CHECK-constrained to the codes in
   * lib/leads/loss-reasons.ts. `lost_at` is separate from `updated_at` because
   * any later edit moves updated_at, which would make "lost in the last 90
   * days" unanswerable. All three are NULL for deals lost before capture
   * existed — reported as "Not recorded", never back-filled with a guess.
   */
  lost_reason: string | null;
  lost_note:   string | null;
  lost_at:     string | null;
  owner_id: string | null;
  source: string | null;
  /** Migration 0018 — structured domain captured at lead intake (trial / buy page) */
  domain: string | null;
  notes: string | null;
  /** Migration 0026 — trial lifecycle tracking */
  trial_started_at:   string | null;
  trial_expires_at:   string | null;
  trial_converted_at: string | null;
  trial_expired_at:   string | null;
  // Migration 0046 — sales workflow fields
  /** Next planned contact (call/email/meeting). Drives the daily "who do I call today" worklist. */
  follow_up_date: string | null;     // YYYY-MM-DD
  /**
   * When the rep expects this deal to CLOSE (migration 20260816094848). YYYY-MM-DD.
   *
   * Distinct from `follow_up_date`, which is the next touch. A deal can be followed up
   * weekly for two months and still be expected to close in March; conflating the two
   * makes both useless.
   *
   * NULL means nobody has committed to a date. buildForecast() reports those separately
   * rather than guessing — see lib/leads/forecast.ts.
   */
  expected_close_date: string | null;
  /**
   * When this lead last entered its current stage (migration 20260816100506).
   *
   * NULL means unknown, and must be rendered as unknown. `updated_at` is NOT a
   * substitute — it bumps on any edit, so a deal stuck in `quote` for three weeks reads
   * as one day old the moment somebody corrects its phone number.
   */
  stage_changed_at: string | null;
  /**
   * Which sales motion this deal belongs to (migration 20260816101730).
   *
   * Seeded from `subscription_type` — fresh becomes new_logo, switch becomes migration —
   * so the two do not start life disagreeing. They may diverge afterwards.
   * 'renewal' is never inferred: nothing in `leads` identifies one.
   */
  pipeline: "new_logo" | "migration" | "renewal";
  /** Triage signal: 'low' / 'medium' / 'high'. Default 'medium'. */
  priority: LeadPriority;
  /** B2B GSTIN captured at lead time (auto-fills legal name + address on conversion). */
  gstin: string | null;
  /** GST place-of-supply, copied to the customer on conversion (drives IGST vs CGST+SGST). */
  state_code: string | null;
  state: string | null;
  country: string;                             // migration 0153 — non-India = export prospect
  /** Migration 0108 — 'fresh' = net-new subscription · 'switch' = already
   *  subscribed elsewhere, moving vendor/reseller to us (migration/transfer). */
  subscription_type: "fresh" | "switch" | null;
  /** Migration 0197 — the master contact (person) this lead belongs to.
   *  Auto-linked on insert via resolve_or_create_contact. */
  contact_id: string | null;
  /** Migration 0232 — inbound attribution, captured by lib/marketing/utm.ts on the
   *  four public lead-creating routes. NULL on every lead created before 0232 and
   *  on anything typed in by hand: NULL means "nothing was captured", which is a
   *  different fact from "unknown". */
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** Origin + path only; query string stripped (it leaks search terms/tokens). */
  referrer_url: string | null;
  /** Path + utm params ONLY. Other query params are dropped before storage --
   *  they routinely carry email/phone/session ids (DPDP). */
  landing_page_url: string | null;
  /**
   * Ad-platform click ids (migration 0232).
   *
   * These exist for ONE purpose: offline conversion import. Telling Google or
   * Meta that a click became a paid deal requires sending the original click id
   * back, and an id that was never stored can never be sent. Captured before any
   * API integration exists because token approval takes weeks and the leads that
   * arrive in the meantime would otherwise be permanently un-attributable.
   *
   * wbraid is what Google sends INSTEAD of gclid when consent limits tracking,
   * so reading only gclid silently loses every consent-limited click.
   */
  gclid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  created_at: string;
  updated_at: string;
}
type LeadInsert = {
  id: string;
  tenant_id: string;
  company: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  plan?: string | null;
  seats?: number | null;
  value?: number | null;
  stage?: "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";
  owner_id?: string | null;
  source?: string | null;
  domain?: string | null;
  notes?: string | null;
  trial_started_at?:   string | null;
  trial_expires_at?:   string | null;
  trial_converted_at?: string | null;
  trial_expired_at?:   string | null;
  follow_up_date?:     string | null;
  expected_close_date?: string | null;
  /** Set by trg_leads_stage_changed_at — never write it by hand. */
  stage_changed_at?: string | null;
  pipeline?: "new_logo" | "migration" | "renewal";
  priority?:           LeadPriority;
  gstin?:              string | null;
  state_code?:         string | null;
  state?:              string | null;
  country?:            string;
  subscription_type?:  "fresh" | "switch" | null;
  is_junk?:            boolean;
  junk_reason?: "fake_phone" | "spam_email" | "not_commercial" | "unresponsive" | "other" | null;
  junk_note?:   string | null;
  junked_at?:   string | null;
  contact_id?:         string | null;
  lost_reason?:        string | null;   // migration 0225
  lost_note?:          string | null;
  lost_at?:            string | null;
  // Migration 0232 — inbound attribution. Optional: only the public routes have
  // a landing URL to read, and a hand-typed lead legitimately has none.
  utm_source?:         string | null;
  utm_medium?:         string | null;
  utm_campaign?:       string | null;
  referrer_url?:       string | null;
  landing_page_url?:   string | null;
  gclid?:              string | null;
  wbraid?:             string | null;
  fbclid?:             string | null;
}
type LeadUpdate = Partial<LeadInsert>;

/**
 * A line's PRICE TIER. Since migration 0161, invoice frequency lives in the
 * quote-level `billing_cycle` — a line's `commitment` now only distinguishes
 * flex-monthly pricing from annual-commit pricing. New quotes write just two
 * values: "monthly" (flex) or "annual_yearly" (annual price tier). The
 * annual_monthly/quarterly/half_yearly variants are legacy (pre-0161) and are
 * still read/tolerated — record_payment's "make a subscription?" gate keys off
 * `commitment is distinct from 'monthly'`, which holds for all annual_* values.
 *  - monthly            — flex, no commitment (its own price tier)
 *  - annual_yearly      — annual commitment price tier (default)
 *  - annual_* (legacy)  — annual price tier; frequency now in quote.billing_cycle
 */
export type LineCommitment =
  | "monthly"
  | "annual_monthly"
  | "annual_quarterly"
  | "annual_half_yearly"
  | "annual_yearly";

/**
 * Quote-level BILLING CYCLE = how often invoices are raised through the year.
 * Migration 0161 made this independent of a line's `commitment` (which is now
 * the PRICE TIER: monthly-flex vs annual). A flex-monthly line forces the whole
 * quote to 'monthly'. Frequency is a stated schedule/label today — it does not
 * yet auto-generate N invoices/yr (that's a separate future feature).
 */
export type BillingCycle = "monthly" | "quarterly" | "half_yearly" | "yearly";

/** Invoices raised per year for each billing cycle. */
export const BILLING_CYCLE_INVOICES_PER_YEAR: Record<BillingCycle, number> = {
  yearly: 1, half_yearly: 2, quarterly: 4, monthly: 12,
};

export type QuoteLineItem = {
  id: string;        // local UUID for React keys
  item_id?: string;  // FK to items table (optional — only if from catalog)
  name: string;
  description?: string;
  qty: number;
  rate: number;          // ₹ per seat — annual amount regardless of billing frequency (the negotiated SELLING price)
  /** ₹ per seat/yr — the LIST price captured when the line was added (catalog MSRP,
   *  or the first rate entered for a custom item). Frozen; editing `rate` below this
   *  surfaces the difference as the customer's discount. Falls back to `rate` if unset. */
  list_rate?: number;
  cost: number;          // ₹ per seat — annual wholesale (for margin calc)
  commitment?: LineCommitment;  // billing/commitment tier (default "annual_yearly")
  /** Service start date (YYYY-MM-DD). Blank ⇒ subscription starts on payment date.
   *  When set, record_payment uses it as the subscription start (renewal = start + term). */
  start_date?: string;
  /** Reseller-given discount on THIS line (0–50%). Comes out of reseller margin, NOT Google wholesale. */
  discount_pct?: number;
  /** Optional reason shown on quote PDF + accept page (e.g., "Loyalty discount", "Volume offer"). */
  discount_reason?: string;
  /** BULK ORDER: when true, this one line expands into one subscription PER domain on payment. */
  bulk?: boolean;
  /** Per-domain breakdown for a bulk line. `qty` must equal the sum of these seats. */
  domains?: Array<{ domain: string; seats: number }>;
  /** Optional domain this subscription is provisioned against (Google Workspace /
   *  M365 / Zoho). Per-line because a quote can hold products for different domains. */
  domain?: string | null;
  // Customer-adjustable quote (lib/quotes/configure.ts) ─────────────────────
  /** The customer may tick this line on or off on the public quote page. */
  optional?: boolean;
  /** For an optional line: is it ticked when the page first loads? */
  included_by_default?: boolean;
  /** The customer may change the seat count on the public quote page. */
  seats_adjustable?: boolean;
  /** Bounds for that change. Absent → a sensible default around the quoted qty. */
  min_seats?: number;
  max_seats?: number;
};

type QuoteRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  lead_id: string | null;
  plan: string | null;
  seats: number | null;
  amount: number | null;
  status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";
  owner_id: string | null;
  created_date: string;
  expires_date: string | null;
  pdf_url: string | null;
  line_items: QuoteLineItem[];
  subtotal: number;
  total_cost: number;
  discount_pct: number;
  tax_rate: number;
  notes: string | null;
  payment_status: "none" | "awaiting" | "partial" | "received" | "invoiced";
  payment_amount: number | null;
  payment_method: string | null;
  payment_reference: string | null;
  payment_received_at: string | null;
  payment_notes: string | null;
  invoice_id: string | null;
  /** True when issued for the renewal of an existing subscription. Migration 0011. */
  is_renewal: boolean;
  currency: string;                            // migration 0153 — billing currency ('INR' default); books stay INR
  exchange_rate: number;                       // INR per 1 unit of currency (1 for INR)
  /** Migration 0018 — structured domain copied from lead at quote create, propagates to subscription. */
  domain: string | null;
  /** Migration 0020 — how many months to advance subscription.renewal_date when this (renewal) quote is paid. Default 12. Used by record_payment. */
  extension_months: number;
  /** Migration 0021 — display-only flag set by the operator "Extend subscription" flow. */
  is_extension: boolean;
  /** Migration 0052 — true for add-seats quotes; record_payment skips subscription handling so it does not create a duplicate sub. */
  is_add_seats: boolean;
  /** Migration 0157 — true for direct one-off invoices; record_payment skips subscription creation. */
  is_one_off: boolean;
  /** Migration 0161 — invoice frequency, independent of line price-tier commitment. Default 'yearly'. */
  billing_cycle: BillingCycle;
  /** Migration 0162 — net days for the invoice due date (0/15/30/45); null → 30. */
  payment_terms_days: number | null;
  /** Migration 0162 — document-level terms & conditions shown on the quote/invoice PDF. */
  terms_conditions: string | null;
  /** Migration 0115 — unguessable token for the public /quote/[id]/accept link (SEC-1). */
  public_token: string;
  /** Migration 0167 — typed-prospect place-of-supply, copied to the customer by record_payment (drives IGST vs CGST+SGST). Null for lead/customer quotes. */
  prospect_state_code: string | null;
  prospect_state: string | null;
  prospect_country: string | null;
  // Discount / margin approval (migration 20260816110500) ──────────────────
  /** Where this quote sits in the approval matrix. See lib/quotes/approval.ts. */
  approval_status: "not_required" | "pending" | "approved" | "rejected";
  /** Which sign-off is needed. Null when none is. */
  approval_tier: "manager" | "owner" | null;
  /** Who pushed it into the queue. The self-approval rule keys on THIS, not owner_id. */
  approval_requested_by: string | null;
  approval_requested_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  /** The discount that was ACTUALLY signed off, in basis points (1500 = 15%). Compared
   *  against the quote's current discount so an edit after approval cannot stay approved. */
  approved_discount_bps: number | null;
  /** The margin that was ACTUALLY signed off, in basis points. Null also means it was
   *  unknown at approval time. */
  approved_margin_bps: number | null;
  approval_rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}
type QuoteInsert = {
  id: string;
  tenant_id: string;
  customer_id?: string | null;
  customer_name: string;
  lead_id?: string | null;
  plan?: string | null;
  seats?: number | null;
  amount?: number | null;
  status?: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";
  owner_id?: string | null;
  created_date?: string;
  expires_date?: string | null;
  pdf_url?: string | null;
  line_items?: QuoteLineItem[];
  subtotal?: number;
  total_cost?: number;
  discount_pct?: number;
  tax_rate?: number;
  notes?: string | null;
  payment_status?: "none" | "awaiting" | "partial" | "received" | "invoiced";
  payment_amount?: number | null;
  payment_method?: string | null;
  payment_reference?: string | null;
  payment_received_at?: string | null;
  payment_notes?: string | null;
  invoice_id?: string | null;
  is_renewal?: boolean;
  currency?: string;
  exchange_rate?: number;
  domain?: string | null;
  extension_months?: number;
  is_extension?: boolean;
  is_add_seats?: boolean;
  is_one_off?: boolean;
  billing_cycle?: BillingCycle;
  payment_terms_days?: number | null;
  terms_conditions?: string | null;
  prospect_state_code?: string | null;
  prospect_state?: string | null;
  prospect_country?: string | null;
  approval_status?: "not_required" | "pending" | "approved" | "rejected";
  approval_tier?: "manager" | "owner" | null;
  approval_requested_by?: string | null;
  approval_requested_at?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  approved_discount_bps?: number | null;
  approved_margin_bps?: number | null;
  approval_rejection_reason?: string | null;
}
type QuoteUpdate = Partial<QuoteInsert>;

/**
 * A click-to-sign acknowledgement on the public quote page.
 *
 * Evidence of assent — NOT a digital signature under the IT Act 2000, which needs a
 * DSC from a licensed CA. See migration 20260816113000 for why that distinction is
 * written down rather than assumed.
 */
type QuoteSignatureRow = {
  id: string;
  tenant_id: string;
  quote_id: string;
  signer_name: string;
  signer_email: string | null;
  signer_title: string | null;
  signer_ip: string | null;
  user_agent: string | null;
  /** The lines and total AS SHOWN at signing — a signature pointing at a mutable row
   *  proves nothing. */
  signed_snapshot: {
    subtotal?: number;
    total?: number;
    lines?: Array<{ name: string; qty: number; rate: number }>;
    changed?: boolean;
  };
  signed_at: string;
  created_at: string;
};
/**
 * One dunning message per overdue invoice.
 *
 * Separate from renewal_email_log on purpose: that counts DOWN to a renewal, this
 * counts UP from a due date, and a customer can be current on one and late on the
 * other. See migration 20260816114500.
 */
type InvoiceDunningLogRow = {
  id: string;
  tenant_id: string;
  invoice_id: string;
  /** 'reminder' | 'retry' | 'grace_warning' | 'final' — see lib/invoices/dunning.ts. */
  dunning_step: string;
  days_overdue: number;
  /** What was DONE, which is not always what the step implies. */
  action_taken: string;
  recipient_email: string | null;
  subject: string | null;
  status: string;
  error_message: string | null;
  sent_at: string;
};
type InvoiceDunningLogInsert = {
  id?: string;
  tenant_id: string;
  invoice_id: string;
  dunning_step: string;
  days_overdue: number;
  action_taken?: string;
  recipient_email?: string | null;
  subject?: string | null;
  status?: string;
  error_message?: string | null;
  sent_at?: string;
};

/**
 * Seats to be created at a vendor once a quote is paid.
 *
 * Raised by trg_quotes_raise_provisioning as ONE unresolved row per paid quote (vendor
 * / plan / seats all null); the app expands it per line with lib/provisioning/plan.ts.
 * No vendor API is connected on this project, so every task is mode='manual'.
 */
type ProvisioningTaskRow = {
  id: string;
  tenant_id: string;
  quote_id: string;
  vendor: string | null;
  plan: string | null;
  seats: number | null;
  domain: string | null;
  /** 'api' the day a vendor client exists; 'manual' until then. */
  mode: string;
  /** pending | in_progress | done | failed | not_required. "not_required" is a real
   *  outcome (a services-only quote), NOT a silent success. */
  status: string;
  error_message: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};
/**
 * A customer asking for a seat change, as data rather than as prose in a ticket.
 * See migration 20260816150000 for why this is not a support_tickets row.
 */
type SeatRequestRow = {
  id: string;
  tenant_id: string;
  subscription_id: string;
  customer_id: string | null;
  customer_name: string;
  /** Seats at REQUEST time — the subscription can move underneath a pending row. */
  current_seats: number;
  requested_seats: number;
  effective_on: string | null;
  note: string | null;
  requested_by_email: string | null;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  /** The quote addSeats() produced on approval. Null until then. */
  quote_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  /** Shown to the CUSTOMER, so it is written for them. */
  decision_note: string | null;
  created_at: string;
  updated_at: string;
};
/**
 * One customer's MRR for one month. The history NRR is computed from — nothing else
 * in this schema records what MRR WAS. Grain is the CUSTOMER, so a plan swap is not
 * a churn plus a new customer. See migration 20260816160000.
 */
type MrrSnapshotRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  /** First day of the month described. */
  period: string;
  mrr: number;
  subscription_count: number;
  created_at: string;
};
/**
 * An append-only record of a change to a subscription's commercial terms.
 *
 * `Insert` and `Update` are `never` on purpose: rows arrive only from
 * trg_subscriptions_record_amendment, and the table refuses edits outright. Typing
 * them as writable would offer the app a door Postgres has already bricked up.
 * See migration 20260816170000.
 */
type ContractAmendmentRow = {
  id: string;
  tenant_id: string;
  subscription_id: string;
  customer_name: string | null;
  /** One or more joined with "+", e.g. "seats_added+price_changed". */
  kind: string;
  /** {field: {from, to}} for every commercial field that moved. */
  changes: Record<string, { from: unknown; to: unknown }>;
  seats_from: number | null;
  seats_to: number | null;
  mrr_from: number | null;
  mrr_to: number | null;
  changed_by: string | null;
  /** "user" when a person did it, "system" for crons and service-role routes. */
  source: string;
  note: string | null;
  created_at: string;
};

/**
 * A customer's standing permission to be debited (UPI Autopay / e-NACH).
 *
 *  is written ONLY by the signature-verified Razorpay webhook.
 * See migration 20260817090000 for why the app has no path to it.
 */
type PaymentMandateRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  subscription_id: string | null;
  method: string;
  status: "pending_authorisation" | "active" | "paused" | "cancelled" | "expired";
  /** ₹ per debit the customer APPROVED. Null until the gateway confirms. */
  max_amount: number | null;
  /** ₹ we asked for — kept apart so a request/approval mismatch stays visible. */
  requested_amount: number;
  gateway: string;
  gateway_plan_id: string | null;
  gateway_subscription_id: string | null;
  gateway_customer_id: string | null;
  auth_link: string | null;
  /** TRUE when created against test keys — on the row, so a key swap cannot make a
   *  test mandate read as a live authorisation. */
  test_mode: boolean;
  authorised_at: string | null;
  cancelled_at: string | null;
  end_date: string | null;
  status_note: string | null;
  created_at: string;
  updated_at: string;
};
type PaymentMandateInsert = {
  id?: string;
  tenant_id: string;
  customer_id: string;
  subscription_id?: string | null;
  method?: string;
  status?: "pending_authorisation" | "active" | "paused" | "cancelled" | "expired";
  max_amount?: number | null;
  requested_amount: number;
  gateway?: string;
  gateway_plan_id?: string | null;
  gateway_subscription_id?: string | null;
  gateway_customer_id?: string | null;
  auth_link?: string | null;
  test_mode?: boolean;
  authorised_at?: string | null;
  cancelled_at?: string | null;
  end_date?: string | null;
  status_note?: string | null;
  updated_at?: string;
};

/**
 * One instalment of a subscription term (migration 20260817110000).
 *
 * `invoice_id` null means "due, not yet raised" — that IS the state machine. The
 * unique key (subscription_id, term_start, period_index) is what stops the daily
 * billing cron invoicing the same period twice.
 */
type SubscriptionBillingRow = {
  id: string;
  tenant_id: string;
  subscription_id: string;
  /** First day of the term these instalments belong to. In the unique key because
   *  period_index restarts at 1 every term. */
  term_start: string;
  /** 1-based position within the term, matching BillingPeriod.index. */
  period_index: number;
  bill_on: string;
  period_start: string;
  period_end: string;
  /** ₹ EX-GST. The gross is derived once, when the invoice is raised. */
  taxable_amount: number;
  tax_rate: number;
  /** Null until raised. */
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
};
type SubscriptionBillingInsert = {
  id?: string;
  tenant_id: string;
  subscription_id: string;
  term_start: string;
  period_index: number;
  bill_on: string;
  period_start: string;
  period_end: string;
  taxable_amount: number;
  tax_rate?: number;
  invoice_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

type MrrSnapshotInsert = {
  id?: string;
  tenant_id: string;
  customer_id: string;
  period: string;
  mrr: number;
  subscription_count?: number;
};

type SeatRequestInsert = {
  id?: string;
  tenant_id: string;
  subscription_id: string;
  customer_id?: string | null;
  customer_name: string;
  current_seats: number;
  requested_seats: number;
  effective_on?: string | null;
  note?: string | null;
  requested_by_email?: string | null;
  status?: "pending" | "approved" | "rejected" | "withdrawn";
  quote_id?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  updated_at?: string;
};

type ProvisioningTaskInsert = {
  id?: string;
  tenant_id: string;
  quote_id: string;
  vendor?: string | null;
  plan?: string | null;
  seats?: number | null;
  domain?: string | null;
  mode?: string;
  status?: string;
  error_message?: string | null;
  completed_by?: string | null;
  completed_at?: string | null;
  updated_at?: string;
};

type QuoteSignatureInsert = {
  id?: string;
  tenant_id: string;
  quote_id: string;
  signer_name: string;
  signer_email?: string | null;
  signer_title?: string | null;
  signer_ip?: string | null;
  user_agent?: string | null;
  signed_snapshot?: QuoteSignatureRow["signed_snapshot"];
  signed_at?: string;
};

/**
 * Single entry in the adjusted_advances jsonb array on an invoice.
 * Snapshot of a Receipt Voucher payment that was applied against this invoice
 * at issue time. Frozen — never edited; later refunds become credit notes.
 */
export type InvoiceAdvanceAdjustment = {
  payment_id:  string;         // uuid of payments row
  voucher_no:  string | null;  // RV-2025-26-NNNN (null for legacy un-numbered)
  amount:      number;         // ₹ (paise once #103 lands)
  received_at: string;         // ISO timestamp
  method:      "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
};

type InvoiceRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  amount: number;                          // Gross invoice total (full quote amount)
  status: "draft" | "pending" | "paid" | "overdue" | "void";
  invoice_date: string;
  due_date: string | null;
  paid_date: string | null;
  overdue_days: number;
  razorpay_id: string | null;
  gst_irn: string | null;
  pdf_url: string | null;
  created_at: string;
  updated_at: string;
  // Advance adjustment (CGST Section 31 + Rule 53) — populated at invoice issue time
  adjusted_advances: InvoiceAdvanceAdjustment[];
  net_payable:       number | null;        // amount - sum(adjusted_advances.amount), floor 0
  paid_amount:       number;               // migration 0184 — ₹ received (project invoices synced by trigger)
  first_advance_at:  string | null;        // Drives 30-day GST clock (Sec 13(2))
  quote_id:          string | null;        // FK to source quote
  // GST breakdown persisted at issue time (migration 0116). taxable_value + tax_amount = amount.
  taxable_value:     number | null;
  tax_amount:        number | null;
  tax_rate:          number | null;
  inter_state:       boolean | null;       // true → IGST, false → CGST + SGST
  /** Lines for an invoice with NO backing quote — subscription instalments, project
   *  milestones (migration 20260817110000). When quote_id is set the quote's lines
   *  are authoritative and this stays null; lib/pdf/build-props.ts prefers the quote
   *  for everything it prints, which is why an instalment invoice carries no quote. */
  line_items:        QuoteLineItem[] | null;
}
type InvoiceInsert = {
  id: string;
  tenant_id: string;
  customer_id?: string | null;
  customer_name: string;
  amount: number;
  status?: "draft" | "pending" | "paid" | "overdue" | "void";
  invoice_date?: string;
  due_date?: string | null;
  paid_date?: string | null;
  overdue_days?: number;
  razorpay_id?: string | null;
  gst_irn?: string | null;
  pdf_url?: string | null;
  adjusted_advances?: InvoiceAdvanceAdjustment[];
  net_payable?:      number | null;
  first_advance_at?: string | null;
  quote_id?:         string | null;
  taxable_value?:    number | null;
  tax_amount?:       number | null;
  tax_rate?:         number | null;
  inter_state?:      boolean | null;
  line_items?:       QuoteLineItem[] | null;
}
type InvoiceUpdate = Partial<InvoiceInsert>;

export type RenewalState =
  | "pending"
  /** T-30 early heads-up. Added to the DB enum by migration 0228 — this union
   *  mirrors `public.renewal_state`, so it must not list a value the enum lacks. */
  | "early_notice"
  | "notice_sent"
  | "reminder_1"
  | "reminder_2"
  | "reminder_3"
  | "reminder_4"
  | "final_sent"
  | "grace_period"
  | "renewed"
  | "suspended";

type SubscriptionRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  domain: string | null;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  seats: number;
  used: number;
  mrr: number;
  start_date: string | null;
  renewal_date: string | null;
  status: "active" | "paused" | "expired" | "cancelled";
  is_urgent: boolean;
  /** ₹ amount still owed by customer (0 = fully paid). Service can be active with outstanding > 0. */
  outstanding_amount: number;
  /** Set when subscription is written off (uncollectable bad debt) */
  write_off_reason: string | null;
  written_off_at:   string | null;
  /** Last time operator sent a payment reminder */
  last_reminder_at: string | null;
  /** Renewal cadence position. Updated by /api/cron/renewals daily. */
  renewal_state:    RenewalState;
  /** How many cadence emails have fired against this subscription. */
  reminder_count:   number;
  /** Most recent cadence email timestamp (v2 column from migration 0008). */
  last_reminder_sent_at_v2: string | null;
  /** Auto-generated renewal quote (created at T-15). */
  renewal_quote_id: string | null;
  /** The quote whose payment created this sub. Scopes outstanding updates (bug #1b). */
  quote_id:         string | null;
  /** When the auto-suspend trigger fired. NULL = never auto-suspended. */
  suspended_at:     string | null;
  /** Customer-controlled (migration 0017). When false, no renewal quote auto-generated. */
  auto_renew:       boolean;
  /**
   * Catalog row this subscription sells (migration 0248). NULL when the plan has no
   * catalog row — normal, not an error. Auto-filled on write by
   * trg_subscriptions_resolve_item; an explicit value always wins.
   */
  item_id:          string | null;
  // Billing terms (migration 20260816130000) ────────────────────────────────
  /** How often this subscription is INVOICED — distinct from a quote line's
   *  commitment, which is the price tier. */
  billing_cycle:    BillingCycle;
  /** Length of the committed term. 12 = annual, 36 = a three-year deal.
   *  renewal_date says when the term ENDS; this says how long it is. */
  term_months:      number;
  /** The main plan this add-on is co-termed to. A relationship, not a copied
   *  anniversary — a copied date drifts the moment the parent's renewal moves. */
  parent_subscription_id: string | null;
  // Vendor COGS (migration 20260816140000) ──────────────────────────────────
  /** Seats the VENDOR provisions and bills us for. NOT `used` (assigned) and NOT
   *  `seats` (what we bill). NULL = never reconciled, which is not the same as 0. */
  vendor_seats: number | null;
  /** ₹/seat/month the vendor actually charges. Distinct from items.wholesale, which
   *  is the price list — the gap between them is the thing worth seeing. */
  vendor_cost_per_seat_month: number | null;
  /** When those were last confirmed. A count from four months ago is not a fact. */
  vendor_synced_at: string | null;
  /** When the assigned-user count was last confirmed. NULL means `used` has never
   *  been measured — 0-because-unmeasured is a blind spot, 0-because-measured is a
   *  churn alarm. Nothing writes `used` today, so this is NULL everywhere. */
  used_synced_at: string | null;
  created_at: string;
  updated_at: string;
}
type SubscriptionInsert = {
  id?: string;
  tenant_id: string;
  customer_id?: string | null;
  customer_name: string;
  domain?: string | null;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  seats: number;
  used?: number;
  mrr: number;
  start_date?: string | null;
  renewal_date?: string | null;
  status?: "active" | "paused" | "expired" | "cancelled";
  is_urgent?: boolean;
  outstanding_amount?: number;
  write_off_reason?: string | null;
  written_off_at?:   string | null;
  last_reminder_at?: string | null;
  renewal_state?:    RenewalState;
  reminder_count?:   number;
  last_reminder_sent_at_v2?: string | null;
  renewal_quote_id?: string | null;
  quote_id?:         string | null;
  suspended_at?:     string | null;
  auto_renew?:       boolean;
  /** migration 0248 — usually left to the trigger. */
  item_id?:          string | null;
  billing_cycle?:    BillingCycle;
  term_months?:      number;
  parent_subscription_id?: string | null;
  vendor_seats?: number | null;
  vendor_cost_per_seat_month?: number | null;
  vendor_synced_at?: string | null;
  used_synced_at?: string | null;
}
type SubscriptionUpdate = Partial<SubscriptionInsert>;

// ============================================================
// Payments — multiple per quote (partial / installments / refunds)
// ============================================================
export type PaymentMethod = "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";

type PaymentRow = {
  id:                 string;
  tenant_id:          string;
  quote_id:           string;
  customer_id:        string | null;
  amount:             number;
  method:             PaymentMethod;
  reference:          string | null;
  notes:              string | null;
  status:             "received" | "refunded";
  received_at:        string;
  refunded_at:        string | null;
  refund_reason:      string | null;
  recorded_by:        string | null;
  receipt_voucher_no: string | null;
  bank_account_id:    string | null;
  receipt_file_path:  string | null;
  created_at:         string;
}
type PaymentInsert = {
  id?:           string;
  tenant_id:     string;
  quote_id:      string;
  customer_id?:  string | null;
  amount:        number;
  method:        PaymentMethod;
  reference?:    string | null;
  notes?:        string | null;
  status?:       "received" | "refunded";
  received_at?:  string;
  refunded_at?:  string | null;
  refund_reason?: string | null;
  recorded_by?:  string | null;
  receipt_voucher_no?: string | null;
  bank_account_id?: string | null;
  receipt_file_path?: string | null;
}
type PaymentUpdate = Partial<PaymentInsert>;

// ============================================================
// Tasks — follow-up to-dos for sales reps (per migration 0007)
// ============================================================
export type TaskStatus = "pending" | "done" | "snoozed" | "cancelled";
export type TaskKind   = "call" | "email" | "meeting" | "followup" | "custom";

type TaskRow = {
  id:                       string;
  tenant_id:                string;
  owner_id:                 string | null;
  title:                    string;
  notes:                    string | null;
  kind:                     TaskKind;
  due_at:                   string;
  reminder_minutes_before:  number;
  status:                   TaskStatus;
  lead_id:                  string | null;
  quote_id:                 string | null;
  customer_id:              string | null;
  subscription_id:          string | null;
  created_at:               string;
  completed_at:             string | null;
  completed_by:             string | null;
  snooze_count:             number;
};
type TaskInsert = {
  id?:                       string;
  tenant_id:                 string;
  owner_id?:                 string | null;
  title:                     string;
  notes?:                    string | null;
  kind?:                     TaskKind;
  due_at:                    string;
  reminder_minutes_before?:  number;
  status?:                   TaskStatus;
  lead_id?:                  string | null;
  quote_id?:                 string | null;
  customer_id?:              string | null;
  subscription_id?:          string | null;
  completed_at?:             string | null;
  completed_by?:             string | null;
  snooze_count?:             number;
};
type TaskUpdate = Partial<TaskInsert>;

// ============================================================
// Renewal email log (migration 0008) — audit of every renewal cadence email
// ============================================================
/** Migration 0229 — one row per statutory reminder actually sent. */
type ComplianceReminderLogRow = {
  id:              string;
  tenant_id:       string;
  /** Obligation.key from lib/compliance/obligations.ts, e.g. 'roc_aoc4'. */
  obligation_key:  string;
  /** ComplianceInstance.periodKey, e.g. 'fy2025' or '2026-07'. */
  period_key:      string;
  /** Rung of the ladder: 15, 7 or 3. */
  days_before:     number;
  recipient_email: string;
  status:          "sent" | "stubbed" | "failed" | "skipped";
  provider_id:     string | null;
  error_message:   string | null;
  sent_at:         string;
};
type ComplianceReminderLogInsert = {
  id?:              string;
  tenant_id:        string;
  obligation_key:   string;
  period_key:       string;
  days_before:      number;
  recipient_email:  string;
  status:           "sent" | "stubbed" | "failed" | "skipped";
  provider_id?:     string | null;
  error_message?:   string | null;
  sent_at?:         string;
};
type ComplianceReminderLogUpdate = Partial<ComplianceReminderLogInsert>;

// ============================================================
// Migration 0231 — gamified task collaboration
// ============================================================
/**
 * Co-workers on a shared task. A join table rather than a `uuid[]` on `tasks`,
 * because kudos and join-time attach per collaborator and an array can hold
 * neither a foreign key nor per-row state.
 */
type TaskCollaboratorRow = {
  id:         string;
  tenant_id:  string;
  task_id:    string;
  user_id:    string;
  added_by:   string | null;
  created_at: string;
};
type TaskCollaboratorInsert = {
  id?:         string;
  tenant_id:   string;
  task_id:     string;
  user_id:     string;
  added_by?:   string | null;
  created_at?: string;
};
type TaskCollaboratorUpdate = Partial<TaskCollaboratorInsert>;

/** Discussion thread on a task, with @mention targets and an optional file. */
type TaskCommentRow = {
  id:              string;
  tenant_id:       string;
  task_id:         string;
  user_id:         string;
  content:         string;
  /** users.id values to notify. A plain array is fine here — a mention carries
   *  no state of its own and is never a parent row. */
  mentions:        string[];
  attachment_path: string | null;
  attachment_name: string | null;
  created_at:      string;
  edited_at:       string | null;
};
type TaskCommentInsert = {
  id?:              string;
  tenant_id:        string;
  task_id:          string;
  user_id:          string;
  content:          string;
  mentions?:        string[];
  attachment_path?: string | null;
  attachment_name?: string | null;
  created_at?:      string;
  edited_at?:       string | null;
};
type TaskCommentUpdate = Partial<TaskCommentInsert>;

/**
 * Peer kudos (+10 pts) on a shared task.
 *
 * Rows rather than a counter: the per-giver budget and the "kudos from 3+
 * different people" badge both need the individual awards. `awarded_by` is NOT
 * NULL — an unattributed kudos cannot be budgeted, and the tally rejects it.
 * DB constraints enforce one per (task, recipient, giver) and no self-kudos.
 */
type TaskKudosRow = {
  id:         string;
  tenant_id:  string;
  task_id:    string;
  user_id:    string;
  awarded_by: string;
  note:       string | null;
  created_at: string;
};
type TaskKudosInsert = {
  id?:         string;
  tenant_id:   string;
  task_id:     string;
  user_id:     string;
  awarded_by:  string;
  note?:       string | null;
  created_at?: string;
};
type TaskKudosUpdate = Partial<TaskKudosInsert>;

type RenewalEmailLogRow = {
  id:              string;
  tenant_id:       string;
  subscription_id: string;
  cadence_step:    RenewalState;
  recipient_email: string;
  subject:         string | null;
  status:          "sent" | "stubbed" | "failed" | "skipped";
  provider_id:     string | null;
  error_message:   string | null;
  sent_at:         string;
};
type RenewalEmailLogInsert = {
  id?:              string;
  tenant_id:        string;
  subscription_id:  string;
  cadence_step:     RenewalState;
  recipient_email:  string;
  subject?:         string | null;
  status:           "sent" | "stubbed" | "failed" | "skipped";
  provider_id?:     string | null;
  error_message?:   string | null;
  sent_at?:         string;
};
type RenewalEmailLogUpdate = Partial<RenewalEmailLogInsert>;

// ============================================================
// Quote send log (migration 0009) — audit of every quote email sent
// ============================================================
type QuoteSendLogRow = {
  id:              string;
  tenant_id:       string;
  quote_id:        string;
  recipient_email: string;
  cc_emails:       string[] | null;
  subject:         string | null;
  status:          "sent" | "stubbed" | "failed";
  provider_id:     string | null;
  error_message:   string | null;
  sent_by:         string | null;
  sent_at:         string;
};
type QuoteSendLogInsert = {
  id?:              string;
  tenant_id:        string;
  quote_id:         string;
  recipient_email:  string;
  cc_emails?:       string[] | null;
  subject?:         string | null;
  status:           "sent" | "stubbed" | "failed";
  provider_id?:     string | null;
  error_message?:   string | null;
  sent_by?:         string | null;
  sent_at?:         string;
};
type QuoteSendLogUpdate = Partial<QuoteSendLogInsert>;

// ============================================================
// Accounting — vendor_bills + expenses (migration 0013)
// ============================================================
export type VendorBillLine = {
  id?:    string;
  name:   string;
  qty?:   number;
  rate?:  number;
  amount: number;
};
export type VendorBillRow = {
  id:               string;
  tenant_id:        string;
  vendor_id:        string | null;          // migration 0134 — link to vendors master
  vendor_name:      string;
  vendor_gstin:     string | null;
  bill_no:          string | null;
  bill_date:        string;                  // YYYY-MM-DD
  due_date:         string | null;
  category:         string;                  // 'COGS-Workspace' | 'COGS-M365' | 'COGS-Zoho' | 'COGS-Other'
  line_items:       VendorBillLine[];
  currency:         string;                  // migration 0177 — 'INR' | 'USD' | … (INR = domestic)
  fx_rate:          number;                  // ₹ per 1 unit of currency (1 for INR); foreign amt = total / fx_rate
  subtotal:         number;
  cgst:             number;
  sgst:             number;
  igst:             number;
  total:            number;
  status:           string;                  // 'unpaid' | 'paid' | 'partial'
  paid_amount:      number;
  notes:            string | null;
  attachment_url:   string | null;
  /** Migration 0043 — on a child tenant's auto-imported bill, the parent's invoice id. */
  source_tenant_invoice_id: string | null;
  created_at:       string;
  updated_at:       string;
};
// Vendors master (migration 0134)
export type VendorRow = {
  id:               string;
  tenant_id:        string;
  name:             string;
  gstin:            string | null;
  contact_name:     string | null;
  contact_email:    string | null;
  contact_phone:    string | null;
  default_category: string | null;
  address:          string | null;
  city:             string | null;
  state:            string | null;
  pincode:          string | null;
  notes:            string | null;
  created_at:       string;
  updated_at:       string;
};
type VendorInsert = Partial<VendorRow> & { tenant_id: string; name: string };
type VendorUpdate = Partial<Omit<VendorInsert, "tenant_id">>;

type VendorBillInsert = {
  id:               string;
  tenant_id:        string;
  vendor_id?:       string | null;
  vendor_name:      string;
  vendor_gstin?:    string | null;
  bill_no?:         string | null;
  bill_date:        string;
  due_date?:        string | null;
  category?:        string;
  line_items?:      VendorBillLine[];
  currency?:        string;
  fx_rate?:         number;
  subtotal?:        number;
  cgst?:            number;
  sgst?:            number;
  igst?:            number;
  total:            number;
  status?:          string;
  paid_amount?:     number;
  notes?:           string | null;
  attachment_url?:  string | null;
  source_tenant_invoice_id?: string | null;
};
type VendorBillUpdate = Partial<VendorBillInsert>;

export type ExpenseRow = {
  id:               string;
  tenant_id:        string;
  category:         string;                  // 'Hosting' | 'Software' | 'Salaries' | 'Office' | 'Marketing' | 'Travel' | 'Professional' | 'Bank' | 'Other'
  vendor_name:      string | null;
  vendor_id:        string | null;           // migration 0178 — link to the vendors master
  currency:         string;                  // migration 0179 — 'INR' | 'USD' | … (INR = domestic)
  fx_rate:          number;                  // ₹ per 1 unit of currency (1 for INR); foreign amt = amount / fx_rate
  bill_type:        string;                  // migration 0180 — 'gst' | 'kaccha' | 'none'
  line_items:       VendorBillLine[];        // migration 0181 — itemised lines in the bill's own currency
  bill_no:          string | null;           // migration 0182 — supplier invoice no. (duplicate detection)
  expense_date:     string;                  // YYYY-MM-DD
  amount:           number;
  gst_paid:         number;
  payment_method:   string | null;           // 'bank_transfer' | 'upi' | 'cash' | 'card' | 'cheque'
  paid:             boolean;                  // migration 0183 — false = payable (pay later)
  paid_date:        string | null;            // date settled (null while unpaid)
  due_date:         string | null;            // date owed (optional; while unpaid)
  description:      string | null;
  attachment_url:   string | null;
  reconciled_txn_id: string | null;          // bank line this expense is reconciled to (migration 0123)
  project_id:       string | null;           // migration 0192 — cost of a specific project (per-project P&L)
  tds_section:      string | null;           // migration 0202 — TDS deducted section (26Q); null = none
  tds_amount:       number;                   // migration 0202 — TDS deducted (₹) on this payment
  bank_account_id:  string | null;            // migration 0203 — source bank account (bank/UPI/card/cheque)
  notes:            string | null;            // migration 0204 — free-text comment / extra detail
  prepaid_advance_id: string | null;          // migration 0209 — advance this expense was consumed from
  /** Migration 0232 — marketing channel for ad spend. Set only on marketing-category
   *  rows. Deliberately here and NOT in a separate ad-spend table, so CAC/ROAS read
   *  the same rows the accountant reconciles against the bank. */
  channel:          string | null;
  created_at:       string;
  updated_at:       string;
};
type ExpenseInsert = {
  id:               string;
  tenant_id:        string;
  category:         string;
  vendor_name?:     string | null;
  vendor_id?:       string | null;
  currency?:        string;
  fx_rate?:         number;
  bill_type?:       string;
  line_items?:      VendorBillLine[];
  bill_no?:         string | null;
  expense_date:     string;
  amount:           number;
  gst_paid?:        number;
  payment_method?:  string | null;
  paid?:            boolean;
  paid_date?:       string | null;
  due_date?:        string | null;
  description?:     string | null;
  attachment_url?:  string | null;
  reconciled_txn_id?: string | null;
  project_id?:      string | null;
  tds_section?:     string | null;
  tds_amount?:      number;
  bank_account_id?: string | null;
  notes?:           string | null;
  /** Migration 0232 — marketing channel for ad spend. Set only on marketing rows. */
  channel?:         string | null;
  /**
   * Migration 0209 — the employee advance this expense was consumed from.
   *
   * Present on `ExpenseRow` since 0209 but missing here until 22 Aug 2026, so the
   * one route that writes it (`/api/my-advances`) could only do so through
   * `(admin.from("expenses" as any) as any)`. That cast is what a missing field
   * costs: it did not merely smuggle this column past the compiler, it switched
   * off checking for every other column in the same insert.
   */
  prepaid_advance_id?: string | null;
};
type ExpenseUpdate = Partial<ExpenseInsert>;

// ============================================================
// Balance sheet manual lines (migration 0084)
// ============================================================
export type BalanceSheetSection = "asset" | "liability" | "equity";

type BalanceSheetItemRow = {
  id:         string;
  tenant_id:  string;
  section:    BalanceSheetSection;
  label:      string;
  amount:     number;      // ₹, may be negative (depreciation / drawings)
  sort_order: number;
  notes:      string | null;
  bank_txn_id: string | null;
  created_at: string;
  updated_at: string;
};
type BalanceSheetItemInsert = {
  id?:         string;
  tenant_id:   string;
  section:     BalanceSheetSection;
  label:       string;
  amount:      number;
  sort_order?: number;
  notes?:      string | null;
};
type BalanceSheetItemUpdate = Partial<Omit<BalanceSheetItemInsert, "tenant_id">>;

// Employee loans / advances (migration 0085). A loan is an asset, not an expense.
type EmployeeLoanKind = "loan" | "salary_advance" | "expense_advance";
type EmployeeLoanRow = {
  id:              string;
  tenant_id:       string;
  employee_name:   string;
  principal:       number;
  disbursed_on:    string;
  bank_account_id: string | null;
  kind:            EmployeeLoanKind;
  notes:           string | null;
  status:          "active" | "closed";
  created_at:      string;
  updated_at:      string;
  created_by:      string | null;
};
type EmployeeLoanInsert = {
  id?:              string;
  tenant_id:        string;
  employee_name:    string;
  principal:        number;
  disbursed_on:     string;
  bank_account_id?: string | null;
  kind?:            EmployeeLoanKind;
  notes?:           string | null;
  status?:          "active" | "closed";
  created_by?:      string | null;
};
type EmployeeLoanUpdate = Partial<Omit<EmployeeLoanInsert, "tenant_id">>;

type EmployeeLoanRepaymentRow = {
  id:              string;
  tenant_id:       string;
  loan_id:         string;
  amount:          number;
  repaid_on:       string;
  method:          "cash" | "bank" | "salary_deduction" | "expense";
  bank_account_id: string | null;
  expense_id:      string | null;
  notes:           string | null;
  created_at:      string;
};
type EmployeeLoanRepaymentInsert = {
  id?:              string;
  tenant_id:        string;
  loan_id:          string;
  amount:           number;
  repaid_on:        string;
  method:           "cash" | "bank" | "salary_deduction" | "expense";
  bank_account_id?: string | null;
  expense_id?:      string | null;
  notes?:           string | null;
};
type EmployeeLoanRepaymentUpdate = Partial<Omit<EmployeeLoanRepaymentInsert, "tenant_id">>;

// Payroll + leave (migration 0087).
type EmployeeRow = {
  id:              string;
  tenant_id:       string;
  name:            string;
  monthly_gross:   number;
  joining_date:    string | null;
  leave_allowance: number;
  pan:             string | null;
  pf_no:           string | null;
  esi_no:          string | null;
  esi_applicable:  boolean;
  pf_applicable:   boolean;
  is_active:       boolean;
  pin_hash:        string | null;
  notes:           string | null;
  email:                    string | null;
  phone:                    string | null;
  designation:              string | null;
  date_of_birth:            string | null;
  address:                  string | null;
  emergency_contact_name:   string | null;
  emergency_contact_phone:  string | null;
  biometric_id:             string | null;   // migration 0215 — device user number
  attendance_consent_at:     string | null;  // migration 0218 — DPDP consent for selfie/attendance
  attendance_consent_source: string | null;  // 'self' | 'owner'
  face_enrolled_at:          string | null;  // migration 0220 — Phase 4 face-verification seam
  face_ref_path:             string | null;
  created_at:      string;
  updated_at:      string;
};
type EmployeeInsert = {
  id?:              string;
  tenant_id:        string;
  name:             string;
  monthly_gross?:   number;
  joining_date?:    string | null;
  leave_allowance?: number;
  pan?:             string | null;
  pf_no?:           string | null;
  esi_no?:          string | null;
  esi_applicable?:  boolean;
  pf_applicable?:   boolean;
  is_active?:       boolean;
  notes?:           string | null;
  email?:                    string | null;
  phone?:                    string | null;
  designation?:              string | null;
  date_of_birth?:            string | null;
  address?:                  string | null;
  emergency_contact_name?:   string | null;
  emergency_contact_phone?:  string | null;
  biometric_id?:             string | null;
  attendance_consent_at?:     string | null;
  attendance_consent_source?: string | null;
  face_enrolled_at?:          string | null;
  face_ref_path?:             string | null;
};
type EmployeeUpdate = Partial<Omit<EmployeeInsert, "tenant_id">>;

type EmployeeDocumentRow = {
  id:          string;
  tenant_id:   string;
  employee_id: string;
  doc_type:    string;
  file_name:   string;
  file_path:   string;
  mime_type:   string | null;
  size_bytes:  number | null;
  uploaded_by: string | null;
  uploaded_at: string;
};
type EmployeeDocumentInsert = {
  id?:          string;
  tenant_id:    string;
  employee_id:  string;
  doc_type:     string;
  file_name:    string;
  file_path:    string;
  mime_type?:   string | null;
  size_bytes?:  number | null;
  uploaded_by?: string | null;
};
type EmployeeDocumentUpdate = Partial<Omit<EmployeeDocumentInsert, "tenant_id" | "employee_id">>;

export type ReimbursementRow = {
  id:            string;
  tenant_id:     string;
  person_name:   string;
  purpose:       string;
  category:      string;
  amount:        number;
  gst_paid:      number;
  incurred_on:   string;
  paid_via:      string | null;
  status:        "pending" | "settled";
  settled_on:    string | null;
  settled_notes: string | null;
  employee_id:   string | null;
  receipt_path:  string | null;
  expense_id:    string | null;
  created_by:    string | null;
  created_at:    string;
};
type ReimbursementInsert = Partial<ReimbursementRow> & { tenant_id: string; person_name: string; purpose: string; amount: number; incurred_on: string };
type ReimbursementUpdate = Partial<Omit<ReimbursementInsert, "tenant_id">>;

type LeaveKind = "casual" | "sick" | "earned" | "unpaid";
type LeaveEntryRow = {
  id:          string;
  tenant_id:   string;
  employee_id: string;
  from_date:   string;
  to_date:     string;
  days:        number;
  type:        LeaveKind;
  notes:       string | null;
  created_at:  string;
};
type LeaveEntryInsert = {
  id?:         string;
  tenant_id:   string;
  employee_id: string;
  from_date:   string;
  to_date:     string;
  days:        number;
  type:        LeaveKind;
  notes?:      string | null;
};
type LeaveEntryUpdate = Partial<Omit<LeaveEntryInsert, "tenant_id">>;

type SalaryPaymentRow = {
  id:                string;
  tenant_id:         string;
  employee_id:       string;
  period:            string;
  pay_date:          string;
  gross:             number;
  lop_days:          number;
  lop_amount:        number;
  incentive:         number;
  advance_recovered: number;
  tds:               number;
  pf:                number;
  esi:               number;              // employee share (0.75%), withheld from net
  esi_employer:      number;              // employer share (3.25%), a company cost
  pf_employer:       number;              // employer PF share (12%), a company cost
  other_deduction:   number;
  net:               number;
  bank_account_id:   string | null;
  expense_id:        string | null;
  advance_loan_id:   string | null;
  notes:             string | null;
  paid_status:       "unpaid" | "partial" | "paid";
  paid_amount:       number;
  reconciled_txn_id: string | null;
  created_at:        string;
};
type SalaryPaymentInsert = Partial<SalaryPaymentRow> & { tenant_id: string; employee_id: string; period: string; pay_date: string; gross: number; net: number };
type SalaryPaymentUpdate = Partial<Omit<SalaryPaymentInsert, "tenant_id">>;

// ── Project / one-time sales (custom software etc.) — migration 0101 ──────────
export type ProjectSaleRow = {
  id:             string;
  tenant_id:      string;
  customer_id:    string | null;
  customer_name:  string;
  title:          string;
  description:    string | null;
  sac_code:       string;
  gst_rate:       number;
  inter_state:    boolean;
  taxable_amount: number;
  gst_amount:     number;
  total_amount:   number;
  status:         "draft" | "quoted" | "active" | "completed" | "cancelled";
  line_items:     ProjectQuoteLine[];
  accepted_at:    string | null;
  start_date:     string | null;   // migration 0194
  target_date:    string | null;   // migration 0194 — deadline
  created_at:     string;
  updated_at:     string;
};
export type ProjectQuoteLine = { name: string; qty: number; rate: number; amount: number };

// ── Project labour allocation (migration 0193) — employee time as project cost ──
export type ProjectLabourRow = {
  id:          string;
  tenant_id:   string;
  project_id:  string;
  employee_id: string;
  percent:     number;   // % of the employee's monthly gross on THIS project
  months:      number;
  start_date:  string | null;   // migration 0195 — this person's period on the project
  end_date:    string | null;
  note:        string | null;
  created_at:  string;
  updated_at:  string;
};
type ProjectLabourInsert = {
  id?:         string;
  tenant_id:   string;
  project_id:  string;
  employee_id: string;
  percent?:    number;
  months?:     number;
  start_date?: string | null;
  end_date?:   string | null;
  note?:       string | null;
};
type ProjectLabourUpdate = Partial<Omit<ProjectLabourInsert, "id" | "tenant_id" | "project_id" | "employee_id">>;

// ── Project task roadmap — migration 0214 ────────────────────────────────────
export type ProjectTaskStatus = "todo" | "in_progress" | "done";
export type ProjectTaskRow = {
  id:                   string;
  tenant_id:            string;
  project_id:           string;
  title:                string;
  description:          string | null;
  status:               ProjectTaskStatus;
  assignee_employee_id: string | null;
  due_date:             string | null;
  seq:                  number;
  created_by:           string | null;
  created_at:           string;
  updated_at:           string;
};
type ProjectTaskInsert = {
  id?:                   string;
  tenant_id:             string;
  project_id:            string;
  title:                 string;
  description?:          string | null;
  status?:               ProjectTaskStatus;
  assignee_employee_id?: string | null;
  due_date?:             string | null;
  seq?:                  number;
  created_by?:           string | null;
};
type ProjectTaskUpdate = Partial<Omit<ProjectTaskInsert, "tenant_id" | "project_id">>;

// ── Company Document Vault — migration 0107 ──────────────────────────────────
export type DocumentCategory = "legal" | "finance" | "hr" | "operations" | "sales_marketing" | "admin" | "branding" | "other";
export type DocumentRow = {
  id:          string;
  tenant_id:   string;
  title:       string;
  category:    DocumentCategory;
  file_path:   string;
  file_name:   string | null;
  mime_type:   string | null;
  size_bytes:  number | null;
  expiry_date: string | null;
  notes:       string | null;
  uploaded_by: string | null;
  created_at:  string;
  updated_at:  string;
};
type DocumentInsert = Partial<DocumentRow> & { tenant_id: string; title: string; file_path: string };
type DocumentUpdate = Partial<Omit<DocumentInsert, "tenant_id">>;
type ProjectSaleInsert = Partial<ProjectSaleRow> & { tenant_id: string; customer_name: string; title: string; taxable_amount: number; gst_amount: number; total_amount: number };
type ProjectSaleUpdate = Partial<Omit<ProjectSaleInsert, "tenant_id">>;

export type ProjectMilestoneRow = {
  id:           string;
  tenant_id:    string;
  project_id:   string;
  seq:          number;
  label:        string;
  total_amount: number;
  due_date:     string | null;
  status:       "pending" | "invoiced" | "paid";
  invoice_id:   string | null;
  created_at:   string;
};
type ProjectMilestoneInsert = Partial<ProjectMilestoneRow> & { tenant_id: string; project_id: string; label: string; total_amount: number };
type ProjectMilestoneUpdate = Partial<Omit<ProjectMilestoneInsert, "tenant_id">>;

export type ProjectPaymentRow = {
  id:           string;
  tenant_id:    string;
  project_id:   string;
  milestone_id: string | null;
  amount:       number;
  method:       string | null;
  reference:    string | null;
  received_at:  string;
  bank_txn_id:  string | null;
  notes:        string | null;
  created_at:   string;
};
type ProjectPaymentInsert = Partial<ProjectPaymentRow> & { tenant_id: string; project_id: string; amount: number };
type ProjectPaymentUpdate = Partial<Omit<ProjectPaymentInsert, "tenant_id">>;

type StatutoryDuesKind = "tds" | "pf" | "esi" | "mixed";
type StatutoryDuesPaymentRow = {
  id:              string;
  tenant_id:       string;
  kind:            StatutoryDuesKind;
  amount:          number;
  paid_on:         string;
  bank_account_id: string | null;
  notes:           string | null;
  bank_txn_id:     string | null;   // imported challan line this settled (migration 0140)
  created_at:      string;
};
type StatutoryDuesPaymentInsert = {
  id?:              string;
  tenant_id:        string;
  kind?:            StatutoryDuesKind;
  amount:           number;
  paid_on:          string;
  bank_account_id?: string | null;
  notes?:           string | null;
  /** Migration 0232 — marketing channel for ad spend. Set only on marketing rows. */
  channel?:         string | null;
};
type StatutoryDuesPaymentUpdate = Partial<Omit<StatutoryDuesPaymentInsert, "tenant_id">>;

// Customer advance credit — money received over the expected amount (migration 0141).
export type CustomerCreditRow = {
  id:                string;
  tenant_id:         string;
  customer_id:       string;
  amount:            number;
  source:            string;
  source_payment_id: string | null;
  source_quote_id:   string | null;
  note:              string | null;
  status:            "open" | "used" | "refunded";
  created_at:        string;
};

// Credit Note (CGST §34) — reduces a previously-issued invoice. Migration 0154.
export type CreditNoteReasonCode = "overbilling" | "seats_reduced" | "discount" | "cancellation" | "return" | "other";
export type CreditNoteRow = {
  id:            string;               // CN-YYYY-YY-NNNN
  tenant_id:     string;
  invoice_id:    string;
  customer_id:   string | null;
  customer_name: string | null;
  credit_date:   string;
  reason_code:   CreditNoteReasonCode;
  reason:        string | null;
  amount:        number;               // gross ₹ credited
  taxable_value: number;
  tax_amount:    number;
  tax_rate:      number;
  inter_state:   boolean;
  notes:         string | null;
  created_at:    string;
  created_by:    string | null;
};
type CreditNoteInsert = Partial<CreditNoteRow> & { tenant_id: string; invoice_id: string; amount: number };
type CreditNoteUpdate = Partial<CreditNoteInsert>;

// Debit Note (CGST §34) — the mirror of a credit note; increases an invoice. Migration 0155.
export type DebitNoteReasonCode = "undercharge" | "additional_charge" | "price_escalation" | "other";
export type DebitNoteRow = Omit<CreditNoteRow, "credit_date" | "reason_code"> & {
  debit_date:  string;
  reason_code: DebitNoteReasonCode;
};
type DebitNoteInsert = Partial<DebitNoteRow> & { tenant_id: string; invoice_id: string; amount: number };
type DebitNoteUpdate = Partial<DebitNoteInsert>;

// ── Referral / channel-partner commissions (migration 0156) ──────────────────
export type CommissionBasis = "percent" | "fixed";
export type CommissionScope = "one_time" | "recurring";

export type ReferralPartnerRow = {
  id:                   string;
  tenant_id:            string;
  name:                 string;
  phone:                string | null;
  email:                string | null;
  pan:                  string | null;                 // for TDS 194H
  gstin:                string | null;
  default_basis:        CommissionBasis;
  default_percent:      number | null;
  default_fixed_amount: number | null;
  deduct_tds:           boolean;
  tds_rate:             number;
  notes:                string | null;
  is_active:            boolean;
  created_at:           string;
  created_by:           string | null;
};
type ReferralPartnerInsert = Partial<ReferralPartnerRow> & { tenant_id: string; name: string };
type ReferralPartnerUpdate = Partial<ReferralPartnerInsert>;

export type ReferralAgreementRow = {
  id:              string;
  tenant_id:       string;
  partner_id:      string;
  customer_id:     string | null;
  quote_id:        string | null;
  subscription_id: string | null;
  label:           string | null;
  basis:           CommissionBasis;
  percent:         number | null;
  fixed_amount:    number | null;
  scope:           CommissionScope;
  deduct_tds:      boolean;
  tds_rate:        number;
  status:          "active" | "closed" | "cancelled";
  notes:           string | null;
  created_at:      string;
  created_by:      string | null;
};
type ReferralAgreementInsert = Partial<ReferralAgreementRow> & { tenant_id: string; partner_id: string };
type ReferralAgreementUpdate = Partial<ReferralAgreementInsert>;

export type ReferralCommissionRow = {
  id:               string;
  tenant_id:        string;
  agreement_id:     string;
  partner_id:       string;
  customer_id:      string | null;
  payment_id:       string | null;
  base_amount:      number;                             // ex-GST deal value
  basis:            CommissionBasis;
  rate:             number | null;                      // percent used (null for fixed)
  gross_commission: number;
  tds_amount:       number;
  net_payable:      number;
  status:           "earned" | "paid" | "cancelled";
  earned_date:      string;
  paid_date:        string | null;
  pay_txn_id:       string | null;
  notes:            string | null;
  created_at:       string;
};
type ReferralCommissionInsert = Partial<ReferralCommissionRow> & { tenant_id: string; agreement_id: string; partner_id: string };
type ReferralCommissionUpdate = Partial<ReferralCommissionInsert>;

type CustomerCreditInsert = {
  id?:                string;
  tenant_id:          string;
  customer_id:        string;
  amount:             number;
  source?:            string;
  source_payment_id?: string | null;
  source_quote_id?:   string | null;
  note?:              string | null;
  status?:            "open" | "used" | "refunded";
};
type CustomerCreditUpdate = Partial<Omit<CustomerCreditInsert, "tenant_id">>;

// Company holiday calendar (migration 0143) — excluded from payroll working days.
export type HolidayRow = {
  id:           string;
  tenant_id:    string;
  holiday_date: string;
  name:         string;
  created_at:   string;
};
type HolidayInsert = { id?: string; tenant_id: string; holiday_date: string; name: string };
type HolidayUpdate = Partial<Omit<HolidayInsert, "tenant_id">>;

// Attendance (migration 0088).
type AttendanceRow = {
  id:          string;
  tenant_id:   string;
  employee_id: string;
  work_date:   string;
  check_in:    string | null;
  check_out:   string | null;
  source:      string;
  marked_ip:   string | null;
  selfie_in:   string | null;
  selfie_out:  string | null;
  geo_in:      string | null;
  geo_out:     string | null;
  flags:            string[];
  check_in_device:  string | null;
  check_out_device: string | null;
  reviewed_at:      string | null;
  reviewed_by:      string | null;
  created_at:  string;
};
type AttendanceInsert = {
  id?:         string;
  tenant_id:   string;
  employee_id: string;
  work_date:   string;
  check_in?:   string | null;
  check_out?:  string | null;
  source?:     string;
  marked_ip?:  string | null;
  selfie_in?:  string | null;
  selfie_out?: string | null;
  geo_in?:     string | null;
  geo_out?:    string | null;
  flags?:            string[];
  check_in_device?:  string | null;
  check_out_device?: string | null;
  reviewed_at?:      string | null;
  reviewed_by?:      string | null;
};
type AttendanceUpdate = Partial<Omit<AttendanceInsert, "tenant_id">>;

type AttendanceSettingsRow = {
  tenant_id:             string;
  allowed_ips:           string[];
  require_selfie:        boolean;
  require_presence:      boolean;
  presence_secret:       string | null;
  selfie_retention_days: number;
  require_face_match:    boolean;
  updated_at:            string;
};
type AttendanceSettingsInsert = {
  tenant_id:              string;
  allowed_ips?:           string[];
  require_selfie?:        boolean;
  require_presence?:      boolean;
  presence_secret?:       string | null;
  selfie_retention_days?: number;
  require_face_match?:    boolean;
  updated_at?:            string;
};
type AttendanceSettingsUpdate = Partial<Omit<AttendanceSettingsInsert, "tenant_id">>;

// Activity log (migration 0222).
type ActivityLogRow = {
  id:         number;
  tenant_id:  string;
  user_id:    string | null;
  action:     string;
  entity:     string;
  entity_id:  string | null;
  label:      string | null;
  created_at: string;
};
type ActivityLogInsert = {
  tenant_id:  string;
  user_id?:   string | null;
  action:     string;
  entity:     string;
  entity_id?: string | null;
  label?:     string | null;
};

// Assets bought on EMI (migration 0092).
type EmiPurchaseRow = {
  id:              string;
  tenant_id:       string;
  name:            string;
  category:        "vehicle" | "equipment" | "furniture" | "property" | "other";
  total_cost:      number;
  down_payment:    number;
  financed:        number;
  emi_count:       number;
  emi_amount:      number;
  purchased_on:    string;
  down_account_id: string | null;
  lender:          string | null;
  notes:           string | null;
  status:          "active" | "closed";
  created_at:      string;
  updated_at:      string;
  created_by:      string | null;
};
type EmiPurchaseInsert = Partial<EmiPurchaseRow> & { tenant_id: string; name: string; total_cost: number; financed: number; purchased_on: string };
type EmiPurchaseUpdate = Partial<Omit<EmiPurchaseInsert, "tenant_id">>;

type ExpenseClaimRow = {
  id:            string;
  tenant_id:     string;
  loan_id:       string;
  employee_id:   string;
  amount:        number;
  category:      string;
  purpose:       string | null;
  spent_on:      string;
  receipt_path:  string | null;
  status:        "pending" | "approved" | "rejected";
  expense_id:    string | null;
  reject_reason: string | null;
  reviewed_at:   string | null;
  created_at:    string;
};
type ExpenseClaimInsert = Partial<ExpenseClaimRow> & { tenant_id: string; loan_id: string; employee_id: string; amount: number; category: string; spent_on: string };
type ExpenseClaimUpdate = Partial<Omit<ExpenseClaimInsert, "tenant_id">>;

/* Migration 20260819170000 — the owner's PRIVATE books.
   Every one of these is scoped by RLS to `owner_user_id = auth.uid()`, not to the
   tenant and not to the owner role. Read the migration header before changing that. */
type PersonalAccountRow = {
  id:            string;
  tenant_id:     string;
  /** WHOSE row this is. The entire privacy model hangs off this column. */
  owner_user_id: string;
  kind:          "savings" | "current" | "credit_card" | "fd" | "rd" | "ppf" | "cash" | "wallet";
  label:         string;
  institution:   string | null;
  /** Last four digits only — enforced by a CHECK constraint. */
  account_last4: string | null;
  /** Whole rupees. For credit_card this is what is OWED, held positive. */
  balance:       number;
  credit_limit:  number | null;
  interest_rate: number | null;
  maturity_date: string | null;
  is_active:     boolean;
  notes:         string | null;
  created_at:    string;
  updated_at:    string;
};
type PersonalAccountInsert = Partial<PersonalAccountRow> & { tenant_id: string; owner_user_id: string; kind: PersonalAccountRow["kind"]; label: string };
type PersonalAccountUpdate = Partial<Omit<PersonalAccountInsert, "tenant_id" | "owner_user_id">>;

type PersonalTransactionRow = {
  id:            string;
  tenant_id:     string;
  owner_user_id: string;
  kind:          "drawing" | "dividend" | "salary" | "interest" | "other_income" | "expense";
  category:      string | null;
  /** Whole rupees, always positive — direction comes from `kind`. */
  amount:        number;
  occurred_on:   string;
  account_id:    string | null;
  note:          string | null;
  created_at:    string;
  updated_at:    string;
};
type PersonalTransactionInsert = Partial<PersonalTransactionRow> & { tenant_id: string; owner_user_id: string; kind: PersonalTransactionRow["kind"]; amount: number; occurred_on: string };
type PersonalTransactionUpdate = Partial<Omit<PersonalTransactionInsert, "tenant_id" | "owner_user_id">>;

type PersonalHoldingRow = {
  id:            string;
  tenant_id:     string;
  owner_user_id: string;
  asset_class:   "mutual_fund" | "stock" | "real_estate" | "gold" | "sgb" | "lic" | "ppf" | "epf" | "nps" | "fd" | "bond" | "crypto" | "other";
  name:          string;
  invested:      number;
  current_value: number;
  units:         number | null;
  /** When current_value was last true. Null = never marked; the UI must say so. */
  valued_on:     string | null;
  notes:         string | null;
  created_at:    string;
  updated_at:    string;
};
type PersonalHoldingInsert = Partial<PersonalHoldingRow> & { tenant_id: string; owner_user_id: string; asset_class: PersonalHoldingRow["asset_class"]; name: string };
type PersonalHoldingUpdate = Partial<Omit<PersonalHoldingInsert, "tenant_id" | "owner_user_id">>;

type PersonalVaultPinRow = {
  user_id:         string;
  tenant_id:       string;
  /** Salted scrypt hash. The PIN itself is never stored and never leaves the server. */
  pin_hash:        string;
  pin_salt:        string;
  failed_attempts: number;
  locked_until:    string | null;
  created_at:      string;
  updated_at:      string;
};
type PersonalVaultPinInsert = Partial<PersonalVaultPinRow> & { user_id: string; tenant_id: string; pin_hash: string; pin_salt: string };
type PersonalVaultPinUpdate = Partial<Omit<PersonalVaultPinInsert, "user_id" | "tenant_id">>;



/* Migration 20260821140000 — one attendance reminder per person per day per kind.
   The unique index on (user_id, work_date, kind) is the point of the table: it makes a
   Scheduler retry, an overlapping deploy and a half-hourly cron all harmless. Written by
   the cron under the service role only — RLS is on with no policies. */
type AttendanceReminderLogRow = {
  id:         string;
  tenant_id:  string;
  user_id:    string;
  /** The IST calendar date the reminder was for, not when the job ran. */
  work_date:  string;
  kind:       "check_in" | "check_out";
  claimed_at: string;
  /** Null when the slot was claimed but nothing was delivered. */
  sent_at:    string | null;
  devices:    number;
  error:      string | null;
};
type AttendanceReminderLogInsert = Partial<AttendanceReminderLogRow> & {
  tenant_id: string; user_id: string; work_date: string; kind: "check_in" | "check_out";
};
type AttendanceReminderLogUpdate = Partial<Omit<AttendanceReminderLogInsert, "tenant_id" | "user_id">>;

/* Migration 20260821120000 + 20260821123000 — Web Push subscriptions.
   One row per DEVICE: `endpoint` is unique, so re-subscribing updates instead of adding
   a second row (a phone with two rows receives every notification twice). `categories`
   is the consent split — one browser permission covers offers and work alerts alike, so
   the difference has to live in our data. */
type PushSubscriptionRow = {
  id:             string;
  tenant_id:      string;
  user_id:        string;
  /** Identifies one browser on one device. Unique across the table. */
  endpoint:       string;
  /** The device public key material used to encrypt the payload (RFC 8291). */
  p256dh:         string;
  auth:           string;
  user_agent:     string | null;
  created_at:     string;
  last_used_at:   string | null;
  failed_at:      string | null;
  failure_reason: string | null;
  /** "operational" and/or "offers". Never empty — no consent means the row is deleted. */
  categories:     string[];
};
type PushSubscriptionInsert = Partial<PushSubscriptionRow> & {
  tenant_id: string; user_id: string; endpoint: string; p256dh: string; auth: string;
};
type PushSubscriptionUpdate = Partial<Omit<PushSubscriptionInsert, "tenant_id" | "user_id">>;

/* Migration 20260819120000 — internal feedback + its machine triage.
   Deliberately not support_tickets: that table carries a customer SLA clock. */
type FeedbackRow = {
  id:                string;
  tenant_id:         string;
  reported_type:     "bug" | "feature" | "ui_improvement";
  reported_severity: "low" | "medium" | "high" | "critical";
  title:             string;
  body:              string;
  /** Raw captured URL, dynamic segments and all. */
  page_path:         string | null;
  /** Collapsed to a Next.js route so reports group per screen. */
  route_pattern:     string | null;
  reported_by:       string | null;
  reporter_name:     string | null;
  reporter_email:    string | null;
  triage_status:     "pending" | "triaged" | "failed";
  triage_mode:       "gemini" | "stub" | null;
  triaged_at:        string | null;
  problem_summary:   string | null;
  /** What the TEXT says it is — compare with reported_type before believing either. */
  inferred_type:     "bug" | "feature" | "ui_improvement" | null;
  severity_score:    number | null;
  target_files:      string[];
  directive:         string | null;
  triage_notes:      string[];
  status:            "open" | "agent_queued" | "fixed" | "wont_fix" | "duplicate";
  dispatched_at:     string | null;
  dispatched_by:     string | null;
  resolved_at:       string | null;
  resolution_note:   string | null;
  created_at:        string;
  updated_at:        string;
};
type FeedbackInsert = Partial<FeedbackRow> & { tenant_id: string; title: string; body: string };
type FeedbackUpdate = Partial<Omit<FeedbackInsert, "tenant_id">>;

type FeedbackScreenshotRow = {
  id:          string;
  feedback_id: string;
  tenant_id:   string;
  /** <tenant_id>/feedback/<feedback_id>/<file> inside the `documents` bucket. */
  file_path:   string;
  file_name:   string | null;
  byte_size:   number | null;
  created_at:  string;
};
type FeedbackScreenshotInsert = Partial<FeedbackScreenshotRow> & { tenant_id: string; feedback_id: string; file_path: string };
type FeedbackScreenshotUpdate = Partial<Omit<FeedbackScreenshotInsert, "tenant_id">>;

type LeadActivityRow = {
  id:         string;
  tenant_id:  string;
  lead_id:    string;
  kind:       string;
  detail:     string | null;
  created_at: string;
  created_by: string | null;
};
type LeadActivityInsert = Partial<LeadActivityRow> & { tenant_id: string; lead_id: string; kind: string };
type LeadActivityUpdate = Partial<Omit<LeadActivityInsert, "tenant_id">>;

type EmiPaymentRow = {
  id:              string;
  tenant_id:       string;
  purchase_id:     string;
  amount:          number;
  principal_part:  number;
  interest_part:   number;
  paid_on:         string;
  bank_account_id: string | null;
  expense_id:      string | null;
  notes:           string | null;
  created_at:      string;
};
type EmiPaymentInsert = Partial<EmiPaymentRow> & { tenant_id: string; purchase_id: string; amount: number; principal_part: number; paid_on: string };
type EmiPaymentUpdate = Partial<Omit<EmiPaymentInsert, "tenant_id">>;

// Business loans TAKEN by the company (migration 0131)
export type BusinessLoanRow = {
  id:                 string;
  tenant_id:          string;
  lender:             string;
  purpose:            string | null;
  principal:          number;
  interest_rate:      number | null;
  tenure_months:      number | null;
  emi_amount:         number | null;
  disbursed_on:       string;
  deposit_account_id: string | null;
  status:             "active" | "closed";
  notes:              string | null;
  created_at:         string;
  updated_at:         string;
  created_by:         string | null;
};
type BusinessLoanInsert = Partial<BusinessLoanRow> & { tenant_id: string; lender: string; principal: number; disbursed_on: string };
type BusinessLoanUpdate = Partial<Omit<BusinessLoanInsert, "tenant_id">>;

export type BusinessLoanPaymentRow = {
  id:              string;
  tenant_id:       string;
  loan_id:         string;
  amount:          number;
  principal_part:  number;
  interest_part:   number;
  paid_on:         string;
  bank_account_id: string | null;
  expense_id:      string | null;
  notes:           string | null;
  created_at:      string;
};
type BusinessLoanPaymentInsert = Partial<BusinessLoanPaymentRow> & { tenant_id: string; loan_id: string; amount: number; principal_part: number; paid_on: string };
type BusinessLoanPaymentUpdate = Partial<Omit<BusinessLoanPaymentInsert, "tenant_id">>;

// ============================================================
// TDS Receivable (migration 0014)
// ============================================================
export type TdsStatus =
  | "pending_cert"
  | "cert_received"
  | "verified_26as"
  | "claimed"
  | "disputed"
  | "written_off";

export type TdsReceivableRow = {
  id:                     string;
  tenant_id:              string;
  invoice_id:             string | null;
  payment_id:             string | null;
  customer_id:            string | null;
  customer_name:          string;
  customer_tan:           string | null;
  section:                string;     // '194J' / '194C' / etc.
  rate_pct:               number;     // 10.00
  gross_amount:           number;     // pre-GST taxable
  tds_amount:             number;
  net_paid:               number;
  fiscal_year:            string;     // 'FY2526'
  payment_received_date:  string;     // YYYY-MM-DD
  status:                 TdsStatus;
  form_16a_url:           string | null;
  form_16a_received_date: string | null;
  appears_in_26as:        boolean;
  appears_in_26as_date:   string | null;
  claimed_in_itr:         boolean;
  claimed_in_itr_date:    string | null;
  notes:                  string | null;
  created_at:             string;
  updated_at:             string;
};
type TdsReceivableInsert = {
  id:                     string;
  tenant_id:              string;
  invoice_id?:            string | null;
  payment_id?:            string | null;
  customer_id?:           string | null;
  customer_name:          string;
  customer_tan?:          string | null;
  section:                string;
  rate_pct:               number;
  gross_amount:           number;
  tds_amount:             number;
  net_paid:               number;
  fiscal_year:            string;
  payment_received_date:  string;
  status?:                TdsStatus;
  form_16a_url?:          string | null;
  form_16a_received_date?: string | null;
  appears_in_26as?:       boolean;
  appears_in_26as_date?:  string | null;
  claimed_in_itr?:        boolean;
  claimed_in_itr_date?:   string | null;
  notes?:                 string | null;
};
type TdsReceivableUpdate = Partial<TdsReceivableInsert>;

// ============================================================
// Customer Portal Auth (migration 0016)
// ============================================================
export type CustomerUserRow = {
  id:            string;
  tenant_id:     string;
  customer_id:   string;
  auth_user_id:  string;
  email:         string;
  role:          string;          // 'admin' | 'finance' | 'viewer'
  last_login_at: string | null;
  created_at:    string;
};
type CustomerUserInsert = {
  id?:            string;
  tenant_id:     string;
  customer_id:   string;
  auth_user_id:  string;
  email:         string;
  role?:         string;
  last_login_at?: string | null;
};
type CustomerUserUpdate = Partial<CustomerUserInsert>;

// ============================================================
// Support tickets (migration 0017)
// ============================================================
export type SupportTicketStatus =
  | "open"
  | "in_progress"
  | "awaiting_customer"
  | "resolved"
  | "closed";

export type SupportTicketCategory =
  | "billing"
  | "tech"
  | "plan_change"
  | "feature"
  | "other";

export type SupportTicketPriority = "low" | "normal" | "high" | "urgent";

export type SupportTicketRow = {
  id:               string;
  tenant_id:        string;
  customer_id:      string | null;
  customer_name:    string;
  raised_by_email:  string;
  raised_by_user:   string | null;
  category:         SupportTicketCategory;
  priority:         SupportTicketPriority;
  subject:          string;
  body:             string;
  status:           SupportTicketStatus;
  resolved_at:      string | null;
  resolved_by:      string | null;
  resolution_note:  string | null;
  created_at:       string;
  updated_at:       string;
  // ── SLA (migration 20260817170000) ────────────────────────────────────────
  /** The support plan the customer was on WHEN THEY RAISED IT. Stamped by a trigger
   *  on insert and never recomputed — a later downgrade must not rewrite the SLA a
   *  ticket was already judged against. Null on tickets raised before tiers existed. */
  tier:               "free" | "standard" | "enterprise" | null;
  /** When a FIRST RESPONSE is due. Stamped from the tier at raise time. */
  sla_due_at:         string | null;
  /** When a human first replied — stops the SLA clock. These plans sell first
   *  response, not resolution: answered in 40 minutes and closed a week later still
   *  met a one-hour SLA. */
  first_responded_at: string | null;
};
type SupportTicketInsert = {
  id:               string;
  tenant_id:        string;
  customer_id?:     string | null;
  customer_name:    string;
  raised_by_email:  string;
  raised_by_user?:  string | null;
  category:         SupportTicketCategory;
  priority?:        SupportTicketPriority;
  subject:          string;
  body:             string;
  status?:          SupportTicketStatus;
  resolved_at?:     string | null;
  resolved_by?:     string | null;
  resolution_note?: string | null;
  /* Normally left OUT — the trigger stamps both. Present so a historic import can
     carry its real tier, which the trigger then leaves alone. */
  tier?:               "free" | "standard" | "enterprise" | null;
  sla_due_at?:         string | null;
  first_responded_at?: string | null;
};
type SupportTicketUpdate = Partial<SupportTicketInsert>;

/**
 * A customer asking for a live 1-on-1 call (migration 20260817180000).
 *
 * `meet_url` is NULL until a REAL Google Meet link exists. A meeting code can only be
 * issued by Google, through the Calendar API — one generated locally produces a link
 * that looks right and is dead, and everybody believes the call is booked until the
 * moment it fails, which is the moment of the call.
 */
export type SupportCallRequestRow = {
  id:          string;
  tenant_id:   string;
  customer_id: string | null;
  ticket_id:   string | null;
  /** The plan they were on when they asked. Frozen — the monthly allowance is judged
   *  against what they held at the time. */
  tier:        "free" | "standard" | "enterprise";
  requested_by_email: string;
  note:        string | null;
  /** Null until a genuine link exists. Never generated locally. */
  meet_url:    string | null;
  assigned_to: string | null;
  scheduled_at: string | null;
  status:      "requested" | "scheduled" | "completed" | "cancelled";
  created_at:  string;
  updated_at:  string;
};
type SupportCallRequestInsert = {
  id?:          string;
  tenant_id:    string;
  customer_id?: string | null;
  ticket_id?:   string | null;
  tier:         "free" | "standard" | "enterprise";
  requested_by_email: string;
  note?:        string | null;
  meet_url?:    string | null;
  assigned_to?: string | null;
  scheduled_at?: string | null;
  status?:      "requested" | "scheduled" | "completed" | "cancelled";
  created_at?:  string;
  updated_at?:  string;
};

// ============================================================
// Purchase Orders — procurement / buy-side (migration 0022)
// ============================================================
export type PurchaseOrderStatus =
  | "draft"          // auto-created when sub spawns; not yet placed
  | "placed"         // ordered from vendor (Google CSP, MS Partner, Zoho)
  | "provisioned"    // licenses live on customer's domain
  | "closed"         // billed by vendor, fully reconciled
  | "cancelled";

export type PurchaseOrderRow = {
  id:               string;            // PO-2526-0001
  tenant_id:        string;
  subscription_id:  string | null;     // FK to subscriptions
  customer_id:      string | null;
  customer_name:    string;
  domain:           string | null;     // e.g. acme.in
  vendor:           "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  vendor_order_id:  string | null;     // Google CSP order ID etc.
  plan:             string;
  seats:            number;
  term_months:      number;            // 12 / 24 / 36
  unit_cost_pm:     number;            // ₹/seat/month wholesale
  total_cost:       number;            // unit_cost_pm × seats × term_months
  status:           PurchaseOrderStatus;
  placed_at:        string | null;
  provisioned_at:   string | null;
  closed_at:        string | null;
  notes:            string | null;
  created_by:       string | null;
  created_at:       string;
  updated_at:       string;
};
type PurchaseOrderInsert = {
  id:               string;
  tenant_id:        string;
  subscription_id?: string | null;
  customer_id?:     string | null;
  customer_name:    string;
  domain?:          string | null;
  vendor:           "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  vendor_order_id?: string | null;
  plan:             string;
  seats:            number;
  term_months?:     number;
  unit_cost_pm?:    number;
  total_cost?:      number;
  status?:          PurchaseOrderStatus;
  placed_at?:       string | null;
  provisioned_at?:  string | null;
  closed_at?:       string | null;
  notes?:           string | null;
  created_by?:      string | null;
};
type PurchaseOrderUpdate = Partial<Omit<PurchaseOrderInsert, "id" | "tenant_id">>;

// ============================================================
// PO ↔ Vendor Bill allocations (migration 0024)
// ============================================================
export type PoBillAllocationRow = {
  id:                  string;
  tenant_id:           string;
  purchase_order_id:   string;
  vendor_bill_id:      string;
  allocated_amount:    number;
  notes:               string | null;
  created_by:          string | null;
  created_at:          string;
};
type PoBillAllocationInsert = {
  id?:                 string;
  tenant_id:           string;
  purchase_order_id:   string;
  vendor_bill_id:      string;
  allocated_amount:    number;
  notes?:              string | null;
  created_by?:         string | null;
};
type PoBillAllocationUpdate = Partial<Omit<PoBillAllocationInsert, "id" | "tenant_id">>;

// ============================================================
// Campaigns — bulk email broadcasts to leads (migration 0028)
// ============================================================
export type CampaignStatus = "draft" | "sending" | "sent" | "failed" | "cancelled";

export type CampaignRow = {
  id:                 string;
  tenant_id:          string;
  name:               string;
  subject:            string;
  body:               string;
  /** Migration 0029 — optional HTML body. When present, email uses HTML; text body is fallback. */
  body_html:          string | null;
  audience_filter:    { stages?: string[]; sources?: string[]; search?: string };
  offer_code:         string | null;
  offer_discount_pct: number | null;
  offer_expires_at:   string | null;
  recipients_count:   number;
  sent_count:         number;
  failed_count:       number;
  status:             CampaignStatus;
  sent_at:            string | null;
  created_by:         string | null;
  created_at:         string;
  updated_at:         string;
};
type CampaignInsert = {
  id:                 string;
  tenant_id:          string;
  name:               string;
  subject:            string;
  body:               string;
  body_html?:         string | null;
  audience_filter?:   { stages?: string[]; sources?: string[]; search?: string };
  offer_code?:        string | null;
  offer_discount_pct?: number | null;
  offer_expires_at?:  string | null;
  recipients_count?:  number;
  sent_count?:        number;
  failed_count?:      number;
  status?:            CampaignStatus;
  sent_at?:           string | null;
  created_by?:        string | null;
};
type CampaignUpdate = Partial<Omit<CampaignInsert, "id" | "tenant_id">>;

export type CampaignSendStatus = "pending" | "sent" | "failed" | "skipped" | "stubbed";

export type CampaignSendRow = {
  id:                 string;
  tenant_id:          string;
  campaign_id:        string;
  lead_id:            string | null;
  recipient_email:    string;
  recipient_name:     string | null;
  status:             CampaignSendStatus;
  provider_id:        string | null;
  error_message:      string | null;
  sent_at:            string | null;
  created_at:         string;
};
type CampaignSendInsert = Omit<CampaignSendRow, "id" | "created_at"> & { id?: string };
type CampaignSendUpdate = Partial<Omit<CampaignSendInsert, "tenant_id" | "campaign_id">>;

// ── campaign_templates (migration 0029) ─────────────────────────
export type CampaignTemplateCategory =
  | "newsletter" | "offer" | "winback" | "onboarding" | "custom";

export type CampaignTemplateRow = {
  id:           string;
  tenant_id:    string | null;          // null = system template (visible to all tenants)
  name:         string;
  category:     CampaignTemplateCategory;
  subject:      string;
  body_html:    string;
  body_text:    string | null;
  description:  string | null;
  is_system:    boolean;
  created_by:   string | null;
  created_at:   string;
  updated_at:   string;
};
type CampaignTemplateInsert = Omit<CampaignTemplateRow, "id" | "created_at" | "updated_at"> & { id?: string };
type CampaignTemplateUpdate = Partial<Omit<CampaignTemplateInsert, "tenant_id" | "is_system">>;

// ============================================================
// Contacts — standalone directory (migration 0030)
// ============================================================
export type ContactSource     = "manual" | "google_csv" | "google_api" | "outlook" | "linkedin" | "event" | "other" | "enquiry";
export type ContactStatus     = "pending" | "engaged" | "promoted" | "archived";

/** One email/phone entry on a contact. label ∈ mobile|work|home|other. */
export type ContactChannel = { value: string; label: string };

export type ContactRow = {
  id:                  string;
  tenant_id:           string;
  full_name:           string;
  email:               string | null;
  phone:               string | null;
  /** All emails/phones (each with a label). email/phone above mirror index 0. */
  emails:              ContactChannel[];
  phones:              ContactChannel[];
  company:             string | null;
  title:               string | null;
  source:              ContactSource;
  external_id:         string | null;
  status:              ContactStatus;
  promoted_to_lead_id: string | null;
  promoted_at:         string | null;
  notes:               string | null;
  tags:                string[];
  imported_by:         string | null;
  // Rich person-profile fields (migration 0137) — marketing + personal outreach.
  whatsapp:            string | null;
  linkedin:            string | null;
  instagram:           string | null;
  facebook:            string | null;
  twitter:             string | null;
  website:             string | null;
  address:             string | null;
  city:                string | null;
  // Optional link to a customer company (migration 0188). null = no company /
  // free-text `company` only. FK is ON DELETE SET NULL.
  customer_id:         string | null;
  // Relationship classification for standalone contacts (migration 0196):
  // 'partner' | 'vendor' | 'personal' | 'other'. null = unclassified.
  relationship:        string | null;
  // Personal-profile fields (migration 0198) — what you keep about a real
  // relationship. birthday/anniversary are DATE (YYYY-MM-DD).
  birthday:            string | null;
  anniversary:         string | null;
  nickname:            string | null;
  family:              string | null;
  // Google Contacts sync (migration 0189). external_id holds the resourceName.
  google_etag:         string | null;
  google_synced_at:    string | null;
  created_at:          string;
  updated_at:          string;
};
type ContactInsert = {
  id:                  string;
  tenant_id:           string;
  full_name:           string;
  email?:              string | null;
  phone?:              string | null;
  emails?:             ContactChannel[];
  phones?:             ContactChannel[];
  company?:            string | null;
  title?:              string | null;
  source?:             ContactSource;
  external_id?:        string | null;
  status?:             ContactStatus;
  promoted_to_lead_id?: string | null;
  promoted_at?:        string | null;
  notes?:              string | null;
  tags?:               string[];
  imported_by?:        string | null;
  whatsapp?:           string | null;
  linkedin?:           string | null;
  instagram?:          string | null;
  facebook?:           string | null;
  twitter?:            string | null;
  website?:            string | null;
  address?:            string | null;
  city?:               string | null;
  customer_id?:        string | null;
  relationship?:       string | null;
  birthday?:           string | null;
  anniversary?:        string | null;
  nickname?:           string | null;
  family?:             string | null;
  google_etag?:        string | null;
  google_synced_at?:   string | null;
};
type ContactUpdate = Partial<Omit<ContactInsert, "id" | "tenant_id">>;

// Birthday / anniversary greeting audit + idempotency (migration 0199).
export type ContactGreetingLogRow = {
  id:            number;
  tenant_id:     string;
  contact_id:    string;
  kind:          "birthday" | "anniversary";
  channel:       string;
  greeting_year: number;
  recipient:     string | null;
  subject:       string | null;
  status:        string;
  provider_id:   string | null;
  error_message: string | null;
  sent_at:       string;
};
type ContactGreetingLogInsert = {
  id?:            number;
  tenant_id:      string;
  contact_id:     string;
  kind:           "birthday" | "anniversary";
  channel?:       string;
  greeting_year:  number;
  recipient?:     string | null;
  subject?:       string | null;
  status:         string;
  provider_id?:   string | null;
  error_message?: string | null;
  sent_at?:       string;
};
type ContactGreetingLogUpdate = Partial<ContactGreetingLogInsert>;

// Prepaid / vendor advances (migration 0205).
export type PrepaidAdvanceRow = {
  id:              string;
  tenant_id:       string;
  vendor_name:     string;
  vendor_id:       string | null;
  category:        string;
  total_amount:    number;
  consumed_amount: number;
  paid_date:       string;
  payment_method:  string | null;
  bank_account_id: string | null;
  notes:           string | null;
  created_by:      string | null;
  created_at:      string;
  updated_at:      string;
};
type PrepaidAdvanceInsert = {
  id?:              string;
  tenant_id:        string;
  vendor_name:      string;
  vendor_id?:       string | null;
  category?:        string;
  total_amount:     number;
  consumed_amount?: number;
  paid_date?:       string;
  payment_method?:  string | null;
  bank_account_id?: string | null;
  notes?:           string | null;
  created_by?:      string | null;
};
type PrepaidAdvanceUpdate = Partial<PrepaidAdvanceInsert>;

// Employee reasoning assessments (migration 0207).
export type AssessmentRow = {
  id: string; tenant_id: string; title: string; topic: string | null;
  difficulty: string; questions: unknown; public_token: string; pass_pct: number;
  status: string; created_by: string | null; created_at: string;
};
type AssessmentInsert = {
  id?: string; tenant_id: string; title: string; topic?: string | null;
  difficulty?: string; questions?: unknown; public_token: string; pass_pct?: number;
  status?: string; created_by?: string | null;
};
type AssessmentUpdate = Partial<AssessmentInsert>;

export type AssessmentAttemptRow = {
  id: string; tenant_id: string; assessment_id: string; employee_id: string | null;
  candidate_name: string; answers: unknown; score: number; total: number; pct: number;
  grade: string; submitted_at: string;
  duration_seconds: number | null; focus_lost_count: number; focus_lost_seconds: number; paste_count: number;
};
type AssessmentAttemptInsert = {
  id?: string; tenant_id: string; assessment_id: string; employee_id?: string | null;
  candidate_name: string; answers?: unknown; score: number; total: number; pct: number;
  grade: string;
  duration_seconds?: number | null; focus_lost_count?: number; focus_lost_seconds?: number; paste_count?: number;
};
type AssessmentAttemptUpdate = Partial<AssessmentAttemptInsert>;

// Statutory-compliance filing log (migration 0201).
export type ComplianceLogRow = {
  id:             string;
  tenant_id:      string;
  obligation_key: string;
  period_key:     string;
  period_label:   string | null;
  due_date:       string | null;
  filed_date:     string;
  reference:      string | null;
  notes:          string | null;
  created_by:     string | null;
  created_at:     string;
  updated_at:     string;
};
type ComplianceLogInsert = {
  id?:             string;
  tenant_id:       string;
  obligation_key:  string;
  period_key:      string;
  period_label?:   string | null;
  due_date?:       string | null;
  filed_date?:     string;
  reference?:      string | null;
  notes?:          string | null;
  created_by?:     string | null;
  created_at?:     string;
  updated_at?:     string;
};
type ComplianceLogUpdate = Partial<ComplianceLogInsert>;

// Inbound purchase capture — Amazon & co. order emails staged for review (migration 0200).
export type InboundPurchaseItem = { name: string; qty: number; amount: number };
export type InboundPurchaseRow = {
  id:          number;
  tenant_id:   string;
  source:      string;
  message_id:  string | null;
  order_id:    string | null;
  from_email:  string | null;
  subject:     string | null;
  order_date:  string | null;
  currency:    string;
  total:       number | null;
  gst:         number | null;
  items:       InboundPurchaseItem[];
  raw_text:    string | null;
  status:      "pending" | "imported" | "ignored";
  expense_id:  string | null;
  created_at:  string;
  updated_at:  string;
};
type InboundPurchaseInsert = {
  id?:          number;
  tenant_id:    string;
  source?:      string;
  message_id?:  string | null;
  order_id?:    string | null;
  from_email?:  string | null;
  subject?:     string | null;
  order_date?:  string | null;
  currency?:    string;
  total?:       number | null;
  gst?:         number | null;
  items?:       InboundPurchaseItem[];
  raw_text?:    string | null;
  status?:      "pending" | "imported" | "ignored";
  expense_id?:  string | null;
};
type InboundPurchaseUpdate = Partial<InboundPurchaseInsert>;

// ── Per-user Google OAuth tokens (Contacts sync, migration 0190) ────────────
export type UserGoogleTokenRow = {
  user_id:         string;
  tenant_id:       string;
  google_email:    string | null;
  access_token:    string | null;
  refresh_token:   string | null;
  token_expiry:    string | null;
  scopes:          string | null;
  sync_token:      string | null;
  last_synced_at:  string | null;
  last_error:      string | null;
  created_at:      string;
  updated_at:      string;
};
type UserGoogleTokenInsert = {
  user_id:         string;
  tenant_id:       string;
  google_email?:   string | null;
  access_token?:   string | null;
  refresh_token?:  string | null;
  token_expiry?:   string | null;
  scopes?:         string | null;
  sync_token?:     string | null;
  last_synced_at?: string | null;
  last_error?:     string | null;
};
type UserGoogleTokenUpdate = Partial<Omit<UserGoogleTokenInsert, "user_id">>;

// ── App person ↔ Google resourceName link (migration 0191) ──────────────────
export type GoogleContactLinkRow = {
  id:            string;
  tenant_id:     string;
  user_id:       string;
  source_type:   "contact" | "lead" | "customer";
  source_id:     string;
  resource_name: string;
  etag:          string | null;
  synced_at:     string;
  created_at:    string;
  updated_at:    string;
};
type GoogleContactLinkInsert = {
  id?:           string;
  tenant_id:     string;
  user_id:       string;
  source_type:   "contact" | "lead" | "customer";
  source_id:     string;
  resource_name: string;
  etag?:         string | null;
  synced_at?:    string;
};
type GoogleContactLinkUpdate = Partial<Omit<GoogleContactLinkInsert, "id">>;

// ============================================================
// Coupons — public buy-page promo codes (migration 0031)
// ============================================================
export type CouponDiscountType = "percent" | "flat";

export type CouponRow = {
  code:              string;
  tenant_id:         string;
  description:       string | null;
  discount_type:     CouponDiscountType;
  discount_value:    number;
  applies_to_tier:   string | null;
  applies_to_vendor: string | null;
  min_seats:         number;
  max_seats:         number | null;
  max_redemptions:   number | null;
  redemption_count:  number;
  valid_from:        string;
  valid_until:       string | null;
  is_active:         boolean;
  created_by:        string | null;
  created_at:        string;
  updated_at:        string;
};
type CouponInsert = {
  code:              string;
  tenant_id:         string;
  description?:      string | null;
  discount_type?:    CouponDiscountType;
  discount_value:    number;
  applies_to_tier?:  string | null;
  applies_to_vendor?: string | null;
  min_seats?:        number;
  max_seats?:        number | null;
  max_redemptions?:  number | null;
  redemption_count?: number;
  valid_from?:       string;
  valid_until?:      string | null;
  is_active?:        boolean;
  created_by?:       string | null;
};
type CouponUpdate = Partial<Omit<CouponInsert, "code" | "tenant_id">>;

export type CouponRedemptionRow = {
  id:            string;
  coupon_code:   string;
  tenant_id:     string;
  quote_id:      string | null;
  lead_id:       string | null;
  contact_email: string | null;
  contact_name:  string | null;
  tier_id:       string | null;
  seats:         number | null;
  amount_saved:  number;
  redeemed_at:   string;
};
type CouponRedemptionInsert = Omit<CouponRedemptionRow, "id" | "redeemed_at"> & { id?: string };
type CouponRedemptionUpdate = Partial<Omit<CouponRedemptionInsert, "coupon_code" | "tenant_id">>;

// ============================================================
// Site Promos — public buy-page automatic sales (migration 0032)
// Pardeep enables one; the buy page auto-discounts and shows a
// big banner — no code required. Stacks below Google promo, above
// any visitor-entered coupon code.
// ============================================================
export type SitePromoBannerStyle = "amber" | "rose" | "emerald" | "indigo" | "ink";

export type SitePromoRow = {
  id:                string;
  tenant_id:         string;
  headline:          string;
  subheadline:       string | null;
  badge_text:        string | null;
  discount_type:     CouponDiscountType;
  discount_value:    number;
  applies_to_tier:   string | null;
  applies_to_vendor: string | null;
  min_seats:         number;
  max_seats:         number | null;
  banner_style:      SitePromoBannerStyle;
  valid_from:        string;
  valid_until:       string | null;
  is_active:         boolean;
  created_by:        string | null;
  created_at:        string;
  updated_at:        string;
};
type SitePromoInsert = Partial<SitePromoRow> & {
  id:             string;
  tenant_id:      string;
  headline:       string;
  discount_type:  CouponDiscountType;
  discount_value: number;
};
type SitePromoUpdate = Partial<Omit<SitePromoInsert, "id" | "tenant_id">>;

// ============================================================
// Database type (the shape supabase-js expects)
// ============================================================
export type Database = {
  public: {
    Tables: {
      tenants:       { Row: TenantRow;       Insert: TenantInsert;       Update: TenantUpdate;       Relationships: [] };
      users:         { Row: UserRow;         Insert: UserInsert;         Update: UserUpdate;         Relationships: [] };
      customers:     { Row: CustomerRow;     Insert: CustomerInsert;     Update: CustomerUpdate;     Relationships: [] };
      customer_groups: { Row: CustomerGroupRow; Insert: CustomerGroupInsert; Update: CustomerGroupUpdate; Relationships: [] };
      items:         { Row: ItemRow;         Insert: ItemInsert;         Update: ItemUpdate;         Relationships: [] };
      leads:         { Row: LeadRow;         Insert: LeadInsert;         Update: LeadUpdate;         Relationships: [] };
      quotes:        { Row: QuoteRow;        Insert: QuoteInsert;        Update: QuoteUpdate;        Relationships: [] };
      quote_signatures: { Row: QuoteSignatureRow; Insert: QuoteSignatureInsert; Update: Partial<QuoteSignatureInsert>; Relationships: [] };
      invoice_dunning_log: { Row: InvoiceDunningLogRow; Insert: InvoiceDunningLogInsert; Update: Partial<InvoiceDunningLogInsert>; Relationships: [] };
      provisioning_tasks: { Row: ProvisioningTaskRow; Insert: ProvisioningTaskInsert; Update: Partial<ProvisioningTaskInsert>; Relationships: [] };
      seat_requests: { Row: SeatRequestRow; Insert: SeatRequestInsert; Update: Partial<SeatRequestInsert>; Relationships: [] };
      mrr_snapshots: { Row: MrrSnapshotRow; Insert: MrrSnapshotInsert; Update: Partial<MrrSnapshotInsert>; Relationships: [] };
      contract_amendments: { Row: ContractAmendmentRow; Insert: never; Update: never; Relationships: [] };
      payment_mandates: { Row: PaymentMandateRow; Insert: PaymentMandateInsert; Update: Partial<PaymentMandateInsert>; Relationships: [] };
      subscription_billings: { Row: SubscriptionBillingRow; Insert: SubscriptionBillingInsert; Update: Partial<SubscriptionBillingInsert>; Relationships: [] };
      invoices:      { Row: InvoiceRow;      Insert: InvoiceInsert;      Update: InvoiceUpdate;      Relationships: [] };
      subscriptions: { Row: SubscriptionRow; Insert: SubscriptionInsert; Update: SubscriptionUpdate; Relationships: [] };
      payments:           { Row: PaymentRow;           Insert: PaymentInsert;           Update: PaymentUpdate;           Relationships: [] };
      inbound_emails:     { Row: InboundEmailRow;      Insert: InboundEmailInsert;      Update: InboundEmailUpdate;      Relationships: [] };
      api_keys:           { Row: ApiKeyRow;            Insert: ApiKeyInsert;            Update: ApiKeyUpdate;            Relationships: [] };
      tasks:              { Row: TaskRow;              Insert: TaskInsert;              Update: TaskUpdate;              Relationships: [] };
      renewal_email_log:  { Row: RenewalEmailLogRow;   Insert: RenewalEmailLogInsert;   Update: RenewalEmailLogUpdate;   Relationships: [] };
      compliance_reminder_log: { Row: ComplianceReminderLogRow; Insert: ComplianceReminderLogInsert; Update: ComplianceReminderLogUpdate; Relationships: [] };
      task_collaborators: { Row: TaskCollaboratorRow; Insert: TaskCollaboratorInsert; Update: TaskCollaboratorUpdate; Relationships: [] };
      task_comments:      { Row: TaskCommentRow;      Insert: TaskCommentInsert;      Update: TaskCommentUpdate;      Relationships: [] };
      task_kudos:         { Row: TaskKudosRow;        Insert: TaskKudosInsert;        Update: TaskKudosUpdate;        Relationships: [] };
      quote_send_log:     { Row: QuoteSendLogRow;      Insert: QuoteSendLogInsert;      Update: QuoteSendLogUpdate;      Relationships: [] };
      vendors:            { Row: VendorRow;             Insert: VendorInsert;            Update: VendorUpdate;            Relationships: [] };
      vendor_bills:       { Row: VendorBillRow;        Insert: VendorBillInsert;        Update: VendorBillUpdate;        Relationships: [] };
      expenses:           { Row: ExpenseRow;           Insert: ExpenseInsert;           Update: ExpenseUpdate;           Relationships: [] };
      balance_sheet_items:{ Row: BalanceSheetItemRow;  Insert: BalanceSheetItemInsert;  Update: BalanceSheetItemUpdate;  Relationships: [] };
      employee_loans:{ Row: EmployeeLoanRow; Insert: EmployeeLoanInsert; Update: EmployeeLoanUpdate; Relationships: [] };
      employee_loan_repayments:{ Row: EmployeeLoanRepaymentRow; Insert: EmployeeLoanRepaymentInsert; Update: EmployeeLoanRepaymentUpdate; Relationships: [] };
      employees:{ Row: EmployeeRow; Insert: EmployeeInsert; Update: EmployeeUpdate; Relationships: [] };
      employee_documents:{ Row: EmployeeDocumentRow; Insert: EmployeeDocumentInsert; Update: EmployeeDocumentUpdate; Relationships: [] };
      reimbursements:{ Row: ReimbursementRow; Insert: ReimbursementInsert; Update: ReimbursementUpdate; Relationships: [] };
      leave_entries:{ Row: LeaveEntryRow; Insert: LeaveEntryInsert; Update: LeaveEntryUpdate; Relationships: [] };
      salary_payments:{ Row: SalaryPaymentRow; Insert: SalaryPaymentInsert; Update: SalaryPaymentUpdate; Relationships: [] };
      project_sales:     { Row: ProjectSaleRow;      Insert: ProjectSaleInsert;      Update: ProjectSaleUpdate;      Relationships: [] };
      project_labour:    { Row: ProjectLabourRow;    Insert: ProjectLabourInsert;    Update: ProjectLabourUpdate;    Relationships: [] };
      project_milestones:{ Row: ProjectMilestoneRow; Insert: ProjectMilestoneInsert; Update: ProjectMilestoneUpdate; Relationships: [] };
      project_tasks:     { Row: ProjectTaskRow;      Insert: ProjectTaskInsert;      Update: ProjectTaskUpdate;      Relationships: [] };
      project_payments:  { Row: ProjectPaymentRow;   Insert: ProjectPaymentInsert;   Update: ProjectPaymentUpdate;   Relationships: [] };
      documents:         { Row: DocumentRow;         Insert: DocumentInsert;         Update: DocumentUpdate;         Relationships: [] };
      statutory_dues_payments:{ Row: StatutoryDuesPaymentRow; Insert: StatutoryDuesPaymentInsert; Update: StatutoryDuesPaymentUpdate; Relationships: [] };
      customer_credits:{ Row: CustomerCreditRow; Insert: CustomerCreditInsert; Update: CustomerCreditUpdate; Relationships: [] };
      credit_notes:    { Row: CreditNoteRow;      Insert: CreditNoteInsert;      Update: CreditNoteUpdate;      Relationships: [] };
      debit_notes:     { Row: DebitNoteRow;       Insert: DebitNoteInsert;       Update: DebitNoteUpdate;       Relationships: [] };
      holidays:{ Row: HolidayRow; Insert: HolidayInsert; Update: HolidayUpdate; Relationships: [] };
      attendance:{ Row: AttendanceRow; Insert: AttendanceInsert; Update: AttendanceUpdate; Relationships: [] };
      activity_log:{ Row: ActivityLogRow; Insert: ActivityLogInsert; Update: Partial<ActivityLogInsert>; Relationships: [] };
      attendance_settings:{ Row: AttendanceSettingsRow; Insert: AttendanceSettingsInsert; Update: AttendanceSettingsUpdate; Relationships: [] };
      emi_purchases:{ Row: EmiPurchaseRow; Insert: EmiPurchaseInsert; Update: EmiPurchaseUpdate; Relationships: [] };
      emi_payments:{ Row: EmiPaymentRow; Insert: EmiPaymentInsert; Update: EmiPaymentUpdate; Relationships: [] };
      business_loans:{ Row: BusinessLoanRow; Insert: BusinessLoanInsert; Update: BusinessLoanUpdate; Relationships: [] };
      business_loan_payments:{ Row: BusinessLoanPaymentRow; Insert: BusinessLoanPaymentInsert; Update: BusinessLoanPaymentUpdate; Relationships: [] };
      expense_claims:{ Row: ExpenseClaimRow; Insert: ExpenseClaimInsert; Update: ExpenseClaimUpdate; Relationships: [] };
      lead_activities:{ Row: LeadActivityRow; Insert: LeadActivityInsert; Update: LeadActivityUpdate; Relationships: [] };
      contact_greeting_log:{ Row: ContactGreetingLogRow; Insert: ContactGreetingLogInsert; Update: ContactGreetingLogUpdate; Relationships: [] };
      compliance_log:{ Row: ComplianceLogRow; Insert: ComplianceLogInsert; Update: ComplianceLogUpdate; Relationships: [] };
      prepaid_advances:{ Row: PrepaidAdvanceRow; Insert: PrepaidAdvanceInsert; Update: PrepaidAdvanceUpdate; Relationships: [] };
      assessments:{ Row: AssessmentRow; Insert: AssessmentInsert; Update: AssessmentUpdate; Relationships: [] };
      assessment_attempts:{ Row: AssessmentAttemptRow; Insert: AssessmentAttemptInsert; Update: AssessmentAttemptUpdate; Relationships: [] };
      inbound_purchases:{ Row: InboundPurchaseRow; Insert: InboundPurchaseInsert; Update: InboundPurchaseUpdate; Relationships: [] };
      tds_receivable:     { Row: TdsReceivableRow;     Insert: TdsReceivableInsert;     Update: TdsReceivableUpdate;     Relationships: [] };
      customer_users:     { Row: CustomerUserRow;      Insert: CustomerUserInsert;      Update: CustomerUserUpdate;      Relationships: [] };
      support_tickets:    { Row: SupportTicketRow;     Insert: SupportTicketInsert;     Update: SupportTicketUpdate;     Relationships: [] };
      support_call_requests: { Row: SupportCallRequestRow; Insert: SupportCallRequestInsert; Update: Partial<SupportCallRequestInsert>; Relationships: [] };
      purchase_orders:    { Row: PurchaseOrderRow;     Insert: PurchaseOrderInsert;     Update: PurchaseOrderUpdate;     Relationships: [] };
      po_bill_allocations:{ Row: PoBillAllocationRow;  Insert: PoBillAllocationInsert;  Update: PoBillAllocationUpdate;  Relationships: [] };
      campaigns:          { Row: CampaignRow;          Insert: CampaignInsert;          Update: CampaignUpdate;          Relationships: [] };
      campaign_sends:     { Row: CampaignSendRow;      Insert: CampaignSendInsert;      Update: CampaignSendUpdate;      Relationships: [] };
      campaign_templates: { Row: CampaignTemplateRow;  Insert: CampaignTemplateInsert;  Update: CampaignTemplateUpdate;  Relationships: [] };
      contacts:           { Row: ContactRow;           Insert: ContactInsert;           Update: ContactUpdate;           Relationships: [] };
      user_google_tokens: { Row: UserGoogleTokenRow;   Insert: UserGoogleTokenInsert;   Update: UserGoogleTokenUpdate;   Relationships: [] };
      google_contact_links: { Row: GoogleContactLinkRow; Insert: GoogleContactLinkInsert; Update: GoogleContactLinkUpdate; Relationships: [] };
      coupons:            { Row: CouponRow;            Insert: CouponInsert;            Update: CouponUpdate;            Relationships: [] };
      coupon_redemptions: { Row: CouponRedemptionRow;  Insert: CouponRedemptionInsert;  Update: CouponRedemptionUpdate;  Relationships: [] };
      site_promos:        { Row: SitePromoRow;         Insert: SitePromoInsert;         Update: SitePromoUpdate;         Relationships: [] };
      tenant_secrets:     { Row: TenantSecretsRow;     Insert: TenantSecretsInsert;     Update: TenantSecretsUpdate;     Relationships: [] };
      team_invites:       { Row: TeamInviteRow;        Insert: TeamInviteInsert;        Update: TeamInviteUpdate;        Relationships: [] };
      tenant_domains:     { Row: TenantDomainRow;      Insert: TenantDomainInsert;      Update: TenantDomainUpdate;      Relationships: [] };
      join_requests:      { Row: JoinRequestRow;       Insert: JoinRequestInsert;       Update: JoinRequestUpdate;       Relationships: [] };
      customer_domains:   { Row: CustomerDomainRow;     Insert: CustomerDomainInsert;    Update: CustomerDomainUpdate;    Relationships: [] };
      whatsapp_messages:  { Row: WhatsAppMessageRow;   Insert: WhatsAppMessageInsert;   Update: WhatsAppMessageUpdate;   Relationships: [] };
      bank_accounts:        { Row: BankAccountRow;       Insert: BankAccountInsert;       Update: BankAccountUpdate;       Relationships: [] };
      bank_transactions:    { Row: BankTransactionRow;   Insert: BankTransactionInsert;   Update: BankTransactionUpdate;   Relationships: [] };
      txn_category_rules:   { Row: TxnCategoryRuleRow;   Insert: TxnCategoryRuleInsert;   Update: TxnCategoryRuleUpdate;   Relationships: [] };
      bank_aa_connections:  { Row: BankAaConnectionRow;  Insert: BankAaConnectionInsert;  Update: BankAaConnectionUpdate;  Relationships: [] };
      referral_partners:    { Row: ReferralPartnerRow;    Insert: ReferralPartnerInsert;    Update: ReferralPartnerUpdate;    Relationships: [] };
      referral_agreements:  { Row: ReferralAgreementRow;  Insert: ReferralAgreementInsert;  Update: ReferralAgreementUpdate;  Relationships: [] };
      referral_commissions: { Row: ReferralCommissionRow; Insert: ReferralCommissionInsert; Update: ReferralCommissionUpdate; Relationships: [] };
      feedback:             { Row: FeedbackRow;           Insert: FeedbackInsert;           Update: FeedbackUpdate;           Relationships: [] };
      feedback_screenshots: { Row: FeedbackScreenshotRow; Insert: FeedbackScreenshotInsert; Update: FeedbackScreenshotUpdate; Relationships: [] };
      personal_accounts:     { Row: PersonalAccountRow;     Insert: PersonalAccountInsert;     Update: PersonalAccountUpdate;     Relationships: [] };
      personal_transactions: { Row: PersonalTransactionRow; Insert: PersonalTransactionInsert; Update: PersonalTransactionUpdate; Relationships: [] };
      personal_holdings:     { Row: PersonalHoldingRow;     Insert: PersonalHoldingInsert;     Update: PersonalHoldingUpdate;     Relationships: [] };
      personal_vault_pin:    { Row: PersonalVaultPinRow;    Insert: PersonalVaultPinInsert;    Update: PersonalVaultPinUpdate;    Relationships: [] };
      push_subscriptions:    { Row: PushSubscriptionRow;    Insert: PushSubscriptionInsert;    Update: PushSubscriptionUpdate;    Relationships: [] };
      attendance_reminder_log: { Row: AttendanceReminderLogRow; Insert: AttendanceReminderLogInsert; Update: AttendanceReminderLogUpdate; Relationships: [] };
    };
    Views: {
      // Added in migration 0040 — tenant joined with its parent's display fields.
      // Read-only by definition; Insert/Update fall back to `never`.
      v_tenant_with_parent: { Row: TenantWithParent; Relationships: [] };
    };
    Functions: {
      /**
       * service_role ONLY (migration 0244). Nightly sweep — one snapshot per tenant.
       * The single backup function not scoped to the caller's own tenant, which is why
       * `authenticated` has no EXECUTE on it. A per-tenant failure is recorded in
       * `results` and the sweep continues.
       */
      backup_all_tenants: {
        Args: { p_label?: string | null };
        Returns: {
          label:       string;
          ok:          number;
          failed:      number;
          total_bytes: number;
          results:     Array<{ tenant: string; ok: boolean; bytes?: number; tables?: number; error?: string }>;
        };
      };
      /**
       * Owner-only (migration 0241). Takes a pre-reset snapshot and clears the selected
       * sections IN ONE TRANSACTION — either both happen or neither.
       *
       * `p_confirm_statutory` is NOT optional in spirit: invoices and attendance are records
       * the business must keep (GST series must have no gaps; attendance backs payroll), and
       * the function refuses them unless this is passed true deliberately. Do not drop it
       * from a caller "to simplify the signature" — that turns "reset my demo data" into
       * "delete this year's invoices".
       */
      reset_tenant_selected_tables: {
        Args: { p_tables: string[]; p_label: string; p_confirm_statutory?: boolean };
        Returns: {
          backup_id: string;
          backup_bytes: number;
          deleted: Record<string, number>;
        };
      };
      /**
       * Owner-only (migration 0243). Attaches an auth account to the caller's tenant and
       * deletes the workspace it came from ONLY when that workspace is empty of business
       * data. Raises — it does not partially apply — when the old workspace holds records
       * or holds other people, so the caller must surface the error text verbatim: those
       * messages carry the next step (CLAUDE.md §24).
       */
      merge_stranded_user_into_tenant: {
        Args: { p_email: string; p_tenant_id: string; p_role?: string };
        Returns: {
          action: "attached" | "moved" | "already_member" | "role_updated";
          email: string;
          full_name: string | null;
          auth_user_id: string;
          role: string;
          tenant_id: string;
          tenant_name: string | null;
          old_tenant_name: string | null;
          old_tenant_deleted: boolean;
        };
      };
      /** Owner-only (migration 0243). Auth accounts with no public.users row — people who can sign in and land nowhere. */
      list_stranded_auth_users: {
        Args: Record<string, never>;
        Returns: { email: string; full_name: string | null; created_at: string; last_sign_in_at: string | null }[];
      };
      /** Consume part of a prepaid advance → books an expense (with optional GST + bill) + reduces balance (migrations 0205/0206). */
      consume_prepaid_advance: {
        Args: { p_advance_id: string; p_amount: number; p_date?: string; p_note?: string | null; p_gst?: number; p_attachment?: string | null };
        Returns: number;
      };
      /** In-app backup (migration 0211) — owner-only, tenant-scoped snapshot of the caller's own data. */
      create_tenant_backup: {
        Args: { p_label?: string | null };
        Returns: { id: string; table_count: number; bytes: number; created_at: string };
      };
      list_tenant_backups: {
        Args: Record<string, never>;
        Returns: { id: string; created_at: string; label: string | null; kind: string; table_count: number; bytes: number }[];
      };
      get_tenant_backup: {
        Args: { p_id: string };
        Returns: unknown;
      };
      delete_tenant_backup: {
        Args: { p_id: string };
        Returns: undefined;
      };
      /** Restore points (migration 0212). */
      auto_backup_if_stale: {
        Args: Record<string, never>;
        Returns: { created: boolean };
      };
      restore_tenant_backup: {
        Args: { p_id: string };
        Returns: { restored_tables: number; restored_at: string };
      };
      /** Self attendance for logged-in users (migration 0216). */
      set_my_employee: { Args: { p_employee_id: string }; Returns: undefined };
      my_attendance_today: { Args: Record<string, never>; Returns: unknown };
      mark_self_attendance: { Args: Record<string, never>; Returns: string };
      undo_my_last_punch: { Args: Record<string, never>; Returns: string };
      log_activity: { Args: { p_action: string; p_entity?: string; p_entity_id?: string | null; p_label?: string | null }; Returns: undefined };
      record_attendance_consent: { Args: Record<string, never>; Returns: undefined };
      my_attendance_history: {
        Args: { p_days?: number };
        Returns: { work_date: string; check_in: string | null; check_out: string | null; source: string }[];
      };
      /**
       * Returns the caller's tenant joined with its parent's display fields.
       * SECURITY DEFINER — bypasses RLS for the parent JOIN, but the WHERE
       * clause confines results to the caller's own tenant. Added in 0040.
       */
      get_my_tenant_with_parent: {
        Args: Record<string, never>;
        Returns: TenantWithParent[];
      };
      /**
       * Returns parent tenant's partner-visible items for the caller's tenant.
       * SECURITY DEFINER — cross-tenant read confined to caller's declared distributor.
       * See migration 0041.
       */
      get_partner_catalog: {
        Args: Record<string, never>;
        Returns: PartnerCatalogRow[];
      };
      /**
       * Aggregated per-child metrics for the distributor's /partners
       * dashboard (migration 0044). Privacy-preserving — no end-customer
       * data leaks across tenants, only roll-up totals.
       */
      get_partner_metrics: {
        Args: Record<string, never>;
        Returns: PartnerMetricsRow[];
      };
      /**
       * Atomically clones a parent's partner item into the child's items table
       * — or links/refreshes an existing row. Resolution priority:
       *   1. p_link_existing_id → link that row, update wholesale (0042)
       *   2. existing synced_from_partner_id match → refresh idempotently
       *   3. neither → clone a new row
       * Returns the resulting item id.
       */
      sync_partner_item: {
        Args: {
          p_partner_item_id:   string;
          p_my_msrp?:          number | null;
          p_link_existing_id?: string | null;
        };
        Returns: string;
      };
      /**
       * Returns the Indian fiscal year label (e.g. 'FY2627') for a given date.
       * FY runs Apr 1 – Mar 31; date defaults to current_date.
       */
      indian_fiscal_year: {
        Args: { p_date?: string };
        Returns: string;
      };
      /**
       * Atomically issues the next sequential document number for the given doc_type.
       * Format: PREFIX-YYYY-YY-NNNN (e.g., 'INV-2025-26-0001'). GST-compliant.
       *
       * @example
       *   const { data: invoiceId } = await supabase.rpc('next_document_number',
       *     { p_doc_type: 'invoice' });
       */
      next_document_number: {
        Args: {
          p_doc_type:
            | "invoice"
            | "receipt_voucher"
            | "refund_voucher"
            | "credit_note"
            | "debit_note"
            | "quote"
            | "purchase_order"
            | "campaign";
          p_tenant_id?: string;
        };
        Returns: string;
      };
      /**
       * Raise a one-off GST invoice directly against a customer (migration 0158).
       * Creates a one-off quote (is_one_off — no subscription) then generate_invoice.
       */
      create_direct_invoice: {
        Args: {
          p_customer_id: string;
          p_line_items:  QuoteLineItem[];
          p_notes?:      string | null;
          p_recurring?:  boolean;
        };
        Returns: { invoice_id: string; quote_id: string; net_payable: number; tax_rate: number }[];
      };
      /**
       * Raise a one-shot PROJECT tax invoice (migration 0160). Composes
       * create_project_quote → accept → raise_project_milestone_invoice atomically.
       */
      create_project_direct_invoice: {
        Args: {
          p_customer_id:   string | null;
          p_customer_name: string;
          p_title:         string;
          p_description:   string | null;
          p_line_items:    { name: string; qty: number; rate: number; amount: number }[];
          p_gst_rate:      number;
          p_inter_state:   boolean;
        };
        Returns: { invoice_id: string; project_id: string }[];
      };
      /**
       * Pay a referral commission out of a bank account (migration 0156, atomic).
       * Debits the bank (net of TDS) linked to the commission + marks it paid.
       */
      pay_referral_commission: {
        Args: {
          p_commission_id:   string;
          p_bank_account_id: string;
          p_paid_on?:        string | null;
          p_method?:         string | null;
        };
        Returns: void;
      };
      /**
       * Guarded customer delete (0077). Refuses to delete a customer that still
       * has subscriptions / payments / invoices (subscriptions cascade). Only
       * "empty" customers can be removed. Raises on money history.
       */
      delete_customer: {
        Args: { p_customer_id: string };
        Returns: { deleted: boolean; customer_id: string };
      };
      /** Revert an accidentally-accepted quote back to 'sent' (0173). Refuses if
       *  any money has moved (invoice / received payment). */
      reopen_quote: {
        Args: { p_quote_id: string };
        Returns: undefined;
      };
      /**
       * Atomic convert-to-lead for an inbound email (0079). Creates a lead from
       * the email + stamps the inbound_emails row (status/lead_id) in one
       * transaction. Tenant-scoped, idempotent — returns the new/existing
       * lead id. Used by the Enquiries Inbox "Convert to lead" action.
       */
      convert_inbound_email_to_lead: {
        Args: { p_id: string };
        Returns: string;
      };
      /**
       * Owner-only escape hatch — sets a sequence's last_number directly.
       * Used during tenant onboarding when migrating from an existing
       * accounting system that already has issued document numbers.
       */
      set_document_series_start: {
        Args: {
          p_doc_type: string;
          p_fiscal_year: string;
          p_start_number: number;
          p_prefix?: string | null;
        };
        Returns: null;
      };
      /**
       * Aggregates all 'received' payments for a quote into a snapshot used
       * when generating an invoice. Returns advances jsonb + total + earliest
       * received_at — all the data needed to populate invoices.adjusted_advances,
       * net_payable, and first_advance_at columns.
       */
      compute_advance_adjustment: {
        Args: { p_quote_id: string };
        Returns: {
          advances:   InvoiceAdvanceAdjustment[];
          total_paid: number;
          first_at:   string | null;
        }[];
      };
      /**
       * Atomically generates a GST invoice from a paid/partially-paid quote
       * (migration 0058). One SECURITY DEFINER transaction: locks the quote
       * (FOR UPDATE), freezes the advance-adjustment snapshot, allocates the
       * sequential invoice number, inserts the invoice, and marks the quote
       * invoiced — closing the old client-side race (#8) + orphan (#9) windows.
       * Tenant-guarded: an authenticated caller may only invoice their own
       * tenant's quote. Raises if the quote already has an invoice.
       */
      generate_invoice: {
        Args: { p_quote_id: string };
        Returns: {
          invoice_id:      string;
          net_payable:     number;
          total_advances:  number;
        }[];
      };
      /**
       * Raises the tax invoice for ONE subscription instalment
       * (migration 20260817110100).
       *
       * Idempotent by design: an instalment already billed comes back with
       * `already_raised: true` and its existing invoice, rather than erroring. The
       * daily billing cron retries, and code that has to swallow an error around
       * invoice creation eventually swallows a real one.
       */
      raise_subscription_billing: {
        Args: { p_billing_id: string };
        Returns: {
          invoice_id:     string;
          /** ₹ including GST. */
          gross:          number;
          already_raised: boolean;
        }[];
      };
      /**
       * Scoped auto-renew setter (migration 0062). SECURITY DEFINER + scoped to
       * current_customer_id(); updates ONLY auto_renew. NOTE (0063): execute was
       * revoked from `authenticated` — auto-renew is not customer-facing in the
       * manual-pay model, so this is operator/service-role only now (kept as a
       * building block for a future real-autopay flow). The portal shows renewal
       * mode read-only and routes cancellation through a ticket.
       */
      set_subscription_auto_renew: {
        Args: { p_sub_id: string; p_value: boolean };
        Returns: boolean;
      };
      /**
       * Public (anon-callable) existence check used by the portal login page to
       * tell a non-customer up front, before sending a magic link (migration 0066).
       * True if any customer has this contact_email (case-insensitive).
       */
      portal_customer_exists: {
        Args: { p_email: string };
        Returns: boolean;
      };
      /**
       * After a customer verifies their email OTP code, link the auth user to
       * their customer row (migration 0067). SECURITY DEFINER, but only ever
       * links auth.uid() to a customer matching that user's own email — no
       * cross-user surface. Idempotent. Replaces the magic-link callback's
       * linking step for the scanner-proof OTP-code login flow.
       * Returns: 'linked' | 'already' | 'no_customer' | 'no_auth'.
       */
      portal_ensure_customer_link: {
        Args: Record<string, never>;
        Returns: string;
      };
      /**
       * Customer-portal cross-sell catalog (migration 0068). Active "main" SKUs
       * for the caller's tenant, customer-safe fields ONLY (no wholesale/margin).
       */
      portal_list_products: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          name: string;
          vendor: string;
          price_per_seat_month: number;
          hsn: string | null;
        }[];
      };
      /**
       * Customer requests a quote for a product → creates a lead in the
       * reseller's pipeline (migration 0068). Returns the new lead id.
       */
      portal_request_quote: {
        Args: { p_item_id: string; p_seats: number; p_note?: string };
        Returns: string;
      };
      /**
       * Stamp last_login_at on the calling portal customer's own customer_users
       * row (migration 0064). Narrow SECURITY DEFINER replacement for the raw
       * UPDATE that customers used to have — that path had no WITH CHECK and let
       * a customer re-point their link's customer_id to another customer.
       */
      portal_touch_login: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      /**
       * Atomically records a payment against a quote. Runs as one transaction:
       * issues Receipt Voucher (if pre-invoice), inserts payment ledger row,
       * converts prospect→customer + promotes lead on first payment, creates
       * annual subscription, updates outstanding, marks invoice paid when
       * net_payable is covered. Either all writes commit or none do.
       *
       * @example
       *   const { data, error } = await supabase.rpc('record_payment', {
       *     p_quote_id: 'Q-2025-26-0042',
       *     p_amount:    50000,
       *     p_method:    'upi',
       *     p_reference: 'UPI/123456789',
       *     p_notes:     'Half payment',
       *   });
       */
      /**
       * Marks a quote as accepted and converts its linked lead into a customer
       * WITHOUT recording payment. Used when the customer has verbally accepted
       * but their payment will arrive later. Subscription is NOT created here;
       * record_payment will spawn it when the money actually lands.
       */
      accept_quote: {
        Args: { p_quote_id: string };
        Returns: {
          quote_id:       string;
          customer_id:    string;
          converted_now:  boolean;
          quote_status:   string;
          awaits_payment: boolean;
        };
      };
      /**
       * Atomically validates AND redeems a coupon code in a single transaction.
       * Used by /api/public/coupons/validate (with dry-run flag) and the
       * checkout route (live redemption). Returns either a discount payload
       * or a refusal reason ('expired', 'maxed_out', 'wrong_tier', etc.).
       */
      redeem_coupon: {
        Args: {
          p_code:         string;
          p_tenant_id:    string;
          p_tier_id:      string;
          p_seats:        number;
          p_gross_amount: number;
          p_quote_id?:    string;
          p_lead_id?:     string;
          p_email?:       string;
          p_name?:        string;
        };
        Returns: {
          ok:             boolean;
          discount?:      number;
          discount_type?: CouponDiscountType;
          discount_value?: number;
          code?:          string;
          reason?:        string;
          required_tier?: string;
          min_seats?:     number;
          max_seats?:     number;
        };
      };
      /**
       * Returns at-most-one active site promo for the given tenant. Tier +
       * seats narrow the eligibility check. Null row when no promo is active.
       * Public-safe — no auth.uid() dependency.
       */
      get_active_site_promo: {
        Args: {
          p_tenant_id: string;
          p_tier_id?:  string | null;
          p_seats?:    number | null;
        };
        Returns: SitePromoRow | null;
      };
      /**
       * Atomic create — generates an SP-XXXXXX id and inserts the row in
       * a single round-trip. Returns the new promo id.
       */
      create_site_promo: {
        Args: {
          p_tenant_id:       string;
          p_headline:        string;
          p_subheadline:     string | null;
          p_badge_text:      string | null;
          p_discount_type:   CouponDiscountType;
          p_discount_value:  number;
          p_applies_to_tier: string | null;
          p_min_seats:       number;
          p_max_seats:       number | null;
          p_banner_style:    SitePromoBannerStyle;
          p_valid_until:     string | null;
          p_created_by:      string | null;
        };
        Returns: string;
      };
      record_payment: {
        Args: {
          p_quote_id:  string;
          p_amount:    number;
          p_method:    "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
          p_reference: string;
          p_notes?:    string | null;
        };
        Returns: {
          payment_id:           string;
          receipt_voucher_no:   string | null;
          customer_id:          string | null;
          total_received:       number;
          expected:             number;
          outstanding:          number;
          is_first_payment:     boolean;
          is_fully_paid:        boolean;
          converted_now:        boolean;
          subscription_created: boolean;
          invoice_paid:         boolean;
          has_existing_invoice: boolean;
          /** Added in migration 0010. True if the quote is linked to a subscription's renewal_quote_id. */
          is_renewal_quote:        boolean;
          /** Added in migration 0010. True when this payment fully covered a renewal quote and the linked subscription was advanced 1 year. */
          renewal_rolled_forward:  boolean;
          /** True when the same (quote, reference) was already recorded — idempotent replay; no new row inserted. */
          idempotent_replay?:      boolean;
          already_recorded?:       boolean;
        };
      };
      /**
       * Migration 0150 (audit #22) — record_payment + the TDS receivable row in
       * ONE transaction. Delegates to record_payment, then inserts the
       * tds_receivable atomically (rolls the payment back if the TDS insert
       * fails, so a fully-paid quote can never lose its government TDS
       * receivable). Skips the TDS insert on an idempotent replay. Returns
       * record_payment's result plus `tds_saved`.
       */
      record_payment_with_tds: {
        Args: {
          p_quote_id:      string;
          p_amount:        number;
          p_method:        "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
          p_reference:     string;
          p_notes?:        string | null;
          p_tds_amount?:   number;
          p_tds_gross?:    number;
          p_tds_net_paid?: number;
          p_tds_section?:  string | null;
          p_tds_rate_pct?: number | null;
          p_customer_tan?: string | null;
          p_invoice_id?:   string | null;
          p_fiscal_year?:  string | null;
        };
        Returns: {
          payment_id:           string;
          receipt_voucher_no:   string | null;
          customer_id:          string | null;
          total_received:       number;
          expected:             number;
          outstanding:          number;
          is_first_payment:     boolean;
          is_fully_paid:        boolean;
          converted_now:        boolean;
          subscription_created: boolean;
          invoice_paid:         boolean;
          has_existing_invoice: boolean;
          is_renewal_quote:        boolean;
          renewal_rolled_forward:  boolean;
          idempotent_replay?:      boolean;
          already_recorded?:       boolean;
          /** True when the TDS receivable committed in the same txn as the payment. */
          tds_saved?:              boolean;
        };
      };
      /**
       * Returns the current balance for a bank account = opening_balance +
       * sum(credit - debit) across all bank_transactions for that account.
       * SECURITY DEFINER — uses RLS on the underlying tables. Added in 0048.
       */
      bank_account_current_balance: {
        Args: { p_account_id: string };
        Returns: number;
      };
      /**
       * Server-side reconciliation hint — returns top 3-5 nearest
       * payments/expenses by amount (±₹100) and date (±7 days) for the
       * given bank_transaction. Used by the Reconcile drawer in the
       * banking module. Added in migration 0048.
       */
      suggest_bank_transaction_matches: {
        Args: { p_bank_txn_id: string };
        Returns: BankMatchSuggestionRow[];
      };
      /**
       * Atomic transfer between two of the tenant's own accounts (e.g. a bank
       * → petty-cash withdrawal): a debit leg on the source + credit leg on the
       * destination, in one transaction. Added in migration 0083.
       */
      record_account_transfer: {
        Args: {
          p_from_account: string;
          p_to_account:   string;
          p_amount:       number;
          p_txn_date:     string;
          p_note?:        string | null;
        };
        Returns: undefined;
      };
      delete_bank_account: {
        Args: { p_account_id: string };
        Returns: undefined;
      };
      create_project_sale: {
        Args: {
          p_customer_id:   string | null;
          p_customer_name: string;
          p_title:         string;
          p_description:   string | null;
          p_taxable:       number;
          p_gst_rate:      number;
          p_inter_state:   boolean;
          p_milestones:    unknown;  // jsonb array [{label,total_amount,due_date}]
        };
        Returns: string;
      };
      raise_project_milestone_invoice: {
        Args: { p_milestone_id: string };
        Returns: string;
      };
      record_project_payment: {
        Args: {
          p_milestone_id: string;
          p_amount:       number;
          p_method:       string | null;
          p_reference:    string | null;
          p_received_at:  string;
          p_bank_txn_id?: string | null;
        };
        Returns: string;
      };
      create_project_quote: {
        Args: {
          p_customer_id:   string | null;
          p_customer_name: string;
          p_title:         string;
          p_description:   string | null;
          p_line_items:    unknown;
          p_gst_rate:      number;
          p_inter_state:   boolean;
          p_milestones:    unknown;
        };
        Returns: string;
      };
      accept_project_quote: {
        Args: { p_project_id: string };
        Returns: string;
      };
      update_project_quote: {
        Args: {
          p_project_id:    string;
          p_customer_name: string;
          p_title:         string;
          p_description:   string | null;
          p_line_items:    unknown;
          p_gst_rate:      number;
          p_inter_state:   boolean;
          p_milestones:    unknown;
        };
        Returns: undefined;
      };
      update_project_future_milestones: {
        Args: {
          p_project_id: string;
          p_milestones: unknown;
        };
        Returns: undefined;
      };
      delete_project_sale: {
        Args: { p_project_id: string };
        Returns: undefined;
      };
      delete_project_invoice: {
        Args: { p_invoice_id: string };
        Returns: undefined;
      };
      delete_subscription_invoice: {
        Args: { p_invoice_id: string };
        Returns: undefined;
      };
      disburse_employee_loan: {
        Args: {
          p_employee_name:   string;
          p_principal:       number;
          p_disbursed_on:    string;
          p_bank_account_id: string;
          p_kind?:           string;
          p_notes?:          string | null;
        };
        Returns: string;
      };
      settle_expense_advance: {
        Args: {
          p_loan_id:        string;
          p_spent_amount:   number;
          p_category:       string;
          p_return_amount:  number;
          p_return_account: string | null;
          p_date:           string;
          p_notes?:         string | null;
        };
        Returns: undefined;
      };
      submit_expense_claim: {
        Args: {
          p_tenant_id:    string;
          p_employee_id:  string;
          p_pin:          string;
          p_amount:       number;
          p_category:     string;
          p_purpose:      string | null;
          p_spent_on:     string;
          p_receipt_path?: string | null;
        };
        Returns: string;
      };
      verify_claim_access: {
        Args: { p_tenant_id: string; p_employee_id: string; p_pin: string };
        Returns: number;
      };
      approve_expense_claim: {
        Args: { p_claim_id: string };
        Returns: undefined;
      };
      reject_expense_claim: {
        Args: { p_claim_id: string; p_reason?: string | null };
        Returns: undefined;
      };
      edit_expense_claim: {
        Args: { p_claim_id: string; p_amount: number; p_category: string; p_purpose: string | null; p_spent_on: string };
        Returns: undefined;
      };
      delete_expense_claim: {
        Args: { p_claim_id: string };
        Returns: undefined;
      };
      edit_claim_public: {
        Args: {
          p_tenant_id: string; p_employee_id: string; p_pin: string; p_claim_id: string;
          p_amount: number; p_category: string; p_purpose: string | null; p_spent_on: string;
        };
        Returns: undefined;
      };
      delete_claim_public: {
        Args: { p_tenant_id: string; p_employee_id: string; p_pin: string; p_claim_id: string };
        Returns: undefined;
      };
      log_lead_activity: {
        Args: { p_lead_id: string; p_kind: string; p_detail?: string | null };
        Returns: string;
      };
      book_bank_txn_as_expense: {
        Args: { p_txn_id: string; p_category: string; p_vendor: string | null; p_gst: number; p_notes?: string | null };
        Returns: string;
      };
      book_bank_credit: {
        Args: { p_txn_id: string; p_kind: string; p_label: string; p_notes?: string | null };
        Returns: undefined;
      };
      book_bank_advance: {
        Args: { p_txn_id: string; p_counterparty: string; p_kind?: string; p_notes?: string | null };
        Returns: undefined;
      };
      edit_employee_loan: {
        Args: {
          p_loan_id:         string;
          p_employee_name:   string;
          p_principal:       number;
          p_disbursed_on:    string;
          p_bank_account_id: string;
          p_kind:            string;
          p_notes?:          string | null;
        };
        Returns: undefined;
      };
      delete_employee_loan: {
        Args: { p_loan_id: string };
        Returns: undefined;
      };
      record_emi_purchase: {
        Args: {
          p_name:         string;
          p_category:     string;
          p_total_cost:   number;
          p_down_payment: number;
          p_emi_count:    number;
          p_emi_amount:   number;
          p_purchased_on: string;
          p_down_account: string | null;
          p_lender?:      string | null;
          p_notes?:       string | null;
        };
        Returns: string;
      };
      record_emi_payment: {
        Args: {
          p_purchase_id:     string;
          p_amount:          number;
          p_interest:        number;
          p_paid_on:         string;
          p_bank_account_id: string;
          p_notes?:          string | null;
        };
        Returns: undefined;
      };
      record_business_loan: {
        Args: {
          p_lender:          string;
          p_purpose:         string | null;
          p_principal:       number;
          p_interest_rate:   number | null;
          p_tenure_months:   number | null;
          p_emi_amount:      number | null;
          p_disbursed_on:    string;
          p_deposit_account: string;
        };
        Returns: string;
      };
      record_loan_emi: {
        Args: {
          p_loan_id:         string;
          p_amount:          number;
          p_interest:        number;
          p_paid_on:         string;
          p_bank_account_id: string;
          p_notes?:          string | null;
        };
        Returns: undefined;
      };
      delete_business_loan: {
        Args: { p_loan_id: string };
        Returns: undefined;
      };
      pay_vendor_bill: {
        Args: { p_bill_id: string; p_amount: number; p_paid_on: string; p_bank_account_id: string; p_method?: string | null };
        Returns: undefined;
      };
      merge_leads: {
        Args: { p_primary_id: string; p_duplicate_id: string };
        Returns: undefined;
      };
      record_employee_loan_repayment: {
        Args: {
          p_loan_id:         string;
          p_amount:          number;
          p_repaid_on:       string;
          p_method:          string;
          p_bank_account_id?: string | null;
          p_notes?:          string | null;
        };
        Returns: undefined;
      };
      pay_salary: {
        Args: {
          p_employee_id:       string;
          p_period:            string;
          p_pay_date:          string;
          p_gross:             number;
          p_lop_days:          number;
          p_lop_amount:        number;
          p_advance_recovered: number;
          p_advance_loan_id:   string | null;
          p_tds:               number;
          p_pf:                number;
          p_esi:               number;
          p_other:             number;
          p_bank_account_id:   string;
          p_notes?:            string | null;
          p_incentive?:        number;
          p_esi_employer?:     number;
          p_pf_employer?:      number;
        };
        Returns: string;
      };
      book_bank_txn_as_statutory: {
        Args: { p_txn_id: string; p_kind: string; p_notes?: string | null };
        Returns: undefined;
      };
      redeem_customer_credits: {
        Args: { p_customer_id: string; p_amount: number; p_note?: string | null };
        Returns: number;
      };
      issue_credit_note: {
        Args: { p_invoice_id: string; p_gross_amount: number; p_reason_code?: string; p_reason?: string | null; p_notes?: string | null };
        Returns: Json;
      };
      issue_debit_note: {
        Args: { p_invoice_id: string; p_gross_amount: number; p_reason_code?: string; p_reason?: string | null; p_notes?: string | null };
        Returns: Json;
      };
      delete_salary_payment: {
        Args: { p_salary_id: string };
        Returns: undefined;
      };
      delete_payment: {
        Args: { p_payment_id: string };
        Returns: Json;
      };
      add_reimbursement: {
        Args: { p_person: string; p_purpose: string; p_category: string; p_amount: number; p_gst: number; p_incurred_on: string; p_paid_via: string | null; p_employee_id?: string | null; p_receipt_path?: string | null };
        Returns: string;
      };
      settle_reimbursement: {
        Args: { p_id: string; p_settled_on: string; p_notes: string | null };
        Returns: undefined;
      };
      delete_reimbursement: {
        Args: { p_id: string };
        Returns: undefined;
      };
      delete_subscription: {
        Args: { p_subscription_id: string };
        Returns: Json;
      };
      reconcile_salaries_to_bank_txn: {
        Args: { p_bank_txn_id: string; p_salary_ids: string[] };
        Returns: undefined;
      };
      reconcile_expenses_to_bank_txn: {
        Args: { p_bank_txn_id: string; p_expense_ids: string[] };
        Returns: undefined;
      };
      reconcile_salary_advance_split: {
        Args: { p_txn_id: string; p_salary_id: string; p_advance_amount: number; p_employee_name: string; p_notes?: string | null };
        Returns: undefined;
      };
      pay_statutory_dues: {
        Args: {
          p_amount:          number;
          p_kind:            string;
          p_paid_on:         string;
          p_bank_account_id: string;
          p_notes?:          string | null;
        };
        Returns: undefined;
      };
      set_employee_pin: {
        Args: { p_employee_id: string; p_pin: string };
        Returns: undefined;
      };
      mark_attendance: {
        Args: { p_employee_id: string; p_pin: string; p_ip?: string | null };
        Returns: string;
      };
    };
    Enums: {
      user_role: "owner" | "manager" | "sales" | "sales_senior" | "billing" | "accountant" | "delivery" | "support";
      vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
      lead_stage: "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";
      quote_status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";
      invoice_status: "draft" | "pending" | "paid" | "overdue" | "void";
      sub_status: "active" | "paused" | "expired" | "cancelled";
      payment_status: "none" | "awaiting" | "partial" | "received" | "invoiced";
      task_status: TaskStatus;
      task_kind:   TaskKind;
    };
    CompositeTypes: { [_ in never]: never };
  };
};

// ============================================================
// Public type aliases
// ============================================================
export type Tenant       = TenantRow;
export type DBUser       = UserRow;
export type Customer     = CustomerRow;
export type CustomerGroup = CustomerGroupRow;
export type Item         = ItemRow;
export type Lead         = LeadRow;
export type Quote        = QuoteRow;
export type QuoteSignature = QuoteSignatureRow;
export type ProvisioningTask = ProvisioningTaskRow;
export type SeatRequest = SeatRequestRow;
export type MrrSnapshot = MrrSnapshotRow;
export type ContractAmendment = ContractAmendmentRow;
export type PaymentMandate = PaymentMandateRow;
export type PaymentMandateInsertT = PaymentMandateInsert;
export type SubscriptionBilling = SubscriptionBillingRow;
export type SubscriptionBillingInsertT = SubscriptionBillingInsert;
export type Invoice      = InvoiceRow;
export type Subscription = SubscriptionRow;
export type Payment      = PaymentRow;
export type TxnCategoryRule = TxnCategoryRuleRow;
export type Task         = TaskRow;
