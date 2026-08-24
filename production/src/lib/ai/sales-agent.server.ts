/**
 * Server side of the AI sales agent: read the catalogue, read the thread, call the model.
 *
 * The decisions live in `sales-agent.ts` and are pure. This file is the IO around them, kept
 * thin on purpose — same split as autonomy.ts / autonomy.server.ts and quote-from-enquiry /
 * send-auto-quote, for the same reason: what the agent is ALLOWED to say is the part that
 * gets argued about, and arguing about it should not require a database.
 *
 * ─── WHY A BARE CLIENT FOR THE TWO NEW TABLES ───────────────────────────────
 * `ai_sales_conversations` and `ai_sales_loops` are not in the generated `Database` type, and
 * registering them is not a two-line fix. Measured 23 Aug 2026 on `document_series`: adding
 * ONE table to the Tables map took `npm run typecheck` from 4 errors to 2,722, because
 * supabase-js resolves row types through a conditional chain that tips over the instantiation
 * limit at this schema size and collapses every table to `never`. So these stay unregistered
 * and are reached through a deliberately untyped client — the pattern
 * `api/invoices/series/route.ts` and `lib/ai/autonomy.server.ts` already establish.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. Every query below carries an
 * explicit `.eq("tenant_id", …)`, and that line is the entire boundary between one
 * workspace's customer conversations and another's. `tenantId` always comes from the caller's
 * resolved context, never from a request body.
 */
import { createClient as createBareClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resolveGeminiConfig, geminiJson } from "./gemini";
import {
  applyHandoverRules,
  buildSalesAgentPrompt,
  parseSalesAgentDecision,
  MAX_CONTEXT_TURNS,
  type SalesAgentDecision,
  type SalesAgentLeadFacts,
  type SalesAgentTurn,
  type SalesCatalogEntry,
  type SalesChannel,
  type SalesTurnRole,
  isBelowCost,
  perSeatPerYear,
  authorisedTotalsFor,
} from "./sales-agent";

/**
 * `no-store` is not optional (CLAUDE.md §17). A cached thread read is a stale transcript,
 * and a stale transcript is how the agent re-asks a question the customer already answered —
 * the single failure this whole feature exists to prevent.
 */
function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/* ── The catalogue ───────────────────────────────────────────────────────── */

/** Row shape we read out of `items`. Narrow on purpose — see loadSalesCatalog. */
interface CatalogRow {
  id: string | null;
  name: string | null;
  vendor: string | null;
  msrp: number | null;
  wholesale: number | null;
}

/**
 * The tenant's own sellable catalogue, in whole rupees, as the agent is allowed to quote it.
 *
 * ─── EVERY FILTER HERE IS LOAD-BEARING ─────────────────────────────────────
 * `kind = 'main'` excludes add-ons and support tiers, which are priced per-tenant-plan rather
 * than per-seat and would be quoted as seats if they reached the prompt.
 * `is_active` excludes SKUs the operator has retired — quoting a withdrawn product is worse
 * than not quoting.
 * `msrp > 0` excludes the placeholder rows (measured on the live catalogue: several support
 * SKUs carry msrp 0 and hold their real figure in `prices.annual_total`). A zero handed to the
 * model is an invitation to give the product away.
 *
 * A SKU whose wholesale is unknown is kept, with cost 0. The margin is only ever context for
 * the model; a missing cost must not remove a real product from the catalogue.
 */
export async function loadSalesCatalog(
  admin: SupabaseClient<Database>,
  tenantId: string,
): Promise<SalesCatalogEntry[]> {
  const { data, error } = await admin
    .from("items")
    .select("id, name, vendor, msrp, wholesale")
    .eq("tenant_id", tenantId)
    .eq("kind", "main")
    .eq("is_active", true)
    .gt("msrp", 0)
    .order("name");

  if (error) {
    console.error("[sales-agent] catalogue read failed:", error.message);
    return [];
  }

  const rows = (data ?? []) as CatalogRow[];
  return rows.flatMap((r): SalesCatalogEntry[] => {
    if (!r.id || !r.name || typeof r.msrp !== "number" || r.msrp <= 0) return [];

    /* × 12. `items.msrp` is ₹/seat/MONTH (AGENTS.md §1) and this field is per YEAR — the
       conversion was missing until 24 Aug 2026, so the agent quoted a twelfth of every
       price. See perSeatPerYear for the measurement. */
    const entry: SalesCatalogEntry = {
      sku: r.id,
      name: r.name,
      vendor: r.vendor ?? "other",
      msrpPerSeatPerYear: perSeatPerYear(r.msrp),
      wholesalePerSeatPerYear:
        typeof r.wholesale === "number" ? perSeatPerYear(r.wholesale) : 0,
    };

    /* Dropped, not corrected and not passed through. The agent can only quote what it can
       see, so removing the SKU is the strongest available refusal — and it is loud, because
       a product silently missing from a quote is the next bug. */
    if (isBelowCost(entry)) {
      console.error(
        `[sales-agent] "${entry.name}" (${entry.sku}) is priced BELOW COST — ` +
          `Rs ${entry.msrpPerSeatPerYear}/seat/year retail against Rs ` +
          `${entry.wholesalePerSeatPerYear}/seat/year cost. Withheld from the agent's ` +
          "catalogue so it cannot be quoted. Fix the item's msrp under Items.",
      );
      return [];
    }

    return [entry];
  });
}

/* ── The transcript ──────────────────────────────────────────────────────── */

interface TurnRow {
  role: string | null;
  content: string | null;
  channel: string | null;
}

function isRole(v: string | null): v is SalesTurnRole {
  return v === "user" || v === "agent" || v === "system";
}

function isChannel(v: string | null): v is SalesChannel {
  return v === "email" || v === "whatsapp";
}

/**
 * The conversation so far, oldest first.
 *
 * Keyed on the LEAD when we have one, and on the CONTACT when we do not — because the first
 * message of a thread arrives before the lead exists, and those early turns are exactly the
 * ones a second message needs as context. Both paths are tenant-filtered.
 *
 * Ordered newest-first in SQL and reversed here, because the limit has to keep the LAST
 * MAX_CONTEXT_TURNS, not the first. Ordering ascending with a limit would hand the model the
 * opening of a long conversation and hide the part that matters.
 */
export async function loadSalesThread(args: {
  tenantId: string;
  leadId: string | null;
  channel: SalesChannel;
  customerContact: string;
}): Promise<SalesAgentTurn[]> {
  const db = bare();
  if (!db) return [];

  let q = db
    .from("ai_sales_conversations")
    .select("role, content, channel")
    .eq("tenant_id", args.tenantId);

  q = args.leadId
    ? q.eq("lead_id", args.leadId)
    : q.eq("channel", args.channel).eq("customer_contact", args.customerContact);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(MAX_CONTEXT_TURNS);

  if (error) {
    console.error("[sales-agent] thread read failed:", error.message);
    return [];
  }

  const rows = (data ?? []) as TurnRow[];
  return rows
    .flatMap((r): SalesAgentTurn[] => {
      if (!r.content || !isRole(r.role) || !isChannel(r.channel)) return [];
      return [{ role: r.role, content: r.content, channel: r.channel }];
    })
    .reverse();
}

/**
 * Append one turn to the transcript.
 *
 * Returns a boolean rather than throwing: the caller is a webhook that has already committed
 * the lead and the message, and losing a captured enquiry to protect a transcript row would
 * be the wrong trade. A missing turn costs the NEXT reply some context; a failed webhook
 * costs the enquiry outright.
 */
export async function recordSalesTurn(args: {
  tenantId: string;
  leadId: string | null;
  channel: SalesChannel;
  customerContact: string;
  role: SalesTurnRole;
  content: string;
  intent?: string | null;
  sentiment?: string | null;
  confidence?: number | null;
}): Promise<boolean> {
  const db = bare();
  if (!db) return false;

  const { error } = await db.from("ai_sales_conversations").insert({
    tenant_id: args.tenantId,
    lead_id: args.leadId,
    channel: args.channel,
    customer_contact: args.customerContact,
    role: args.role,
    content: args.content,
    intent: args.intent ?? null,
    sentiment: args.sentiment ?? null,
    confidence_score: args.confidence ?? null,
  });

  if (error) {
    console.error("[sales-agent] turn insert failed:", error.message);
    return false;
  }
  return true;
}

/* ── Running the agent ───────────────────────────────────────────────────── */

export type SalesAgentRun =
  | {
      ok: true;
      decision: SalesAgentDecision;
      /** True when applyHandoverRules overruled the model. Goes into the audit log. */
      overruled: boolean;
      /** Why it was overruled, or "" when it was not. */
      overruleReason: string;
      /** Retail figures the prompt authorised — carried out so the dispatcher can re-check. */
      allowedMoney: number[];
    }
  | { ok: false; reason: string };

/**
 * One turn of the agent: assemble context, ask the model, validate, apply the hard rules.
 *
 * Never throws. Every failure comes back as `{ ok: false, reason }` with a sentence a
 * non-engineer can act on, because that sentence is what gets written to the lead's timeline.
 * "AI drafting is not configured" is fixed on a settings page; "draft failed" is fixed by
 * asking an engineer, and that difference is the whole reason `onFailure` exists in gemini.ts.
 */
export async function runSalesAgent(args: {
  admin: SupabaseClient<Database>;
  tenantId: string;
  lead: SalesAgentLeadFacts;
  incoming: string;
  sellerName: string;
  sellerEmail: string;
  /**
   * Totals the CALLER already knows are real — a live quote's own subtotal and amount.
   * Folded in alongside the seats × price figure this function works out itself. See
   * BuildPromptArgs.authorisedTotals for why a total has to be authorised at all.
   */
  extraAuthorisedTotals?: readonly number[];
}): Promise<SalesAgentRun> {
  const cfg = await resolveGeminiConfig(args.admin, args.tenantId);
  if (!cfg.apiKey) {
    return {
      ok: false,
      reason:
        "The AI sales agent has no Gemini key. Add one in Settings → Integrations → Gemini, and this enquiry will be answered on the next message.",
    };
  }

  const catalog = await loadSalesCatalog(args.admin, args.tenantId);
  if (catalog.length === 0) {
    /* Fail loudly rather than letting the model improvise. An empty catalogue means the agent
       may not name any price, and a "helpful" reply with no price in it is a wasted first
       impression on a live enquiry — better that a person sees it. */
    return {
      ok: false,
      reason:
        "No sellable products found in this workspace's catalogue, so the agent has no prices it is allowed to quote. Add products under Items first.",
    };
  }

  const history = await loadSalesThread({
    tenantId: args.tenantId,
    leadId: args.lead.leadId,
    channel: args.lead.channel,
    customerContact: args.lead.customerContact,
  });

  /* The app does the arithmetic, not the model. Deduplicated because the seats × price
     figure and a quote subtotal for the same deal are usually the same number, and a repeated
     line in the prompt reads as two different authorised amounts. */
  const authorisedTotals = [
    ...new Set([
      ...authorisedTotalsFor(catalog, args.lead),
      ...(args.extraAuthorisedTotals ?? []),
    ]),
  ];

  const prompt = buildSalesAgentPrompt({
    lead: args.lead,
    authorisedTotals,
    history,
    incoming: args.incoming,
    catalog,
    sellerName: args.sellerName,
    sellerEmail: args.sellerEmail,
  });

  let failure = "";
  const raw = await geminiJson<unknown>({
    apiKey: cfg.apiKey,
    model: cfg.model,
    system: prompt.system,
    user: prompt.user,
    /* Low, not zero. Zero makes every reply to a similar enquiry word-for-word identical,
       which reads as a template the second time a customer sees it. */
    temperature: 0.3,
    label: "ai/sales-agent",
    onFailure: (r) => {
      failure = r;
    },
  });

  if (raw === null) {
    return { ok: false, reason: failure || "The AI did not answer, and gave no reason." };
  }

  const parsed = parseSalesAgentDecision(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const ruled = applyHandoverRules({
    decision: parsed.decision,
    seats: args.lead.seats,
    allowedMoney: prompt.allowedMoney,
  });

  return {
    ok: true,
    decision: ruled.decision,
    overruled: ruled.overruled,
    overruleReason: ruled.reason,
    allowedMoney: prompt.allowedMoney,
  };
}

/* ── The handover flag ───────────────────────────────────────────────────── */

/**
 * Mark a lead as needing a person, with the reason in words.
 *
 * ─── WHY THIS IS NOT DONE THROUGH THE TYPED ADMIN CLIENT ────────────────────
 * `requires_human_attention`, `human_attention_reason` and `human_attention_at` are added by
 * migration 20260824120000 and are not in the generated `Database` type, so a typed
 * `.update()` rejects them at compile time. Regenerating the type is not the cheap fix it
 * sounds like: measured 23 Aug 2026, adding ONE table to the Tables map took `npm run
 * typecheck` from 4 errors to 2,722, because supabase-js resolves row types through a
 * conditional chain that tips over the instantiation limit at this schema size.
 *
 * So the write goes through the same deliberately-untyped client the rest of this file uses,
 * in ONE place rather than at each call site. The tenant filter is explicit and load-bearing:
 * with no generated types nothing checks it, and `tenantId` always comes from the caller's
 * resolved context.
 */
export async function flagLeadForHumanAttention(args: {
  tenantId: string;
  leadId: string;
  reason: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured" };

  const { error } = await db
    .from("leads")
    .update({
      requires_human_attention: true,
      human_attention_reason: args.reason,
      human_attention_at: new Date().toISOString(),
    })
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId);

  return error ? { ok: false, error: error.message } : { ok: true };
}
