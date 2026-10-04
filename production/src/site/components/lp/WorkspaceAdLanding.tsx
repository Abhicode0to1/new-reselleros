"use client";

/**
 * Google Ads landing page — Google Workspace (R-139, 4 Oct 2026).
 *
 * Built from Pardeep's poster: hero → the apps → five benefits beside the price → trust →
 * free-trial form → Anutech band. One job: turn an ad click into a lead or a sale.
 *
 * Rules this page keeps (they are why it differs from the poster in places):
 *   • PRICE comes from the live catalogue (the same number checkout charges). No "Google
 *     price" strike-through until a real Google list price is supplied — an ad page that
 *     shows a price the checkout does not honour breaks Google Ads policy and trust.
 *   • WHATSAPP / CALL shows only when the real number is configured (WHATSAPP_READY, R-078);
 *     until then the trial form is the primary action.
 *   • ATTRIBUTION: the first ad URL of the visit (gclid / utm) travels with the form as
 *     `pageUrl` and onto the Buy link, so the lead records which ad brought it.
 * Variations later (3–4) reuse this component with different copy props.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "@/site/components/ui/SiteLink";
import { buyWorkspaceHref } from "@/lib/checkout/buy-link";
import { WHATSAPP_URL, WHATSAPP_READY, COMPANY } from "@/site/lib/config";
import { useTurnstile } from "@/components/shared/turnstile";
import { pickAdParams, withAdParams, rememberLanding } from "@/site/lib/ad-attribution";

export interface WorkspaceAdCopy {
  /** Two-line headline; the second line gets the yellow underline. */
  headline: [string, string];
  sub: string;
}

export const DEFAULT_COPY: WorkspaceAdCopy = {
  headline: ["Business ko banaye", "Smart & Professional!"],
  sub: "Professional email, productivity tools aur secure cloud storage — sab ek hi jagah.",
};

const C = {
  ink: "#0C1116", body: "#4A5560", faint: "#8A939E", blue: "#1668E3", blueDk: "#0A47A0",
  green: "#0F7B4F", greenDk: "#0B5E3C", yellow: "#FFD233", border: "#E0E5EC", soft: "#F5F8FD",
};
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

const APPS: { name: string; what: string; icon?: string }[] = [
  { name: "Gmail", what: "Business email", icon: "/ic-gmail.png" },
  { name: "Drive", what: "Cloud storage", icon: "/ic-drive.png" },
  { name: "Meet", what: "Video meetings", icon: "/ic-meet.png" },
  { name: "Calendar", what: "Stay organised", icon: "/ic-calendar.png" },
  { name: "Gemini", what: "AI assistant", icon: "/ic-gemini.png" },
  { name: "Docs · Sheets · Slides", what: "Create together" },
];

const BENEFITS: { title: string; line: string; color: string; path: string }[] = [
  { title: "Professional business email", line: "you@yourcompany.com", color: "#1668E3",
    path: "M4 6h16v12H4z M4 7l8 6 8-6" },
  { title: "Secure & reliable", line: "Google ki business-grade security", color: "#0F7B4F",
    path: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z" },
  { title: "Easy team collaboration", line: "Kahin se bhi saath kaam karein", color: "#D93025",
    path: "M8 11a3 3 0 100-6 3 3 0 000 6z M16 11a3 3 0 100-6 3 3 0 000 6z M2 20c0-3 3-5 6-5s6 2 6 5 M12 20c0-3 3-5 6-5" },
  { title: "Har device par", line: "Desktop, mobile aur tablet", color: "#F29900",
    path: "M7 18a4 4 0 010-8 6 6 0 0111.5 1.5A3.5 3.5 0 0118 18z" },
  { title: "Productivity badhaye", line: "Aapke business ke liye powerful tools", color: "#7B3FE4",
    path: "M5 19V11 M10 19V6 M15 19v-5 M20 19V9" },
];

export function WorkspaceAdLanding({
  annualPerSeatMo, monthlyPerSeatMo, copy = DEFAULT_COPY,
}: {
  /** Business Starter, ₹ per user per month on the yearly plan (live catalogue). */
  annualPerSeatMo: number;
  /** Business Starter flexible monthly rate, or null when not offered. */
  monthlyPerSeatMo: number | null;
  copy?: WorkspaceAdCopy;
}) {
  const [ad, setAd] = useState<URLSearchParams>(new URLSearchParams());
  const [landing, setLanding] = useState<string>("");
  const [seats, setSeats] = useState(5);

  useEffect(() => {
    let store: Storage | null = null;
    try { store = window.sessionStorage; } catch { store = null; }
    const first = rememberLanding(window.location.href, store);
    setLanding(first);
    setAd(pickAdParams(first.includes("?") ? first.slice(first.indexOf("?")) : ""));
  }, []);

  const buyHref = useMemo(
    () => withAdParams(buyWorkspaceHref("GW Business Starter", seats) ?? "/buy/workspace", ad),
    [seats, ad],
  );
  const yearly = annualPerSeatMo * 12;
  const wa = `${WHATSAPP_URL}?text=${encodeURIComponent("Hi Anutech, Google Workspace ke baare mein baat karni hai (ad se aaya hoon).")}`;

  return (
    <div className="lpgw">
      <style>{CSS}</style>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="lpgw-hero">
        <div className="lpgw-wrap lpgw-hero-grid">
          <div>
            <img src="/logo-google-workspace-wordmark.png" alt="Google Workspace" className="lpgw-wordmark" />
            <h1 className="lpgw-h1">
              {copy.headline[0]}<br />
              <span className="lpgw-underline">{copy.headline[1]}</span>
            </h1>
            <p className="lpgw-sub">{copy.sub}</p>
            <div className="lpgw-ctas">
              <a href="#trial" className="lpgw-btn lpgw-btn-primary">14 din free trial shuru karein</a>
              <Link href={buyHref} className="lpgw-btn lpgw-btn-ghost">
                Abhi kharidein · {inr(annualPerSeatMo)}/user/mahina
              </Link>
            </div>
            {WHATSAPP_READY && (
              <a href={wa} target="_blank" rel="noopener" className="lpgw-wa">Call / WhatsApp Now ›</a>
            )}
            <p className="lpgw-fine">{COMPANY.partnerLine} · GST invoice · Hindi/English support</p>
          </div>
          <div className="lpgw-hero-art">
            <div className="lpgw-note">Grow your business with Google ↗</div>
            <img src="/googleworkspace-inbox.png" alt="Gmail inbox on your own company domain" className="lpgw-inbox" />
          </div>
        </div>
      </section>

      {/* ── Apps ───────────────────────────────────────────────────────────── */}
      <section className="lpgw-wrap">
        <ul className="lpgw-apps" aria-label="Google Workspace apps">
          {APPS.map((a) => (
            <li key={a.name}>
              {a.icon ? <img src={a.icon} alt="" width={40} height={40} /> : <span className="lpgw-docs" aria-hidden>D·S·S</span>}
              <b>{a.name}</b>
              <span>{a.what}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Benefits + price ───────────────────────────────────────────────── */}
      <section className="lpgw-wrap lpgw-two">
        <ul className="lpgw-benefits">
          {BENEFITS.map((b) => (
            <li key={b.title}>
              <span className="lpgw-bicon" style={{ background: b.color }} aria-hidden>
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={b.path} /></svg>
              </span>
              <span><b>{b.title}</b><br /><span className="lpgw-muted">{b.line}</span></span>
            </li>
          ))}
        </ul>

        <div className="lpgw-price">
          <div className="lpgw-ribbon">Business Starter</div>
          <div className="lpgw-price-main">
            <span className="lpgw-price-label">Hamara daam</span>
            <span className="lpgw-price-num">{inr(annualPerSeatMo)}</span>
            <span className="lpgw-price-unit">per user / mahina</span>
            <span className="lpgw-price-year">{inr(yearly)} per user / saal · + 18% GST (ITC milta hai)</span>
          </div>
          {monthlyPerSeatMo != null && (
            <p className="lpgw-price-alt">Mahine-mahine chahiye? {inr(monthlyPerSeatMo)}/user/mahina, kabhi bhi band karein.</p>
          )}
          <label className="lpgw-seats">
            Kitne users?
            <input type="number" min={1} max={300} value={seats}
              onChange={(e) => setSeats(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} />
            <span>= {inr(yearly * seats)} / saal + GST</span>
          </label>
          <Link href={buyHref} className="lpgw-btn lpgw-btn-yellow">Abhi kharidein</Link>
          <div className="lpgw-trust">
            <span>Millions of businesses use Google Workspace</span>
            <span>{COMPANY.partnerLine}</span>
            <span>India mein local support</span>
          </div>
        </div>
      </section>

      {/* ── Trial form ─────────────────────────────────────────────────────── */}
      <section id="trial" className="lpgw-trial">
        <div className="lpgw-wrap lpgw-trial-grid">
          <div>
            <h2 className="lpgw-h2">14 din ka <span className="lpgw-underline">free trial</span></h2>
            <p className="lpgw-sub lpgw-on-blue">Details bhariye — hamari team aaj hi call karke aapke domain par Workspace chalu karegi. Koi card nahi chahiye.</p>
            <ul className="lpgw-steps">
              <li>1. Form bhariye (1 minute)</li>
              <li>2. Hum call karke domain jodte hain</li>
              <li>3. Aapki team ka business email chalu</li>
            </ul>
          </div>
          <TrialForm landing={landing} defaultSeats={seats} />
        </div>
      </section>

      {/* ── Anutech band ───────────────────────────────────────────────────── */}
      <section className="lpgw-wrap lpgw-band">
        <img src="/anutech-digital-logo.png" alt="Anutech Digital Pvt Ltd" className="lpgw-logo" />
        <ul>
          <li><b>Easy setup</b><span>Domain, users, purana mail — sab hum karte hain</span></li>
          <li><b>Expert support</b><span>{COMPANY.hours}</span></li>
          <li><b>Authorised reseller</b><span>{COMPANY.partnerLine}</span></li>
        </ul>
      </section>
    </div>
  );
}

function TrialForm({ landing, defaultSeats }: { landing: string; defaultSeats: number }) {
  const ts = useTurnstile();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ts.ready) {
      setErr("Ek second — spam check chal raha hai");
      setState("error");
      return;
    }
    const f = new FormData(e.currentTarget);
    const body = {
      fullName: String(f.get("fullName") ?? "").trim(),
      companyName: String(f.get("companyName") ?? "").trim(),
      email: String(f.get("email") ?? "").trim(),
      phone: String(f.get("phone") ?? "").trim(),
      seats: Number(f.get("seats") ?? 1) || 1,
      tierId: "starter",
      billing: "annual",
      message: "Google Ads landing page: 14-day free trial request",
      pageUrl: landing || window.location.href,
      pageReferrer: document.referrer || undefined,
    };
    setState("sending"); setErr("");
    try {
      const res = await fetch("/api/public/enquiry/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ts.headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : "Request nahi gayi");
      }
      setState("done");
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Request nahi gayi");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="lpgw-form lpgw-done" role="status">
        <b>Shukriya! Request mil gayi.</b>
        <p>Hamari team {COMPANY.hours} ke beech aapko call karegi. Email par confirmation bhi aa raha hai.</p>
      </div>
    );
  }
  return (
    <form className="lpgw-form" onSubmit={submit}>
      <label>Aapka naam<input name="fullName" required minLength={2} autoComplete="name" /></label>
      <label>Company ka naam<input name="companyName" required minLength={2} autoComplete="organization" /></label>
      <label>Email<input name="email" type="email" required autoComplete="email" /></label>
      <label>Mobile<input name="phone" type="tel" required minLength={10} autoComplete="tel" inputMode="tel" /></label>
      <label>Kitne users<input name="seats" type="number" min={1} max={300} defaultValue={defaultSeats} /></label>
      {ts.widget}
      {state === "error" && <p className="lpgw-err" role="alert">{err} — dobara try karein.</p>}
      <button type="submit" className="lpgw-btn lpgw-btn-yellow" disabled={state === "sending"}>
        {state === "sending" ? "Bhej rahe hain…" : "Free trial shuru karein"}
      </button>
      <p className="lpgw-fine">Bhejne par aap {COMPANY.short} ki call/email ke liye haan kehte hain. Koi spam nahi.</p>
    </form>
  );
}

const CSS = `
.lpgw{color:${C.ink};font-family:var(--font-sans),Archivo,system-ui,sans-serif;background:#fff}
.lpgw img{max-width:100%}
.lpgw-wrap{max-width:1120px;margin:0 auto;padding-inline:16px}
.lpgw-hero{background:linear-gradient(180deg,#F5F8FD,#fff);padding-block:32px 24px}
.lpgw-hero-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:32px;align-items:center}
.lpgw-wordmark{height:44px;width:auto;margin-bottom:16px}
.lpgw-h1{font-size:clamp(30px,4.6vw,52px);line-height:1.08;font-weight:800;letter-spacing:-.02em;margin:0 0 14px;text-wrap:balance}
.lpgw-h2{font-size:clamp(26px,3.4vw,38px);line-height:1.1;font-weight:800;margin:0 0 10px;color:#fff}
.lpgw-underline{background:linear-gradient(transparent 72%,${C.yellow} 72%,${C.yellow} 92%,transparent 92%)}
.lpgw-sub{font-size:18px;line-height:1.5;color:${C.body};max-width:52ch;margin:0 0 20px}
.lpgw-on-blue{color:#DCE8FB}
.lpgw-ctas{display:flex;flex-wrap:wrap;gap:12px}
.lpgw-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border-radius:999px;font-weight:700;font-size:16px;text-decoration:none;border:0;cursor:pointer}
.lpgw-btn:focus-visible{outline:3px solid ${C.blueDk};outline-offset:2px}
.lpgw a.lpgw-btn-primary,.lpgw .lpgw-btn-primary{background:linear-gradient(180deg,${C.blue},${C.blueDk});color:#fff;box-shadow:0 12px 26px -16px rgba(22,104,227,.7)}
.lpgw a.lpgw-btn-ghost{background:#fff;color:${C.blueDk};border:2px solid ${C.blue}}
.lpgw a.lpgw-btn-yellow,.lpgw .lpgw-btn-yellow{background:${C.yellow};color:${C.ink};width:100%}
.lpgw-btn[disabled]{opacity:.6;cursor:default}
.lpgw a.lpgw-wa{display:inline-flex;margin-top:12px;min-height:48px;align-items:center;padding:0 22px;border-radius:999px;background:#1F9D55;color:#fff;font-weight:700;text-decoration:none}
.lpgw-fine{font-size:13px;color:${C.faint};margin-top:12px}
.lpgw-hero-art{position:relative}
.lpgw-inbox{border-radius:16px;box-shadow:0 30px 60px -36px rgba(12,17,22,.45);border:1px solid ${C.border}}
.lpgw-note{position:absolute;top:-14px;right:8px;transform:rotate(3deg);background:#FFF4C2;padding:10px 14px;font-weight:700;font-size:15px;box-shadow:0 10px 20px -14px rgba(0,0,0,.4);z-index:1}
.lpgw-apps{list-style:none;margin:8px 0 0;padding:16px;display:grid;grid-template-columns:repeat(6,1fr);gap:8px;border:1px solid ${C.border};border-radius:18px;background:#fff;box-shadow:0 12px 30px -26px rgba(12,17,22,.3)}
.lpgw-apps li{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;font-size:13px;color:${C.body}}
.lpgw-apps b{color:${C.ink};font-size:14px}
.lpgw-docs{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#E8F0FE;color:${C.blueDk};font-size:11px;font-weight:800}
.lpgw-two{display:grid;grid-template-columns:1fr 1fr;gap:32px;padding-block:40px;align-items:start}
.lpgw-benefits{list-style:none;margin:0;padding:0;display:grid;gap:18px}
.lpgw-benefits li{display:flex;gap:14px;align-items:center;font-size:17px}
.lpgw-bicon{flex:none;display:grid;place-items:center;width:52px;height:52px;border-radius:50%}
.lpgw-muted{color:${C.body};font-size:15px}
.lpgw-price{border-radius:22px;background:linear-gradient(160deg,${C.green},${C.greenDk});color:#fff;padding:22px;display:grid;gap:14px;box-shadow:0 20px 46px -30px rgba(15,123,79,.75)}
.lpgw-ribbon{justify-self:start;background:#D93025;color:#fff;font-weight:800;padding:6px 14px;border-radius:8px;transform:rotate(-2deg);letter-spacing:.02em;text-transform:uppercase;font-size:14px}
.lpgw-price-main{display:grid;gap:2px}
.lpgw-price-label{font-size:18px;opacity:.9}
.lpgw-price-num{font-size:clamp(48px,7vw,68px);font-weight:900;color:${C.yellow};line-height:1;font-variant-numeric:tabular-nums}
.lpgw-price-unit{font-size:20px;font-weight:700}
.lpgw-price-year{font-size:14px;opacity:.9}
.lpgw-price-alt{margin:0;font-size:14px;opacity:.9}
.lpgw-seats{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:15px;background:rgba(255,255,255,.12);padding:10px 12px;border-radius:12px}
.lpgw-seats input{width:80px;min-height:40px;border-radius:8px;border:0;padding:0 10px;font-size:16px;color:${C.ink}}
.lpgw-trust{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:13px;text-align:center;opacity:.95}
.lpgw-trust span{border-top:1px solid rgba(255,255,255,.25);padding-top:8px}
.lpgw-trial{background:linear-gradient(135deg,${C.blue},${C.blueDk});padding-block:40px}
.lpgw-trial-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:start}
.lpgw-steps{list-style:none;margin:0;padding:0;display:grid;gap:8px;color:#fff;font-weight:600}
.lpgw-form{background:#fff;border-radius:18px;padding:20px;display:grid;gap:12px;box-shadow:0 30px 60px -36px rgba(0,0,0,.5)}
.lpgw-form label{display:grid;gap:4px;font-size:14px;font-weight:600;color:${C.ink}}
.lpgw-form input{min-height:46px;border:1px solid #C6CED8;border-radius:10px;padding:0 12px;font-size:16px}
.lpgw-form input:focus-visible{outline:3px solid ${C.blue};outline-offset:1px}
.lpgw-err{color:#B42318;font-size:14px;margin:0}
.lpgw-done b{font-size:20px;color:${C.green}}
.lpgw-band{display:flex;flex-wrap:wrap;align-items:center;gap:24px;padding-block:28px}
.lpgw-logo{height:56px;width:auto}
.lpgw-band ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:24px;flex:1}
.lpgw-band li{display:grid;font-size:13px;color:${C.body};min-width:160px}
.lpgw-band li b{color:${C.ink};font-size:15px}
@media (max-width:820px){
  .lpgw-hero-grid,.lpgw-two,.lpgw-trial-grid{grid-template-columns:1fr}
  .lpgw-apps{grid-template-columns:repeat(3,1fr)}
  .lpgw-hero-art{max-width:520px}
  .lpgw-wordmark{height:34px}
  .lpgw-btn{width:100%}
}
@media (prefers-reduced-motion:reduce){.lpgw *{transition:none!important}}
`;
