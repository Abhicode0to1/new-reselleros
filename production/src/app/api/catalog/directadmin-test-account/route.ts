import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  daWriteConfigured,
  daCreateAccount,
  daDeleteAccount,
  daAccountExists,
  genUsername,
  genPassword,
} from "@/lib/directadmin/provision";

/**
 * GET /api/catalog/directadmin-test-account?action=create|status|delete&domain=…
 *
 * OWNER-ONLY bring-up tool (2 Sep 2026). It exercises the irreversible
 * account-creating path ONCE, by hand, against a throwaway domain, so the write
 * client is proven before the public trial flow is switched live. It is the only
 * way this app creates an account outside the gated trial confirm route, and it
 * is owner-gated exactly like the read-only probe next to it.
 *
 *   ?action=create  → create the account (Starter package) for `domain`
 *   ?action=status  → does the account for `domain` exist?
 *   ?action=delete  → PERMANENTLY delete it (the test cleanup)
 *
 * Never returns the generated password. Use a domain you don't mind existing on
 * the server for a minute (e.g. clitest-<n>.example), then delete it.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { data: me } = await supabase.from("users").select("role").eq("id", authData.user.id).single();
  if (me?.role !== "owner") return NextResponse.json({ error: "Owner only." }, { status: 403 });

  if (!daWriteConfigured()) {
    return NextResponse.json({ ok: false, reason: "DirectAdmin credentials are not set." }, { status: 400 });
  }

  const action = req.nextUrl.searchParams.get("action") || "status";
  const domain = (req.nextUrl.searchParams.get("domain") || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
  if (!/^[a-z0-9.-]{3,}\.[a-z]{2,}$/.test(domain)) {
    return NextResponse.json({ ok: false, reason: "Pass a plausible ?domain= (e.g. clitest-1.example)." }, { status: 400 });
  }
  const username = genUsername(domain);

  if (action === "status") {
    const exists = await daAccountExists(username);
    return NextResponse.json({ ok: true, action, domain, username, exists });
  }

  if (action === "create") {
    const result = await daCreateAccount({
      username,
      password: genPassword(),
      email: authData.user.email || "owner@anutech.in",
      domain,
      pkg: "Starter",
    });
    return NextResponse.json({ ok: result.ok, action, domain, username, message: result.message, alreadyExisted: result.alreadyExisted ?? false });
  }

  if (action === "delete") {
    const result = await daDeleteAccount(username);
    return NextResponse.json({ ok: result.ok, action, domain, username, message: result.message });
  }

  return NextResponse.json({ ok: false, reason: "action must be create, status or delete." }, { status: 400 });
}
