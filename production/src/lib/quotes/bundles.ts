/**
 * Solution packages — one click puts a whole solution on the quote.
 *
 * "Google Workspace + Acronis Backup + SSL" is three separate catalogue items that a
 * rep currently adds one at a time, forgetting the backup roughly as often as they
 * remember it. A bundle is a named list of things to look for; it is NOT a product,
 * has no price of its own, and creates nothing that is not already in the catalogue.
 *
 * ─── IT RESOLVES AGAINST THE TENANT'S REAL CATALOGUE, AND SAYS WHAT IT MISSED ──
 * Every tenant's catalogue is different. A bundle that quietly drops the SSL line
 * because this reseller does not stock SSL produces a quote that looks complete and
 * under-sells by one product — the same failure this codebase keeps finding, where a
 * miss is converted into a plausible-looking result.
 *
 * So `resolveBundle` returns BOTH what it found and what it could not, the caller is
 * expected to show the misses, and a bundle with zero matches returns zero lines
 * rather than an empty quote presented as a filled one.
 *
 * ─── AMBIGUITY IS REFUSED, NOT GUESSED ─────────────────────────────────────────
 * If two catalogue rows match one component equally well, the component is reported
 * as ambiguous with both candidates named. Picking the first row would silently
 * decide a price. Same rule as `matchPlan` in lib/subscriptions/plan-match.ts.
 */
import type { Item } from "@/lib/supabase/database.types";

export interface BundleComponent {
  /** Shown in the picker and in the "not in your catalogue" message. */
  label: string;
  /** All of these must appear in the item name (lowercased) for a match. */
  keywords: string[];
  /** Optional vendor restriction — narrows "backup" to the right supplier. */
  vendors?: Array<Item["vendor"]>;
  /** Seats default to the bundle's seat count; a fixed-quantity component overrides it. */
  fixedQty?: number;
  /** False when the deal still stands without it — drives "optional" in the UI. */
  required: boolean;
}

export interface SolutionBundle {
  id: string;
  name: string;
  /** One line on what problem this package solves — the rep's pitch, not marketing. */
  pitch: string;
  components: BundleComponent[];
}

export const SOLUTION_BUNDLES: readonly SolutionBundle[] = [
  {
    id: "secure-workspace",
    name: "Secure Workspace",
    pitch: "Email plus the backup that Google does not include, plus a certificate for their site.",
    components: [
      { label: "Google Workspace", keywords: ["google", "workspace"], vendors: ["google"], required: true },
      { label: "Backup",           keywords: ["backup"],              required: true },
      { label: "SSL certificate",  keywords: ["ssl"],                 fixedQty: 1, required: false },
    ],
  },
  {
    id: "microsoft-secure",
    name: "Microsoft 365 + Backup",
    pitch: "Microsoft's own retention is not a backup — this pairs the seats with one.",
    components: [
      { label: "Microsoft 365", keywords: ["microsoft"], vendors: ["microsoft"], required: true },
      { label: "Backup",        keywords: ["backup"],    required: true },
    ],
  },
  {
    id: "domain-starter",
    name: "Domain + Mail Starter",
    pitch: "The whole first-time setup: a domain, mail seats, and a certificate.",
    components: [
      { label: "Domain",          keywords: ["domain"],                vendors: ["domain"], fixedQty: 1, required: true },
      { label: "Mail seats",      keywords: ["workspace"],             required: true },
      { label: "SSL certificate", keywords: ["ssl"],                   fixedQty: 1, required: false },
    ],
  },
];

export interface ResolvedComponent {
  component: BundleComponent;
  item: Item;
  qty: number;
}

export interface UnresolvedComponent {
  component: BundleComponent;
  reason: "not_in_catalog" | "ambiguous";
  /** Names of the tied candidates, when ambiguous. */
  candidates?: string[];
}

export interface ResolvedBundle {
  bundle: SolutionBundle;
  resolved: ResolvedComponent[];
  unresolved: UnresolvedComponent[];
  /** True when every REQUIRED component was found — optional misses do not block. */
  complete: boolean;
}

function matches(item: Item, c: BundleComponent): boolean {
  if (!item.is_active) return false;
  if (c.vendors && !c.vendors.includes(item.vendor)) return false;
  const name = item.name.toLowerCase();
  return c.keywords.every((k) => name.includes(k));
}

/**
 * Resolve a bundle against a catalogue.
 *
 * When several rows match a component, the CHEAPEST is chosen — but only when it is
 * strictly cheaper than the runner-up. An exact tie is ambiguous and is refused:
 * two rows at the same price are two different products, and picking either one
 * decides what the customer receives.
 */
export function resolveBundle(bundle: SolutionBundle, catalog: readonly Item[], seats: number): ResolvedBundle {
  const resolved: ResolvedComponent[] = [];
  const unresolved: UnresolvedComponent[] = [];
  const qtyFor = (c: BundleComponent) => c.fixedQty ?? Math.max(1, Math.trunc(seats) || 1);

  for (const component of bundle.components) {
    const hits = catalog.filter((i) => matches(i, component));

    if (hits.length === 0) {
      unresolved.push({ component, reason: "not_in_catalog" });
      continue;
    }
    if (hits.length === 1) {
      resolved.push({ component, item: hits[0], qty: qtyFor(component) });
      continue;
    }

    const sorted = [...hits].sort((a, b) => a.msrp - b.msrp);
    if (sorted[0].msrp === sorted[1].msrp) {
      unresolved.push({
        component,
        reason: "ambiguous",
        candidates: sorted.filter((i) => i.msrp === sorted[0].msrp).map((i) => i.name),
      });
      continue;
    }
    resolved.push({ component, item: sorted[0], qty: qtyFor(component) });
  }

  const complete = bundle.components
    .filter((c) => c.required)
    .every((c) => resolved.some((r) => r.component === c));

  return { bundle, resolved, unresolved, complete };
}

/**
 * A rep-readable sentence for what could not be added, or null when nothing was
 * missed. §24: it names the gap and the next step, never just "some items missing".
 */
export function bundleGapMessage(r: ResolvedBundle): string | null {
  if (r.unresolved.length === 0) return null;

  const missing  = r.unresolved.filter((u) => u.reason === "not_in_catalog");
  const ambiguous = r.unresolved.filter((u) => u.reason === "ambiguous");
  const parts: string[] = [];

  if (missing.length) {
    parts.push(
      /* Names the nav entry as it actually reads ("Catalog & Products", /items). A
         next-step that points somewhere the user cannot find is the same dead end
         §24 exists to prevent. */
      `${missing.map((u) => u.component.label).join(", ")} ${missing.length === 1 ? "is" : "are"} not in your catalogue — add ${missing.length === 1 ? "it" : "them"} under Catalog & Products, then re-apply the package.`,
    );
  }
  for (const a of ambiguous) {
    parts.push(
      `${a.component.label} matched ${a.candidates?.length ?? 0} catalogue rows at the same price (${a.candidates?.join(", ")}) — add the right one by hand.`,
    );
  }
  return parts.join(" ");
}
