/**
 * Google Workspace DNS verification — pure spec logic.
 *
 * THE PROBLEM THIS SOLVES. Provisioning a Workspace tenant stalls on the
 * customer's DNS more often than on anything else: the TXT token is pasted into
 * the wrong zone, the old mail provider's MX records are left in place alongside
 * Google's, or someone adds a second SPF record and quietly breaks deliverability
 * for the whole domain. Today that is diagnosed by reading `nslookup` output over
 * a phone call.
 *
 * This module holds the JUDGEMENT — what Google's specification actually requires
 * — separately from the lookup, so the rules are unit-testable without a network.
 * The lookup lives in the API route.
 *
 * THREE THINGS THAT MAKE OR BREAK A CHECKER LIKE THIS:
 *
 * 1. BOTH MX layouts are correct. Google's current guidance is a single
 *    `smtp.google.com` at priority 1; the older, still fully supported layout is
 *    five ASPMX hosts at priorities 1/5/5/10/10. A checker that knows only one
 *    tells a working domain it is broken — and a false alarm on someone else's
 *    live mail is worse than no check, because it invites them to "fix" what
 *    already works.
 *
 * 2. DNS answers are not normalised. Hosts come back with a trailing dot and in
 *    arbitrary case ("ASPMX.L.GOOGLE.COM." vs "aspmx.l.google.com"), and TXT
 *    values arrive wrapped in quotes and sometimes split into chunks.
 *
 * 3. Extra records matter as much as missing ones. A leftover MX from the
 *    previous provider silently steals mail; two SPF records is a hard failure by
 *    RFC 7208 rather than a warning. Reporting only what is absent misses the
 *    faults that actually lose email.
 */

/** A normalised MX answer. */
export interface MxRecord {
  priority: number;
  host: string;
}

export type CheckState = "pass" | "warn" | "fail" | "missing";

export interface DnsCheck {
  id: "mx" | "txt" | "spf";
  label: string;
  state: CheckState;
  /** One line the operator can read out to the customer. */
  detail: string;
  /** Exact values to add, when something is missing. Safe to render as copy buttons. */
  expected?: string[];
  /** What was actually found, for the "why do you say it's wrong" conversation. */
  found?: string[];
}

// ── Google's published values ────────────────────────────────────────────────

/** Current single-host layout. */
const MX_MODERN: MxRecord[] = [{ priority: 1, host: "smtp.google.com" }];

/** Legacy five-host layout — still valid and still very common. */
const MX_LEGACY: MxRecord[] = [
  { priority: 1,  host: "aspmx.l.google.com" },
  { priority: 5,  host: "alt1.aspmx.l.google.com" },
  { priority: 5,  host: "alt2.aspmx.l.google.com" },
  { priority: 10, host: "alt3.aspmx.l.google.com" },
  { priority: 10, host: "alt4.aspmx.l.google.com" },
];

const SPF_INCLUDE = "include:_spf.google.com";

/** Strip the trailing dot and lower-case a DNS name. */
export function normaliseHost(host: string): string {
  return host.trim().replace(/\.$/, "").toLowerCase();
}

/**
 * Parse an MX rdata string ("1 smtp.google.com.") into a record.
 * Returns null for anything that isn't a priority followed by a host.
 */
export function parseMx(rdata: string): MxRecord | null {
  const m = /^\s*(\d{1,5})\s+(\S+)\s*$/.exec(rdata);
  if (!m) return null;
  const priority = Number(m[1]);
  const host = normaliseHost(m[2]);
  if (!host || host === ".") return null;
  return { priority, host };
}

/** Unwrap a TXT answer: strip surrounding quotes and join split chunks. */
export function normaliseTxt(rdata: string): string {
  return rdata
    .split(/"\s*"/)          // DNS splits strings >255 bytes into adjacent chunks
    .join("")
    .replace(/^"|"$/g, "")
    .trim();
}

const isGoogleMx = (host: string) =>
  host === "smtp.google.com" || /(^|\.)aspmx[0-9]*\.l\.google\.com$/.test(host) || host.endsWith(".googlemail.com");

/**
 * Judge the MX records.
 *
 * Accepts either published layout. Extra non-Google MX hosts are a FAIL, not a
 * warning: while they are present some mail goes to the old provider, which looks
 * to the customer like Workspace losing email.
 */
export function checkMx(records: MxRecord[]): DnsCheck {
  const found = records.map((r) => `${r.priority} ${r.host}`);
  if (records.length === 0) {
    return {
      id: "mx", label: "MX records", state: "missing",
      detail: "No MX records found — mail cannot be delivered to this domain yet.",
      expected: MX_MODERN.map((r) => `${r.priority} ${r.host}`),
    };
  }

  const foreign = records.filter((r) => !isGoogleMx(r.host));
  const google  = records.filter((r) => isGoogleMx(r.host));

  if (google.length === 0) {
    return {
      id: "mx", label: "MX records", state: "fail",
      detail: `Mail is pointed somewhere else (${foreign.map((r) => r.host).join(", ")}). Replace these with Google's MX records.`,
      expected: MX_MODERN.map((r) => `${r.priority} ${r.host}`), found,
    };
  }

  if (foreign.length > 0) {
    return {
      id: "mx", label: "MX records", state: "fail",
      detail: `Google's MX records are present, but so are ${foreign.length} from another provider (${foreign.map((r) => r.host).join(", ")}). Mail will split between the two — remove them.`,
      found,
    };
  }

  const hosts = new Set(google.map((r) => r.host));
  const isModern = hosts.size === 1 && hosts.has("smtp.google.com");
  const legacyHosts = new Set(MX_LEGACY.map((r) => r.host));
  const isLegacyComplete = MX_LEGACY.every((want) => google.some((r) => r.host === want.host));

  if (isModern) {
    const wrongPriority = google.find((r) => r.priority !== 1);
    return {
      id: "mx", label: "MX records",
      state: wrongPriority ? "warn" : "pass",
      detail: wrongPriority
        ? `smtp.google.com is set at priority ${wrongPriority.priority}; Google publishes it at 1. Mail will still work, but set it to 1 to match the spec.`
        : "Correct — the current single-host Google layout.",
      found,
    };
  }

  if (isLegacyComplete) {
    return {
      id: "mx", label: "MX records", state: "pass",
      detail: "Correct — the older five-host Google layout, which is still fully supported.",
      found,
    };
  }

  // Some Google hosts, but neither layout complete.
  const missing = MX_LEGACY.filter((w) => !hosts.has(w.host) && legacyHosts.has(w.host));
  return {
    id: "mx", label: "MX records", state: "warn",
    detail: "Google MX records are partly set up. Mail will mostly work, but a missing backup host means delivery retries can fail during an outage.",
    expected: missing.map((r) => `${r.priority} ${r.host}`), found,
  };
}

/**
 * Judge the site-verification TXT record.
 *
 * `expectedToken` is what the Google console issued for this domain. When it is
 * unknown we can only report whether ANY Google token is present — which is still
 * useful, and honestly labelled as such rather than reported as a pass.
 */
export function checkVerificationTxt(txts: string[], expectedToken?: string | null): DnsCheck {
  const values = txts.map(normaliseTxt);
  const tokens = values.filter((v) => v.toLowerCase().startsWith("google-site-verification="));
  const label = "Domain verification (TXT)";

  if (tokens.length === 0) {
    return {
      id: "txt", label, state: "missing",
      detail: "No google-site-verification TXT record found. Google cannot confirm you own this domain.",
      expected: expectedToken ? [`google-site-verification=${expectedToken}`] : undefined,
    };
  }

  if (!expectedToken) {
    return {
      id: "txt", label, state: "warn",
      detail: `A Google verification token is present, but no expected token was supplied, so it could not be matched. Paste the token from the Google console to confirm.`,
      found: tokens,
    };
  }

  const want = `google-site-verification=${expectedToken}`.toLowerCase();
  const hit = tokens.some((t) => t.toLowerCase() === want);
  return {
    id: "txt", label,
    state: hit ? "pass" : "fail",
    detail: hit
      ? "Correct — the verification token matches."
      : "A Google verification token is present but it is not the one issued for this domain. This usually means the token was copied from a different customer's console.",
    expected: hit ? undefined : [want],
    found: tokens,
  };
}

/**
 * Judge SPF.
 *
 * Two SPF records is a hard failure under RFC 7208 §3.2 — a receiver that finds
 * more than one must treat the result as permerror, so mail starts failing rather
 * than degrading. That is why it is reported as FAIL and not a warning.
 */
export function checkSpf(txts: string[]): DnsCheck {
  const values = txts.map(normaliseTxt);
  const spf = values.filter((v) => v.toLowerCase().startsWith("v=spf1"));
  const label = "SPF (sender authorisation)";
  const recommended = `v=spf1 ${SPF_INCLUDE} ~all`;

  if (spf.length === 0) {
    return {
      id: "spf", label, state: "missing",
      detail: "No SPF record. Mail sent from Workspace is more likely to be marked as spam.",
      expected: [recommended],
    };
  }

  if (spf.length > 1) {
    return {
      id: "spf", label, state: "fail",
      detail: `${spf.length} SPF records found. More than one is a permanent error (RFC 7208), and receivers may reject your mail outright. Merge them into a single record.`,
      expected: [recommended], found: spf,
    };
  }

  const only = spf[0];
  if (!only.toLowerCase().includes(SPF_INCLUDE)) {
    return {
      id: "spf", label, state: "fail",
      detail: `An SPF record exists but does not authorise Google. Add ${SPF_INCLUDE} to it — do not add a second record.`,
      expected: [recommended], found: spf,
    };
  }

  return {
    id: "spf", label, state: "pass",
    detail: "Correct — Google is authorised to send for this domain.",
    found: spf,
  };
}

/** Worst state across the checks, for a single headline pill. */
export function overallState(checks: DnsCheck[]): CheckState {
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "missing")) return "missing";
  if (checks.some((c) => c.state === "warn")) return "warn";
  return "pass";
}
