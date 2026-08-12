/**
 * POST /api/inbound-emails/[id]/convert
 *
 * Tenant-scoped server endpoint for converting an inbound email to a lead.
 * Uses admin client to bypass function permission checks while strictly enforcing tenant scoping.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", user.id)
    .maybeSingle();

  if (!me?.tenant_id) {
    return NextResponse.json({ error: "No tenant context found." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("convert_inbound_email_to_lead", { p_id: params.id });

  if (error) {
    console.error("[api/inbound-emails/convert] error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ leadId: data });
}
