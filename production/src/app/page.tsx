import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PLATFORM_OPERATOR } from "@/lib/platform";
import {
  Hero,
  TrustRibbon,
  PainSection,
  ModuleShowcase,
  WhyUs,
  FounderSection,
  BetaPricing,
  FinalCta,
} from "./(public)/_components/landing-sections";

/**
 * Public marketing landing page — visual v3 (World-Class).
 *
 * Built for cold prospects (Indian cloud resellers).
 * Introduces dynamic animations (Framer Motion), glassmorphism,
 * and interactive hover states for a premium, high-trust feel.
 *
 * If a visitor is already authenticated, kick them to /dashboard
 * (unless ?preview=1 is set — useful for demos).
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: { preview?: string };
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && searchParams.preview !== "1") redirect("/dashboard");

  return (
    <main className="min-h-screen bg-paper text-ink antialiased relative">
      <TopNav />
      <Hero />
      <TrustRibbon />
      <PainSection />
      <ModuleShowcase />
      <WhyUs />
      <FounderSection />
      <BetaPricing />
      <FinalCta />
      <Footer />

      {/* Floating WhatsApp Chat Widget for Instant B2B Trust */}
      <a
        href="https://wa.me/919876543210?text=Hi%20ResellerOS%20team,%20I'd%20like%20to%20know%20more%20about%20ResellerOS"
        target="_blank"
        rel="noopener noreferrer"
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-full bg-[#25D366] px-4 py-3 text-white shadow-xl hover:bg-[#20bd5a] hover:scale-105 transition-all focus:outline-none"
        title="Chat on WhatsApp with Founder / Support"
      >
        <Icon name="message_square" className="h-5 w-5 fill-current" />
        <span className="text-xs font-semibold tracking-wide sm:inline">Chat on WhatsApp</span>
      </a>
    </main>
  );
}

/* ───────────────────────────────────────────────────────────────
   Top nav
   ─────────────────────────────────────────────────────────────── */

function TopNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline/80 bg-paper/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        {/* ── Product pehle, company uske neeche — LOGO ke saath ────────────────
            Pehle maine logo sirf footer me rakha tha, ye soch kar ki 28px ke nav me do
            logo gande dikhenge. Pardeep ne do baar kaha "logo show nahi kar raha" — aur
            wo theek tha: footer y=935 par hai, yaani scroll kiye bina dikhta hi nahi.
            Ek logo jo dikhta nahi, laga hua nahi hai.

            Ab ANUTECH ka logo "by" ke saath us hi sub-line me hai. 16px par wo chhota hai
            par pehchana jata hai, aur product mark (kaala square) apni jagah bada rehta
            hai — visitor ResellerOS kharidne aaya hai, wo pehle padhna chahiye. */}
        <Link href="/" className="flex items-center gap-2.5 group">
          {/* Yahan pehle ek kaala square tha jisme `layout` icon bana hua tha — ek aam-sa
              mark jo kisi bhi app ka ho sakta tha. Uski jagah ab ANUTECH ka ASLI logo hai.
              alt="" jaan-boojh kar: company ka naam iske turant baad TEXT me likha hai, to
              alt dene se screen reader use do baar bolta. */}
          <img
            src={PLATFORM_OPERATOR.logo}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-full transition-transform group-hover:scale-105"
          />
          <span className="flex flex-col leading-none">
            <span className="font-serif text-xl tracking-tight">{PLATFORM_OPERATOR.productName}</span>
            <span className="mt-1 text-2xs font-medium uppercase tracking-wider text-ink-3">
              by {PLATFORM_OPERATOR.shortName}
            </span>
          </span>
        </Link>
        <nav className="flex items-center gap-5 text-sm font-medium text-ink-2">
          <Link href={"/pricing" as never} className="hidden sm:inline hover:text-ink transition-colors">
            Pricing
          </Link>
          <Link href={"/about" as never} className="hidden sm:inline hover:text-ink transition-colors">
            About
          </Link>
          <Link href="/login" className="hover:text-ink transition-colors">
            Sign in
          </Link>
          <Button asChild size="sm" className="shadow-sm hover:shadow-md transition-shadow">
            <Link href="/signup">Start free</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

/* ───────────────────────────────────────────────────────────────
   Footer
   ─────────────────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-hairline bg-paper-2/40">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          {/* Footer me ANUTECH ka ASLI logo — yahi wo jagah hai jahan company ki pehchan
              rehti hai aur use padhne layak jagah milti hai. `<img>` jaan-boojh kar,
              `next/image` nahi: is repo me `sharp` install nahi hai, aur uske bina
              production build par image optimizer chalta nahi. Wahi `<img>`
              project-quote/[id]/page.tsx:52 par bhi hai. */}
          {/* Header jaisa hi lockup, chhote naap me — do jagah do tarah ka mark hona wahi
              "ek naam, do shakl" wali dikkat hai. */}
          <div className="flex items-center gap-2.5">
            <img
              src={PLATFORM_OPERATOR.logo}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded-full"
            />
            <span className="flex flex-col leading-none">
              <span className="font-serif text-base tracking-tight">
                {PLATFORM_OPERATOR.productName}
              </span>
              <span className="mt-1 text-2xs font-medium uppercase tracking-wider text-ink-3">
                by {PLATFORM_OPERATOR.shortName}
              </span>
            </span>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm font-medium text-ink-2">
            <Link href={"/pricing" as never} className="hover:text-ink transition-colors">Pricing</Link>
            <Link href={"/about" as never}   className="hover:text-ink transition-colors">About</Link>
            <Link href={"/privacy" as never} className="hover:text-ink transition-colors">Privacy</Link>
            <Link href={"/terms" as never}   className="hover:text-ink transition-colors">Terms</Link>
            <a href="mailto:hello@resellersos.in" className="hover:text-amber-ink transition-colors">
              Contact
            </a>
          </nav>
        </div>
        {/* GSTIN yahan hai kyunki B2B India me wahi asli pehchan hai — naam do company ka
            ek jaisa ho sakta hai, GSTIN nahi. Aur "Mumbai" hata: company Delhi ki hai.
            (Neeche TrustRibbon me "Google Cloud Mumbai" JAAN-BOOJHKAR raha — wo server ka
            region hai, `ap-south-1`, aur wo sach hai. Do alag Mumbai.) */}
        <div className="mt-8 border-t border-hairline/60 pt-6 font-mono text-2xs uppercase tracking-wider text-ink-3">
          {PLATFORM_OPERATOR.productName} is a product of {PLATFORM_OPERATOR.legalName} ·{" "}
          {PLATFORM_OPERATOR.city} · GSTIN {PLATFORM_OPERATOR.gstin}
        </div>
      </div>
    </footer>
  );
}
