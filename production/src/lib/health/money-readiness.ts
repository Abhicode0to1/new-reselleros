/**
 * Is the money machinery actually alive?
 *
 * THE PROBLEM THIS SOLVES. Three separate pieces of this product turned out to
 * be built, wired, tested — and doing nothing, with no way to tell from inside
 * the app:
 *
 *   • Razorpay had keys but no webhook secret, so every payment event was
 *     rejected. Not one of 37 recorded payments came from the webhook. The
 *     Settings card said "Accepting payments".
 *   • Email had no API key, so a renewal reminder would be written to
 *     renewal_email_log and never delivered. Nothing anywhere said so.
 *   • The renewal cadence was healthy, but its first real send is eleven months
 *     out — and a healthy engine's empty log is indistinguishable from a dead
 *     one's.
 *
 * Every one of those is the same shape: a silent gap between "configured" and
 * "working". Fixing them one at a time leaves the next one to be discovered by
 * a customer. So this module states the rules for the whole class in one place,
 * as pure functions over a snapshot of config presence.
 *
 * DESIGN RULES:
 *
 * 1. Booleans only. This module never receives a secret value, so it can never
 *    log or leak one. The caller checks presence; this decides meaning.
 * 2. Silent when healthy. A checklist that always shows something is a
 *    checklist nobody reads. Findings exist only when something is actually
 *    wrong.
 * 3. Severity means consequence, not effort. `critical` is reserved for states
 *    where money or a legal document is lost or double-charged. Anything a
 *    person would merely like to have is `warning` at most.
 * 4. Every finding says what BREAKS, not what is missing. "webhook_secret is
 *    null" is a fact nobody can act on; "customers can pay and the app will
 *    never know" is.
 */

export type HealthSeverity = "critical" | "warning";

export interface HealthFinding {
  /** Stable id — safe to use as a React key or to suppress a known finding. */
  id: string;
  severity: HealthSeverity;
  /** One line. What is broken, in the operator's language. */
  title: string;
  /** What will actually happen if this is left alone. */
  consequence: string;
  /** The single next action. */
  fix: string;
  /** In-app destination for that action, when there is one. */
  href?: string;
}

/**
 * Presence of configuration — never the values themselves.
 * Every field is optional so a caller that cannot determine one (a missing
 * table, a failed query) simply omits it rather than guessing `false` and
 * raising a false alarm.
 */
export interface MoneyConfigSnapshot {
  razorpayKeys?: boolean;
  razorpayWebhookSecret?: boolean;
  /** True when the saved key_id is a live key rather than a test key. */
  razorpayLive?: boolean;
  /** Resend (or equivalent) API key present — false means email is stubbed. */
  emailConfigured?: boolean;
  /** Tenant has a UPI VPA, so invoice PDFs can carry a scan-to-pay QR. */
  upiVpa?: boolean;
  /** CRON_SECRET present — without it the renewal job refuses to run at all. */
  cronSecret?: boolean;
}

export function moneyHealth(cfg: MoneyConfigSnapshot): HealthFinding[] {
  const findings: HealthFinding[] = [];

  // ── Collect without reconcile ────────────────────────────────────────────
  // The worst state in the product: money moves and the app never learns.
  if (cfg.razorpayKeys === true && cfg.razorpayWebhookSecret === false) {
    findings.push({
      id: "razorpay-no-webhook-secret",
      severity: "critical",
      title: cfg.razorpayLive
        ? "Razorpay is LIVE but payments are not being recorded"
        : "Razorpay can take payments but cannot record them",
      consequence:
        "Customers can pay, but Razorpay's confirmation is rejected, so the quote stays " +
        "unpaid, the deal never moves to Won, no tax invoice is raised and MRR does not " +
        "change. Every payment has to be found and entered by hand.",
      fix: "Add the webhook signing secret from Razorpay Dashboard → Settings → Webhooks.",
      href: "/settings?tab=integrations",
    });
  }

  // ── Email silently stubbed ───────────────────────────────────────────────
  // Worse than an outright failure: the send is logged as if it happened, so
  // the app's own records agree that the customer was contacted.
  if (cfg.emailConfigured === false) {
    findings.push({
      id: "email-not-configured",
      severity: "critical",
      title: "Emails are being logged, not sent",
      consequence:
        "Renewal reminders, payment confirmations and invoice emails are recorded as sent " +
        "and never reach anyone. A renewal can lapse with the app showing that the customer " +
        "was reminded six times.",
      fix: "Set RESEND_API_KEY in your deployment's environment variables.",
    });
  }

  // ── Cron disabled ────────────────────────────────────────────────────────
  if (cfg.cronSecret === false) {
    findings.push({
      id: "cron-secret-missing",
      severity: "critical",
      title: "Renewal automation is switched off",
      consequence:
        "The daily job refuses to run without a secret (it fails closed rather than letting " +
        "anyone trigger it). No renewal reminders go out and nothing is suspended — renewals " +
        "will simply pass their date unnoticed.",
      fix: "Set CRON_SECRET in your deployment's environment variables.",
    });
  }

  // ── Razorpay is on TEST credentials ──────────────────────────────────────
  // Measured 14 Aug 2026: this workspace has razorpay_mode 'test' and a
  // rzp_test_ key id, with a webhook secret present. Every other check passes, so
  // the panel said nothing at all — keys present, webhook present, no findings —
  // while a real customer clicking Pay could not actually pay. `razorpayLive` was
  // already computed and only used to reword a different finding, so the one fact
  // an operator most needs was being collected and thrown away.
  //
  // WARNING rather than critical, deliberately. During a build or soft launch test
  // mode is the CORRECT state, and a permanent critical alert for a correct state
  // is how a health panel trains people to ignore it. The wording carries the
  // weight instead: it says plainly that real customers cannot pay.
  if (cfg.razorpayKeys === true && cfg.razorpayLive === false) {
    findings.push({
      id: "razorpay-test-mode",
      severity: "warning",
      title: "Razorpay is on TEST keys — real customers cannot pay",
      consequence:
        "Online checkout and payment links will not take real money. Test-mode payments look " +
        "successful and settle nothing, so an order can appear paid while no funds exist.",
      fix: "Correct while you are still testing. Before taking real orders, swap in the live " +
           "key id and secret from the Razorpay dashboard (they start rzp_live_), and set the " +
           "live webhook secret too — the test and live webhook secrets are different.",
      href: "/settings",
    });
  }

  // ── No UPI ID ────────────────────────────────────────────────────────────
  // Not critical: nothing breaks, an invoice is just harder to pay. Kept at
  // warning so it can never crowd out a finding that costs money.
  if (cfg.upiVpa === false) {
    findings.push({
      id: "upi-vpa-missing",
      severity: "warning",
      title: "Invoices have no scan-to-pay QR",
      consequence:
        "Customers must copy the bank details by hand, which is the slowest way to get paid " +
        "and the easiest to put off.",
      fix: "Add your UPI ID in Settings → Company.",
      href: "/settings",
    });
  }

  return findings;
}

/** Highest severity present, or null when everything checked is healthy. */
export function worstSeverity(findings: HealthFinding[]): HealthSeverity | null {
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.length > 0) return "warning";
  return null;
}
