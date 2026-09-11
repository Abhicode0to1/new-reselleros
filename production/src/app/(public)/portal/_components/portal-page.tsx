/**
 * The customer portal's page furniture, in one place.
 *
 * ─── WHY A SHARED COMPONENT AND NOT A PATTERN TO COPY ───────────────────────
 * Pardeep, 11 Sep 2026: "Whole customer portal design should be like that.
 * Including navbar design and etc, for all pages of customer portals."
 *
 * Twelve pages had each grown their own version of the same three things — a
 * heading block, a row of numbers, an empty state. They were close, which is
 * worse than being different: close means nobody notices the drift until the
 * screens are put side by side, which is exactly how this started.
 *
 * Copying the dashboard's markup into eleven more files would have produced
 * twelve copies to keep in step. These are the pieces instead, so a change to
 * the portal's look is one edit and the pages cannot disagree.
 *
 * ─── SERVER-SAFE ON PURPOSE ─────────────────────────────────────────────────
 * Every portal page is a Server Component that awaits its own data. `KPI` and
 * `EmptyState` carry no hooks, so these stay server components too — a "use
 * client" here would drag each page's data fetching into the browser.
 */
import { KPI } from "@/components/shared/kpi";

/**
 * The heading block: serif title, one line of what the page is for.
 *
 * Identical on all twelve pages already — centralised so it stays that way,
 * and so the spacing below it is decided once rather than per page (it was
 * `mb-6` on some and `mb-8` on others).
 */
export function PortalPageHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-serif text-3xl md:text-4xl tracking-tight">{title}</h1>
      <p className="text-sm text-ink-3 mt-1">{sub}</p>
    </div>
  );
}

export interface PortalStat {
  label: string;
  value: string | number;
  /** Formats the value as rupees. Integer rupees, per §13. */
  asCurrency?: boolean;
  icon?: string;
  accent?: "ink" | "amber" | "rose" | "emerald";
  /** The small line under the number — "in 9 days", "2 not live". */
  trend?: string;
  trendKind?: "up" | "down" | "neutral";
}

/**
 * The row of numbers a page opens with — the staff dashboard's own `KPI`, in
 * the grid the portal uses everywhere.
 *
 * Two columns on a phone rather than one: these are short values, and a single
 * column pushes the actual content of the page below the fold on every screen.
 * Four across from `lg`, which is where 1080px of content has room for them.
 */
export function PortalStats({ items }: { items: PortalStat[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
      {items.map((s) => (
        <KPI
          key={s.label}
          label={s.label}
          value={s.value}
          asCurrency={s.asCurrency}
          icon={s.icon}
          accent={s.accent ?? "ink"}
          trend={s.trend}
          trendKind={s.trendKind ?? "neutral"}
        />
      ))}
    </div>
  );
}

/**
 * A section: serif heading, optional one-line explanation, then the content.
 *
 * The dashboard grew this shape first ("Needs your attention", "Your
 * subscription") and every other page wants it. Without it each page invents
 * its own heading size — measured before this existed: `text-lg`, `text-xl`
 * and a bare `<h2>` with no class, on three pages of the same portal.
 */
export function PortalSection({
  title,
  sub,
  children,
  className,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className ?? "mb-8"}>
      <h2 className="font-serif text-lg mb-1">{title}</h2>
      {sub && <p className="text-2xs text-ink-3 mb-3">{sub}</p>}
      {!sub && <div className="mb-3" />}
      {children}
    </section>
  );
}
