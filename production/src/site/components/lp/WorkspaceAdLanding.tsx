"use client";

/**
 * Google Ads landing page — Google Workspace (R-139, 4 Oct 2026).
 *
 * Layout and copy follow Pardeep's brief (Google_Workspace_Landing_Page_1.zip): own small
 * header, hero with photo, apps strip, benefits beside the offer card, trust, final CTA,
 * footer, and an enquiry modal. What the audit changed, and why:
 *   • PRICE from the live catalogue (₹270/user/month = ₹3,240/year, Business Starter) — the
 *     brief's "₹3,080 our price / ₹3,240 Google price / save ₹160" used the WHOLESALE cost as
 *     the selling price. No strike-through: we sell at Google's list price.
 *   • The FORM creates the lead in the app first (with the ad's gclid/utm), then offers
 *     WhatsApp. The brief only opened WhatsApp, so a visitor without it was a lost lead and
 *     no ad could be credited.
 *   • PHOTO cropped: the original carried cut-off text at the edge and a baked-in
 *     "24/7 Support" claim (support is Mon–Sat 10–19).
 *   • Real Gmail / Drive / Meet / Calendar icons instead of letters.
 *   • BUY NOW opens the same form while online Workspace checkout is paused (Pardeep,
 *     4 Oct 2026, until all prices are in the catalogue). Flip BUY_ONLINE to send it to
 *     checkout.
 * Copy is a prop so the 3–4 ad variants reuse this component.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { buyWorkspaceHref } from "@/lib/checkout/buy-link";
import { WHATSAPP_NUMBER, WHATSAPP_READY, COMPANY } from "@/site/lib/config";
import { useTurnstile } from "@/components/shared/turnstile";
import { pickAdParams, withAdParams, rememberLanding } from "@/site/lib/ad-attribution";

/** Online checkout for Workspace — off until every edition's price is confirmed (see header). */
const BUY_ONLINE = false;

export interface WorkspaceAdCopy {
  eyebrow: string;
  h1Rest: string;
  h2: string;
  sub: string;
}
export const DEFAULT_COPY: WorkspaceAdCopy = {
  eyebrow: "Authorised Google Workspace Reseller",
  h1Rest: "Workspace for Your Business",
  h2: "Business ko banaye Smart, Secure & Professional!",
  sub: "Gmail, Drive, Meet, Docs aur bahut kuch — sab ek hi platform par. Work smarter, collaborate better, grow faster.",
};

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const PHONE_SHOWN = WHATSAPP_NUMBER.replace(/^91/, "");
const waLink = (text: string) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;

const APPS: { name: string; what: string; icon?: string; tile?: { bg: string; label: string } }[] = [
  { name: "Gmail", what: "Business Email", icon: "/ic-gmail.png" },
  { name: "Drive", what: "Cloud Storage", icon: "/ic-drive.png" },
  { name: "Meet", what: "Video Meetings", icon: "/ic-meet.png" },
  { name: "Docs", what: "Create & Collaborate", tile: { bg: "#4285F4", label: "D" } },
  { name: "Sheets", what: "Work Together", tile: { bg: "#34A853", label: "S" } },
  { name: "Slides", what: "Present Ideas", tile: { bg: "#F9AB00", label: "P" } },
  { name: "Calendar", what: "Stay Organised", icon: "/ic-calendar.png" },
];
const BENEFITS = [
  ["Professional email", "you@yourcompany.com — apne domain par"],
  ["Secure & reliable", "Google ki business-grade security"],
  ["Easy collaboration", "Kahin se bhi saath kaam karein"],
  ["Har device par", "Desktop, mobile aur tablet"],
] as const;

export function WorkspaceAdLanding({
  annualPerSeatMo, copy = DEFAULT_COPY,
}: {
  /** Business Starter, ₹ per user per month on the yearly plan (live catalogue). */
  annualPerSeatMo: number;
  copy?: WorkspaceAdCopy;
}) {
  const [ad, setAd] = useState<URLSearchParams>(new URLSearchParams());
  const [landing, setLanding] = useState("");
  const [modal, setModal] = useState<null | "buy" | "trial">(null);

  useEffect(() => {
    let store: Storage | null = null;
    try { store = window.sessionStorage; } catch { store = null; }
    const first = rememberLanding(window.location.href, store);
    setLanding(first);
    setAd(pickAdParams(first.includes("?") ? first.slice(first.indexOf("?")) : ""));
  }, []);

  const checkoutHref = useMemo(() => withAdParams(buyWorkspaceHref("GW Business Starter", 5) ?? "/buy/workspace", ad), [ad]);
  const yearly = annualPerSeatMo * 12;
  const wa = waLink("Hello ANUTECH, mujhe Google Workspace chahiye.");

  const BuyButton = ({ className = "" }: { className?: string }) =>
    BUY_ONLINE
      ? <a className={`gw-btn gw-buy ${className}`} href={checkoutHref}>Buy Now <span aria-hidden>→</span></a>
      : <button type="button" className={`gw-btn gw-buy ${className}`} onClick={() => setModal("buy")}>Buy Now <span aria-hidden>→</span></button>;
  const TrialButton = ({ className = "" }: { className?: string }) =>
    <button type="button" className={`gw-btn gw-trial ${className}`} onClick={() => setModal("trial")}>Start 14-Day Free Trial <span aria-hidden>→</span></button>;

  return (
    <div className="gw">
      <style>{CSS}</style>

      <header className="gw-top">
        <div className="gw-wrap gw-nav">
          <a href="#top" aria-label="ANUTECH Digital"><img src="/lp/anutech-logo.png" alt="ANUTECH Digital Pvt Ltd" className="gw-logo" width={210} height={70} /></a>
          <div className="gw-nav-actions">
            {WHATSAPP_READY && <a className="gw-mini" href={wa} target="_blank" rel="noopener">WhatsApp</a>}
            <a className="gw-mini gw-mini-primary" href="#offer">View Offer</a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="gw-hero">
          <div className="gw-wrap gw-hero-grid">
            <div>
              <span className="gw-eyebrow">✓ {copy.eyebrow}</span>
              <h1 className="gw-h1"><span className="gw-google">Google</span> {copy.h1Rest}</h1>
              <h2 className="gw-h2">{copy.h2}</h2>
              <p className="gw-copy">{copy.sub}</p>
              <div className="gw-buttons">
                <BuyButton />
                <TrialButton />
                {WHATSAPP_READY && <a className="gw-btn gw-wa" href={wa} target="_blank" rel="noopener">WhatsApp {PHONE_SHOWN}</a>}
              </div>
              <p className="gw-note">Business email · Cloud storage · Video meetings · {COMPANY.partnerLine}</p>
            </div>
            <div className="gw-visual">
              <img className="gw-photo" src="/lp/gw-hero.jpg" alt="A business owner working on Google Workspace" width={400} height={458} />
              <div className="gw-float">Grow your business with Google<small>Secure · Collaborative · Productive</small></div>
            </div>
          </div>
        </section>

        <section className="gw-wrap gw-apps-sec">
          <ul className="gw-apps" aria-label="Google Workspace apps">
            {APPS.map((a) => (
              <li key={a.name}>
                {a.icon
                  ? <img src={a.icon} alt="" width={44} height={44} />
                  : <span className="gw-tile" style={{ background: a.tile!.bg }} aria-hidden>{a.tile!.label}</span>}
                <b>{a.name}</b><span>{a.what}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="gw-wrap gw-offer" id="offer">
          <div className="gw-card gw-benefits">
            <div className="gw-kicker">Why Google Workspace?</div>
            <h3 className="gw-h3">Everything your business needs, in one place.</h3>
            <p className="gw-copy">Email, files, meetings aur roz ka kaam — ek simple, secure jagah par.</p>
            <ul className="gw-blist">
              {BENEFITS.map(([t, l]) => (
                <li key={t}><span className="gw-check" aria-hidden>✓</span><span><b>{t}</b><small>{l}</small></span></li>
              ))}
            </ul>
          </div>

          <aside className="gw-card gw-pricing" aria-label="Price">
            <div className="gw-tag">Business Starter</div>
            <div className="gw-price">{inr(annualPerSeatMo)}<small> per user / month</small></div>
            <div className="gw-year">{inr(yearly)} per user / year · + 18% GST (input credit milta hai)</div>
            <ul className="gw-incl">
              <li>30 GB per user · custom email</li>
              <li>Setup, domain aur migration help included</li>
              <li>GST invoice · {COMPANY.partnerLine}</li>
            </ul>
            <div className="gw-price-actions">
              <BuyButton className="gw-full" />
              <TrialButton className="gw-full" />
              {WHATSAPP_READY && <a className="gw-btn gw-wa gw-full" href={waLink("Hello ANUTECH, mujhe Google Workspace kharidna hai.")} target="_blank" rel="noopener">Call / WhatsApp {PHONE_SHOWN}</a>}
            </div>
            <p className="gw-secure">Easy setup · Expert support · Local support in India</p>
          </aside>
        </section>

        <section className="gw-wrap gw-trust">
          {[["🛡️", "Secure & Reliable", "Built for business productivity"], ["⚙️", "Easy Setup", "Hum aapke domain par chalu karte hain"], ["🎧", "Expert Support", COMPANY.hours]].map(([i, t, l]) => (
            <div key={t} className="gw-card gw-trust-card"><span aria-hidden className="gw-ticon">{i}</span><b>{t}</b><small>{l}</small></div>
          ))}
        </section>

        <section className="gw-wrap gw-final">
          <div className="gw-cta">
            <div>
              <h3 className="gw-h3">Ready to make your business smarter?</h3>
              <p>Google Workspace shuru karein — ANUTECH Digital har kadam par saath.</p>
            </div>
            <div className="gw-cta-actions">
              <BuyButton />
              <TrialButton />
              {WHATSAPP_READY && <a className="gw-btn gw-wa" href={wa} target="_blank" rel="noopener">WhatsApp</a>}
            </div>
          </div>
        </section>
      </main>

      <footer className="gw-foot">
        <div className="gw-wrap gw-foot-row">
          <b>ANUTECH DIGITAL PVT LTD</b>
          <span>Google Workspace solutions{WHATSAPP_READY ? ` · Call / WhatsApp: ${PHONE_SHOWN}` : ""} · {COMPANY.supportEmail}</span>
        </div>
      </footer>

      {modal && <EnquiryModal kind={modal} landing={landing} onClose={() => setModal(null)} />}
    </div>
  );
}

function EnquiryModal({ kind, landing, onClose }: { kind: "buy" | "trial"; landing: string; onClose: () => void }) {
  const ts = useTurnstile();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState<{ name: string; users: number } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && card.current) {        // keep focus inside the dialog
        const f = card.current.querySelectorAll<HTMLElement>("button, input, a[href]");
        if (!f.length) return;
        const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ts.ready) { setErr("Ek second — spam check chal raha hai"); setState("error"); return; }
    const f = new FormData(e.currentTarget);
    const users = Math.max(1, Math.min(300, Number(f.get("users")) || 1));
    const body = {
      fullName: String(f.get("fullName") ?? "").trim(),
      companyName: String(f.get("companyName") ?? "").trim(),
      email: String(f.get("email") ?? "").trim(),
      phone: String(f.get("phone") ?? "").trim(),
      seats: users,
      tierId: "starter",
      billing: "annual",
      message: kind === "buy" ? "Google Ads landing page: wants to BUY Business Starter" : "Google Ads landing page: 14-day free trial request",
      pageUrl: landing || window.location.href,
      pageReferrer: document.referrer || undefined,
    };
    setState("sending"); setErr("");
    try {
      const res = await fetch("/api/public/enquiry/workspace", {
        method: "POST", headers: { "Content-Type": "application/json", ...ts.headers }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : "Request nahi gayi");
      }
      setSent({ name: body.fullName, users }); setState("done");
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Request nahi gayi"); setState("error");
    }
  }

  return (
    <div className="gw-modal" role="dialog" aria-modal="true" aria-labelledby="gw-modal-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="gw-modal-card" ref={card}>
        <button type="button" className="gw-close" aria-label="Close" onClick={onClose}>×</button>
        {state === "done" && sent ? (
          <div role="status">
            <div className="gw-kicker">Request mil gayi</div>
            <h3 id="gw-modal-title" className="gw-h3">Shukriya, {sent.name.split(" ")[0]}!</h3>
            <p className="gw-copy">Hamari team {COMPANY.hours} ke beech aapko call karegi. Email par confirmation bhi aa raha hai.</p>
            {WHATSAPP_READY && (
              <a className="gw-btn gw-wa gw-full" target="_blank" rel="noopener"
                href={waLink(`Hello ANUTECH, I am ${sent.name}. I want Google Workspace for ${sent.users} users.`)}>
                Abhi WhatsApp par baat karein
              </a>
            )}
          </div>
        ) : (
          <>
            <div className="gw-kicker">{kind === "buy" ? "Buy Google Workspace" : "14-day free trial"}</div>
            <h3 id="gw-modal-title" className="gw-h3">{kind === "buy" ? "Apni details dijiye" : "Free trial shuru karein"}</h3>
            <p className="gw-copy">{kind === "buy" ? "Hamari team aaj hi call karke aapke domain par setup karegi." : "Koi card nahi chahiye. Hum aapke domain par trial chalu karenge."}</p>
            <form className="gw-form" onSubmit={submit}>
              <label>Name<input ref={first} name="fullName" required minLength={2} autoComplete="name" /></label>
              <label>Company name<input name="companyName" required minLength={2} autoComplete="organization" /></label>
              <label>Email<input name="email" type="email" required autoComplete="email" /></label>
              <label>Mobile number<input name="phone" type="tel" required minLength={10} inputMode="tel" autoComplete="tel" /></label>
              <label>Number of users<input name="users" type="number" min={1} max={300} defaultValue={5} /></label>
              {ts.widget}
              {state === "error" && <p className="gw-err" role="alert">{err} — dobara try karein.</p>}
              <button type="submit" className="gw-btn gw-trial gw-full" disabled={state === "sending"}>
                {state === "sending" ? "Bhej rahe hain…" : "Submit enquiry →"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

const CSS = `
.gw{--blue:#0b57d0;--ink:#172b4d;--muted:#5b6a83;--line:#e7edf7;--bg:#f7fbff;--shadow:0 18px 50px rgba(16,42,86,.12);
  font-family:var(--font-sans),Archivo,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;overflow-x:hidden}
.gw *{box-sizing:border-box}
.gw img{max-width:100%;height:auto}
.gw a{color:inherit;text-decoration:none}
.gw-wrap{width:min(1180px,calc(100% - 32px));margin:0 auto}
.gw-top{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}
.gw-nav{min-height:72px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.gw-logo{width:190px;height:auto;display:block}
.gw-nav-actions{display:flex;gap:8px}
.gw .gw-mini{padding:10px 15px;border-radius:999px;font-weight:800;border:1px solid var(--line);background:#fff;font-size:14px;white-space:nowrap}
.gw .gw-mini-primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.gw-hero{padding:48px 0 24px;background:radial-gradient(circle at 88% 8%,rgba(66,133,244,.16),transparent 34%),linear-gradient(180deg,#fff,#f5faff)}
.gw-hero-grid{display:grid;grid-template-columns:1.05fr .95fr;align-items:center;gap:40px}
.gw-hero-grid>*{min-width:0}
.gw-eyebrow{display:inline-flex;gap:8px;padding:8px 13px;border:1px solid #dbe8ff;border-radius:999px;background:#fff;color:var(--blue);font-weight:800;font-size:13px}
.gw-h1{font-size:clamp(40px,5.4vw,70px);line-height:1;letter-spacing:-.04em;margin:18px 0;color:#15294f;text-wrap:balance}
.gw-google{background:linear-gradient(90deg,#4285f4 0 28%,#ea4335 28% 43%,#fbbc05 43% 57%,#34a853 57% 73%,#4285f4 73%);-webkit-background-clip:text;background-clip:text;color:transparent}
.gw-h2{font-size:clamp(22px,2.6vw,32px);line-height:1.15;margin:0 0 14px;color:#1647a3;text-wrap:balance}
.gw-h3{font-size:clamp(26px,3vw,38px);line-height:1.1;margin:8px 0 10px;text-wrap:balance}
.gw-copy{font-size:17px;color:var(--muted);max-width:62ch;margin:0}
.gw-buttons{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
.gw .gw-btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:54px;padding:0 22px;border-radius:14px;font-weight:800;font-size:16px;border:0;cursor:pointer;box-shadow:0 8px 22px rgba(11,87,208,.12);font-family:inherit;transition:transform .2s,box-shadow .2s}
.gw .gw-btn:hover{transform:translateY(-2px)}
.gw .gw-btn:focus-visible,.gw .gw-mini:focus-visible,.gw-close:focus-visible{outline:3px solid #0a3d91;outline-offset:2px}
.gw .gw-buy{background:linear-gradient(135deg,#ff3b30,#d81b2a);color:#fff}
.gw .gw-trial{background:linear-gradient(135deg,#0b57d0,#3f7fe8);color:#fff}
.gw .gw-wa{background:#15803d;color:#fff}
.gw .gw-full{width:100%}
.gw .gw-btn[disabled]{opacity:.6;cursor:default;transform:none}
.gw-note{margin-top:12px;font-size:13px;color:#6b7a92}
.gw-visual{position:relative}
.gw-photo{width:100%;aspect-ratio:1.18/1;object-fit:cover;object-position:center 20%;border-radius:32px;display:block;box-shadow:var(--shadow);border:8px solid rgba(255,255,255,.9)}
.gw-float{position:absolute;left:-16px;bottom:22px;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow);border-radius:18px;padding:14px 18px;font-weight:800}
.gw-float small{display:block;color:var(--muted);font-weight:500;margin-top:2px}
.gw-apps-sec{padding:18px 0 32px}
.gw-apps{list-style:none;margin:0;padding:0;background:#fff;border:1px solid var(--line);box-shadow:0 10px 30px rgba(16,42,86,.07);border-radius:24px;display:grid;grid-template-columns:repeat(7,1fr);overflow:hidden}
.gw-apps li{padding:18px 8px;text-align:center;border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.gw-apps li:last-child{border-right:0}
.gw-apps b{font-size:14px}.gw-apps span{color:var(--muted);font-size:12px}
.gw-apps .gw-tile{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:900;font-size:18px}
.gw-offer{display:grid;grid-template-columns:1fr .75fr;gap:22px;padding:16px 0 64px;align-items:stretch}
.gw-card{background:#fff;border:1px solid var(--line);border-radius:26px;box-shadow:var(--shadow);min-width:0}
.gw-benefits{padding:30px}
.gw-kicker{color:var(--blue);font-weight:900;text-transform:uppercase;letter-spacing:.12em;font-size:12px}
.gw-blist{list-style:none;margin:22px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.gw-blist li{display:flex;gap:12px;padding:15px;border:1px solid var(--line);border-radius:18px;background:#fbfdff}
.gw-blist b{display:block}.gw-blist small{font-size:13px;color:var(--muted)}
.gw-check{width:36px;height:36px;flex:0 0 36px;border-radius:50%;display:grid;place-items:center;background:#e9f7ee;color:#0a7a35;font-weight:900}
.gw-pricing{padding:28px;display:flex;flex-direction:column;background:linear-gradient(160deg,#fff,#f2f8ff)}
.gw-tag{align-self:flex-start;background:#d81b2a;color:#fff;font-weight:900;padding:7px 14px;border-radius:999px;margin-bottom:12px;font-size:14px}
.gw-price{font-size:clamp(46px,6vw,64px);font-weight:900;letter-spacing:-.04em;color:var(--blue);line-height:1;font-variant-numeric:tabular-nums}
.gw-price small{font-size:16px;letter-spacing:0;color:#51627d;font-weight:700}
.gw-year{margin-top:8px;font-size:14px;color:var(--muted)}
.gw-incl{margin:16px 0 20px;padding-left:18px;color:var(--ink);font-size:15px;display:grid;gap:4px}
.gw-price-actions{display:grid;gap:10px}
.gw-secure{margin:14px 0 0;text-align:center;color:#6c7a91;font-size:13px}
.gw-trust{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;padding-bottom:64px}
.gw-trust-card{padding:22px;text-align:center;display:grid;gap:4px}
.gw-ticon{font-size:26px}.gw-trust-card small{font-size:13px;color:var(--muted)}
.gw-final{padding-bottom:64px}
.gw-cta{background:linear-gradient(135deg,#0b57d0,#0d75e8);border-radius:30px;color:#fff;padding:40px;display:flex;align-items:center;justify-content:space-between;gap:28px;box-shadow:0 22px 60px rgba(11,87,208,.25)}
.gw-cta p{margin:0;color:#dbeaff}
.gw-cta-actions{display:flex;flex-wrap:wrap;gap:10px}
.gw .gw-cta .gw-buy,.gw .gw-cta .gw-trial{background:#fff;color:#0b57d0}
.gw-foot{background:#0d2348;color:#cdd9ee;padding:28px 0}
.gw-foot b{color:#fff}
.gw-foot-row{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;font-size:13px}
.gw-modal{position:fixed;inset:0;background:rgba(6,22,48,.6);display:grid;place-items:center;padding:16px;z-index:100}
.gw-modal-card{width:min(520px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#fff;border-radius:24px;padding:28px;box-shadow:0 30px 90px rgba(0,0,0,.25);position:relative}
.gw-close{position:absolute;right:14px;top:12px;border:0;background:#f0f4fa;width:36px;height:36px;border-radius:50%;font-size:20px;cursor:pointer}
.gw-form{display:grid;gap:12px;margin-top:16px}
.gw-form label{display:grid;gap:4px;font-size:13px;font-weight:700}
.gw-form input{width:100%;min-height:46px;padding:0 14px;border:1px solid #c9d3e3;border-radius:12px;font:inherit;font-size:16px}
.gw-form input:focus-visible{outline:3px solid #0b57d0;outline-offset:1px}
.gw-err{color:#b42318;font-size:14px;margin:0}
@media(max-width:900px){
  .gw-hero-grid,.gw-offer{grid-template-columns:1fr}
  .gw-visual{max-width:640px}
  .gw-apps{grid-template-columns:repeat(4,1fr)}
  .gw-apps li:nth-child(4){border-right:0}.gw-apps li:nth-child(n+5){border-top:1px solid var(--line)}
  .gw-blist{grid-template-columns:1fr}
  .gw-cta{flex-direction:column;align-items:flex-start}
}
@media(max-width:600px){
  .gw-wrap{width:calc(100% - 24px)}
  .gw-logo{width:140px}
  .gw .gw-mini{padding:8px 11px;font-size:12px}
  .gw-hero{padding:28px 0 14px}
  .gw-buttons,.gw-cta-actions{display:grid;width:100%}
  .gw .gw-btn{width:100%}
  .gw-float{left:12px;bottom:12px;font-size:13px}
  .gw-photo{border-width:5px;border-radius:24px}
  .gw-apps{grid-template-columns:repeat(2,1fr)}
  .gw-apps li{border-right:1px solid var(--line)!important}.gw-apps li:nth-child(even){border-right:0!important}
  .gw-apps li:nth-child(n+3){border-top:1px solid var(--line)}
  .gw-benefits,.gw-pricing{padding:22px}
  .gw-trust{grid-template-columns:1fr}
  .gw-cta{padding:26px;border-radius:24px}
}
@media(prefers-reduced-motion:reduce){.gw .gw-btn{transition:none}.gw .gw-btn:hover{transform:none}}
`;
