"use client";
/**
 * The three hosting plan cards under the Yearly −20% / Monthly toggle.
 *
 * The toggle changes BOTH the figure and what gets added to cart: yearly adds one prepaid
 * 12-month line (cycle "yearly"), monthly adds a recurring line (cycle "monthly"). The
 * handoff is explicit that the cycle drives the cart's row label and the recurring total.
 */
import { useState } from "react";
import { useCart } from "@/components/cart/CartProvider";
import { rupee } from "@/lib/money";
import { HOSTING_PLANS } from "@/lib/data/catalog";
import { Tick } from "@/components/ui/bits";

export function HostingPlans({ highlight = "Business" }: { highlight?: string }) {
  const [yearly, setYearly] = useState(true);
  const cart = useCart();

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <div role="group" aria-label="Billing cycle" style={{ display: "inline-flex", background: "#F2F5F9", borderRadius: 999, padding: 4 }}>
          {(
            [
              ["Yearly −20%", true],
              ["Monthly", false],
            ] as const
          ).map(([label, isYearly]) => (
            <button
              key={label}
              aria-pressed={yearly === isYearly}
              onClick={() => setYearly(isYearly)}
              style={{
                border: "none", borderRadius: 999, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer",
                background: yearly === isYearly ? "var(--dark)" : "transparent",
                color: yearly === isYearly ? "#fff" : "var(--text-secondary)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid-3">
        {HOSTING_PLANS.map((p) => {
          const on = p.name === highlight;
          const price = yearly ? p.yearly : p.monthly;
          return (
            <div key={p.name} className={`card${on ? " card-highlight" : ""}`} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{p.name}</div>
              <div className="meta" style={{ marginBottom: 14 }}>For {p.who}</div>
              <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.03em" }}>
                {rupee(price)}<span style={{ fontSize: 15, fontWeight: 400, color: "var(--text-muted)" }}>/mo</span>
              </div>
              <div className="meta" style={{ marginBottom: 16 }}>
                {yearly ? `Billed yearly · ${rupee(price * 12)}/yr` : "Billed monthly · cancel any time"}
              </div>
              <div style={{ flex: 1 }}>
                {p.lines.map((l) => (
                  <Tick key={l}>{l}</Tick>
                ))}
              </div>
              <button
                className={`btn ${on ? "btn-primary" : "btn-outline"}`}
                style={{ marginTop: 18 }}
                onClick={() =>
                  cart.add(
                    yearly
                      ? { label: `${p.name} hosting`, detail: "cPanel hosting · 12 months prepaid", unitPrice: price * 12, unit: "year", cycle: "yearly" }
                      : { label: `${p.name} hosting`, detail: "cPanel hosting · billed monthly, cancel any time", unitPrice: price, unit: "month", cycle: "monthly" },
                  )
                }
              >
                Choose {p.name}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
