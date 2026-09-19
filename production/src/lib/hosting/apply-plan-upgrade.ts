/**
 * Move a hosting account onto a bigger plan, and bill the difference.
 *
 * The hosting twin of `lib/subscriptions/apply-seat-increase.ts` + `add-seats.ts`,
 * and it follows the same rule that file's header states: APPROVING IS APPLYING.
 * There is no "we said yes but nothing happened" state, because that ambiguity is
 * what `hosting_plan_changes` replaced support tickets to remove.
 *
 * ─── THE ORDER IS THE DESIGN ─────────────────────────────────────────────────
 * DirectAdmin FIRST, money SECOND. Deliberately, and it is the one decision in
 * this file worth arguing about, so here is the argument.
 *
 * Something can always fail between the two. The two orders fail differently:
 *
 *   quote first  → charge raised, package change fails. The customer has an
 *                  invoice for storage they did not get. This repo's whole
 *                  provisioning-readiness effort exists because of that shape of
 *                  bug: money taken, nothing delivered, nothing errors.
 *   server first → package changed, quote fails. The customer has more room than
 *                  they have paid for, and an operator can raise the quote by
 *                  hand in a minute.
 *
 * The second is recoverable by a person in a minute; the first is a refund and an
 * apology. So the server moves first, and a failure after it is reported LOUDLY
 * rather than swallowed — see `quoteFailed` in the result.
 *
 * ─── WHY THE QUOTE IS `is_one_off` ──────────────────────────────────────────
 * Not a detail. `record_payment` creates a subscription for any first payment on
 * a quote that is not a renewal, not add-seats, and not one-off — so an unflagged
 * upgrade quote would, ON PAYMENT, give the customer a second recurring
 * subscription that the renewal cron then bills again forever. That exact bug is
 * commented in `record_payment` itself ("the costliest of the three").
 *
 * `is_one_off` and not `is_add_seats`, even though both skip that branch: the
 * add-seats flag also makes `refund_payment` refuse with "reduce the seats on the
 * subscription first", which is advice about a seat count this quote does not
 * have. A pro-rata upgrade charge IS a one-off sale — it buys the difference for
 * the remainder of a term that is already paid for.
 *
 * ─── THE RECURRING PRICE HAS TO MOVE TOO ────────────────────────────────────
 * The one-off quote covers the rest of THIS term. If the account has a
 * subscription, its `mrr` is the number the renewal cron bills next time, so
 * leaving it at the old plan's rate would renew a Plus account at Starter money —
 * quietly, once a year, forever. That update is not optional and it is why this
 * function touches `subscriptions` at all.
 */
import { prorate, rupeesToPaise, paiseToRupees } from "@/lib/subscriptions/proration";
import { resolveTaxRatePct, resolveTermDays } from "@/lib/subscriptions/apply-seat-increase";
import { daysBetweenDates } from "@/lib/subscriptions/proration";
import { daChangePackage } from "@/lib/directadmin/provision";
import { previewUpgradeCharge, type HostingPlanSpec } from "./plan-change";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, QuoteLineItem } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

export interface UpgradeSubject {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  domain_name: string;
  da_username: string | null;
  subscription_id: string | null;
  expires_at: string | null;
  started_at: string | null;
}

export type ApplyUpgradeResult =
  | {
      ok: true;
      quoteId: string | null;
      amount: number;
      proRataDays: number;
      termDays: number;
      newPlan: string;
      /** Set when the SERVER moved but the money did not. Must reach a human. */
      quoteFailed: string | null;
      /** Set when the account has a subscription whose rate could not be moved. */
      renewalRateFailed: string | null;
    }
  | { ok: false; code: string; message: string };

/**
 * How many days of this term are left to charge for.
 *
 * Falls back to a full term when `expires_at` is missing, which is the safe
 * direction here only because `previewUpgradeCharge` clamps to `termDays`: a
 * missing expiry cannot produce a charge larger than one term.
 */
function remainingDaysFor(expiresAt: string | null, todayISO: string, termDays: number): number {
  if (!expiresAt) return termDays;
  return Math.max(0, daysBetweenDates(todayISO, expiresAt));
}

export async function applyPlanUpgrade(args: {
  supabase: Admin;
  account: UpgradeSubject;
  from: HostingPlanSpec;
  to: HostingPlanSpec;
  todayISO: string;
  graceDays: number;
}): Promise<ApplyUpgradeResult> {
  const { supabase, account, from, to, todayISO, graceDays } = args;

  if (!account.da_username) {
    return {
      ok: false,
      code: "no_da_username",
      message:
        "This account has no DirectAdmin username on it, so there is nothing on the server to move. Check the account was really provisioned.",
    };
  }

  const termDays = resolveTermDays(account.started_at, account.expires_at ?? todayISO);
  const remainingDays = remainingDaysFor(account.expires_at, todayISO, termDays);
  const taxRatePct = await resolveTaxRatePct(supabase, account.customer_id);

  const charge = previewUpgradeCharge({
    fromPlanCode: from.code,
    toPlanCode: to.code,
    remainingDays,
    termDays,
    taxRatePct,
  });

  /* No chargeable amount is not a reason to refuse the upgrade — a term with one
     day left is still a term the customer wants more room in. It IS a reason not
     to raise a ₹0 quote, which is why `charge` being null is carried through
     rather than treated as an error. */

  // ── 1. THE SERVER. Nothing below runs if this does not land. ──────────────
  const moved = await daChangePackage(account.da_username, to.daPackage);
  if (moved.kind !== "changed") {
    /* Every outcome is reported with DirectAdmin's own reason, and the code so a
       caller can tell a retryable outage from a configuration mistake. Nothing
       has been written anywhere at this point. */
    return { ok: false, code: moved.kind, message: moved.reason };
  }

  // ── 2. Our record of what the account now is. ─────────────────────────────
  const { error: acctErr } = await supabase
    .from("hosting_accounts")
    .update({
      plan_code: to.code,
      plan_name: to.name,
      da_package: to.daPackage,
      /* LIMITS, not usage — see the note on HostingPlanSpec. This is the one
         time these columns legitimately move. */
      disk_quota_mb: to.diskQuotaMb,
      bandwidth_quota_mb: to.bandwidthQuotaMb,
    })
    .eq("id", account.id);

  if (acctErr) {
    /* The server HAS moved. Saying "failed" now would send an operator to change
       a package that is already changed, and the second change would be a no-op
       that looks like a success. So this is a hard error with the truth in it. */
    return {
      ok: false,
      code: "account_update_failed",
      message: `DirectAdmin was moved to ${to.name} but our record could not be updated (${acctErr.message}). Set the plan on the account by hand — do NOT run the upgrade again.`,
    };
  }

  // ── 3. The recurring rate, so the renewal bills the new plan. ─────────────
  let renewalRateFailed: string | null = null;
  if (account.subscription_id) {
    const newMrr = Math.round(to.monthlyRate);
    const { error: subErr } = await supabase
      .from("subscriptions")
      .update({ mrr: newMrr, plan: `${to.name} Hosting` })
      .eq("id", account.subscription_id);
    if (subErr) {
      renewalRateFailed =
        `The plan is live and our record is updated, but the subscription's monthly rate could not be moved to ₹${newMrr} (${subErr.message}). Fix it on the subscription or the renewal will bill the old plan.`;
      console.error("[apply-plan-upgrade] subscription rate not updated:", subErr.message);
    }
  }

  // ── 4. The money for the rest of this term. ───────────────────────────────
  if (!charge) {
    return {
      ok: true,
      quoteId: null,
      amount: 0,
      proRataDays: 0,
      termDays,
      newPlan: to.name,
      quoteFailed: null,
      renewalRateFailed,
    };
  }

  const { data: nextNumber, error: numErr } = await supabase.rpc("next_document_number", {
    p_doc_type: "quote",
    p_tenant_id: account.tenant_id,
  });
  if (numErr || !nextNumber) {
    return {
      ok: true,
      quoteId: null,
      amount: charge.total,
      proRataDays: charge.remainingDays,
      termDays,
      newPlan: to.name,
      quoteFailed: `${account.domain_name} is on ${to.name} now, but no quote number could be allocated (${numErr?.message ?? "none returned"}), so NOTHING HAS BEEN BILLED. Raise a quote for ₹${charge.total} by hand.`,
      renewalRateFailed,
    };
  }
  const quoteId = nextNumber as unknown as string;

  const lineItems: QuoteLineItem[] = [
    {
      id: "hosting-upgrade-1",
      name: `${account.domain_name} · ${from.name} → ${to.name} (pro-rata to ${account.expires_at?.slice(0, 10) ?? "term end"})`,
      qty: 1,
      rate: charge.subtotal,
      /* No wholesale figure: the hosting cost sits on the catalogue item, not on
         the plan ladder, and inventing one here would put a made-up margin into
         the reports. Zero is the honest placeholder and matches what
         `sync_hosting_catalog` does on first import. */
      cost: 0,
      commitment: "annual_yearly",
    },
  ];

  const validUntil = new Date(
    (account.expires_at ? new Date(account.expires_at).getTime() : Date.now()) + graceDays * 86_400_000,
  );

  const { error: quoteErr } = await supabase.from("quotes").insert({
    id: quoteId,
    tenant_id: account.tenant_id,
    customer_id: account.customer_id,
    customer_name: account.domain_name,
    plan: `${to.name} Hosting`,
    seats: 1,
    amount: charge.total,
    status: "sent",
    payment_status: "awaiting",
    owner_id: null,
    created_date: todayISO,
    expires_date: validUntil.toISOString().slice(0, 10),
    line_items: lineItems,
    subtotal: charge.subtotal,
    total_cost: 0,
    discount_pct: 0,
    /* The customer's real rate. A zero-rated export must SAY zero or the PDF and
       the GST return disagree with the amount. */
    tax_rate: taxRatePct,
    is_renewal: false,
    is_add_seats: false,
    /* See the header. Without this, paying it creates a second subscription that
       the renewal cron bills forever. */
    is_one_off: true,
    extension_months: 0,
    notes: `Hosting plan upgrade for ${account.domain_name}: ${from.name} → ${to.name}. ${charge.remainingDays} of ${termDays} days remaining. Difference ₹${charge.monthlyDelta}/month. GST ${taxRatePct}%.`,
  });

  if (quoteErr) {
    return {
      ok: true,
      quoteId: null,
      amount: charge.total,
      proRataDays: charge.remainingDays,
      termDays,
      newPlan: to.name,
      quoteFailed: `${account.domain_name} is on ${to.name} now, but the quote could not be raised (${quoteErr.message}), so NOTHING HAS BEEN BILLED. Raise a quote for ₹${charge.total} by hand.`,
      renewalRateFailed,
    };
  }

  return {
    ok: true,
    quoteId,
    amount: charge.total,
    proRataDays: charge.remainingDays,
    termDays,
    newPlan: to.name,
    quoteFailed: null,
    renewalRateFailed,
  };
}

/* Re-exported so callers do not have to reach into two modules for one flow. */
export { prorate, rupeesToPaise, paiseToRupees };
