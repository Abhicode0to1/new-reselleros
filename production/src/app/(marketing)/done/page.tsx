"use client";
/**
 * Order / trial confirmation. Checkout leaves one of two things in sessionStorage:
 * `anutech.order` (the quote number of a paid order) or `anutech.trial` (the email a
 * free hosting trial's confirmation link went to — 24 Sep 2026, when the trial moved
 * into the cart).
 *
 * Neither is invented when missing. This page used to default to the order number
 * "ORD-ADPL-2026-4107", which belongs to no order, so a reload or a new tab told the
 * customer a number that support could never find (AGENTS.md §2).
 */
import Link from "@/site/components/ui/SiteLink";
import { useEffect, useState } from "react";
import { COMPANY } from "@/site/lib/config";

export default function DonePage() {
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [trialEmail, setTrialEmail] = useState<string | null>(null);
  /* False only when the server said the confirmation link did NOT go out (30 Sep 2026). */
  const [trialSent, setTrialSent] = useState(true);
  useEffect(() => {
    try {
      setOrderNo(window.sessionStorage.getItem("anutech.order") || null);
      setTrialEmail(window.sessionStorage.getItem("anutech.trial") || null);
      setTrialSent(window.sessionStorage.getItem("anutech.trial.sent") !== "0");
    } catch { /* storage blocked: the generic wording below still holds */ }
  }, []);

  if (trialEmail && !trialSent) {
    return (
      <section className="section rise">
        <div className="wrap" style={{ maxWidth: 640 }}>
          <div className="mono-label" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 999, background: "#FFFBEB", color: "#92400E", border: "1px solid #FDE68A", marginBottom: 22 }}>
            TRIAL SAVED · CONFIRMATION EMAIL NOT SENT
          </div>
          <h1 className="h1-narrow" style={{ marginBottom: 14 }}>Your trial is saved — but the email did not go out.</h1>
          <p className="body-lg" style={{ margin: "0 0 10px" }}>
            We tried to send the confirmation link to <strong>{trialEmail}</strong> and it did not go
            through. Nothing was charged, and your request is with us.
          </p>
          <p className="body-lg" style={{ margin: "0 0 26px" }}>
            Write to <a href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent("Please start my hosting trial")}`} style={{ color: "var(--primary)", fontWeight: 600 }}>{COMPANY.supportEmail}</a> from
            that address and we will start the trial for you. If the address was mistyped, start again
            with the right one.
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <Link href="/hosting" className="btn btn-primary">Back to hosting</Link>
            <Link href="/" className="btn btn-outline">Back to home</Link>
          </div>
        </div>
      </section>
    );
  }

  if (trialEmail) {
    return (
      <section className="section rise">
        <div className="wrap" style={{ maxWidth: 640 }}>
          <div className="mono-label" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)", marginBottom: 22 }}>
            TRIAL REQUESTED · NOTHING CHARGED
          </div>
          <h1 className="h1-narrow" style={{ marginBottom: 14 }}>One step left — confirm your email.</h1>
          <p className="body-lg" style={{ margin: "0 0 10px" }}>
            We sent a link to <strong>{trialEmail}</strong>. Open it within 48 hours and we set up your
            Starter hosting account and email your login. Your 15 free days start then.
          </p>
          <p className="body-lg" style={{ margin: "0 0 26px" }}>
            No card was taken, so nothing can be charged when the trial ends. Moving from another host?
            Reply to that email with your current login — the migration is free.
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <Link href="/hosting" className="btn btn-primary">Back to hosting</Link>
            <Link href="/" className="btn btn-outline">Back to home</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section rise">
      <div className="wrap" style={{ maxWidth: 640 }}>
        <div className="mono-label" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 999, background: "#EEF7F0", color: "var(--success)", border: "1px solid var(--success)", marginBottom: 22 }}>
          ORDER PLACED
        </div>
        <h1 className="h1-narrow" style={{ marginBottom: 14 }}>
          {orderNo ? <>Done — order <span className="mono">{orderNo}</span> is with us.</> : <>Done — your order is with us.</>}
        </h1>
        <p className="body-lg" style={{ margin: "0 0 10px" }}>
          The GST invoice and receipt reach your inbox shortly{orderNo ? "" : ", and they carry your order number"}. UPI,
          netbanking and card orders activate immediately; NEFT and RTGS activate when the credit lands.
        </p>
        <p className="body-lg" style={{ margin: "0 0 26px" }}>
          If a migration is part of the order, the migration desk messages you on WhatsApp today to
          schedule it — outside your business hours.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <Link href="/dashboard" className="btn btn-primary">Open the client area</Link>
          <Link href="/" className="btn btn-outline">Back to home</Link>
        </div>
      </div>
    </section>
  );
}
