/**
 * Vendor licence reconciliation — what the console has, against what is billed.
 *
 * ─── THE LEAK THIS FINDS ────────────────────────────────────────────────────
 * A reseller buys seats from Google or Microsoft and bills them on to a customer. The two
 * numbers drift, always in both directions and for the same mundane reason: somebody added
 * a mailbox in the vendor console because a customer asked on the phone, and nobody came
 * back to the app.
 *
 *   • Console MORE than billed → the reseller is PAYING for seats nobody is charged for.
 *     Silent, monthly, and it compounds. This is the leak.
 *   • Console FEWER than billed → the customer is being charged for seats they do not
 *     have. Smaller in rupees and far worse in trust: it is the one they find, and they
 *     find it during a renewal negotiation.
 *
 * Both are reported, and the second is never dressed up as good news.
 *
 * ─── DOMAIN IS THE JOIN, NOT THE PLAN NAME ──────────────────────────────────
 * A vendor export identifies an account by its email address, and the domain is the only
 * thing in it that reliably maps back to a subscription. Plan names do not survive the
 * trip: "Google Workspace Business Starter" in the catalogue is "Google Workspace Business
 * Starter - Annual, Monthly Pay" in a console CSV, and matching on that string produces
 * confident nonsense.
 *
 * ─── AND AN UNMATCHED DOMAIN IS REPORTED, NOT DROPPED ───────────────────────
 * A domain in the console with no subscription at all is the most valuable row in the
 * report: it is a customer being served and billed nothing. Silently skipping it — which
 * is what a plain inner join does — hides exactly the case worth money.
 */
import { parseCsvLine, findColumn } from "@/lib/csv";

/* ── Parsing a vendor export ────────────────────────────────────────────────── */

export interface SeatCount {
  /** Lower-cased domain, e.g. "acme.co.in". */
  domain: string;
  /** How many active accounts the console lists on it. */
  seats: number;
}

export interface VendorCsvResult {
  perDomain: SeatCount[];
  /** Rows the parser could not use, with the reason. Never silently dropped. */
  skipped: { row: number; reason: string }[];
  /** Column the email was read from — shown so an operator can sanity-check the mapping. */
  emailColumn: string | null;
  /** Column the suspended/active flag was read from, when there was one. */
  statusColumn: string | null;
  totalRows: number;
}

/**
 * Header names both consoles use for the account's address.
 *
 * Ordered most-specific first: a Google export has "Email Address", a Microsoft one has
 * "User principal name". "Email" is last because a CSV somebody edited in Excel often
 * gains a looser column of that name.
 */
const EMAIL_HEADERS = [
  "Email Address", "Email address", "User principal name", "userPrincipalName",
  "Primary Email", "Username", "Email", "E-mail",
] as const;

/**
 * Suspended accounts must not count.
 *
 * A suspended Google user still appears in the export, and Google still bills for it —
 * but the customer is not using it, and counting it as a live seat would report a
 * shortfall that does not exist. Both consoles express this differently, so the value is
 * read loosely and only an explicit "suspended"/"blocked"/"false" excludes a row.
 */
const STATUS_HEADERS = ["Status", "Account Status", "Suspended", "Block credential", "State"] as const;

function isSuspended(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return false;
  return v === "suspended" || v === "blocked" || v === "true"
    || v === "inactive" || v === "disabled";
}

/** Domain part of an address, lower-cased. Null when there isn't one. */
export function domainOf(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.includes(".") ? d : null;
}

export function parseVendorCsv(csv: string): VendorCsvResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { perDomain: [], skipped: [], emailColumn: null, statusColumn: null, totalRows: 0 };
  }

  const headers  = parseCsvLine(lines[0]);
  const emailIdx = findColumn(headers, EMAIL_HEADERS);
  const statIdx  = findColumn(headers, STATUS_HEADERS);

  if (emailIdx < 0) {
    /* Says which columns it looked for. "Could not parse the CSV" would leave an operator
       guessing at a file they cannot read either. */
    return {
      perDomain: [], skipped: [{ row: 1, reason: `No email column. Looked for: ${EMAIL_HEADERS.join(", ")}` }],
      emailColumn: null, statusColumn: null, totalRows: 0,
    };
  }

  const counts  = new Map<string, number>();
  const skipped: { row: number; reason: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const f     = parseCsvLine(lines[i]);
    const email = (f[emailIdx] ?? "").trim();
    if (!email) { skipped.push({ row: i + 1, reason: "no email in the row" }); continue; }

    if (statIdx >= 0 && isSuspended(f[statIdx] ?? "")) {
      skipped.push({ row: i + 1, reason: `${email} is suspended in the console` });
      continue;
    }

    const d = domainOf(email);
    if (!d) { skipped.push({ row: i + 1, reason: `"${email}" is not an email address` }); continue; }

    counts.set(d, (counts.get(d) ?? 0) + 1);
  }

  return {
    perDomain: [...counts.entries()]
      .map(([domain, seats]) => ({ domain, seats }))
      .sort((a, b) => b.seats - a.seats),
    skipped,
    emailColumn:  headers[emailIdx] ?? null,
    statusColumn: statIdx >= 0 ? (headers[statIdx] ?? null) : null,
    totalRows: lines.length - 1,
  };
}

/* ── Comparing it with what is billed ───────────────────────────────────────── */

export interface BilledSub {
  id: string;
  customerName: string | null;
  plan: string | null;
  domain: string | null;
  seats: number;
  /** ₹ per month, whole rupees, as stored. */
  mrr: number;
  status: string | null;
}

export type MismatchKind =
  /** Console has more accounts than are billed — the reseller is paying for the difference. */
  | "unbilled"
  /** Fewer accounts than billed — the customer is being over-charged. */
  | "over-billed"
  /** A domain in the console with no subscription at all. */
  | "no-subscription"
  /** In the app, absent from this export. */
  | "not-in-export";

export interface Mismatch {
  kind: MismatchKind;
  domain: string;
  customerName: string | null;
  plan: string | null;
  consoleSeats: number | null;
  billedSeats: number | null;
  /** consoleSeats − billedSeats. Positive means unbilled. */
  delta: number | null;
  /**
   * ₹/month at stake, derived from the subscription's own per-seat rate.
   *
   * Null when there is no subscription to take a rate from — a domain with no
   * subscription has no known price, and inventing one would put a made-up number next to
   * a real problem. The row still appears; only the rupees are withheld.
   */
  monthlyAtStake: number | null;
}

export interface AuditResult {
  mismatches: Mismatch[];
  matched: number;
  /** ₹/month leaking out: seats the reseller pays for and does not bill. */
  unbilledMonthly: number;
  /** ₹/month over-charged. Reported separately — it is not a saving. */
  overBilledMonthly: number;
}

/**
 * Compare a parsed export against the subscriptions on file.
 *
 * `vendorScope` narrows which subscriptions are in scope, because a Google export says
 * nothing about the Microsoft rows and calling them "not in export" would fill the report
 * with noise the operator has to learn to ignore.
 */
export function auditLicences(
  consoleSeats: readonly SeatCount[],
  subs: readonly BilledSub[],
  vendorScope: (s: BilledSub) => boolean,
): AuditResult {
  const inScope = subs.filter((s) => vendorScope(s) && s.status !== "cancelled");

  /* Several subscriptions can share a domain — a licence line and a support line, or seats
     added later. Billed seats for a domain is their SUM; comparing against just one would
     report a shortfall that is only an incomplete lookup. */
  const billed = new Map<string, { seats: number; mrr: number; subs: BilledSub[] }>();
  for (const s of inScope) {
    const d = (s.domain ?? "").trim().toLowerCase();
    if (!d) continue;
    const cur = billed.get(d) ?? { seats: 0, mrr: 0, subs: [] };
    cur.seats += s.seats;
    cur.mrr   += s.mrr;
    cur.subs.push(s);
    billed.set(d, cur);
  }

  const mismatches: Mismatch[] = [];
  let matched = 0;
  let unbilledMonthly = 0;
  let overBilledMonthly = 0;
  const seen = new Set<string>();

  for (const c of consoleSeats) {
    seen.add(c.domain);
    const b = billed.get(c.domain);

    if (!b) {
      /* The most valuable row in the report: a domain being served and billed nothing. A
         plain inner join would drop it. */
      mismatches.push({
        kind: "no-subscription", domain: c.domain,
        customerName: null, plan: null,
        consoleSeats: c.seats, billedSeats: 0, delta: c.seats,
        monthlyAtStake: null,
      });
      continue;
    }

    const delta = c.seats - b.seats;
    if (delta === 0) { matched++; continue; }

    /* Per-seat from the subscription's OWN mrr, so the money follows this customer's
       negotiated rate rather than a catalogue list price. */
    const perSeat = b.seats > 0 ? Math.round(b.mrr / b.seats) : 0;
    const stake   = Math.abs(delta) * perSeat;
    if (delta > 0) unbilledMonthly += stake; else overBilledMonthly += stake;

    mismatches.push({
      kind: delta > 0 ? "unbilled" : "over-billed",
      domain: c.domain,
      customerName: b.subs[0]?.customerName ?? null,
      plan: b.subs.map((s) => s.plan).filter(Boolean).join(" + ") || null,
      consoleSeats: c.seats,
      billedSeats: b.seats,
      delta,
      monthlyAtStake: stake,
    });
  }

  for (const [domain, b] of billed) {
    if (seen.has(domain)) continue;
    mismatches.push({
      kind: "not-in-export", domain,
      customerName: b.subs[0]?.customerName ?? null,
      plan: b.subs.map((s) => s.plan).filter(Boolean).join(" + ") || null,
      consoleSeats: 0, billedSeats: b.seats, delta: -b.seats,
      /* Deliberately NOT counted as over-billing. A domain absent from one export is
         usually a partial export or a different console — treating it as money owed back
         would turn a filtering accident into a refund. */
      monthlyAtStake: null,
    });
  }

  /* Worst first: unbilled by rupees, then the trust problem, then the unknowns. */
  const rank: Record<MismatchKind, number> = {
    unbilled: 0, "no-subscription": 1, "over-billed": 2, "not-in-export": 3,
  };
  mismatches.sort((a, b) =>
    rank[a.kind] - rank[b.kind] || (b.monthlyAtStake ?? 0) - (a.monthlyAtStake ?? 0));

  return { mismatches, matched, unbilledMonthly, overBilledMonthly };
}

/** The sentence for one row. Says who, how many, and what it costs a month. */
export function mismatchNote(m: Mismatch, rupees: (n: number) => string): string {
  const who = m.customerName ? `${m.customerName} (${m.domain})` : m.domain;
  switch (m.kind) {
    case "unbilled":
      return `${who}: ${m.consoleSeats} accounts in the console, ${m.billedSeats} billed — you are paying for ${m.delta} nobody is charged for, about ${rupees(m.monthlyAtStake ?? 0)} a month.`;
    case "over-billed":
      return `${who}: ${m.billedSeats} billed but only ${m.consoleSeats} accounts exist — the customer is being charged ${rupees(m.monthlyAtStake ?? 0)} a month too much.`;
    case "no-subscription":
      return `${m.domain}: ${m.consoleSeats} accounts in the console and no subscription at all — this domain is being served and billed nothing.`;
    case "not-in-export":
      return `${who}: ${m.billedSeats} seats billed, but this domain is not in the file — check you exported the whole console before treating it as a problem.`;
  }
}
