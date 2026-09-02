"use client";
/**
 * The hosting landing — ported from the engine's own page (app.anutech.in) into
 * ResellerOS, because that is the page Pardeep wants as THE hosting page here
 * (2 Sep 2026: "bilkul yahi hona chahiye meri app me").
 *
 * ─── SAME PAGE, OUR PLUMBING ────────────────────────────────────────────────
 * The engine's version is built on ITS stack: next-auth for the session, a
 * zustand cart store, react-hot-toast, and its own Navigation/Footer/Support
 * widget. Copying that verbatim would have given this app a second auth system,
 * a second cart and a second toaster — the opposite of the one-app merge. So the
 * layout, copy, sections and look are reproduced faithfully, while the moving
 * parts are the ones this app already has:
 *   · cart      → the marketing site's CartProvider (useCart)
 *   · toast     → sonner (the app's toaster, mounted in the root layout)
 *   · chrome    → the (marketing) layout's header/footer/WhatsApp/agent, so the
 *                 engine's Navigation, Footer and SupportWidget are dropped
 *   · search    → this site's real DomainSearch (asks the platform, and says so
 *                 honestly when the platform can't be reached)
 *
 * The engine's font stack ("Google Sans", which resolves to system-ui for most
 * visitors) is set on the root here, so the page keeps its own face rather than
 * inheriting the marketing site's Archivo.
 *
 * ⚠️ The trust logos and testimonials are the engine's PLACEHOLDER content — not
 * signed-off customer references. See src/site/lib/data/hosting-landing.ts.
 */
import * as React from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "@/site/components/ui/SiteLink";
import { DomainSearch } from "@/site/components/home/DomainSearch";
import { useCart } from "@/site/components/cart/CartProvider";
import {
  LANDING_PLANS, TRUSTED_LOGOS, HOSTING_FEATURES, HOSTING_COMPARISON,
  HOSTING_STEPS, HOSTING_TESTIMONIALS, HOSTING_FAQS, type LandingPlan,
} from "@/site/lib/data/hosting-landing";
import {
  Cloud, Zap, Lock, RefreshCw, Rocket, Headphones, CreditCard, Globe, Server,
  CheckCircle, Check, Minus, X, Star, ShieldCheck, ArrowRight, ChevronDown,
  LayoutDashboard, Layers, Mail, FileText, Database, Save, Shield, Settings,
  Bell, Grid3x3, Plus,
} from "lucide-react";

/** The engine's face: Google Sans if present, else the system UI font. */
const FACE = "'Google Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  cloud: Cloud, zap: Zap, lock: Lock, refresh: RefreshCw, rocket: Rocket,
  headphones: Headphones, card: CreditCard, globe: Globe, server: Server,
};

function Section({ tone, id, className, children }: {
  tone: "white" | "gray"; id?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <section id={id} className={`py-14 sm:py-20 ${tone === "gray" ? "bg-gray-50" : "bg-white"} ${className ?? ""}`}>
      <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8">{children}</div>
    </section>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-600 mb-3">{children}</p>;
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-4 text-left px-5 py-4"
      >
        <span className="text-sm sm:text-base font-semibold text-gray-900">{question}</span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-violet-600 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <p className="px-5 pb-5 -mt-1 text-sm text-gray-600 leading-relaxed">{answer}</p>}
    </div>
  );
}

export function HostingLanding() {
  const [billingCycle, setBillingCycle] = React.useState<"monthly" | "yearly">("yearly");
  const router = useRouter();
  const cart = useCart();

  /* Testimonial carousel — responsive cards-per-view, same as the engine's. */
  const [tIndex, setTIndex] = React.useState(0);
  const [perView, setPerView] = React.useState(4);
  React.useEffect(() => {
    const calc = () => setPerView(window.innerWidth < 640 ? 1 : window.innerWidth < 1024 ? 2 : 4);
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  const maxT = Math.max(0, HOSTING_TESTIMONIALS.length - perView);
  React.useEffect(() => { setTIndex((i) => Math.min(i, maxT)); }, [maxT]);

  const isMonthly = billingCycle === "monthly";

  /* Buy → the site's own cart (the same one the domain rate card fills), then
     the cart page. Monthly is billed at 2× the yearly rate, as the shop does. */
  const choosePlan = (plan: LandingPlan) => {
    const price = isMonthly ? plan.price * 2 : plan.price;
    cart.add({
      label: `${plan.name} hosting`,
      detail: isMonthly
        ? "cPanel hosting · billed monthly, cancel any time"
        : "cPanel hosting · 12 months prepaid · 30-day money-back",
      unitPrice: Math.round(isMonthly ? price : price * 12),
      unit: isMonthly ? "month" : "year",
      cycle: isMonthly ? "monthly" : "yearly",
    });
    toast.success(`${plan.name} hosting added to your cart`);
    router.push("/cart" as never);
  };

  /* The 15-day trial (yearly Starter). It costs ₹0 today; the team sets the
     account up and the first invoice follows the trial — so it goes through the
     same cart → enquiry path, never a silent charge. */
  const startTrial = (plan: LandingPlan) => {
    cart.add({
      label: `${plan.name} hosting — 15-day free trial`,
      detail: `₹0 today · then ${plan.price.toFixed(2)}/mo billed yearly after 15 days · cancel any time`,
      unitPrice: 0,
      unit: "trial",
      cycle: "once",
    });
    toast.success("Free trial added — ₹0 today. Tell us where to set it up.");
    router.push("/cart" as never);
  };

  return (
    <div className="bg-white text-gray-900" style={{ fontFamily: FACE }}>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-gradient-to-b from-violet-50/70 via-white to-white">
        <div aria-hidden className="absolute -top-24 -right-24 w-[30rem] h-[30rem] rounded-full bg-violet-100/50 blur-3xl pointer-events-none" />
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-14 sm:py-20 relative">
          <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="text-center lg:text-left">
              <div className="inline-flex items-center gap-2 mb-5 text-green-600 text-[11px] sm:text-xs font-bold tracking-[0.12em] uppercase">
                <Rocket className="h-3.5 w-3.5" />
                15-Day Free Trial · No Credit Card Required
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-gray-900 leading-[1.05] mb-5">
                Launch Your<br />
                Business Website<br />
                <span className="bg-gradient-to-r from-[#7C3AED] to-[#6D28D9] bg-clip-text text-transparent">FREE for 15 Days</span>
              </h1>
              <p className="text-base sm:text-lg text-gray-600 leading-relaxed mb-8 max-w-xl mx-auto lg:mx-0">
                Enterprise-grade web hosting powered by Google Cloud. Free SSL, daily backups, free migration and 24×7 expert support.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 mb-6 sm:justify-center lg:justify-start">
                <Link href="#pricing" className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#22C55E] to-[#16A34A] hover:from-[#16A34A] hover:to-[#15803D] text-white font-bold py-3.5 px-7 rounded-xl shadow-lg hover:shadow-xl transition-all active:scale-95">
                  <Rocket className="h-5 w-5" />
                  Start Your 15-Day Free Trial
                </Link>
                <Link href="#pricing" className="inline-flex items-center justify-center gap-2 bg-white text-gray-800 font-bold py-3.5 px-7 rounded-xl border border-gray-200 shadow-sm hover:border-violet-300 hover:text-violet-700 transition-all">
                  View Hosting Plans
                </Link>
              </div>
              <div className="flex flex-wrap justify-center lg:justify-start gap-x-5 gap-y-2 text-sm text-gray-500">
                {["No Credit Card Required", "Full Access to All Features", "Cancel Anytime"].map((t) => (
                  <span key={t} className="inline-flex items-center gap-1.5"><CheckCircle className="h-4 w-4 text-green-500" />{t}</span>
                ))}
              </div>
            </motion.div>

            {/* Dashboard mock — what the customer gets after signing up. */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15 }} className="hidden lg:block">
              <div className="rounded-2xl border border-gray-200 shadow-2xl overflow-hidden bg-white">
                <div className="flex items-center gap-1.5 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                  <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                  <span className="ml-3 text-[11px] text-gray-400 font-medium">Your hosting dashboard</span>
                </div>
                <div className="flex">
                  <div className="w-36 shrink-0 border-r border-gray-100 p-3 hidden xl:block">
                    <div className="flex items-center gap-1.5 mb-4 px-1">
                      <div className="h-5 w-5 rounded bg-gradient-to-br from-[#7C3AED] to-[#6D28D9]" />
                      <span className="text-[11px] font-bold text-gray-800">ANUTECH</span>
                    </div>
                    {([
                      { n: "Dashboard", Icon: LayoutDashboard }, { n: "Websites", Icon: Layers },
                      { n: "Domains", Icon: Globe }, { n: "Emails", Icon: Mail },
                      { n: "Files", Icon: FileText }, { n: "Databases", Icon: Database },
                      { n: "Backups", Icon: Save }, { n: "Security", Icon: Shield },
                      { n: "Settings", Icon: Settings },
                    ] as const).map(({ n, Icon }, i) => (
                      <div key={n} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg mb-0.5 text-[11px] ${i === 0 ? "bg-violet-50 text-violet-700 font-semibold" : "text-gray-500"}`}>
                        <Icon className={`h-3 w-3 ${i === 0 ? "text-violet-600" : "text-gray-400"}`} />
                        {n}
                      </div>
                    ))}
                  </div>
                  <div className="flex-1 p-4 min-w-0">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">Welcome back! 👋</p>
                        <p className="text-[11px] text-gray-500">Here&apos;s what&apos;s happening with your website today.</p>
                      </div>
                      <div className="flex items-center gap-2 text-gray-300">
                        <Bell className="h-4 w-4" />
                        <Grid3x3 className="h-4 w-4" />
                        <span className="h-5 w-5 rounded-full bg-gradient-to-br from-violet-300 to-violet-500" />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {[
                        { label: "Website", value: "mybusiness.com", badge: "Active", pct: null as number | null },
                        { label: "Storage", value: "12.6 / 20 GB", badge: "63% Used", pct: 63 },
                        { label: "Bandwidth", value: "32.4 / 100 GB", badge: "32% Used", pct: 32 },
                      ].map((s) => (
                        <div key={s.label} className="rounded-lg border border-gray-100 bg-gray-50/60 p-2.5">
                          <p className="text-[9px] uppercase tracking-wide text-gray-400">{s.label}</p>
                          <p className="text-[11px] font-bold text-gray-900 truncate">{s.value}</p>
                          {s.pct === null ? (
                            <p className="text-[9px] font-semibold text-green-600 mt-0.5 flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-green-500" />{s.badge}</p>
                          ) : (
                            <>
                              <div className="h-1 rounded-full bg-gray-200 mt-1.5 overflow-hidden"><div className="h-full rounded-full bg-violet-500" style={{ width: `${s.pct}%` }} /></div>
                              <p className="text-[9px] text-gray-400 mt-0.5">{s.badge}</p>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2 rounded-lg border border-gray-100 p-3">
                        <p className="text-[10px] font-semibold text-gray-500 mb-2">Performance <span className="text-green-500">+12.9%</span></p>
                        <svg viewBox="0 0 200 60" className="w-full h-14" aria-hidden>
                          <polyline fill="none" stroke="#7C3AED" strokeWidth="2.5" points="0,45 28,40 56,44 84,30 112,34 140,20 168,24 200,8" />
                        </svg>
                      </div>
                      <div className="rounded-lg border border-gray-100 p-3">
                        <p className="text-[10px] font-semibold text-gray-500 mb-2">Quick Actions</p>
                        {([
                          { a: "Create Website", Icon: Globe }, { a: "Install WordPress", Icon: Server },
                          { a: "Add Domain", Icon: Plus }, { a: "Manage Emails", Icon: Mail },
                        ] as const).map(({ a, Icon }) => (
                          <p key={a} className="text-[9px] text-gray-600 mb-1.5 flex items-center gap-1.5"><Icon className="h-2.5 w-2.5 text-violet-500" />{a}</p>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* ── Trust bar ────────────────────────────────────────────────────── */}
      <section className="border-y border-gray-100 bg-white">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
            <div>
              <p className="text-[11px] font-bold tracking-[0.18em] uppercase text-violet-600 mb-3 text-center lg:text-left">Trusted by 1,000+ businesses</p>
              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-x-6 gap-y-2">
                {TRUSTED_LOGOS.map((l) => (
                  <span key={l} className="text-sm sm:text-base font-bold text-gray-400/80">{l}</span>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-5 sm:gap-8">
              {[
                { Icon: Star, value: "1,000+", label: "Happy Customers" },
                { Icon: ShieldCheck, value: "99.99%", label: "Uptime Guarantee" },
                { Icon: Rocket, value: "5+", label: "Years of Trust" },
                { Icon: Headphones, value: "24×7", label: "Expert Support" },
              ].map(({ Icon, value, label }) => (
                <div key={label} className="flex flex-col items-center text-center">
                  <Icon className="h-4 w-4 text-violet-600 mb-1" />
                  <p className="text-base sm:text-lg font-extrabold text-gray-900">{value}</p>
                  <p className="text-[10px] sm:text-xs text-gray-500">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Domain search ────────────────────────────────────────────────── */}
      <section id="domain-search" className="scroll-mt-24 relative overflow-hidden bg-gradient-to-br from-[#312e81] via-[#4c1d95] to-[#3730a3] py-14 sm:py-20">
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-indigo-400/20 blur-3xl" />
        <div className="relative max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-xs font-bold tracking-[0.18em] uppercase text-violet-300 mb-3">Search for your perfect domain</p>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Find the Perfect Domain Name</h2>
          <p className="text-indigo-100/80 text-base max-w-xl mx-auto mb-8">Search across 500+ extensions and register your domain in seconds — free with select hosting plans.</p>
          <div className="max-w-3xl mx-auto text-left">
            <DomainSearch />
          </div>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <Section tone="white">
        <div className="text-center mb-10 sm:mb-14">
          <Eyebrow>Everything you need to succeed online</Eyebrow>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">Powerful Features. Unmatched Performance.</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 sm:gap-5">
          {HOSTING_FEATURES.map((f, i) => {
            const Icon = ICONS[f.icon] ?? Cloud;
            return (
              <motion.div key={f.title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: i * 0.05 }}
                className="group bg-white rounded-2xl p-5 border border-gray-200 shadow-sm hover:shadow-md hover:border-violet-200 transition-all">
                <div className={`inline-flex items-center justify-center h-12 w-12 rounded-full ${f.tint} mb-4`}>
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-bold text-gray-900 mb-2">{f.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{f.body}</p>
              </motion.div>
            );
          })}
        </div>
      </Section>

      {/* ── Comparison ───────────────────────────────────────────────────── */}
      <Section tone="gray">
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          <div className="text-center lg:text-left">
            <Eyebrow>Why choose Anutech?</Eyebrow>
            <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-gray-900 leading-[1.1]">
              Better Hosting.<br />Better Results.
            </h2>
            <p className="mt-5 text-base text-gray-600 leading-relaxed max-w-md mx-auto lg:mx-0">
              We combine the power of Google Cloud with personalized support to give your business the hosting experience it deserves.
            </p>
            <div className="mt-8 hidden lg:block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/server-cloud.png"
                alt="Google Cloud powered hosting infrastructure"
                width={340}
                height={340}
                className="h-auto w-[340px] max-w-full select-none"
                loading="lazy"
                draggable={false}
              />
            </div>
          </div>

          <div className="relative pt-3">
            <div aria-hidden className="pointer-events-none absolute top-0 bottom-0 right-20 w-20 sm:right-[150px] sm:w-[150px] rounded-2xl border-2 border-violet-300 bg-violet-50/40 shadow-xl shadow-violet-500/10" />
            <div className="relative grid grid-cols-[minmax(0,1fr)_5rem_5rem] sm:grid-cols-[minmax(0,1fr)_150px_150px] rounded-2xl bg-white/60 border border-gray-200">
              <div className="px-3 sm:px-5 py-4 border-b border-gray-100" />
              <div className="relative z-10 -mt-3 mx-[-1px] px-2 sm:px-6 py-4 sm:py-5 bg-gradient-to-b from-violet-600 to-violet-700 text-white text-xs sm:text-sm font-bold text-center leading-tight rounded-t-2xl shadow-lg shadow-violet-500/20">Anutech Hosting</div>
              <div className="px-2 sm:px-6 py-4 border-b border-gray-100 text-xs sm:text-sm font-semibold text-gray-500 text-center leading-tight">Typical Hosting</div>
              {HOSTING_COMPARISON.map((row, i) => {
                const last = i === HOSTING_COMPARISON.length - 1;
                return (
                  <div key={row.feature} className="contents">
                    <div className={`px-3 sm:px-5 py-3.5 text-xs sm:text-sm font-medium text-gray-800 ${!last ? "border-b border-gray-100" : ""}`}>{row.feature}</div>
                    <div className={`relative z-10 px-2 sm:px-6 py-3.5 flex justify-center ${!last ? "border-b border-violet-100" : ""}`}>
                      <CheckCircle className="h-5 w-5 text-white fill-green-500" />
                    </div>
                    <div className={`px-2 sm:px-6 py-3.5 flex justify-center ${!last ? "border-b border-gray-100" : ""}`}>
                      {row.typical === "yes" ? <CheckCircle className="h-5 w-5 text-white fill-green-500" />
                        : row.typical === "partial" ? <Minus className="h-5 w-5 text-amber-400" strokeWidth={3} />
                          : <X className="h-5 w-5 text-red-500" strokeWidth={3} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Section>

      {/* ── How the trial works ──────────────────────────────────────────── */}
      <Section tone="white">
        <div className="text-center mb-10 sm:mb-14">
          <Eyebrow>Get started in minutes</Eyebrow>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">How the 15-Day Free Trial Works</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
          {HOSTING_STEPS.map((step, i) => {
            const Icon = ICONS[step.icon] ?? Rocket;
            return (
              <motion.div key={step.num} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.4, delay: i * 0.08 }}
                className="relative bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-center">
                <div className="relative w-16 h-16 mx-auto mb-4">
                  <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-violet-50 to-indigo-50" />
                  <div className="relative flex items-center justify-center h-full"><Icon className="h-7 w-7 text-violet-600" /></div>
                  <span className="absolute -top-2 -right-2 h-7 w-7 rounded-full bg-violet-600 text-white text-xs font-bold flex items-center justify-center shadow-md border-2 border-white">{step.num}</span>
                </div>
                <h4 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">{step.title}</h4>
                <p className="text-sm text-gray-600 leading-relaxed">{step.body}</p>
              </motion.div>
            );
          })}
        </div>
      </Section>

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <Section tone="gray" id="pricing" className="scroll-mt-24">
        <div className="text-center mb-8 sm:mb-10">
          <Eyebrow>Choose the perfect plan for you</Eyebrow>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">Simple, Transparent Pricing</h2>
          <p className="text-base text-gray-600">Start with a 15-day free trial — no credit card required.</p>
        </div>

        <div className="flex justify-center mb-10">
          <div className="inline-flex items-center gap-1 bg-gray-100 rounded-full p-1">
            <button type="button" onClick={() => setBillingCycle("monthly")} aria-pressed={isMonthly}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-all ${isMonthly ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              Monthly
            </button>
            <button type="button" onClick={() => setBillingCycle("yearly")} aria-pressed={!isMonthly}
              className={`inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-semibold transition-all ${!isMonthly ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>
              Yearly
              <span className="text-[10px] font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Save up to 60%</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-7xl mx-auto items-start">
          {LANDING_PLANS.map((plan) => {
            const monthlyPrice = plan.price * 2;
            const displayPrice = (isMonthly ? monthlyPrice : plan.price).toFixed(2);
            const isStarter = /starter/i.test(plan.name);
            const offersTrial = !isMonthly && isStarter;
            return (
              <div key={plan.planId}
                className={`relative bg-white rounded-2xl border p-6 shadow-sm ${plan.isPopular ? "border-violet-400 shadow-xl shadow-violet-500/10 ring-1 ring-violet-200" : "border-gray-200"}`}>
                {plan.isPopular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-[10px] font-bold tracking-wider uppercase px-3 py-1 rounded-full shadow">
                    Most Popular
                  </span>
                )}
                {!isMonthly && (
                  <span className="inline-block mb-3 text-[10px] font-bold bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Save 50% OFF</span>
                )}
                <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>
                <p className="text-sm text-gray-500 mb-4">{plan.description}</p>
                <div className="flex items-end gap-2 mb-1">
                  {!isMonthly && <span className="text-base text-gray-400 line-through">₹{monthlyPrice.toFixed(2)}</span>}
                  <span className="text-4xl font-extrabold text-gray-900">₹{displayPrice}</span>
                  <span className="text-sm text-gray-500 mb-1.5">/mo</span>
                </div>
                <p className="text-xs text-gray-500 mb-5">
                  Renews at ₹{(isMonthly ? monthlyPrice : plan.price).toFixed(2)}/mo
                </p>
                <div className="flex flex-col gap-2 mb-5">
                  <button type="button" onClick={() => (offersTrial ? startTrial(plan) : choosePlan(plan))}
                    className="w-full inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#7C3AED] to-[#6D28D9] hover:from-[#6D28D9] hover:to-[#5B21B6] text-white font-bold py-3 rounded-xl shadow-md transition-all active:scale-95">
                    {offersTrial ? "Start Free Trial" : "Buy Now"}
                  </button>
                  {offersTrial && (
                    <button type="button" onClick={() => choosePlan(plan)}
                      className="w-full inline-flex items-center justify-center gap-2 bg-white text-gray-800 font-semibold py-3 rounded-xl border border-gray-200 hover:border-violet-300 hover:text-violet-700 transition-all">
                      Buy Now
                    </button>
                  )}
                </div>
                <ul className="space-y-2">
                  {[...plan.features, ...(!isMonthly ? ["30-Day Money-Back Guarantee"] : [])].map((f) => (
                    <li key={f} className={`flex items-start gap-2 text-sm ${plan.highlightFeatures.includes(f) ? "font-semibold text-gray-900" : "text-gray-600"}`}>
                      <Check className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="text-center text-sm text-gray-500 mt-8">15-Day Money-Back Guarantee · Cancel Anytime</p>
      </Section>

      {/* ── Testimonials ─────────────────────────────────────────────────── */}
      <Section tone="white">
        <div className="text-center mb-10 sm:mb-14">
          <Eyebrow>What our customers say</Eyebrow>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">Loved by 1,000+ Businesses</h2>
        </div>
        <div className="relative overflow-hidden">
          <div className="flex transition-transform duration-700 ease-out" style={{ transform: `translateX(-${tIndex * (100 / perView)}%)` }}>
            {HOSTING_TESTIMONIALS.map((t) => (
              <div key={t.name} className="shrink-0 px-2.5 sm:px-3" style={{ flexBasis: `${100 / perView}%` }}>
                <div className="h-full bg-white rounded-2xl p-6 border border-gray-200 shadow-sm">
                  <div className="flex gap-0.5 mb-3">{Array.from({ length: 5 }).map((_, s) => (<Star key={s} className="h-4 w-4 fill-yellow-400 text-yellow-400" />))}</div>
                  <p className="text-sm text-gray-700 leading-relaxed mb-4">&ldquo;{t.quote}&rdquo;</p>
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={t.img} alt={t.name} loading="lazy" className="h-11 w-11 rounded-full bg-violet-100 object-cover shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                      <p className="text-xs text-gray-500">{t.role}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {maxT > 0 && (
          <div className="flex justify-center gap-2 mt-8">
            {Array.from({ length: maxT + 1 }).map((_, i) => (
              <button key={i} type="button" onClick={() => setTIndex(i)} aria-label={`Go to testimonial slide ${i + 1}`}
                className={`h-2 rounded-full transition-all ${i === tIndex ? "w-6 bg-violet-600" : "w-2 bg-gray-300 hover:bg-gray-400"}`} />
            ))}
          </div>
        )}
      </Section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <Section tone="gray">
        <div className="grid lg:grid-cols-3 gap-8 lg:gap-12">
          <div className="lg:col-span-1 text-center lg:text-left">
            <Eyebrow>Frequently asked questions</Eyebrow>
            <h2 className="text-3xl sm:text-4xl font-bold text-gray-900">
              Got Questions?<br />We&apos;ve Got Answers.
            </h2>
          </div>
          <div className="lg:col-span-2 space-y-3">
            {HOSTING_FAQS.map((f) => (<FaqItem key={f.question} question={f.question} answer={f.answer} />))}
          </div>
        </div>
      </Section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section className="bg-gradient-to-r from-[#7C3AED] to-[#4F46E5]">
        <div className="max-w-screen-xl mx-auto px-4 sm:px-6 lg:px-8 py-14 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">Ready to Launch Your Website?</h2>
          <p className="text-violet-100 mb-7 max-w-2xl mx-auto">Join 1,000+ businesses who trust Anutech for their online success.</p>
          <Link href="#pricing" className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-[#22C55E] to-[#16A34A] hover:from-[#16A34A] hover:to-[#15803D] text-white font-bold py-3.5 px-8 rounded-xl shadow-lg hover:shadow-xl transition-all active:scale-95">
            <Rocket className="h-5 w-5" />
            Start Your 15-Day Free Trial
            <ArrowRight className="h-5 w-5" />
          </Link>
          <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-violet-100 mt-6">
            {["15-Day Free Trial", "No Credit Card Required", "Cancel Anytime"].map((t) => (
              <span key={t} className="inline-flex items-center gap-1.5"><Check className="h-4 w-4" />{t}</span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
