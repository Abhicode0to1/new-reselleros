"use client";
/** Four certificate cards. Positive SSL and Wildcard add to cart; OV/EV routes to quote. */
import { useRouter } from "next/navigation";
import { useCart } from "@/site/components/cart/CartProvider";
import { CERTS } from "@/site/lib/data/catalog";
import { Tick } from "@/site/components/ui/bits";

export function CertCards() {
  const cart = useCart();
  const router = useRouter();

  return (
    <div className="grid-4" style={{ gap: 20 }}>
      {CERTS.map((c) => (
        <div key={c.name} className={`card${c.highlighted ? " card-highlight" : ""}`} style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{c.name}</div>
          <div className="meta" style={{ marginBottom: 10 }}>{c.who}</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", marginBottom: 12 }}>
            {c.price}
            <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)" }}>{c.unit}</span>
          </div>
          <div style={{ flex: 1 }}>
            {c.lines.map((l) => (
              <Tick key={l}>{l}</Tick>
            ))}
          </div>
          <button
            className={`btn btn-sm ${c.highlighted ? "btn-primary" : "btn-outline"}`}
            style={{ marginTop: 16 }}
            disabled={c.cta === "Included"}
            onClick={() => {
              if (c.addPrice !== null) {
                cart.add({
                  label: c.name === "Positive SSL" ? "Positive SSL" : "Wildcard SSL",
                  detail: c.name === "Positive SSL" ? "DV certificate for one domain" : "Covers every subdomain",
                  unitPrice: c.addPrice,
                  unit: "year",
                  cycle: "yearly",
                });
              } else if (c.cta === "Talk to us") {
                router.push("/quote" as never);
              } else {
                router.push("/hosting" as never);
              }
            }}
          >
            {c.cta}
          </button>
        </div>
      ))}
    </div>
  );
}
