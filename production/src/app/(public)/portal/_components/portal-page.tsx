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
import { Card } from "@/components/ui/card";
import { KPI } from "@/components/shared/kpi";

/**
 * The heading block — the staff dashboard's header, in a customer's words.
 *
 * ─── WHY IT GREW AN EYEBROW AND AN ACTION SLOT ──────────────────────────────
 * Put side by side on 11 Sep 2026, the staff header carries three things this
 * one did not: a small uppercase line above the title, a primary action pinned
 * to the right of it, and the whole row as `flex items-end justify-between`
 * rather than a plain block. `dashboard/page.tsx:533` is the original.
 *
 * Without them the portal reads as a document and the staff app reads as a
 * tool, whatever the fonts and colours match — the title sat alone over an
 * empty right half of the screen.
 *
 * Both are optional: a page with nothing to do on it should not grow a button
 * for the sake of symmetry, which is how a header ends up with "Refresh".
 */
export function PortalPageHeader({
  title,
  sub,
  eyebrow,
  action,
}: {
  title: string;
  sub: string;
  /** Small uppercase line above the title — the date, or where you are. */
  eyebrow?: string;
  /** The one thing to do from this page, pinned right like the staff header. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
      <div>
        {eyebrow && (
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{eyebrow}</p>
        )}
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight leading-tight">{title}</h1>
        <p className="text-sm text-ink-3 mt-1">{sub}</p>
      </div>
      {action && <div className="flex gap-2">{action}</div>}
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
 * A section — a TITLED CARD, which is how the staff app titles a section.
 *
 * ─── WHY THE HEADING MOVED INSIDE THE CARD ──────────────────────────────────
 * `Card` has taken `title` / `sub` / `actions` props all along, and the staff
 * app uses them: measured 11 Sep 2026, `<Card title=…>` appears 30 times under
 * `(app)/` and `components/features/`, and twice in the whole portal.
 *
 * So the portal was floating an `<h2>` above an untitled card while the staff
 * app put the same words inside one. That is most of why the two screens read
 * differently even with identical type and colour: a heading outside a box
 * leaves a gap above every section, and the page loosens.
 *
 * `flush` is offered because a section whose body is its own list of cards
 * should not be a card inside a card.
 */
export function PortalSection({
  title,
  sub,
  actions,
  children,
  flush,
  className,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Renders the heading alone, for a body that is already made of cards. */
  flush?: boolean;
  className?: string;
}) {
  if (flush) {
    return (
      <section className={className ?? "mb-8"}>
        <div className="flex items-end justify-between gap-3 mb-3">
          <div>
            <h2 className="font-serif text-lg">{title}</h2>
            {sub && <p className="text-2xs text-ink-3 mt-0.5">{sub}</p>}
          </div>
          {actions}
        </div>
        {children}
      </section>
    );
  }
  return (
    <Card title={title} sub={sub} actions={actions} className={className ?? "mb-8"}>
      {children}
    </Card>
  );
}
