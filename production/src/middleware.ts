/**
 * Root middleware — runs on every matched request.
 *
 * Responsibilities:
 * 1. Refresh Supabase auth session cookies
 * 2. Gate (app)/* routes behind authentication
 * 3. Redirect authenticated users away from (auth)/* routes
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { allowedRoutesForRole, ROLE_HOME, type UserRole } from "@/lib/nav";

// Routes that require authentication (the entire app shell).
// Keep this in sync with APP_NAV in src/lib/nav.ts — any new section's
// prefix must be added here for the auth gate + role guard to fire.
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/leads",
  "/deals",
  "/tasks",
  "/customers",
  "/contacts",
  "/items",
  "/online-orders",
  "/quotes",
  "/payments",
  "/invoices",
  "/subscriptions",
  "/renewals",
  "/purchase-orders",
  "/projects",        // Project Sales (financials) — was missing from the gate
  "/performance",     // Team performance / bonus — was missing
  "/assessments",     // employee reasoning tests (owner view; public take page is /assessment/[token])
  "/enquiries",       // inbound enquiries inbox — was missing
  "/compliance",      // Pvt Ltd statutory compliance tracker
  "/accounting",      // /accounting/bills, /accounting/pnl, etc.
  "/whatsapp",
  "/automations",
  "/campaigns",
  "/online-promos",
  "/coupons",
  "/reports",
  "/support",
  "/setup",
  "/settings",
  "/team",
  "/partners",
  "/mobile",
  "/lead-gen",
  /* Internal bug-report triage queue. The role gate is the nav-derived one further
     down (owner + manager); this list is only the "must be signed in" half. */
  "/admin",
  /* ─── BOTH ADDED 19 Aug 2026, AND BOTH WERE ALREADY MISSING ──────────────────
     Found by curling the live service right after a deploy: `/dashboard` answered 307
     to /login as expected, and `/vault` and `/attendance/me` answered **200** — the app
     shell rendered for a request with no session at all.

     No data was exposed: every query underneath runs through PostgREST under RLS, and
     with no session there is no `auth.uid()`, so nothing comes back. But rendering the
     Password Vault and the private vault to a signed-out visitor is wrong on its own
     terms, and it is precisely the shape of thing a security review reads as a leak.

     `/vault` predates this session — the customer-console Password Vault has been
     reachable this way the whole time. `/attendance` covers /attendance/me and the
     kiosk; the kiosk is safe to gate because its own header says the office tablet runs
     it "logged in as the owner", so it always had a session. */
  "/vault",
  "/attendance",
  /* Onboarding fork for a signed-in person who has no workspace yet. It is
     PROTECTED (you must be authenticated to see it) but deliberately NOT in
     AUTH_PREFIXES below — those bounce a signed-in user to their role home,
     and this page exists precisely for people who do not have one yet. The
     role guard further down is skipped for them too, because `role` is null
     until a users row exists. */
  "/welcome",
];

// Routes that should redirect to /dashboard if user is logged in
const AUTH_PREFIXES = ["/login", "/signup"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // If Supabase isn't configured yet, just let everything pass.
  // (Until the operator pastes real env vars, we don't enforce auth.)
  if (!isSupabaseConfigured()) {
    return NextResponse.next();
  }

  // DEMO_MODE: bypass auth in local dev for screenshots / UI review.
  // Controlled by NEXT_PUBLIC_DEMO_MODE=true in .env.local only.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true" && process.env.NODE_ENV === "development") {
    return NextResponse.next();
  }

  const { response, user, role, canViewDeals } = await updateSession(request);
  const isAuthed = !!user;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthPage = AUTH_PREFIXES.some((p) => pathname.startsWith(p));

  // Not logged in → block protected routes
  if (!isAuthed && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Logged in → redirect away from auth pages, sending each role to its
  // own home page (sales lands on /leads, others on /dashboard).
  if (isAuthed && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = ROLE_HOME[(role as UserRole) ?? "owner"] ?? "/dashboard";
    url.searchParams.delete("next");
    return NextResponse.redirect(url);
  }

  // Role-based route guard. Sales users only have /leads + /tasks in their
  // nav; visiting any other protected route bounces them to their home.
  // Owners + managers get the full app — no gate applied to them.
  if (isAuthed && isProtected && role && role !== "owner" && role !== "manager") {
    const userRole = role as UserRole;
    const allowed = allowedRoutesForRole(userRole, { canViewDeals });
    const isAllowedPath = allowed.some(
      (a) => pathname === a || pathname.startsWith(a + "/"),
    );
    if (!isAllowedPath) {
      const url = request.nextUrl.clone();
      url.pathname = ROLE_HOME[userRole];
      url.searchParams.delete("next");
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  // Run on everything except static assets + Next internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
