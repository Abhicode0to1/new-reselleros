/**
 * What the customer sees after clicking the link in their "confirm your email"
 * trial mail. The confirm route (api/public/trial/hosting/confirm) redirects to
 * /hosting/trial?confirmed=<status> and this renders that status.
 *
 * This is all that is left of the old trial FORM. On 24 Sep 2026 "Start free
 * trial" moved into the cart (Pardeep: no page in between), so the details are
 * now collected at checkout and the trial is started by lib/hosting/start-trial.
 * The confirmation link still lands here, which is why the page survives.
 *
 * Styled to match the hosting landing (Manrope + Instrument Serif, the cream /
 * orange palette). It renders under (marketing), so the site menu is above it.
 */
import { Manrope } from "next/font/google";
import { TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";

const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--htf-sans", display: "swap" });

const C = {
  ink: "#17120F", ink2: "#4A403A", paper: "#FDFBF8",
  accBorder: "#FBD3B8", accSurf: "#FFF1E7", successSurf: "#F0FDF4", successBorder: "#BBF7D0",
};

const STATUSES: Record<string, { ok: boolean; title: string; body: string }> = {
  provisioned: { ok: true, title: "You're all set — check your email.", body: "Your hosting account is live and we've emailed your control-panel login. Please change the password after your first sign-in." },
  already: { ok: true, title: "Your trial is already active.", body: "This account is already set up. Check your inbox for the login we sent earlier, or reply to that email if you need it again." },
  pending: { ok: true, title: "Email confirmed — setting up your account.", body: "Thanks! We're creating your cPanel account now and will email your login shortly. No credit card is charged." },
  needdomain: { ok: true, title: "Email confirmed — one thing left.", body: "You told us you still need a domain. We'll be in touch shortly to help you pick one, then set up your trial." },
  notrialplan: { ok: true, title: "Email confirmed — we'll call you about the plan.", body: `The free trial is now only on the ${TRIAL_PLAN_NAME} plan, and you asked for a bigger one. We'll be in touch shortly to start a ${TRIAL_PLAN_NAME} trial or set up the plan you picked. Nothing is charged.` },
  error: { ok: false, title: "Almost there — we'll finish this by hand.", body: "We hit a snag setting things up automatically, so our team will complete it and email your login shortly. Nothing is wrong on your end." },
  expired: { ok: false, title: "That link has expired.", body: "Confirmation links are valid for 48 hours. Start the trial again from the hosting page and we'll send a fresh one." },
  invalid: { ok: false, title: "That link didn't work.", body: "Start the trial again from the hosting page to get a new confirmation link." },
};

export function HostingTrialStatus({ status }: { status: string }) {
  const m = STATUSES[status] ?? STATUSES.invalid;
  return (
    <div className={manrope.variable} style={{ fontFamily: "var(--htf-sans), system-ui, sans-serif", background: C.paper, color: C.ink, padding: "clamp(32px,6vw,64px) 20px clamp(48px,8vw,80px)" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", background: m.ok ? C.successSurf : C.accSurf, border: `1px solid ${m.ok ? C.successBorder : C.accBorder}`, borderRadius: 18, padding: "clamp(28px,4vw,44px)", textAlign: "center" }}>
        <div style={{ fontSize: 40 }} aria-hidden>{m.ok ? "✓" : "!"}</div>
        <h1 style={{ fontSize: "clamp(24px,4vw,34px)", fontWeight: 800, letterSpacing: "-.03em", marginTop: 8 }}>{m.title}</h1>
        <p style={{ marginTop: 14, fontSize: 17, lineHeight: 1.55, color: C.ink2 }}>{m.body}</p>
        <a href="/hosting#choose" style={{ display: "inline-block", marginTop: 22, background: C.ink, color: C.paper, padding: "14px 24px", borderRadius: 11, fontSize: 15, fontWeight: 700, textDecoration: "none" }}>Back to hosting</a>
      </div>
    </div>
  );
}
