/**
 * DEV ONLY — sign in as a demo portal customer in one click.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Pardeep, 11 Sep 2026: "why do i need to confirm email id anyway / shouldn't i
 * be logged in directly like others login of owner and tenet".
 *
 * Fair. The two staff rows in the dev login box fill a password and you are in.
 * The customer row sent you to a second screen, then to a Docker mail catcher
 * to copy six digits. Same purpose, five times the work, for a fixture.
 *
 * ─── IT AUTOMATES THE REAL FLOW, IT DOES NOT BYPASS IT ──────────────────────
 * No hand-rolled session, no forged cookie, no "trust this header" shortcut.
 * It asks Supabase for the same one-time token the email would have carried
 * (`admin.generateLink`) and then verifies it (`verifyOtp`) exactly as pasting
 * the code does. The session that comes out is an ordinary customer session,
 * indistinguishable from one earned the long way, and it goes through the same
 * `linkAuthUserToCustomer` the real callback uses.
 *
 * That matters more than the convenience: a shortcut that skipped verification
 * would mean the thing being tested is no longer the thing customers use, and
 * the first bug it hides will be an auth bug.
 *
 * ─── THREE INDEPENDENT GUARDS, AND THE SECOND IS THE REAL ONE ───────────────
 * 1. NODE_ENV. Production returns 404 — not 403, which would confirm the route
 *    exists to anybody probing.
 *
 * 2. THE ADDRESS MUST END IN `.invalid`. This is the guard that would still
 *    hold if the first one were ever defeated by a bad build or a stray
 *    NODE_ENV: `.invalid` is reserved by RFC 2606 and can never be a real
 *    person's mailbox, so this route CANNOT sign anybody in as a real
 *    customer. It is not "unlikely to" — there is no such address to target.
 *
 * 3. POST only. A GET that establishes a session is one prefetch, crawler or
 *    pasted link away from firing on its own.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { linkAuthUserToCustomer } from "@/lib/portal/link-customer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 404, so a probe cannot tell this route from one that never existed. */
const GONE = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Is this "the database is not running" wearing a different hat?
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Measured 11 Sep 2026: clicking the demo row with the local stack down showed
 *
 *   {"error":"Could not prepare the demo user: fetch failed"}
 *
 * "fetch failed" is Node's words for a refused TCP connection, and passing it
 * through named the wrong thing entirely — it reads as a bug in this route, and
 * a person then goes looking through code that is working. The actual cause is
 * that nothing is listening on the Supabase URL.
 *
 * Every one of the three upstream calls below fails identically when the stack
 * is down, so the check is shared rather than repeated three times with three
 * different wordings.
 */
function isUpstreamDown(message: string | undefined): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|Failed to fetch/i.test(
    message ?? "",
  );
}

/** Says what is actually wrong, and the command that fixes it (§24). */
function upstreamDownResponse() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "(NEXT_PUBLIC_SUPABASE_URL is unset)";
  return NextResponse.json(
    {
      error: `The local Supabase stack is not reachable at ${url}, so nobody can sign in — this is not a problem with the demo account.`,
      nextStep:
        "Start it with `npx supabase start` in production/. If that fails on a port with " +
        "\"an attempt was made to access a socket in a way forbidden by its access permissions\", " +
        "Windows has reserved the port range: run `net stop winnat` then `net start winnat` in an " +
        "Administrator shell and start it again.",
    },
    { status: 503 },
  );
}

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return GONE();

  const form = await request.formData().catch(() => null);
  const email = String(form?.get("email") ?? "").trim().toLowerCase();

  /* Guard 2 — see the header. The one that holds on its own. */
  if (!email || !email.endsWith(".invalid")) {
    return NextResponse.json(
      {
        error:
          "This dev sign-in only works for a .invalid demo address, so it can never sign in a real customer.",
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  /* The auth user may not exist yet — a fresh database, or the very first
     sign-in for this fixture. Created confirmed, because an unconfirmed user
     cannot verify an OTP and the failure reads as a wrong code. */
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  /* "already registered" is the expected case on every run after the first. */
  if (createErr && !/already|exists|registered/i.test(createErr.message)) {
    /* The commonest failure here by far is the stack being down, and saying
       "could not prepare the demo user" for that sends the reader into this
       file instead of to their terminal. */
    if (isUpstreamDown(createErr.message)) return upstreamDownResponse();
    return NextResponse.json(
      { error: `Could not prepare the demo user: ${createErr.message}` },
      { status: 500 },
    );
  }

  /* The same token the email would have carried. */
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    if (isUpstreamDown(linkErr?.message)) return upstreamDownResponse();
    return NextResponse.json(
      { error: `Could not mint a sign-in token: ${linkErr?.message ?? "no token returned"}` },
      { status: 500 },
    );
  }

  /* Verified through the ordinary path, on the cookie-writing client, so the
     session is a real one. */
  const supabase = createClient();
  const { data: verified, error: verifyErr } = await supabase.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  });
  if (verifyErr || !verified.user?.email) {
    if (isUpstreamDown(verifyErr?.message)) return upstreamDownResponse();
    return NextResponse.json(
      { error: `Sign-in failed: ${verifyErr?.message ?? "no session"}` },
      { status: 500 },
    );
  }

  /* Same linking step as /portal/auth/callback — one implementation, because
     this decides which customer's data the session can read. */
  const linked = await linkAuthUserToCustomer({
    authUserId: verified.user.id,
    email: verified.user.email,
  });

  if (!linked.ok) {
    /* Do not leave a half-authenticated session behind, exactly as the real
       callback does not. */
    await supabase.auth.signOut();
    const hint =
      linked.reason === "no_customer"
        ? `No customer has ${email} as its contact_email. Run scripts/seed-portal-test-customer.sql.`
        : `Could not link the demo user: ${linked.detail ?? "insert failed"}`;
    return NextResponse.json({ error: hint }, { status: 409 });
  }

  /* Relative redirect: the browser resolves it against the host it is already
     on, so this cannot produce the https://0.0.0.0:3000 links that the real
     callback's comment warns about. */
  return NextResponse.redirect(new URL("/portal/dashboard", request.url), { status: 303 });
}
