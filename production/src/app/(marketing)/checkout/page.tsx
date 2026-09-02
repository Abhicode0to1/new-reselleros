"use client";
/**
 * Two-step checkout. Step 1 collects who the invoice is for (GSTIN optional); step 2 shows
 * four payment methods as selectable rows and a terms checkbox that GATES the pay button —
 * disabled at #C8D4E4 with cursor not-allowed until ticked, per the handoff.
 *
 * ⚠️ No real payment happens here yet. Razorpay integration is a launch task; until then
 * "Pay" records the order locally and lands on /done, which is exactly what the design
 * prototype did. The button says the amount so nobody can claim the total surprised them.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/site/components/cart/CartProvider";
import { rupee, cycleLabel } from "@/site/lib/money";

const METHODS = [
  { label: "UPI", note: "GPay, PhonePe, Paytm — instant" },
  { label: "Netbanking", note: "All major Indian banks" },
  { label: "Card", note: "Visa, Mastercard, RuPay" },
  { label: "Bank transfer", note: "NEFT/RTGS — activated on credit" },
] as const;

export default function CheckoutPage() {
  const cart = useCart();
  const router = useRouter();
  const t = cart.totals;

  const [step, setStep] = useState<"details" | "payment">("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<string>("UPI");
  const [agreed, setAgreed] = useState(false);

  if (cart.lines.length === 0) {
    return (
      <section className="section rise">
        <div className="wrap" style={{ maxWidth: 640 }}>
          <h1 className="h1-narrow" style={{ marginBottom: 16 }}>Checkout</h1>
          <p className="body-lg">The cart is empty — nothing to pay for.</p>
        </div>
      </section>
    );
  }

  const detailsOk = name.trim().length >= 2 && email.includes("@") && phone.trim().length >= 10;

  const placeOrder = () => {
    if (!agreed) return;
    const orderNo = "ORD-ADPL-2026-" + String(4100 + cart.lines.length * 7).padStart(4, "0");
    try { window.sessionStorage.setItem("anutech.order", orderNo); } catch { /* shown from the default */ }
    cart.clear();
    router.push("/done" as never);
  };

  return (
    <section className="section rise">
      <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.2fr .8fr", gap: 40, alignItems: "start" }} data-grid>
        <div>
          <h1 className="h1-narrow" style={{ marginBottom: 6 }}>Checkout</h1>
          <p className="meta" style={{ marginBottom: 24 }}>
            {step === "details" ? "Step 1 of 2 — who the invoice is for" : "Step 2 of 2 — how you would like to pay"}
          </p>

          {step === "details" ? (
            <div style={{ maxWidth: 460 }}>
              <Field label="NAME" value={name} onChange={setName} />
              <Field label="EMAIL — THE GST INVOICE GOES HERE" value={email} onChange={setEmail} type="email" />
              <Field label="GSTIN (OPTIONAL — FOR INPUT CREDIT)" value={gstin} onChange={setGstin} mono />
              <Field label="MOBILE" value={phone} onChange={setPhone} type="tel" />
              <button className="btn btn-primary" style={{ width: "100%", marginTop: 8 }} disabled={!detailsOk} onClick={() => setStep("payment")}>
                Continue
              </button>
            </div>
          ) : (
            <div style={{ maxWidth: 460 }}>
              {METHODS.map((m) => {
                const on = method === m.label;
                return (
                  <button
                    key={m.label}
                    onClick={() => setMethod(m.label)}
                    aria-pressed={on}
                    style={{
                      display: "flex", width: "100%", textAlign: "left", alignItems: "center", gap: 12,
                      border: on ? "2px solid var(--primary)" : "1px solid var(--border)",
                      background: on ? "var(--tint)" : "#fff",
                      borderRadius: 8, padding: "14px 16px", marginBottom: 10, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    <span aria-hidden style={{ color: on ? "var(--primary)" : "#B8C0C9", fontSize: 16 }}>{on ? "●" : "○"}</span>
                    <span>
                      <span style={{ display: "block", fontSize: 15, fontWeight: 600 }}>{m.label}</span>
                      <span className="meta">{m.note}</span>
                    </span>
                  </button>
                );
              })}

              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", margin: "16px 0", cursor: "pointer" }}>
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 3, accentColor: "var(--primary)" }} />
                <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                  I have read the terms of service and the refund policy, including that domain
                  registrations are non-refundable once submitted to the registry.
                </span>
              </label>

              <button
                className="btn"
                style={{
                  width: "100%",
                  background: agreed ? "var(--primary)" : "#C8D4E4",
                  color: "#fff",
                  cursor: agreed ? "pointer" : "not-allowed",
                }}
                disabled={!agreed}
                onClick={placeOrder}
              >
                Pay {rupee(t.payable)}
              </button>
              <button
                onClick={() => setStep("details")}
                style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer", marginTop: 12 }}
              >
                ← Back to details
              </button>
            </div>
          )}
        </div>

        {/* Sticky — payment method chunte waqt total nazron me rahe. */}
        <aside className="card" style={{ position: "sticky", top: 84 }}>
          {cart.lines.map((l) => (
            <div key={l.key} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-hairline)" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{l.label} × {l.qty}</div>
                <div className="meta" style={{ fontSize: 12 }}>{cycleLabel(l.cycle)}</div>
              </div>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{rupee(l.unitPrice * l.qty)}</span>
            </div>
          ))}
          <div style={{ paddingTop: 10 }}>
            {t.discount > 0 && <Row label="Discount" value={`−${rupee(t.discount)}`} color="var(--success)" />}
            <Row label="Subtotal" value={rupee(t.subtotal)} />
            <Row label="GST 18%" value={rupee(t.gst)} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Payable</span>
              <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.03em" }}>{rupee(t.payable)}</span>
            </div>
            {t.recurring > 0 && (
              <div className="meta">Then {rupee(t.recurring * 1.18)}/month from next month, GST included</div>
            )}
            <div className="meta" style={{ marginTop: 10 }}>
              GST invoice with GSTIN issued on every order — it reaches your inbox with the receipt.
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Field({ label, value, onChange, type = "text", mono }: { label: string; value: string; onChange: (v: string) => void; type?: string; mono?: boolean }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 6 }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "11px 12px", fontSize: 15, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
      />
    </label>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "2px 0", color: color ?? "var(--text-secondary)" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
