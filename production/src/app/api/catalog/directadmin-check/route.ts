import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { daConfigured, daAllPackages } from "@/lib/directadmin";

/**
 * GET /api/catalog/directadmin-check — owner-only, READ-ONLY DirectAdmin probe.
 *
 * The safe first step of the DirectAdmin bring-up (2 Sep 2026): prove the app
 * can reach the server and read its packages BEFORE any code that creates an
 * account exists. It lists packages + quotas, nothing more — it cannot create,
 * change or delete anything. If this answers with the real packages, the
 * connection and the IP allowlist are good, and provisioning can be built on a
 * verified footing rather than blind.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { data: me } = await supabase
    .from("users").select("role").eq("id", authData.user.id).single();
  if (me?.role !== "owner") {
    return NextResponse.json({ error: "Owner only." }, { status: 403 });
  }

  if (!daConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "DirectAdmin credentials are not set on this server yet." },
      { status: 400 },
    );
  }

  const packages = await daAllPackages();
  if (!packages) {
    return NextResponse.json(
      {
        ok: false,
        reason:
          "DirectAdmin didn't answer with data. Most likely this server's IP (34.14.190.227) " +
          "isn't on the DirectAdmin admin IP allowlist yet, or the credentials are wrong. " +
          "The server logs carry DA's exact response.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, count: packages.length, packages });
}
