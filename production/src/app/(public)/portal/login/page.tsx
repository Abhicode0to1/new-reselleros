"use client";

/**
 * /portal/login — customer sign-in via 6-digit EMAIL OTP CODE (not a magic link).
 *
 * Why a code, not a link:
 *   Gmail / Google Workspace mail scanners pre-fetch links in email for safety
 *   checks. A Supabase magic link's token is single-use, so the scanner's GET to
 *   /verify burns it before the customer ever clicks — the real click then hits
 *   "link invalid or expired" (seen in prod: /verify 303 then 403 "One-time token
 *   not found" from a Google IP). Most of our customers are on Gmail/Workspace,
 *   so links broke login broadly. A 6-digit code has no URL for a scanner to
 *   consume, and works across devices (no PKCE code_verifier cookie needed).
 *
 * Flow:
 *   1. Email step  — verify the email belongs to a customer (portal_customer_exists),
 *                    then signInWithOtp WITHOUT emailRedirectTo → Supabase emails a code.
 *   2. Code step   — verifyOtp({type:'email'}) sets the session client-side, then
 *                    portal_ensure_customer_link() (service-role RPC) links the
 *                    auth user → their customer row. Redirect to /portal/dashboard.
 */
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FormField } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

/** Where a customer goes for hosting and domains — a separate app, separate login.
 *  Must be written out in full for Next to inline it at build time; a computed
 *  `process.env[name]` is NOT replaced and would be undefined in the browser. */
const DMS_PORTAL_URL = (process.env.NEXT_PUBLIC_DMS_PORTAL_URL ?? "").trim();

/**
 * Dev-only demo customer, mirroring the staff login page's panel.
 *
 * ─── WHY THIS IS NOT ON THE STAFF PAGE ───────────────────────────────────────
 * The obvious place for a "customer demo login" is beside the two tenant logins
 * at /login. It cannot go there: /login is `signInWithPassword` against a `users`
 * row, and a customer has neither. The button would autofill a credential that
 * can never succeed.
 *
 * That is not hypothetical. The staff page carries a comment about a third entry
 * (`darshan@exceltechnologies.in`) that pointed at a user who did not exist, so
 * pressing it only ever failed — under a heading claiming the list was "kept in
 * sync with the actual tenants". A demo credential that does not work is worse
 * than none, because it sends whoever tries it hunting for a bug in the auth.
 *
 * So the customer demo lives here, on the page that can actually sign a customer
 * in, and it fills the EMAIL only — the second factor is a real emailed code.
 *
 * ─── THIS ADDRESS MUST STAY UNROUTABLE ───────────────────────────────────────
 * `.invalid` is reserved by RFC 2606. Autofilling a real customer's address
 * would mean every developer pressing this button sends that person a sign-in
 * code. Pick a different demo customer only if its address is equally fake.
 *
 * Requires the matching row: `customers.contact_email = portal-test@anutech.invalid`
 * (the portal_customer_exists RPC matches on that column, not on auth.users).
 */
const DEMO_CUSTOMER = {
  label: "Portal Test Customer",
  sub: "Anutech Digital",
  email: "portal-test@anutech.invalid",
};

/** Where the emailed code lands on a local `supabase start` stack. */
const LOCAL_MAIL_URL = "http://localhost:14324";

const emailSchema = z.object({ email: z.string().email("Valid email required") });
type EmailForm = z.infer<typeof emailSchema>;

// Supabase's email-OTP length is project-configurable (6–10). Accept that
// range instead of hardcoding 6, so the box matches whatever length the
// dashboard is set to (this project currently sends 8).
const codeSchema = z.object({
  code: z.string().trim().regex(/^\d{6,10}$/, "Enter the code from your email"),
});
type CodeForm = z.infer<typeof codeSchema>;

function PortalLoginInner() {
  const params = useSearchParams();
  const error = params.get("error");

  const [step, setStep] = React.useState<"email" | "code">("email");
  const [email, setEmail] = React.useState("");
  const [preNoCustomer, setPreNoCustomer] = React.useState(false);
  const [resending, setResending] = React.useState(false);

  const emailForm = useForm<EmailForm>({ resolver: zodResolver(emailSchema) });
  const codeForm = useForm<CodeForm>({ resolver: zodResolver(codeSchema) });

  /** Check the email is a customer, then send a 6-digit code. Returns success. */
  async function sendCode(addr: string): Promise<boolean> {
    const supabase = createClient();
    // Up-front check: only send to a real customer. Saves a non-customer the
    // wasted email + avoids creating an orphan auth.users row (shouldCreateUser).
    const { data: exists, error: chkErr } = await supabase.rpc("portal_customer_exists", {
      p_email: addr,
    });
    if (chkErr) {
      toast.error(chkErr.message);
      return false;
    }
    if (!exists) {
      setPreNoCustomer(true);
      return false;
    }
    // No emailRedirectTo → Supabase emails a 6-digit code instead of a link.
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { shouldCreateUser: true },
    });
    if (otpErr) {
      toast.error(otpErr.message);
      return false;
    }
    return true;
  }

  async function onEmailSubmit({ email: addr }: EmailForm) {
    setPreNoCustomer(false);
    const ok = await sendCode(addr);
    if (ok) {
      setEmail(addr);
      setStep("code");
      codeForm.reset();
    }
  }

  async function onCodeSubmit({ code }: CodeForm) {
    const supabase = createClient();
    const { error: vErr } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email",
    });
    if (vErr) {
      /* A NETWORK failure is not a wrong code, and saying so sends a customer back
         to retype a code that was perfectly correct — over and over, until they give
         up and call. Seen for real: the tab's network was suspended, verifyOtp threw
         AuthRetryableFetchError, and the screen said "wrong or expired".

         Supabase marks these as retryable; anything else really is a bad or expired
         code. */
      const retryable = (vErr as { name?: string; status?: number }).name === "AuthRetryableFetchError"
        || (vErr as { status?: number }).status === 0;
      if (retryable) {
        toast.error("We could not reach the sign-in service.", {
          description: "Your code is probably fine — check your connection and press Verify again. Do not request a new code yet.",
          duration: 10_000,
        });
        return;
      }
      toast.error("That code is wrong or expired. Check the email, or resend a new code.");
      return;
    }
    /* Session is set — the code has now been CONSUMED. Everything below has to
       succeed on this session, because pressing Verify again would fail: a
       single-use code cannot be replayed.

       That is exactly what stranded a real sign-in: verifyOtp succeeded
       (auth.users.last_sign_in_at was stamped), the link RPC then failed on a
       transient network error, the screen printed "Failed to fetch", and the
       customer was left signed in, unlinked, staring at a login page — with a code
       that could never be used again. */
    await finishLink(supabase);
  }

  /**
   * Link auth user → customer, and go.
   *
   * Retries a transient failure rather than throwing the session away. A network
   * blip here costs the customer their one-time code, so it is worth two more
   * attempts before asking them to start over.
   */
  async function finishLink(supabase: ReturnType<typeof createClient>) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data: linkResult, error: linkErr } = await supabase.rpc("portal_ensure_customer_link");

      if (!linkErr) {
        if (linkResult === "no_customer" || linkResult === "no_auth") {
          await supabase.auth.signOut();
          setStep("email");
          setPreNoCustomer(true);
          return;
        }
        window.location.href = "/portal/dashboard";
        return;
      }

      const retryable = (linkErr as { name?: string; status?: number }).name === "AuthRetryableFetchError"
        || (linkErr as { status?: number }).status === 0
        || /fetch/i.test(linkErr.message ?? "");
      if (!retryable) {
        toast.error(linkErr.message);
        return;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 800));
    }

    /* Still failing. The session is VALID — say so, because the instinct at this
       point is to request another code, and that is the one thing that does not
       help. Reloading re-runs the rescue below. */
    toast.error("You are signed in, but we could not finish connecting your account.", {
      description: "Your connection dropped at the last step. Reload this page — you will NOT need a new code.",
      duration: 15_000,
    });
  }

  /**
   * Rescue a half-finished sign-in.
   *
   * If a session already exists but the link never got made, finish it on load
   * instead of asking for a code that was already spent. Without this, the only way
   * out of that state was a new code — and the user had just been told not to
   * request one.
   */
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      await finishLink(supabase);
    })();
    return () => { cancelled = true; };
    // Runs once on mount; finishLink is stable enough for this one-shot rescue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resend() {
    setResending(true);
    try {
      const ok = await sendCode(email);
      if (ok) toast.success("New code sent.");
    } finally {
      setResending(false);
    }
  }

  function useDifferentEmail() {
    setStep("email");
    setPreNoCustomer(false);
    codeForm.reset();
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <Card className="max-w-md w-full p-8">
        <div className="text-center mb-6">
          <h1 className="font-serif text-3xl mb-2">Customer sign-in</h1>
          <p className="text-sm text-ink-3">Access your orders, invoices and subscription</p>
        </div>

        {(error === "no_customer" || preNoCustomer) && (
          <div className="mb-4 p-3 bg-rose-soft border border-rose/30 rounded-md text-xs text-rose-ink">
            We couldn&apos;t find a customer account with that email. Please use the
            same email address you provided when ordering. If you&apos;re sure it&apos;s
            right, contact the business you purchased from.
          </div>
        )}
        {error === "auth_failed" && step === "email" && (
          <div className="mb-4 p-3 bg-rose-soft border border-rose/30 rounded-md text-xs text-rose-ink">
            Your sign-in session expired. Please request a new code below.
          </div>
        )}

        {/* Dev-only demo customer — same gate as the staff login page, so it
            cannot reach a production build. Fills the email; the code itself
            still has to be fetched, which is the point of linking the local
            mail catcher beside it. */}
        {process.env.NODE_ENV !== "production" && step === "email" && (
          <div className="mb-4 p-3 bg-indigo-50 border border-indigo/30 rounded-md text-xs">
            <div className="flex items-start gap-2 mb-2">
              <Icon name="info" size={14} className="text-indigo flex-shrink-0 mt-0.5" />
              <div className="text-indigo flex-1">
                <b>Dev mode — demo customer</b>
                <span className="text-ink-3 ml-1">· click to autofill</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                emailForm.setValue("email", DEMO_CUSTOMER.email, { shouldValidate: true })
              }
              className="w-full text-left rounded px-2 py-1.5 hover:bg-indigo/10 transition-colors"
            >
              <div className="font-medium text-ink">
                {DEMO_CUSTOMER.label}
                <span className="text-ink-3 font-normal"> · {DEMO_CUSTOMER.sub}</span>
              </div>
              <div className="text-2xs text-ink-3 font-mono">{DEMO_CUSTOMER.email}</div>
            </button>
            <p className="mt-2 pt-2 border-t border-indigo/20 text-2xs text-ink-3">
              There is no demo password — the portal signs in by emailed code. Read it at{" "}
              <a
                href={LOCAL_MAIL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo underline underline-offset-2"
              >
                the local inbox
              </a>
              .
            </p>
          </div>
        )}

        {step === "email" ? (
          <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-4">
            <FormField label="Your work email" required htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="e.g. you@yourcompany.in"
                error={emailForm.formState.errors.email?.message}
                {...emailForm.register("email")}
              />
            </FormField>

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={emailForm.formState.isSubmitting}
            >
              <Icon name="mail" size={14} className="mr-1.5" />
              Email me a sign-in code
            </Button>

            <p className="text-2xs text-ink-3 text-center leading-relaxed">
              No passwords. We email you a one-time code that signs you in.
            </p>
          </form>
        ) : (
          <form onSubmit={codeForm.handleSubmit(onCodeSubmit)} className="space-y-4">
            <p className="text-sm text-ink-3 text-center leading-relaxed">
              We&apos;ve emailed a sign-in code to <b className="text-ink">{email}</b>.
              Enter it below. Check spam if you don&apos;t see it.
            </p>

            <FormField label="Sign-in code" required htmlFor="code">
              <Input
                id="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                placeholder="12345678"
                className="text-center text-lg tracking-[0.3em] font-mono"
                error={codeForm.formState.errors.code?.message}
                {...codeForm.register("code")}
              />
            </FormField>

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={codeForm.formState.isSubmitting}
            >
              <Icon name="lock" size={14} className="mr-1.5" />
              Verify &amp; sign in
            </Button>

            <div className="flex items-center justify-between text-2xs text-ink-3">
              <button
                type="button"
                onClick={resend}
                disabled={resending}
                className="text-amber-ink underline disabled:opacity-50"
              >
                {resending ? "Sending…" : "Resend code"}
              </button>
              <button
                type="button"
                onClick={useDifferentEmail}
                className="text-amber-ink underline"
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        {/* Hosting and domains live in a separate application with its own
            login. A customer who bought hosting arrives here expecting to find
            it, does not, and contacts support — so the signpost belongs on the
            page where that wrong turn happens, not behind a successful sign-in
            they may never complete.

            Rendered only when NEXT_PUBLIC_DMS_PORTAL_URL is set: a hard-coded
            fallback would send customers to a host that may not be this
            deployment's engine. Absent config means no link, not a guess. */}
        {DMS_PORTAL_URL && (
          <div className="mt-6 pt-5 border-t border-hairline text-center">
            <p className="text-xs text-ink-3">Looking for your hosting or domains?</p>
            <a
              href={DMS_PORTAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-amber-ink underline underline-offset-4"
            >
              Sign in to the hosting &amp; domains portal
              <Icon name="external" size={11} />
            </a>
            <p className="mt-1.5 text-2xs text-ink-3">
              It uses a separate account from this one.
            </p>
          </div>
        )}

        <div className="mt-6 pt-5 border-t border-hairline text-center text-xs text-ink-3">
          Need help? Contact the business you purchased from.
        </div>
      </Card>
    </div>
  );
}

export default function PortalLoginPage() {
  return (
    <React.Suspense fallback={null}>
      <PortalLoginInner />
    </React.Suspense>
  );
}
