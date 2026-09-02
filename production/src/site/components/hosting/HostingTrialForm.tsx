"use client";

/**
 * HostingTrialForm — the customer-facing "start your hosting trial" form
 * (2 Sep 2026). This is the destination of the /hosting page's "Start free
 * trial" buttons — a CUSTOMER flow (someone who wants a website), NOT the
 * reseller /signup. It posts to /api/public/trial/hosting, which captures the
 * request as a lead and confirms by email; the cPanel account is provisioned
 * from that lead (gated). No credit card is asked for here — that is the promise.
 *
 * Styled to match the hosting landing (Manrope + Instrument Serif, the cream /
 * orange palette). It renders under (marketing), so the site menu is above it.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Manrope, Instrument_Serif } from "next/font/google";
import { HOSTING_TIERS, TRIAL_DAYS } from "@/site/lib/data/hosting-landing-v2";

const manrope = Manrope({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--htf-sans", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: "italic", variable: "--htf-serif", display: "swap" });

const C = {
  ink: "#17120F", ink2: "#4A403A", muted: "#7A6C62", paper: "#FDFBF8", card: "#fff",
  line: "#E8DFD7", accent: "#C2410C", accentDark: "#7C2D12", accSurf: "#FFF1E7",
  accBorder: "#FBD3B8", success: "#15803D", successSurf: "#F0FDF4", successBorder: "#BBF7D0",
};

type Status = "have" | "need";

export function HostingTrialForm() {
  const params = useSearchParams();
  const planParam = (params.get("plan") || "").toLowerCase();
  const initialPlan = HOSTING_TIERS.some((t) => t.name.toLowerCase() === planParam) ? planParam : "standard";
  const confirmed = params.get("confirmed");

  const [plan, setPlan] = useState(initialPlan);
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [domainStatus, setDomainStatus] = useState<Status>("have");
  const [domain, setDomain] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const label: React.CSSProperties = { fontSize: 14.5, fontWeight: 700, color: C.ink, display: "block", marginBottom: 7 };
  const input: React.CSSProperties = {
    width: "100%", padding: "13px 14px", borderRadius: 11, border: `1px solid ${C.line}`,
    fontSize: 15, background: C.card, color: C.ink, fontFamily: "inherit",
  };
  const field = (children: React.ReactNode) => <div style={{ marginBottom: 18 }}>{children}</div>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (company.trim().length < 2) return setError("Please enter your company name.");
    if (name.trim().length < 2) return setError("Please enter your name.");
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError("Please enter a valid email address.");
    if (phone.replace(/\D/g, "").length < 10) return setError("Please enter a valid phone number.");
    if (domainStatus === "have" && domain.trim().length < 3) return setError("Please enter your website's domain, or choose “I need a new domain”.");

    setSubmitting(true);
    try {
      const res = await fetch("/api/public/trial/hosting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name.trim(),
          companyName: company.trim(),
          email: email.trim(),
          phone: phone.trim(),
          tierId: plan,
          domain: domainStatus === "have" ? domain.trim() : undefined,
          domainStatus,
          message: message.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error || "Could not start your trial. Please try again.");
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const wrap = `${manrope.variable} ${serif.variable}`;
  const outer: React.CSSProperties = {
    fontFamily: "var(--htf-sans), system-ui, sans-serif", background: C.paper, color: C.ink,
    padding: "clamp(32px,6vw,64px) 20px clamp(48px,8vw,80px)",
  };

  if (confirmed) {
    const map: Record<string, { ok: boolean; title: string; body: string }> = {
      provisioned: { ok: true, title: "You're all set — check your email.", body: "Your hosting account is live and we've emailed your control-panel login. Please change the password after your first sign-in." },
      already: { ok: true, title: "Your trial is already active.", body: "This account is already set up. Check your inbox for the login we sent earlier, or reply to that email if you need it again." },
      pending: { ok: true, title: "Email confirmed — setting up your account.", body: "Thanks! We're creating your cPanel account now and will email your login shortly. No credit card is charged." },
      needdomain: { ok: true, title: "Email confirmed — one thing left.", body: "You told us you still need a domain. We'll be in touch shortly to help you pick one, then set up your trial." },
      error: { ok: false, title: "Almost there — we'll finish this by hand.", body: "We hit a snag setting things up automatically, so our team will complete it and email your login shortly. Nothing is wrong on your end." },
      expired: { ok: false, title: "That link has expired.", body: "Confirmation links are valid for 48 hours. Please start the trial again and we'll send a fresh one." },
      invalid: { ok: false, title: "That link didn't work.", body: "Please start the trial again to get a new confirmation link." },
    };
    const m = map[confirmed] || map.invalid;
    return (
      <div className={wrap} style={outer}>
        <div style={{ maxWidth: 640, margin: "0 auto", background: m.ok ? C.successSurf : C.accSurf, border: `1px solid ${m.ok ? C.successBorder : C.accBorder}`, borderRadius: 18, padding: "clamp(28px,4vw,44px)", textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>{m.ok ? "✓" : "!"}</div>
          <h1 style={{ fontSize: "clamp(24px,4vw,34px)", fontWeight: 800, letterSpacing: "-.03em", marginTop: 8 }}>{m.title}</h1>
          <p style={{ marginTop: 14, fontSize: 17, lineHeight: 1.55, color: C.ink2 }}>{m.body}</p>
          <a href="/hosting" style={{ display: "inline-block", marginTop: 22, background: C.ink, color: C.paper, padding: "14px 24px", borderRadius: 11, fontSize: 15, fontWeight: 700, textDecoration: "none" }}>Back to hosting</a>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className={wrap} style={outer}>
        <div style={{ maxWidth: 640, margin: "0 auto", background: C.successSurf, border: `1px solid ${C.successBorder}`, borderRadius: 18, padding: "clamp(28px,4vw,44px)", textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>✓</div>
          <h1 style={{ fontSize: "clamp(26px,4vw,36px)", fontWeight: 800, letterSpacing: "-.03em", marginTop: 8 }}>Trial request received.</h1>
          <p style={{ marginTop: 14, fontSize: 17, lineHeight: 1.55, color: C.ink2 }}>
            We&apos;ll set up your <strong>{HOSTING_TIERS.find((t) => t.name.toLowerCase() === plan)?.name || "hosting"}</strong> cPanel
            account and email your login to <strong>{email}</strong> within a few hours — and WhatsApp you on {phone}.
            <strong> No credit card is charged.</strong> Your {TRIAL_DAYS} free days start once the account is ready.
          </p>
          <p style={{ marginTop: 14, fontSize: 15, color: C.muted }}>
            Moving from another host? Reply to that email with your current login and the migration is free — your old site stays live until you approve the switch.
          </p>
          <a href="/hosting" style={{ display: "inline-block", marginTop: 22, background: C.ink, color: C.paper, padding: "14px 24px", borderRadius: 11, fontSize: 15, fontWeight: 700, textDecoration: "none" }}>Back to hosting</a>
        </div>
      </div>
    );
  }

  return (
    <div className={wrap} style={outer}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div style={{ fontFamily: "var(--htf-sans)", fontSize: 12.5, fontWeight: 700, letterSpacing: ".08em", color: C.accent, textTransform: "uppercase" }}>{TRIAL_DAYS}-day free trial · no card</div>
        <h1 style={{ fontSize: "clamp(28px,4.4vw,42px)", lineHeight: 1.1, letterSpacing: "-.035em", fontWeight: 800, marginTop: 10 }}>
          Start your hosting trial. <span style={{ fontFamily: "var(--htf-serif), serif", fontStyle: "italic", fontWeight: 400, color: C.accent }}>No card needed.</span>
        </h1>
        <p style={{ marginTop: 12, fontSize: 16.5, lineHeight: 1.55, color: C.ink2 }}>
          Tell us a little about your website and we&apos;ll set up a free {TRIAL_DAYS}-day cPanel account for you. We do the migration; your old host stays live until you approve the move.
        </p>

        <form onSubmit={submit} style={{ marginTop: 28, background: C.card, border: `1px solid ${C.line}`, borderRadius: 18, padding: "clamp(20px,3vw,30px)" }}>
          {/* Plan */}
          {field(
            <>
              <span style={label}>Which plan?</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8 }}>
                {HOSTING_TIERS.map((t) => {
                  const id = t.name.toLowerCase();
                  const active = plan === id;
                  return (
                    <button type="button" key={id} onClick={() => setPlan(id)}
                      style={{ padding: "12px 8px", borderRadius: 11, cursor: "pointer", textAlign: "center",
                        border: `1.5px solid ${active ? C.accent : C.line}`, background: active ? C.accSurf : C.card,
                        color: active ? C.accentDark : C.ink2 }}>
                      <div style={{ fontSize: 14.5, fontWeight: 800 }}>{t.name}</div>
                      <div style={{ fontSize: 12, color: active ? C.accentDark : C.muted, marginTop: 2 }}>₹{t.yearlyMo}/mo</div>
                    </button>
                  );
                })}
              </div>
            </>,
          )}

          {field(<><span style={label}>Company / website name *</span><input style={input} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Sharma Traders" /></>)}
          {field(<><span style={label}>Your name *</span><input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pardeep Sharma" /></>)}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16 }}>
            {field(<><span style={label}>Work email *</span><input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompany.in" /></>)}
            {field(<><span style={label}>Phone / WhatsApp *</span><input style={input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98xxx xxxxx" /></>)}
          </div>

          {/* Domain */}
          {field(
            <>
              <span style={label}>Your website domain</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                {([["have", "I already have one"], ["need", "I need a new domain"]] as const).map(([v, t]) => {
                  const active = domainStatus === v;
                  return (
                    <button type="button" key={v} onClick={() => setDomainStatus(v)}
                      style={{ padding: "10px 14px", borderRadius: 999, cursor: "pointer", fontSize: 14, fontWeight: 700,
                        border: `1.5px solid ${active ? C.accent : C.line}`, background: active ? C.accSurf : C.card, color: active ? C.accentDark : C.ink2 }}>{t}</button>
                  );
                })}
              </div>
              {domainStatus === "have" && <input style={input} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. yourcompany.in" />}
              {domainStatus === "need" && <p style={{ fontSize: 13.5, color: C.muted, margin: 0 }}>No problem — we&apos;ll help you pick and register one.</p>}
            </>,
          )}

          {field(<><span style={label}>Anything we should know? (optional)</span><textarea style={{ ...input, minHeight: 84, resize: "vertical" }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Current host, deadline, questions…" /></>)}

          {error && <div style={{ marginBottom: 14, background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", borderRadius: 11, padding: "11px 14px", fontSize: 14 }}>{error}</div>}

          <button type="submit" disabled={submitting}
            style={{ width: "100%", background: submitting ? C.muted : C.accent, color: "#fff", padding: "16px", borderRadius: 12, fontSize: 16, fontWeight: 700, border: 0, cursor: submitting ? "default" : "pointer", minHeight: 54 }}>
            {submitting ? "Starting your trial…" : `Start my ${TRIAL_DAYS}-day free trial`}
          </button>
          <p style={{ marginTop: 12, fontSize: 13, color: C.muted, textAlign: "center" }}>No credit card · we set up the account and email your login · GST invoice when you convert.</p>
        </form>
      </div>
    </div>
  );
}
