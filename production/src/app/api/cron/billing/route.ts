/**
 * Split-billing cron — raises one tax invoice per subscription instalment.
 *
 * Runs daily. For every active subscription on a cycle that actually splits
 * (monthly / quarterly / half-yearly), it materialises the term's instalments into
 * `subscription_billings` and raises an invoice for each one whose date has arrived.
 *
 * Yearly subscriptions are deliberately untouched — they are one period, which the
 * quote path already invoices. lib/billing/instalments.ts and the trigger in
 * migration 20260817110200 draw that same line, and all three have to agree or the
 * same money gets invoiced twice.
 *
 * ─── EVERY WRITE IS IDEMPOTENT ──────────────────────────────────────────────
 * Cloud Scheduler delivers at-least-once, and a job that bills people must survive
 * being run twice:
 *   · instalments are keyed (subscription_id, term_start, period_index) in the DB
 *   · raise_subscription_billing returns the existing invoice for a period already
 *     billed, rather than raising a second one
 *
 * ─── ALREADY-BILLED INSTALMENTS ARE FROZEN ──────────────────────────────────
 * Unbilled instalments are re-synced each run so a mid-term seat change flows into
 * the periods still to come. Anything with an invoice against it is left exactly as
 * it was — the invoice is a GST document, and quietly editing the row it came from
 * would leave the two disagreeing about the same supply.
 *
 * ─── IT WILL REPORT SKIPS LOUDLY, AND TODAY IT SKIPS EVERYTHING ─────────────
 * The sell path still collects the WHOLE term when a quote is accepted, so every
 * subscription that exists has already been paid for and instalment invoices would
 * bill it a second time. Those are skipped with a reason (see instalmentSkip), not
 * silently dropped. `?dry=1` returns what WOULD happen without writing anything.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>. Fails CLOSED — this job issues tax
 * invoices, so an unconfigured secret must refuse, never allow.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { localDateISO } from "@/lib/leads/outcomes";
import { plannedInstalments, instalmentSkip, instalmentsDue } from "@/lib/billing/instalments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SkipRow  { subscription_id: string; code: string; reason: string }
interface RaisedRow { subscription_id: string; period_index: number; invoice_id: string; gross: number }
interface ErrorRow { subscription_id: string; message: string }

interface BillingCronResult {
  ran_at:               string;
  dry_run:              boolean;
  total_active:         number;
  instalments_created:  number;
  instalments_resynced: number;
  invoices_raised:      number;
  already_raised:       number;
  raised:               RaisedRow[];
  skipped:              SkipRow[];
  errors:               ErrorRow[];
}

export async function GET(req: Request)  { return handle(req); }
export async function POST(req: Request) { return handle(req); }

async function handle(req: Request): Promise<NextResponse<BillingCronResult | { error: string }>> {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun   = new URL(req.url).searchParams.get("dry") === "1";
  const supabase = createAdminClient();   // service role — the cron has no session
  const today    = localDateISO(new Date());

  const result: BillingCronResult = {
    ran_at: new Date().toISOString(),
    dry_run: dryRun,
    total_active: 0,
    instalments_created: 0,
    instalments_resynced: 0,
    invoices_raised: 0,
    already_raised: 0,
    raised: [],
    skipped: [],
    errors: [],
  };

  const { data: subs, error: subErr } = await supabase
    .from("subscriptions")
    .select("id, tenant_id, quote_id, mrr, billing_cycle, term_months, start_date, renewal_date")
    .eq("status", "active");

  if (subErr) {
    return NextResponse.json({ error: subErr.message }, { status: 500 });
  }
  result.total_active = subs?.length ?? 0;

  /* Quote payment state, fetched separately rather than as an embedded join. This
     schema has two paths between quotes and subscriptions and PostgREST answers an
     ambiguous embed with PGRST201 — which surfaces as an empty page, not an error. */
  const quoteIds = [...new Set((subs ?? []).map((s) => s.quote_id).filter((q): q is string => q != null))];
  const quoteById = new Map<string, { amount: number | null; payment_amount: number | null }>();
  if (quoteIds.length > 0) {
    const { data: quotes, error: qErr } = await supabase
      .from("quotes")
      .select("id, amount, payment_amount")
      .in("id", quoteIds);
    if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
    for (const q of quotes ?? []) {
      quoteById.set(q.id, { amount: q.amount, payment_amount: q.payment_amount });
    }
  }

  for (const sub of subs ?? []) {
    try {
      const planned = plannedInstalments(sub);
      const quote   = sub.quote_id ? quoteById.get(sub.quote_id) : undefined;

      const skip = instalmentSkip({
        cycle:        sub.billing_cycle,
        quotePaid:    quote?.payment_amount,
        quoteAmount:  quote?.amount,
        scheduleSize: planned.length,
      });
      if (skip) {
        result.skipped.push({ subscription_id: sub.id, code: skip.code, reason: skip.reason });
        continue;
      }

      const termStart = planned[0].termStart;

      const { data: existing, error: exErr } = await supabase
        .from("subscription_billings")
        .select("id, period_index, taxable_amount, invoice_id, bill_on")
        .eq("subscription_id", sub.id)
        .eq("term_start", termStart);
      if (exErr) throw new Error(exErr.message);

      const byIndex = new Map((existing ?? []).map((r) => [r.period_index, r]));

      // ── Materialise: insert what is new, re-sync what is unbilled ──────────
      const toInsert = planned
        .filter((p) => !byIndex.has(p.periodIndex))
        .map((p) => ({
          tenant_id:       sub.tenant_id,
          subscription_id: sub.id,
          term_start:      p.termStart,
          period_index:    p.periodIndex,
          bill_on:         p.billOn,
          period_start:    p.periodStart,
          period_end:      p.periodEnd,
          taxable_amount:  p.taxableAmount,
        }));

      /* Only rows with no invoice. An instalment already invoiced is frozen — see
         the header. */
      const toResync = planned.filter((p) => {
        const row = byIndex.get(p.periodIndex);
        return row != null && row.invoice_id == null && row.taxable_amount !== p.taxableAmount;
      });

      if (!dryRun) {
        if (toInsert.length > 0) {
          const { error } = await supabase.from("subscription_billings").insert(toInsert);
          if (error) throw new Error(error.message);
        }
        for (const p of toResync) {
          const row = byIndex.get(p.periodIndex)!;
          const { error } = await supabase
            .from("subscription_billings")
            .update({ taxable_amount: p.taxableAmount, bill_on: p.billOn, updated_at: new Date().toISOString() })
            .eq("id", row.id)
            .is("invoice_id", null);   // re-checked at write time, not just at read time
          if (error) throw new Error(error.message);
        }
      }
      result.instalments_created  += toInsert.length;
      result.instalments_resynced += toResync.length;

      // ── Raise what is due ─────────────────────────────────────────────────
      const { data: fresh, error: frErr } = dryRun
        ? { data: existing ?? [], error: null }
        : await supabase
            .from("subscription_billings")
            .select("id, period_index, bill_on, invoice_id")
            .eq("subscription_id", sub.id)
            .eq("term_start", termStart);
      if (frErr) throw new Error(frErr.message);

      const due = instalmentsDue(
        (fresh ?? []).map((r) => ({ ...r, billOn: r.bill_on, invoiceId: r.invoice_id })),
        today,
      );

      for (const row of due) {
        if (dryRun) { result.invoices_raised += 1; continue; }
        const { data, error } = await supabase.rpc("raise_subscription_billing", { p_billing_id: row.id });
        if (error) throw new Error(error.message);
        const out = data?.[0];
        if (!out) throw new Error(`raise_subscription_billing returned nothing for instalment ${row.id}`);
        if (out.already_raised) {
          result.already_raised += 1;
        } else {
          result.invoices_raised += 1;
          result.raised.push({
            subscription_id: sub.id,
            period_index:    row.period_index,
            invoice_id:      out.invoice_id,
            gross:           out.gross,
          });
        }
      }
    } catch (e) {
      result.errors.push({
        subscription_id: sub.id,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json(result);
}
