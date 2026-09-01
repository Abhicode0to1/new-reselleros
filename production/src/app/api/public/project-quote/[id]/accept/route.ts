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

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
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
    const status = error.code === "no_data_found" ? 404 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ ok: true, result: data });
}
