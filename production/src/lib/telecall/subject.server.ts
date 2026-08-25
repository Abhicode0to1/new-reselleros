/**
 * Who are we ringing, and about what?
 *
 * One loader for both callers — the operator-triggered route and the nightly renewal cron —
 * because the alternative is two places deciding what "this lead is still open" means, and
 * they would diverge on the first stage anybody adds. `create-renewal-quote.ts` learned the
 * cost of a second lookup path on 24 Aug: a catalogue row resolved by NAME in one place and by
 * id in another went blind to a price guard for a year without anybody noticing.
 */
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;

export interface TelecallSubject {
  leadId: string | null;
  subscriptionId: string | null;
  /** Free text as recorded — normalised later, by decideTelecall. */
  rawPhone: string | null;
  customerName: string | null;
  company: string | null;
  currentPlan: string | null;
  seats: number | null;
  renewalDate: string | null;
  pendingAmount: number | null;
  isOpen: boolean;
  /** Present exactly when `isOpen` is false. See TelecallRequest for why it is required. */
  closedReason: string | null;
}

/**
 * Stages at which a lead is no longer worth an automated call.
 *
 * `won` is on the list and that is deliberate rather than an oversight: a customer who has
 * already bought does not want a qualification call asking how many seats they need. If they
 * need a renewal call they get one through the other path, keyed on their subscription.
 */
const CLOSED_LEAD_STAGES: ReadonlySet<string> = new Set(["won", "lost"]);

export async function loadLeadSubject(
  admin: Admin,
  tenantId: string,
  leadId: string,
): Promise<TelecallSubject | null> {
  const { data, error } = await admin
    .from("leads")
    .select("id, company, contact_name, contact_phone, plan, seats, stage, is_junk, lost_reason")
    .eq("tenant_id", tenantId)
    .eq("id", leadId)
    .maybeSingle();

  if (error || !data) return null;

  const stage = String(data.stage ?? "");
  const junk = data.is_junk === true;
  const closed = junk || CLOSED_LEAD_STAGES.has(stage);

  return {
    leadId: data.id,
    subscriptionId: null,
    rawPhone: data.contact_phone,
    customerName: data.contact_name,
    company: data.company,
    currentPlan: data.plan,
    seats: data.seats,
    renewalDate: null,
    pendingAmount: null,
    isOpen: !closed,
    closedReason: !closed
      ? null
      : junk
        ? "this lead is marked junk, so nothing automated contacts them"
        : `this lead is already ${stage}${data.lost_reason ? ` (${data.lost_reason})` : ""}`,
  };
}

/**
 * A subscription and the person to ring about it.
 *
 * The phone comes off the CUSTOMER record rather than the subscription, because a customer
 * with three subscriptions has one phone and updating it in one place must fix all three.
 * `contact_phone` first, `contact_mobile` as the fallback — both are free text a rep typed and
 * either can be the only one filled in.
 */
export async function loadSubscriptionSubject(
  admin: Admin,
  tenantId: string,
  subscriptionId: string,
): Promise<TelecallSubject | null> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("id, customer_id, customer_name, plan, seats, renewal_date, status, outstanding_amount")
    .eq("tenant_id", tenantId)
    .eq("id", subscriptionId)
    .maybeSingle();

  if (error || !data) return null;

  const status = String(data.status ?? "");
  const open = status === "active";

  let rawPhone: string | null = null;
  let contactName: string | null = null;
  if (data.customer_id) {
    const { data: cust } = await admin
      .from("customers")
      .select("contact_name, contact_phone, contact_mobile")
      .eq("tenant_id", tenantId)
      .eq("id", data.customer_id)
      .maybeSingle();
    rawPhone = cust?.contact_phone?.trim() || cust?.contact_mobile?.trim() || null;
    contactName = cust?.contact_name ?? null;
  }

  return {
    leadId: null,
    subscriptionId: data.id,
    rawPhone,
    customerName: contactName ?? data.customer_name,
    company: data.customer_name,
    currentPlan: data.plan,
    seats: data.seats,
    renewalDate: data.renewal_date,
    /* Only a POSITIVE outstanding balance is a fact worth putting in the agent's mouth. Zero
       means nothing is owed, and a call that opens with "you owe zero rupees" is worse than
       one that does not mention money at all. */
    pendingAmount:
      typeof data.outstanding_amount === "number" && data.outstanding_amount > 0
        ? data.outstanding_amount
        : null,
    isOpen: open,
    closedReason: open ? null : `this subscription is ${status || "not active"}, so there is nothing to renew`,
  };
}
