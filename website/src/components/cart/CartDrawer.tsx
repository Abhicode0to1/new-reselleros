"use client";
/**
 * The right-hand cart drawer — opens on every add-to-cart (README "Cart drawer").
 *
 * Backdrop rgba(12,17,22,.34) at z-98, panel 400px / max 92vw at z-99, wSlide in. Header
 * carries the green "<item> added" line — the confirmation that the click did something,
 * on the same surface as the next step, which is the whole reason a drawer beats a toast.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCart } from "./CartProvider";
import { rupee, cycleLabel } from "@/lib/money";

export function CartDrawer() {
  const cart = useCart();
  const router = useRouter();
  if (!cart.drawerOpen || cart.lines.length === 0) return null;

  const t = cart.totals;
  const cta =
    cart.lines.length === 1
      ? `Checkout · ${rupee(t.payable)}`
      : `Checkout ${cart.lines.length} items · ${rupee(t.payable)}`;

  return (
    <>
      <div
        onClick={cart.closeDrawer}
        style={{ position: "fixed", inset: 0, background: "rgba(12,17,22,.34)", zIndex: 98, animation: "wFade .18s ease" }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Cart"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: 400, maxWidth: "92vw",
          background: "#fff", zIndex: 99, display: "flex", flexDirection: "column",
          boxShadow: "var(--shadow-drawer)", animation: "wSlide .22s ease",
        }}
      >
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ flex: 1 }}>
            {cart.justAdded && (
              <div className="mono-label" style={{ color: "var(--success)", marginBottom: 4 }}>
                {cart.justAdded} added
              </div>
            )}
            <div style={{ fontSize: 18, fontWeight: 700 }}>Your cart</div>
          </div>
          <button
            onClick={cart.closeDrawer}
            aria-label="Close cart"
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--text-muted)" }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 22px" }}>
          {cart.lines.map((l) => (
            <div key={l.key} style={{ padding: "14px 0", borderBottom: "1px solid var(--border-hairline)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{l.label}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{rupee(l.unitPrice * l.qty)}</div>
              </div>
              <div className="meta" style={{ margin: "3px 0 8px" }}>{l.detail}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 13, color: l.cycle === "monthly" ? "var(--primary)" : "var(--text-muted)" }}>
                  {cycleLabel(l.cycle)}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 6 }}>
                  <button onClick={() => cart.setQty(l.key, -1)} aria-label={`Fewer ${l.label}`} style={stepBtn}>−</button>
                  <span style={{ padding: "4px 10px", fontSize: 14, minWidth: 26, textAlign: "center" }}>{l.qty}</span>
                  <button onClick={() => cart.setQty(l.key, 1)} aria-label={`More ${l.label}`} style={stepBtn}>+</button>
                </span>
                <button
                  onClick={() => cart.remove(l.key)}
                  style={{ background: "none", border: "none", color: "var(--danger)", fontSize: 13, cursor: "pointer" }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <p className="meta" style={{ marginTop: 14 }}>
            Migration from your current provider is free on every plan — we do it, outside your business hours.
          </p>
        </div>

        <div style={{ background: "var(--tint-2)", borderTop: "1px solid var(--border-light)", padding: "16px 22px" }}>
          {t.discount > 0 && (
            <Row label="Discount" value={`−${rupee(t.discount)}`} color="var(--success)" />
          )}
          <Row label="Subtotal" value={rupee(t.subtotal)} />
          <Row label="GST 18%" value={rupee(t.gst)} />
          <Row label="Payable" value={rupee(t.payable)} bold />
          {t.recurring > 0 && (
            <div className="meta" style={{ margin: "6px 0 4px" }}>
              Then {rupee(t.recurring * 1.18)}/month from next month, GST included
            </div>
          )}
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => {
              cart.closeDrawer();
              router.push("/checkout");
            }}
          >
            {cta}
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
            <Link href="/cart" onClick={cart.closeDrawer} style={{ fontSize: 14, color: "var(--primary)", fontWeight: 500 }}>
              View full cart
            </Link>
            <button
              onClick={cart.closeDrawer}
              style={{ background: "none", border: "none", fontSize: 14, color: "var(--text-muted)", cursor: "pointer" }}
            >
              Keep shopping
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

const stepBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  width: 28,
  fontSize: 15,
  cursor: "pointer",
  color: "var(--text-secondary)",
};

function Row({ label, value, color, bold }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: bold ? 17 : 14, fontWeight: bold ? 700 : 400, color: color ?? (bold ? "var(--text)" : "var(--text-secondary)"), padding: "2px 0" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
