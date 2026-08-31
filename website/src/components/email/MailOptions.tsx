"use client";
/**
 * Three mailbox option cards. Anutech Mail is highlighted and adds straight to cart;
 * Workspace and M365 route to the quote page — a licence order needs a headcount and a
 * term before a price means anything, which is exactly what the quote form collects.
 */
import { useRouter } from "next/navigation";
import { useCart } from "@/components/cart/CartProvider";
import { rupee } from "@/lib/money";
import { MAIL_RATES } from "@/lib/data/catalog";
import { MAIL_OPTIONS } from "@/lib/data/copy";
import { Tick } from "@/components/ui/bits";

export function MailOptions() {
  const cart = useCart();
  const router = useRouter();

  return (
    <div className="grid-3">
      {MAIL_OPTIONS.map((m) => (
        <div key={m.name} className={`card${m.highlighted ? " card-highlight" : ""}`} style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{m.name}</div>
          <div className="meta" style={{ marginBottom: 12 }}>{m.who}</div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 14 }}>
            {rupee(MAIL_RATES[m.name])}
            <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)" }}>/mailbox/mo</span>
          </div>
          <div style={{ flex: 1 }}>
            {m.lines.map((l) => (
              <Tick key={l}>{l}</Tick>
            ))}
          </div>
          <button
            className={`btn ${m.highlighted ? "btn-primary" : "btn-outline"}`}
            style={{ marginTop: 18 }}
            onClick={() =>
              m.highlighted
                ? cart.add({ label: "Anutech Mail", detail: "Hosted in India · add or remove seats monthly", unitPrice: MAIL_RATES["Anutech Mail"], unit: "mailbox", cycle: "monthly" })
                : router.push("/quote")
            }
          >
            {m.cta}
          </button>
        </div>
      ))}
    </div>
  );
}
