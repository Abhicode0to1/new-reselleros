/**
 * Shared shell for public pages (privacy, terms, about).
 *
 * Lives under `(public)/_components/` — the `_` prefix tells Next.js this
 * isn't a route, so it doesn't try to render it as a page. Centralising
 * these here keeps the public legal/about pages consistent + avoids
 * cross-page imports that confuse the dev compiler.
 */
import Link from "next/link";

export function PublicShell({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-paper">
      <PublicTopBar />
      <main className="max-w-3xl mx-auto px-5 py-12 md:py-16">
        <h1 className="font-serif text-4xl md:text-5xl leading-tight mb-2">{title}</h1>
        {subtitle && <p className="text-sm text-ink-3 mb-8">{subtitle}</p>}
        <div className="prose-resellersos space-y-6 text-[15px] leading-relaxed text-ink-2">
          {children}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

export function PublicTopBar() {
  return (
    <header className="border-b border-hairline">
      <div className="max-w-5xl mx-auto px-5 py-4 flex items-center justify-between">
        <Link href="/" className="font-serif text-xl text-ink hover:text-amber transition-colors">
          ResellerOS
        </Link>
        <nav className="flex gap-5 text-sm text-ink-3">
          <Link href={"/pricing" as never} className="hover:text-ink">Pricing</Link>
          <Link href={"/about" as never}   className="hover:text-ink">About</Link>
          <Link href="/login" className="hover:text-ink">Sign in</Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-hairline mt-16">
      <div className="max-w-5xl mx-auto px-5 py-8 flex flex-col md:flex-row gap-4 md:items-center md:justify-between text-[12px] text-ink-3">
        <div>
          © {new Date().getFullYear()} Excel Technologies Pvt Ltd · Mumbai, India
        </div>
        <nav className="flex gap-4">
          <Link href={"/privacy" as never} className="hover:text-ink">Privacy</Link>
          <Link href={"/terms" as never}   className="hover:text-ink">Terms</Link>
          <Link href={"/about" as never}   className="hover:text-ink">About</Link>
          <a href="mailto:hello@resellersos.in" className="hover:text-ink">Contact</a>
        </nav>
      </div>
    </footer>
  );
}

export function Intro({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-base text-ink-2 leading-relaxed border-l-2 border-amber pl-4 italic">
      {children}
    </p>
  );
}

export function TOC({ items }: { items: Array<{ id: string; label: string }> }) {
  return (
    <nav className="rounded-md border border-hairline bg-paper-2/40 px-5 py-4">
      <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
        On this page
      </p>
      <ol className="space-y-1 text-sm text-ink-2 list-decimal pl-4 marker:text-ink-3">
        {items.map((i) => (
          <li key={i.id}>
            <a href={`#${i.id}`} className="hover:text-amber transition-colors">
              {i.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Section({
  id, n, title, children,
}: {
  id: string; n: number; title: string; children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="font-serif text-2xl text-ink mb-3 leading-tight">
        <span className="text-ink-3 font-sans text-base mr-2">{n}.</span>
        {title}
      </h2>
      <div className="space-y-2 text-ink-2">{children}</div>
    </section>
  );
}

export function Callout({
  tone = "info", children,
}: {
  tone?: "info" | "warning";
  children: React.ReactNode;
}) {
  const bg = tone === "warning" ? "bg-amber-soft/40 border-amber/30" : "bg-indigo-50 border-indigo/20";
  return (
    <div className={`mt-3 rounded-md border px-4 py-3 text-[13px] text-ink-2 ${bg}`}>
      {children}
    </div>
  );
}

export function FooterMeta() {
  return (
    <p className="text-[12px] text-ink-3 italic border-t border-hairline pt-6 mt-8">
      This document is provided for transparency and compliance with the DPDP
      Act 2023. It is not a substitute for legal advice. Excel Technologies Pvt
      Ltd reserves the right to update this policy as our practices or
      applicable law evolves.
    </p>
  );
}
