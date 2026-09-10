/**
 * Writing a provisioning request. One insert, and the reason it is not on the typed client.
 *
 * `provisioning_requests` is not in the generated `Database` type. Registering it is not a
 * two-line fix: measured 23 Aug 2026 on `document_series`, adding ONE table to the Tables map
 * took `npm run typecheck` from 4 errors to 2,722, because supabase-js resolves row types
 * through a conditional chain that tips over the instantiation limit at this schema size and
 * collapses every table to `never`. `ai_autonomy`, `ai_action_log`, `ai_telecall_logs` and
 * `quote_views` are unregistered for the same measured reason; this follows their pattern
 * rather than inventing a sixth.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER — so the tenant id is a required
 * argument and is written on the row, and the caller passes the one it read off the quote it
 * verified, never one from a webhook body.
 */
import { createClient as createBareClient } from "@supabase/supabase-js";
import type { ProvisioningBlocker, ProvisioningVendor } from "./provisioning";

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/** One hosting request ready to be turned into a real cPanel account. */
export interface ReadyHostingRequest {
  id: string;
  tenant_id: string;
  quote_id: string;
  domain: string | null;
  plan: string | null;
  /* ₹ whole rupees, as received. `listReadyEngineRequests` has always selected
     this — the interface simply did not declare it, so the hosting caller could
     not see a field that was already in the row. Declared 11 Sep 2026 when the
     paid-but-undelivered row needed the amount on it. */
  amount_paid: number | null;
}

/**
 * Hosting requests that decideProvisioning fully approved (blocker IS NULL) on a
 * LIVE payment — the ones the worker may provision. A test-mode payment, an
 * engine-not-connected or dial-hold row carries a blocker and is left alone.
 */
export async function listReadyHostingRequests(limit = 50): Promise<ReadyHostingRequest[]> {
  return listReadyEngineRequests("hosting", limit);
}

/**
 * The same query for either engine vendor.
 *
 * Written as one function rather than a second copy because the four filters
 * below are the whole safety property — queued, LIVE payment, no blocker — and
 * a copy is a place for one of them to be forgotten. `amount_paid` comes along
 * so the worker can stamp it on the asset row without a second read.
 */
export async function listReadyEngineRequests(
  vendor: Extract<ProvisioningVendor, "hosting" | "domain">,
  limit = 50,
): Promise<ReadyEngineRequest[]> {
  const db = bare();
  if (!db) return [];
  const { data, error } = await db
    .from("provisioning_requests")
    .select("id, tenant_id, quote_id, domain, plan, amount_paid")
    .eq("vendor", vendor)
    .eq("status", "queued")
    .eq("payment_mode", "live")
    .is("blocker", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error(`[provisioning] list ready ${vendor} failed:`, error.message);
    return [];
  }
  return (data ?? []) as ReadyEngineRequest[];
}

export interface ReadyEngineRequest extends ReadyHostingRequest {
  /** ₹ whole rupees, as received. */
  amount_paid: number | null;
}

export async function markProvisioningActivated(id: string, vendorRef: string): Promise<void> {
  const db = bare();
  if (!db) return;
  const { error } = await db
    .from("provisioning_requests")
    .update({ status: "activated", vendor_ref: vendorRef, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("[provisioning] mark activated failed:", error.message);
}

export async function markProvisioningFailed(id: string, note: string): Promise<void> {
  const db = bare();
  if (!db) return;
  const { error } = await db
    .from("provisioning_requests")
    .update({ status: "failed", note: note.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) console.error("[provisioning] mark failed failed:", error.message);
}

export interface QueueProvisioningInput {
  tenantId: string;
  quoteId: string;
  vendor: ProvisioningVendor;
  seats: number;
  domain: string | null;
  plan: string | null;
  amountPaid: number;
  /** From the Razorpay KEY prefix — never a stored mode column. */
  paymentMode: "live" | "test";
  blocker: ProvisioningBlocker | null;
  note: string;
}

/**
 * Queue one activation. Idempotent by the unique index on (tenant_id, quote_id).
 *
 * Never throws: the caller is a payment webhook that has already committed the money via
 * `record_payment`, and a failed queue write must not turn a recorded payment into a 500 that
 * Razorpay then retries. Returns a word the caller can log.
 */
export async function queueProvisioning(
  input: QueueProvisioningInput,
): Promise<"queued" | "duplicate" | "failed"> {
  const db = bare();
  if (!db) {
    console.error("[provisioning] Supabase is not configured — activation not queued");
    return "failed";
  }

  try {
    const { error } = await db.from("provisioning_requests").insert({
      tenant_id:    input.tenantId,
      quote_id:     input.quoteId,
      vendor:       input.vendor,
      seats:        input.seats,
      domain:       input.domain,
      plan:         input.plan,
      amount_paid:  input.amountPaid,
      payment_mode: input.paymentMode,
      status:       "queued",
      blocker:      input.blocker,
      note:         input.note,
    });

    if (!error) return "queued";

    /* 23505 is the unique index doing its job on a re-delivered Razorpay event — the same
       event arriving twice must not queue two activations, because seats given away twice are
       seats somebody has to take back from a customer who did nothing wrong. */
    if (error.code === "23505") return "duplicate";

    console.error("[provisioning] queue insert failed:", error.message);
    return "failed";
  } catch (err) {
    console.error("[provisioning] queue insert crashed:", err);
    return "failed";
  }
}
