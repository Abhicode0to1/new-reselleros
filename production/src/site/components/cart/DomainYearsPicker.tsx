"use client";
/**
 * "Register for: 1 year ▾" on a domain line (lib/checkout/domain-years.ts). Renders nothing
 * while multi-year domains are switched off, or on any line that is not a domain.
 */
import { DOMAIN_YEAR_OPTIONS, multiYearDomainsOn, yearsLabel } from "@/lib/checkout/domain-years";
import type { CartLine } from "@/site/lib/money";
import { useCart } from "./CartProvider";

export default function DomainYearsPicker({ line }: { line: CartLine }) {
  const cart = useCart();
  if (!multiYearDomainsOn() || !(line.sku ?? "").toLowerCase().startsWith("domain:")) return null;
  const years = line.years ?? 1;
  const id = `years-${line.key}`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <label htmlFor={id} className="meta" style={{ fontSize: 13 }}>Register for</label>
      <select
        id={id}
        value={years}
        onChange={(e) => cart.setYears(line.key, Number(e.target.value))}
        style={{ minHeight: 32, padding: "2px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, background: "var(--bg-white, #fff)", fontSize: 14 }}
      >
        {DOMAIN_YEAR_OPTIONS.map((y) => (
          <option key={y} value={y}>{yearsLabel(y)}</option>
        ))}
      </select>
    </span>
  );
}

/** The line's small print once more than one year is chosen. */
export function domainYearsNote(line: Pick<CartLine, "years">): string | null {
  const y = line.years ?? 1;
  return y > 1 ? `The exact price for ${yearsLabel(y)} is confirmed at checkout` : null;
}

/** "Renews after 3 years" in place of "Renews yearly" for a domain bought for several years. */
export function domainCycleLabel(line: Pick<CartLine, "years">, fallback: string): string {
  const y = line.years ?? 1;
  return y > 1 ? `Renews after ${yearsLabel(y)}` : fallback;
}
