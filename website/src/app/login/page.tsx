"use client";
/**
 * Client login — magic-link UI, per the handoff's 420px column. ⚠️ No auth backend exists
 * on the website yet; the confirmation panel says the link is on its way only in DEMO terms
 * and the page links to the demo client area. Wiring real magic-link auth (or pointing this
 * at the ResellerOS customer portal) is a launch decision.
 */
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  return (
    <section className="section rise">
      <div style={{ maxWidth: 420, margin: "0 auto", padding: "0 20px" }}>
        <Image src="/anutech-logo.png" alt="" width={40} height={40} style={{ objectFit: "contain", marginBottom: 18 }} />
        <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.04em", marginBottom: 10 }}>Client login</h1>
        <p className="body" style={{ margin: "0 0 22px" }}>
          No password. Enter the email your account uses and we send a one-time sign-in link.
        </p>
        <label className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 6 }}>EMAIL</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "12px 13px", fontSize: 15, fontFamily: "inherit", marginBottom: 14 }}
        />
        <button className="btn btn-primary" style={{ width: "100%" }} disabled={!email.includes("@")} onClick={() => setSent(true)}>
          Send me a sign-in link
        </button>
        <p className="meta" style={{ marginTop: 14 }}>
          Just looking? <Link href="/dashboard" style={{ color: "var(--primary)" }}>Open the demo client area</Link>
        </p>
        {sent && (
          <div style={{ marginTop: 16, border: "1px solid var(--success)", background: "#EEF7F0", borderRadius: 8, padding: 16 }}>
            <div className="mono-label" style={{ color: "var(--success)", marginBottom: 6 }}>DEMO — NO LINK ACTUALLY SENT</div>
            <p style={{ fontSize: 14, margin: 0, color: "var(--text-secondary)" }}>
              Login goes live with the client-area launch. Until then the demo client area shows what
              you will see inside.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
