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
import { reportLeadConversion } from "@/site/lib/google-ads";

/** New-customer offer, first year only (Pardeep, 4 Oct 2026). Our cost for a NEW customer
 *  is ₹1,650/user/year, for a renewal ₹3,080 — so the cut is safe in year 1 only, and the page
 *  always says that year 2 renews at the list price. Not in the catalogue: quotes for new
 *  customers are made at this price by the team. */
export const FIRST_YEAR_PER_USER = 2499;

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

/** Free Gmail vs Google Workspace — facts only (Business Starter). */
const COMPARE: [string, string, string][] = [
  ["Email address", "yourname@gmail.com", "you@yourcompany.com"],
  ["Storage", "15 GB, shared with Drive & Photos", "30 GB per user"],
  ["Ads in the inbox", "Yes", "No ads"],
  ["Group video calls", "60-minute limit", "Up to 100 people, long meetings"],
  ["Who owns the account", "The employee", "Your company — add, remove, reset any user"],
  ["Help when stuck", "Online forums", "ANUTECH team + Google support"],
];
const WHY: [string, string][] = [
  ["GST invoice in INR", "Har order par GST invoice — business input credit le sakta hai."],
  ["Setup done for you", "Domain verify, MX records, users — hamari team karti hai."],
  ["Free migration", "Purana mail, folders, contacts aur calendar — hum shift karte hain, kuch nahi chhootta."],
  ["Local support", `Hindi / English mein, phone aur WhatsApp par — ${COMPANY.hours}.`],
];
const FAQ: [string, string][] = [
  ["Mere paas domain nahi hai — kya hoga?", "Koi baat nahi. Hum aapka domain bhi register kar dete hain aur usi par Google Workspace chalu karte hain — ek hi jagah se."],
  ["Purana email (cPanel, Zoho, Outlook) ka kya hoga?", "Free migration: purane mail, folders, contacts aur calendar hum Google Workspace mein shift karte hain. Aapke paas kuch nahi chhootta."],
  ["14 din ke trial ke baad kya hota hai?", "Trial ke baad aap tay karte hain. Jaari rakhna hai to saalana plan lijiye — naye customer ko pehle saal ₹2,499/user (doosre saal se list price); nahi to kuch nahi katega — koi card nahi maanga jaata."],
  ["GST invoice milega?", "Haan, har order par GST invoice milta hai, aur business us par input tax credit le sakta hai."],
  ["Kitne users tak chal sakta hai?", "Business plans 1 se 300 users tak. Users kabhi bhi badha sakte hain."],
];

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
  const [users, setUsers] = useState(5);
  const [exitOffer, setExitOffer] = useState(false);

  /* Desktop only: the pointer leaving through the top of the window is the classic "about to
     close the tab" signal. Shown once per visit, never on phones, never over an open form. */
  useEffect(() => {
    if (window.matchMedia("(max-width: 900px)").matches) return;
    let shown = false;
    try { shown = sessionStorage.getItem("anutech.lp.exit.v1") === "1"; } catch { /* private mode */ }
    if (shown) return;
    const onOut = (e: MouseEvent) => {
      if (e.clientY > 8 || e.relatedTarget) return;
      document.removeEventListener("mouseout", onOut);
      try { sessionStorage.setItem("anutech.lp.exit.v1", "1"); } catch { /* ignore */ }
      setExitOffer(true);
    };
    const t = setTimeout(() => document.addEventListener("mouseout", onOut), 8000);   // not on a quick bounce
    return () => { clearTimeout(t); document.removeEventListener("mouseout", onOut); };
  }, []);
  useEffect(() => {
    if (!exitOffer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExitOffer(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [exitOffer]);

  useEffect(() => {
    let store: Storage | null = null;
    try { store = window.sessionStorage; } catch { store = null; }
    const first = rememberLanding(window.location.href, store);
    setLanding(first);
    setAd(pickAdParams(first.includes("?") ? first.slice(first.indexOf("?")) : ""));
  }, []);

  const checkoutHref = useMemo(() => withAdParams(buyWorkspaceHref("GW Business Starter", 5) ?? "/buy/workspace", ad), [ad]);
  const yearly = annualPerSeatMo * 12;                     // list price = renewal price
  const offerYear = Math.min(FIRST_YEAR_PER_USER, yearly);
  const offerMo = offerYear / 12;
  const offPct = Math.round((1 - offerYear / yearly) * 100);
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
              <ul className="gw-ticks">
                <li>Trial mein koi card nahi</li>
                <li>Setup + migration free</li>
                <li>GST invoice</li>
              </ul>
              <p className="gw-note">Naye customer: pehle saal sirf <b>{inr(offerMo)}/user/mahina</b> (saalana plan) · {COMPANY.partnerLine}</p>
              <CallbackForm landing={landing} />
            </div>
            <div className="gw-visual">
              <aside className="gw-promo" aria-label="Special offer">
                <span className="gw-promo-tag">Naye customer ka offer</span>
                <div className="gw-promo-main">
                  <div className="gw-promo-zero" aria-hidden><b>{offPct}%</b><small>off</small></div>
                  <div>
                    <p className="gw-promo-h">Pehle saal <s>{inr(yearly)}</s> {inr(offerYear)}<span className="gw-promo-unit">/user</span></p>
                    <p className="gw-promo-s">Saath mein <b>FREE setup + email migration</b> — domain, users aur purana mail, sab hamari team karti hai.</p>
                  </div>
                </div>
                <div className="gw-promo-foot">
                  <span>Doosre saal se {inr(yearly)}/user · + GST</span>
                  <button type="button" className="gw-promo-btn" onClick={() => setModal("trial")}>Offer lo <span aria-hidden>→</span></button>
                </div>
              </aside>
              <img className="gw-photo" src="/lp/gw-hero.jpg" alt="A business owner working on Google Workspace" width={400} height={458} fetchPriority="high" decoding="async" />
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

        <section className="gw-wrap gw-sec">
          <div className="gw-kicker">Kaise shuru hota hai</div>
          <h3 className="gw-h3">3 kadam — aur aapki team professional email par</h3>
          <ol className="gw-steps">
            <li><span>1</span><b>Form ya WhatsApp</b><small>Naam aur number dijiye — 1 minute.</small></li>
            <li><span>2</span><b>Hamari call</b><small>Users, domain aur plan tay karte hain — {COMPANY.hours}.</small></li>
            <li><span>3</span><b>Setup hum karte hain</b><small>Domain, users, purana mail — sab shift. Aapki team kaam shuru karti hai.</small></li>
          </ol>
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
            <div className="gw-offer-line"><span className="gw-off-badge">{offPct}% OFF</span> pehle saal · naye customer</div>
            <div className="gw-price">{inr(offerMo)}<small> per user / month</small></div>
            <div className="gw-year"><s>{inr(yearly)}</s> <b>{inr(offerYear)}</b> per user, pehla saal · + 18% GST (input credit milta hai)</div>
            <div className="gw-renew">Doosre saal se {inr(yearly)}/user/saal ({inr(annualPerSeatMo)}/mahina)</div>
            <ul className="gw-incl">
              <li>30 GB per user · custom email</li>
              <li>Setup, domain aur migration help included</li>
              <li>GST invoice · {COMPANY.partnerLine}</li>
            </ul>
            <div className="gw-calc">
              <label htmlFor="gw-users">Kitne users?</label>
              <div className="gw-calc-row">
                <button type="button" aria-label="One user fewer" onClick={() => setUsers((n) => Math.max(1, n - 1))}>−</button>
                <input id="gw-users" type="number" min={1} max={300} value={users}
                  onChange={(e) => setUsers(Math.max(1, Math.min(300, Number(e.target.value) || 1)))} />
                <button type="button" aria-label="One user more" onClick={() => setUsers((n) => Math.min(300, n + 1))}>+</button>
              </div>
              <dl className="gw-calc-out">
                <div><dt>Pehla saal</dt><dd>{inr(offerYear * users)}</dd></div>
                <div><dt>Pehla saal + 18% GST</dt><dd><b>{inr(Math.round(offerYear * users * 1.18))}</b></dd></div>
                <div className="gw-calc-save"><dt>Aapki bachat</dt><dd>{inr((yearly - offerYear) * users)}</dd></div>
                <div><dt>Doosre saal se</dt><dd>{inr(yearly * users)}/saal + GST</dd></div>
              </dl>
            </div>
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

        <section className="gw-wrap gw-sec">
          <div className="gw-kicker">Free Gmail vs Google Workspace</div>
          <h3 className="gw-h3">Business ke liye free Gmail kaafi kyun nahi</h3>
          <div className="gw-table-wrap">
            <table className="gw-table">
              <thead><tr><th scope="col"><span className="gw-sr">Feature</span></th><th scope="col">Free Gmail</th><th scope="col">Google Workspace</th></tr></thead>
              <tbody>
                {COMPARE.map(([k, a, b]) => (
                  <tr key={k}><th scope="row">{k}</th><td data-label="Free Gmail">{a}</td><td data-label="Google Workspace"><span className="gw-yes" aria-hidden>✓</span> {b}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="gw-wrap gw-sec">
          <div className="gw-kicker">Why buy from ANUTECH?</div>
          <h3 className="gw-h3">Google ka product, ANUTECH ka saath</h3>
          <div className="gw-why">
            {WHY.map(([t, l]) => (
              <div key={t} className="gw-card gw-why-card"><b>{t}</b><p>{l}</p></div>
            ))}
          </div>
        </section>

        <section className="gw-wrap gw-sec">
          <div className="gw-kicker">FAQ</div>
          <h3 className="gw-h3">Aksar puchhe jaane wale sawal</h3>
          <div className="gw-faq">
            {FAQ.map(([q, a]) => (
              <details key={q} className="gw-card"><summary>{q}</summary><p>{a}</p></details>
            ))}
          </div>
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

      {exitOffer && !modal && (
        <div className="gw-modal" role="dialog" aria-modal="true" aria-labelledby="gw-exit-title" onClick={(e) => { if (e.target === e.currentTarget) setExitOffer(false); }}>
          <div className="gw-modal-card">
            <button type="button" className="gw-close" aria-label="Close" onClick={() => setExitOffer(false)}>×</button>
            <div className="gw-kicker">Jaane se pehle</div>
            <h3 id="gw-exit-title" className="gw-h3">Ek free call — koi commitment nahi</h3>
            <p className="gw-copy">Naam aur number dijiye. Hum batayenge aapke business ke liye kaunsa plan sahi hai, aur setup kaise hoga.</p>
            <CallbackForm landing={landing} compact />
          </div>
        </div>
      )}

      <div className="gw-sticky" aria-label="Quick actions">
        <button type="button" className="gw-btn gw-buy" onClick={() => { if (BUY_ONLINE) window.location.href = checkoutHref; else setModal("buy"); }}>Buy Now</button>
        <button type="button" className="gw-btn gw-trial" onClick={() => setModal("trial")}>Free Trial</button>
        {WHATSAPP_READY && <a className="gw-btn gw-wa" href={wa} target="_blank" rel="noopener">WhatsApp</a>}
      </div>

      {modal && <EnquiryModal kind={modal} landing={landing} defaultUsers={users} onClose={() => setModal(null)} />}
    </div>
  );
}

/** Two fields — name + mobile — straight into the pipeline (api/public/callback). */
function CallbackForm({ landing, compact = false }: { landing: string; compact?: boolean }) {
  const ts = useTurnstile();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [name, setName] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ts.ready) { setErr("Ek second — spam check chal raha hai"); setState("error"); return; }
    const f = new FormData(e.currentTarget);
    const fullName = String(f.get("fullName") ?? "").trim();
    const phone = String(f.get("phone") ?? "").trim();
    setState("sending"); setErr("");
    try {
      const res = await fetch("/api/public/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ts.headers },
        body: JSON.stringify({ fullName, phone, pageUrl: landing || window.location.href, pageReferrer: document.referrer || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : "Request nahi gayi");
      }
      setName(fullName); setState("done");
      void reportLeadConversion();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Request nahi gayi"); setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className={`gw-cb gw-cb-done${compact ? " gw-cb-compact" : ""}`} role="status">
        <b>Shukriya{name ? `, ${name.split(" ")[0]}` : ""}! Hum jald call karenge.</b>
        <span>{COMPANY.hours}{WHATSAPP_READY ? " · abhi baat karni ho to WhatsApp karein" : ""}</span>
        {WHATSAPP_READY && <a className="gw-btn gw-wa" href={waLink(`Hello ANUTECH, I am ${name}. Mujhe Google Workspace ke liye call chahiye.`)} target="_blank" rel="noopener">WhatsApp {PHONE_SHOWN}</a>}
      </div>
    );
  }
  return (
    <form className={`gw-cb${compact ? " gw-cb-compact" : ""}`} onSubmit={submit} aria-label="Request a call back">
      {!compact && <b className="gw-cb-title">Ya hum aapko call karein — free</b>}
      <div className="gw-cb-row">
        <label className="gw-sr" htmlFor={compact ? "cb-name-x" : "cb-name"}>Your name</label>
        <input id={compact ? "cb-name-x" : "cb-name"} name="fullName" required minLength={2} placeholder="Aapka naam" autoComplete="name" />
        <label className="gw-sr" htmlFor={compact ? "cb-phone-x" : "cb-phone"}>Mobile number</label>
        <input id={compact ? "cb-phone-x" : "cb-phone"} name="phone" type="tel" required minLength={10} inputMode="tel" placeholder="Mobile number" autoComplete="tel" />
        <button type="submit" className="gw-btn gw-trial" disabled={state === "sending"}>{state === "sending" ? "…" : "Call me back"}</button>
      </div>
      {ts.widget}
      {state === "error" && <p className="gw-err" role="alert">{err}</p>}
    </form>
  );
}

function EnquiryModal({ kind, landing, defaultUsers, onClose }: { kind: "buy" | "trial"; landing: string; defaultUsers: number; onClose: () => void }) {
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
      void reportLeadConversion();   // no-op until GOOGLE_ADS_SEND_TO is set
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
              <label>Number of users<input name="users" type="number" min={1} max={300} defaultValue={defaultUsers} /></label>
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
  font-family:var(--font-sans),Archivo,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);line-height:1.55;overflow-x:clip}
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
.gw-visual{position:relative;display:grid;gap:18px}
.gw-promo{position:relative;overflow:hidden;color:#fff;border-radius:24px;padding:18px 20px;background:linear-gradient(135deg,#0b57d0 0%,#1a73e8 55%,#34a853 130%);box-shadow:0 18px 40px rgba(11,87,208,.28)}
.gw-promo::after{content:"";position:absolute;right:-40px;top:-40px;width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.12)}
.gw-promo-tag{display:inline-block;background:#fbbc04;color:#202124;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
.gw-promo-main{display:flex;gap:14px;align-items:center;margin-top:10px;position:relative;z-index:1}
.gw-promo-zero{flex:none;width:76px;height:76px;border-radius:50%;background:#fff;color:#0b57d0;display:grid;place-content:center;text-align:center;line-height:1;box-shadow:0 0 0 5px rgba(255,255,255,.25);transform:rotate(-8deg)}
.gw-promo-zero b{font-size:26px;font-weight:900}.gw-promo-zero small{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#3c4a5e}
.gw-promo-h{margin:0;font-size:20px;font-weight:900;line-height:1.2}
.gw-promo-s{margin:4px 0 0;font-size:14px;opacity:.92}
.gw-promo-h s{opacity:.7;font-weight:700;font-size:.8em}.gw-promo-unit{font-size:.7em;font-weight:700}
.gw-offer-line{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:#14532d;margin:6px 0 4px}
.gw-off-badge{background:#d93025;color:#fff;border-radius:999px;padding:3px 10px;font-size:12px;letter-spacing:.04em}
.gw-year s,.gw-renew{color:#6b7a92}.gw-year b{color:var(--ink)}
.gw-renew{font-size:13px;margin-top:2px}
.gw-calc-save dt,.gw-calc-save dd{color:#0a7a35!important;font-weight:800}
.gw-promo-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-top:14px;padding-top:12px;border-top:1px dashed rgba(255,255,255,.45);font-size:13px;font-weight:700;position:relative;z-index:1}
.gw .gw-promo-btn{background:#fff;color:#0b57d0;border:0;border-radius:999px;padding:10px 18px;font:inherit;font-size:14px;font-weight:900;cursor:pointer;min-height:44px}
.gw .gw-promo-btn:hover{background:#e8f0fe}
.gw .gw-promo-btn:focus-visible{outline:3px solid #fbbc04;outline-offset:2px}
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
.gw-calc{border:1px solid var(--line);border-radius:16px;padding:14px;margin:0 0 16px;background:#fff}
.gw-calc label{font-weight:800;font-size:14px}
.gw-calc-row{display:flex;gap:8px;margin:8px 0 10px}
.gw-calc-row button{width:44px;height:44px;border-radius:12px;border:1px solid #c9d3e3;background:#f5f8fd;font-size:22px;font-weight:800;cursor:pointer;color:var(--ink)}
.gw-calc-row button:focus-visible,.gw-calc-row input:focus-visible,.gw-faq summary:focus-visible{outline:3px solid #0b57d0;outline-offset:2px}
.gw-calc-row input{width:90px;height:44px;text-align:center;border:1px solid #c9d3e3;border-radius:12px;font:inherit;font-size:18px;font-weight:800}
.gw-calc-out{margin:0;display:grid;gap:4px}
.gw-calc-out div{display:flex;justify-content:space-between;gap:12px;font-size:14px}
.gw-calc-out dt{color:var(--muted)}.gw-calc-out dd{margin:0;font-variant-numeric:tabular-nums}
.gw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.gw-sec{padding-bottom:56px}
.gw-table-wrap{overflow-x:auto;margin-top:16px;border:1px solid var(--line);border-radius:20px;background:#fff;box-shadow:var(--shadow)}
.gw-table{width:100%;border-collapse:collapse;min-width:520px;font-size:15px}
.gw-table th,.gw-table td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
.gw-table thead th{background:#f2f7ff;font-size:14px}
.gw-table thead th:last-child{color:var(--blue)}
.gw-table tbody tr:last-child th,.gw-table tbody tr:last-child td{border-bottom:0}
.gw-table tbody th{font-weight:700;color:var(--ink)}
.gw-table td:nth-child(2){color:var(--muted)}
.gw-table td:last-child{font-weight:700}
.gw-yes{color:#0a7a35;font-weight:900}
.gw-why{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:16px}
.gw-why-card{padding:20px}.gw-why-card p{margin:6px 0 0;color:var(--muted);font-size:14px}
.gw-faq{display:grid;gap:10px;margin-top:16px;max-width:860px}
.gw-faq summary{cursor:pointer;padding:18px 20px;font-weight:800;list-style:none}
.gw-faq summary::-webkit-details-marker{display:none}
.gw-faq summary::after{content:"+";float:right;color:var(--blue);font-size:20px;line-height:1}
.gw-faq details[open] summary::after{content:"−"}
.gw-faq p{margin:0;padding:0 20px 18px;color:var(--muted)}
.gw-sticky{display:none}
.gw-ticks{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:8px 16px;font-size:14px;font-weight:700;color:#14532d}
.gw-ticks li::before{content:"✓ ";color:#15803d}
.gw-note b{color:var(--ink)}
.gw-cb{margin-top:18px;background:#fff;border:1px solid #dbe8ff;border-radius:18px;padding:14px;box-shadow:0 10px 28px rgba(16,42,86,.08);display:grid;gap:8px;max-width:620px}
.gw-cb-compact{box-shadow:none;border:0;padding:0;margin-top:14px}
.gw-cb-title{font-size:15px}
.gw-cb-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px}
.gw-cb input{min-height:48px;border:1px solid #c9d3e3;border-radius:12px;padding:0 12px;font:inherit;font-size:16px;min-width:0}
.gw-cb input:focus-visible{outline:3px solid #0b57d0;outline-offset:1px}
.gw .gw-cb .gw-btn{min-height:48px}
.gw-cb-done{color:#14532d}.gw-cb-done span{font-size:13px;color:var(--muted)}
.gw-steps{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.gw-steps li{background:#fff;border:1px solid var(--line);border-radius:20px;padding:20px;display:grid;gap:4px;box-shadow:var(--shadow)}
.gw-steps span{width:36px;height:36px;border-radius:50%;background:#0b57d0;color:#fff;display:grid;place-items:center;font-weight:900}
.gw-steps small{color:var(--muted);font-size:14px}
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
  .gw-why{grid-template-columns:1fr 1fr}
  .gw-steps{grid-template-columns:1fr}
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
  .gw-promo{padding:16px}.gw-promo-h{font-size:18px}.gw-promo-zero{width:64px;height:64px}.gw-promo-zero b{font-size:22px}
  .gw .gw-promo-btn{width:100%}
  .gw-photo{border-width:5px;border-radius:24px}
  .gw-apps{grid-template-columns:repeat(4,1fr);border-radius:18px}
  .gw-apps li{padding:12px 4px;border:0!important}
  .gw-apps li span:not(.gw-tile){display:none}
  .gw-apps b{font-size:12px}
  .gw-apps img,.gw-apps .gw-tile{width:34px;height:34px}
  .gw-benefits,.gw-pricing{padding:22px}
  .gw-trust{grid-template-columns:1fr}
  .gw-why{grid-template-columns:1fr}
  .gw-cb-row{grid-template-columns:1fr}
  .gw-table-wrap{overflow:visible;border:0;box-shadow:none;background:transparent}
  .gw-table,.gw-table tbody,.gw-table tr,.gw-table th,.gw-table td{display:block;min-width:0}
  .gw-table thead{display:none}
  .gw-table tr{background:#fff;border:1px solid var(--line);border-radius:16px;margin-bottom:10px;padding:12px 14px}
  .gw-table th,.gw-table td{padding:2px 0;border:0}
  .gw-table tbody th{font-size:15px;margin-bottom:4px}
  .gw-table td{display:flex;gap:8px;font-size:14px}
  .gw-table td::before{content:attr(data-label);flex:0 0 118px;color:var(--muted);font-weight:600}
  .gw-sticky{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;position:fixed;left:0;right:0;bottom:0;z-index:60;padding:8px 8px calc(8px + env(safe-area-inset-bottom,0px));background:rgba(255,255,255,.96);border-top:1px solid var(--line);box-shadow:0 -10px 30px rgba(16,42,86,.12)}
  .gw .gw-sticky .gw-btn{min-height:46px;padding:0 8px;font-size:14px;border-radius:12px}
  .gw-foot{padding-bottom:84px}
  .gw-cta{padding:26px;border-radius:24px}
}
@media(prefers-reduced-motion:reduce){.gw .gw-btn{transition:none}.gw .gw-btn:hover{transform:none}}
`;
