"use client";
/**
 * The domains rate card: Popular / Business / Tech filter pills over the six-column table.
 * Register renders in primary-blue mono; Add drops a first-year registration in the cart
 * (with the placeholder name, exactly as the handoff does — the search card is where a real
 * name gets added).
 */
import { useState } from "react";
import { useCart } from "@/components/cart/CartProvider";
import { rupee } from "@/lib/money";
import { TLDS, type Tld } from "@/lib/data/catalog";

const GROUPS = ["Popular", "Business", "Tech"] as const;

export function DomainRateCard() {
  const [group, setGroup] = useState<(typeof GROUPS)[number]>("Popular");
  const cart = useCart();

  const add = (t: Tld) =>
    cart.add({
      label: "yourbusiness" + t.tld,
      detail: `Domain registration · renews ${rupee(t.renew)}/yr`,
      unitPrice: t.reg,
      unit: "year",
      cycle: "yearly",
    });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {GROUPS.map((g) => (
          <button key={g} className="chip" aria-pressed={group === g} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
      </div>
      <div className="tablewrap" style={{ background: "#fff" }}>
        <table className="rates" style={{ minWidth: 820 }}>
          <thead>
            <tr>
              <th>Extension</th><th>Register</th><th>Renew</th><th>Transfer</th><th>Good for</th><th></th>
            </tr>
          </thead>
          <tbody>
            {TLDS.filter((t) => t.group === group).map((t) => (
              <tr key={t.tld}>
                <td className="mono" style={{ color: "var(--primary)", fontWeight: 500 }}>{t.tld}</td>
                <td style={{ fontWeight: 600 }}>{rupee(t.reg)}</td>
                <td>{rupee(t.renew)}</td>
                <td>{rupee(t.transfer)}</td>
                <td className="meta">{t.use}</td>
                <td>
                  <button
                    onClick={() => add(t)}
                    style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)", border: "1px solid #9FC5F3", borderRadius: 5, background: "#fff", padding: "5px 12px", cursor: "pointer" }}
                  >
                    Add
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
