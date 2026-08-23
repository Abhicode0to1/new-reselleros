/**
 * GET /api/invoices/series — the tenant's invoice counter, for the pre-issue dialog.
 *
 * ─── WHY THIS IS A ROUTE AND NOT A CLIENT QUERY ─────────────────────────────
 * `document_series` is not in the generated `Database` type, and adding it is not a
 * two-line fix. Measured 23 Aug 2026: registering that ONE extra table in the Tables
 * map took `npm run typecheck` from **4 errors to 2,722** — supabase-js's row-type
 * inference tips over a complexity cliff on a Database type this large and collapses
 * every table to `never`. So the table stays unregistered, and the one query that needs
 * it happens here, against a deliberately UNTYPED client, in a file small enough to
 * read in full.
 *
 * Tenant comes from the session, not from the caller. The untyped client is scoped by
 * an explicit `.eq("tenant_id", …)` — with no generated types there is no compiler
 * checking that filter, so it is the only thing standing between one tenant's counter
 * and another's, and it is written on the very next line for that reason.
 *
 * READ-ONLY, and that matters: `next_document_number()` is the sole allocator
 * (CLAUDE.md §17a). This reads `last_number` to PREDICT the next value and never
 * writes, which is why the dialog calls it a prediction.
 */
import { NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { createClient as createBareClient } from "@supabase/supabase-js";
import type { SeriesState } from "@/lib/invoices/issue-consequences";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const supabase = createSessionClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  /* Typed path, because `users` and `tenants` ARE in the generated types. */
  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const tenantId = (me as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ error: "No tenant on your account." }, { status: 403 });

  const { data: tenant } = await supabase
    .from("tenants").select("doc_code").eq("id", tenantId).maybeSingle();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 500 });
  }
  const bare = createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });

  const { data: series, error } = await bare
    .from("document_series")
    .select("prefix, fiscal_year, last_number")
    .eq("tenant_id", tenantId)          // <- the only tenant boundary on this query
    .eq("doc_type", "invoice")
    .order("fiscal_year", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    /* Reported, not swallowed. Without it the dialog would quietly show "this opens the
       series" for a tenant already at 32 — a reassuring sentence built on a failure. */
    console.error(`[api/invoices/series] tenant ${tenantId}: ${error.message}`);
    return NextResponse.json({ error: "Could not read the invoice series." }, { status: 500 });
  }

  /* No row means the first invoice of this financial year. Null is returned rather than
     a zeroed row so `issueConsequences` can say that, instead of predicting 0001 as
     though it had read it. */
  if (!series) return NextResponse.json({ series: null });

  const { count } = await bare
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);

  const s = series as { prefix: string; fiscal_year: string; last_number: number };
  const out: SeriesState = {
    prefix: s.prefix,
    docCode: (tenant as { doc_code?: string | null } | null)?.doc_code ?? null,
    fiscalYear: s.fiscal_year,
    lastNumber: s.last_number,
    invoiceCount: count ?? 0,
  };
  return NextResponse.json({ series: out });
}
