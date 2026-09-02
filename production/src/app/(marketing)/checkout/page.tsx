"use client";
/**
 * Two-step checkout. Step 1 collects who the invoice is for (GSTIN optional, plus the
 * hosting domain when a hosting line is in the cart); step 2 shows the payment methods
 * and a terms checkbox that GATES the pay button until ticked.
 *
 * Real payment (2 Sep 2026): "Pay" now calls /api/public/checkout/cart — which re-prices
 * every line SERVER-SIDE from its SKU (the client price is never trusted), creates a draft
 * quote, and returns a Razorpay order. The Razorpay widget opens; on success the webhook
 * flips the quote to paid, creates the customer/subscription/invoice and queues provisioning.
 * A line with no server-priceable SKU is refused with a clear message (request a quote).
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

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";
interface RzpCtor { new (opts: Record<string, unknown>): { open: () => void; on: (e: string, cb: (r: { error?: { description?: string } }) => void) => void }; }

/** Read the Razorpay global via a cast — a `declare global` here would clash with
 *  the one in buy-workspace-client.tsx (same property, different local type). */
function rzpGlobal(): RzpCtor | undefined {
  return (window as unknown as { Razorpay?: RzpCtor }).Razorpay;
}

function loadRazorpay(): Promise<RzpCtor> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    const have = rzpGlobal();
    if (have) return resolve(have);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => { const g = rzpGlobal(); g ? resolve(g) : reject(new Error("no global")); });
      existing.addEventListener("error", () => reject(new Error("load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = RAZORPAY_SRC; s.async = true;
    s.onload = () => { const g = rzpGlobal(); g ? resolve(g) : reject(new Error("no global")); };
    s.onerror = () => reject(new Error("load failed"));
    document.body.appendChild(s);
  });
}

export default function CheckoutPage() {
  const cart = useCart();
  const router = useRouter();
  const t = cart.totals;

  const [step, setStep] = useState<"details" | "payment">("details");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [gstin, setGstin] = useState("");
  const [phone, setPhone] = useState("");
  const [domain, setDomain] = useState("");
  const [method, setMethod] = useState<string>("UPI");
  const [agreed, setAgreed] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasHosting = cart.lines.some((l) => (l.sku || "").startsWith("hosting:"));

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

  const detailsOk =
    name.trim().length >= 2 &&
    company.trim().length >= 2 &&
    email.includes("@") &&
    phone.trim().length >= 10 &&
    (!hasHosting || domain.trim().length >= 3);

  async function placeOrder() {
    if (!agreed || paying) return;
    setPaying(true);
    setError(null);
    try {
      const res = await fetch("/api/public/checkout/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: name.trim(),
          companyName: company.trim(),
          email: email.trim(),
          phone: phone.trim(),
          gstin: gstin.trim() || undefined,
          domain: hasHosting ? domain.trim() : undefined,
          lines: cart.lines.map((l) => ({ sku: l.sku, label: l.label, qty: l.qty, cycle: l.cycle })),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean; simulated?: boolean; orderId?: string; amount?: number;
        currency?: string; razorpayKeyId?: string; quoteId?: string; error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error || "Could not start checkout. Please retry.");

      if (json.simulated) {
        try { window.sessionStorage.setItem("anutech.order", json.quoteId || ""); } catch { /* default shown */ }
        cart.clear();
        router.push("/done" as never);
        return;
      }

      if (!json.orderId || !json.razorpayKeyId || !json.amount) {
        throw new Error("Payment details missing from server. Please retry.");
      }
      const Razorpay = await loadRazorpay();
      const rzp = new Razorpay({
        key: json.razorpayKeyId,
        amount: json.amount,
        currency: json.currency ?? "INR",
        name: "ANUTECH DIGITAL PVT LTD",
        description: `Order ${json.quoteId ?? ""}`,
        order_id: json.orderId,
        prefill: { name, email, contact: phone },
        notes: { quoteId: json.quoteId ?? "", domain: hasHosting ? domain.trim() : "" },
        theme: { color: "#C2410C" },
        handler: () => {
          try { window.sessionStorage.setItem("anutech.order", json.quoteId || ""); } catch { /* default */ }
          cart.clear();
          router.push("/done" as never);
        },
        modal: { ondismiss: () => setPaying(false), escape: true },
      });
      rzp.on("payment.failed", (resp) => {
        setError(`Payment failed: ${resp.error?.description ?? "Please retry or WhatsApp us."}`);
        setPaying(false);
      });
      rzp.open();
    } catch (err) {
      setError((err as Error).message);
      setPaying(false);
    }
  }

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
              <Field label="YOUR NAME" value={name} onChange={setName} />
              <Field label="COMPANY / BUSINESS NAME — ON THE GST INVOICE" value={company} onChange={setCompany} />
              <Field label="EMAIL — THE GST INVOICE GOES HERE" value={email} onChange={setEmail} type="email" />
              <Field label="GSTIN (OPTIONAL — FOR INPUT CREDIT)" value={gstin} onChange={setGstin} mono />
              <Field label="MOBILE" value={phone} onChange={setPhone} type="tel" />
              {hasHosting && (
                <Field label="DOMAIN FOR YOUR HOSTING (e.g. yourcompany.in)" value={domain} onChange={setDomain} mono />
              )}
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

              {error && (
                <div style={{ background: "#FEF2F2", border: "1px solid #FECACA", color: "#B91C1C", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>{error}</div>
              )}

              <button
                className="btn"
                style={{
                  width: "100%",
                  background: agreed && !paying ? "var(--primary)" : "#C8D4E4",
                  color: "#fff",
                  cursor: agreed && !paying ? "pointer" : "not-allowed",
                }}
                disabled={!agreed || paying}
                onClick={placeOrder}
              >
                {paying ? "Starting secure payment…" : `Pay ${rupee(t.payable)}`}
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
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-hairline)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12.5, color: "var(--text-muted)" }}>
              <span aria-hidden>🔒</span>
              <span>Payments secured &amp; powered by</span>
              <RazorpayMark />
            </div>
            <div className="meta" style={{ textAlign: "center", marginTop: 4, fontSize: 11.5 }}>UPI · Cards · Netbanking · Wallets</div>
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

/** "Powered by Razorpay" mark — the slanted glyph + wordmark in Razorpay's blues.
 *  Rendered inline (no external image) so it never breaks; the real Razorpay-branded
 *  secure modal (with the full logo) opens when the customer taps Pay. */
function RazorpayMark() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <svg width="13" height="13" viewBox="0 0 40 40" aria-hidden style={{ display: "block" }}>
        <path d="M23 3 L31 3 L17 37 L9 37 Z" fill="#3395FF" />
        <path d="M15 13 L25 13 L20 30 L13 30 Z" fill="#0A1F44" />
      </svg>
      <span style={{ fontWeight: 700, color: "#0A1F44", fontSize: 13.5, letterSpacing: "-0.01em" }}>Razorpay</span>
    </span>
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
