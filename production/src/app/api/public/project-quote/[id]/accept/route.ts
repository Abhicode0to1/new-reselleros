/**
 * POST /api/public/project-quote/[id]/accept
 *
 * Customer-side: accept a project quotation → it becomes an active project.
 * Admin client (customer isn't authenticated), isliye pehchan TOKEN se hoti
 * hai: body ka `t` project ka `public_token` hona chahiye — bilkul waise hi
 * jaise har doosra public quote-route (0115/SEC-1).
 *
 * 1 Sep 2026 tak ye route BINA token ke chalta tha — "id is the implicit
 * link secret" likha tha, par id URL/email/request-log sab me dikhti hai.
 * Audit ne pakda; ab id + token dono chahiye.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { publicDbError } from "@/app/api/public/_lib/db-error";

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createAdminClient();

  const body = await request.json().catch(() => ({}));
  const provided = typeof body?.t === "string" ? body.t : request.nextUrl.searchParams.get("t");

  const { data: project } = await supabase
    .from("project_sales")
    .select("id, public_token")
    .eq("id", params.id)
    .maybeSingle();

  /* Galat id aur galat token ek hi jawab dete hain — warna response ka farq
     bata deta hai ki id asli hai. */
  if (!project || !quoteTokenMatches(provided, project.public_token)) {
    return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  }

  const { data, error } = await supabase.rpc("accept_project_quote", { p_project_id: params.id });

  if (error) {
    /* accept_project_quote raises its two customer-facing refusals with their own SQLSTATE:
       "Quotation not found" (no_data_found = P0002) and "This quotation cannot be accepted
       (status …)" (invalid_parameter_value = 22023). This compared error.code with the
       condition NAME, which Postgres never sends, so a missing quotation was a 400. */
    const e = publicDbError("project-quote/accept", error, "We could not accept this quotation just now. Please try again in a minute.", {
      passCodes: { P0002: 404, "22023": 409 },
    });
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return NextResponse.json({ ok: true, result: data });
}
