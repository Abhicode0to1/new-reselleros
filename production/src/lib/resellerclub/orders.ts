/**
 * ResellerClub — the ordering surface. THIS MODULE SPENDS MONEY.
 *
 * `index.ts` next door is read-only (availability, prices) and always was. This
 * file is the other half: register, renew, transfer, and the nameserver and
 * lookup calls those need. Every function here either costs money at the
 * registrar or changes what a customer's domain points at.
 *
 * ─── THE GATE ────────────────────────────────────────────────────────────────
 * Nothing here runs unless BOTH are true:
 *   · `RESELLERCLUB_API_KEY` + `RESELLERCLUB_RESELLER_ID` are present, and
 *   · `DOMAIN_REGISTER_LIVE === "1"`.
 *
 * The second is not redundant. Credentials arrive for the read side — pricing
 * and availability need exactly the same key — so "we have credentials" must
 * never imply "we may place orders". The flag is the same shape as hosting's
 * `HOSTING_TRIAL_LIVE`, deliberately, so there is one thing to look for when
 * asking "can this environment spend money".
 *
 * The gate here is the LAST line, not the first. A registration only reaches
 * this module after `decideProvisioning` (lib/provisioning) has already
 * required a verified live payment matching the quoted amount to the rupee.
 * This flag exists so an environment can still be denied even when all of that
 * passes — a preview deploy holding production credentials, for instance.
 *
 * ─── ONE THING NOT PORTED FROM THE ENGINE ────────────────────────────────────
 * The engine's `renewDomain` and `transferDomain` return success whenever the
 * HTTP call did not throw (domain-management-system:
 * lib/resellerclub/renewal-transfer.ts) — they never inspect RC's own
 * `{status:"error"}` body, which RC serves with HTTP 200. Only `registerDomain`
 * checks it there. So a renewal that RC refused is recorded as renewed, and the
 * domain quietly expires with a green row next to it.
 *
 * `rcCall` below normalises the body for EVERY operation, so that class of bug
 * cannot be reintroduced one function at a time.
 *
 * ─── RULES ───────────────────────────────────────────────────────────────────
 * 1. SERVER-ONLY. The key is a Cloud Run env var.
 * 2. Never throws to the caller. Every path returns a typed outcome from
 *    `classify.ts`, because a thrown error in a provisioning worker is an
 *    order whose upstream state nobody knows.
 * 3. Works only from the whitelisted egress IP (34.14.190.227, the static NAT).
 *    From anywhere else RC answers with an auth error, which surfaces as a
 *    hard_failure carrying RC's own words.
 */
import "server-only";
import {
  classifyRegister,
  classifyRenew,
  classifyTransfer,
  classifyLookup,
  type RcRawResponse,
  type RegisterOutcome,
  type RenewOutcome,
  type TransferOutcome,
  type LookupOutcome,
} from "./classify";

const BASE = (process.env.RESELLERCLUB_API_URL?.trim() || "https://httpapi.com").replace(/\/+$/, "");
const RESELLER_ID = process.env.RESELLERCLUB_RESELLER_ID?.trim() || "";
const API_KEY = process.env.RESELLERCLUB_API_KEY?.trim() || "";

/** Credentials present. NOT permission to order — see `rcOrderingEnabled`. */
export function rcWriteConfigured(): boolean {
  return RESELLER_ID.length > 0 && API_KEY.length > 0;
}

/** The money gate. Both halves, in one place, so a call site cannot check half. */
export function rcOrderingEnabled(): boolean {
  return rcWriteConfigured() && process.env.DOMAIN_REGISTER_LIVE === "1";
}

/**
 * Nameservers a new registration is pointed at.
 *
 * Configurable because they belong to a reseller account, not to this codebase.
 * The fallbacks are the ones the Anutech engine has used on this same
 * ResellerClub account since it went live — the same account these credentials
 * authenticate to, so they are the correct default rather than a borrowed one.
 * A registration with no nameservers is parked at the registry and the
 * customer's site does not resolve, so an empty list is never used.
 */
function defaultNameservers(): string[] {
  const fromEnv = [1, 2, 3, 4]
    .map((n) => process.env[`RESELLERCLUB_NS_${n}`]?.trim())
    .filter((v): v is string => !!v && v.length > 0);
  if (fromEnv.length > 0) return fromEnv;
  return [
    "deepak1299294.mercury.orderbox-dns.com",
    "deepak1299294.venus.orderbox-dns.com",
    "deepak1299294.earth.orderbox-dns.com",
    "deepak1299294.mars.orderbox-dns.com",
  ];
}

/* ── Transport ──────────────────────────────────────────────────────────────── */

/**
 * One call to ResellerClub, normalised into the three words `classify.ts`
 * understands.
 *
 * RC's conventions, all of which this has to absorb:
 *   · credentials go in the QUERY STRING on every request, including POSTs —
 *     there is no header auth;
 *   · errors come back with HTTP 200 and `{"status":"ERROR","message":…}`, or
 *     sometimes `{"error": "…"}` with no status at all;
 *   · `status` casing is inconsistent, hence the lowercase compare;
 *   · `"InvoicePaid"` with an error attached means the money moved but the
 *     order has not completed — pending, never a failure (observed by the
 *     engine; see its registration.ts).
 */
async function rcCall(
  path: string,
  params: Record<string, string | string[]>,
  method: "GET" | "POST",
): Promise<RcRawResponse> {
  if (!rcWriteConfigured()) {
    return { status: "error", message: "ResellerClub credentials are not configured in this environment" };
  }

  const qs = new URLSearchParams();
  qs.set("auth-userid", RESELLER_ID);
  qs.set("api-key", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, item));
    else if (v !== "") qs.set(k, v);
  }

  const url = `${BASE}${path}?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      /* 60s, not the read side's 15s. A registration is a registry round-trip
         and RC is routinely slow on it; timing out early does not cancel the
         order, it only loses our record of it. */
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    /* The URL is never logged — it carries the api-key in the query string. */
    const message = (err as Error).message || "unreachable";
    console.error(`[resellerclub] ${path} unreachable: ${message}`);
    return { status: "error", message: `ResellerClub unreachable: ${message}` };
  }

  const text = await res.text().catch(() => "");

  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    /* A non-2xx still often carries RC's reason in the body — prefer it over
       the bare status code, because "IP not whitelisted" is actionable and
       "HTTP 403" is not (§24). */
    const message =
      (typeof body?.message === "string" && body.message) ||
      (typeof body?.error === "string" && body.error) ||
      `ResellerClub HTTP ${res.status}: ${text.slice(0, 200)}`;
    console.error(`[resellerclub] ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { status: "error", message, data: body ?? undefined };
  }

  if (!body || typeof body !== "object") {
    return { status: "error", message: `ResellerClub returned an unreadable body: ${text.slice(0, 200)}` };
  }

  const rawStatus = typeof body.status === "string" ? body.status.toLowerCase() : "";

  /* The money moved but the order has not landed. Pending, not an error. */
  if (rawStatus === "invoicepaid") {
    return {
      status: "pending",
      message: typeof body.message === "string" ? body.message : "invoice paid, order not yet complete",
      data: body,
    };
  }

  if (rawStatus === "error" || typeof body.error === "string") {
    const message =
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      "ResellerClub reported an error with no message";
    return { status: "error", message, data: body };
  }

  return { status: "success", data: body };
}

/* ── Orders ─────────────────────────────────────────────────────────────────── */

export interface RegisterInput {
  domainName: string;
  years: number;
  /** RC customer id (numeric, as a string is fine — RC is loose about this). */
  customerId: string;
  /** RC contact ids. RC wants all four; we send the same one unless told otherwise. */
  contactId: string;
  adminContactId?: string;
  techContactId?: string;
  billingContactId?: string;
  nameservers?: string[];
  /** Per-TLD extras collected at checkout (.us Nexus, .pro profession, gTLD T&C). */
  tldAttributes?: Record<string, string>;
  privacyProtection?: boolean;
}

/**
 * Register a domain. Irreversible spend.
 *
 * `invoice-option=NoInvoice` tells RC not to raise its own invoice against the
 * reseller account — we have already billed the customer through this app's GST
 * spine, and a second document in RC's system is a reconciliation problem, not
 * a record.
 */
export async function rcRegisterDomain(input: RegisterInput): Promise<RegisterOutcome> {
  if (!rcOrderingEnabled()) {
    return {
      kind: "hard_failure",
      reason: rcWriteConfigured()
        ? "domain ordering is switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)"
        : "ResellerClub credentials are not configured in this environment",
    };
  }

  /* Integer-checked BEFORE any truncation. Rounding 1.5 down to 1 would give
     the customer a shorter term than the one they were charged for, silently —
     the caller has to be wrong out loud instead. */
  const years = input.years;
  if (!Number.isInteger(years) || years < 1 || years > 10) {
    return { kind: "hard_failure", reason: `${input.years} is not a registration period ResellerClub accepts (whole years, 1-10)` };
  }
  const name = input.domainName.trim().toLowerCase();
  if (!name || !name.includes(".")) {
    return { kind: "hard_failure", reason: `"${input.domainName}" is not a domain name` };
  }

  const admin = input.adminContactId || input.contactId;
  const params: Record<string, string | string[]> = {
    "domain-name": name,
    years: String(years),
    "customer-id": input.customerId,
    "reg-contact-id": input.contactId,
    "admin-contact-id": admin,
    "tech-contact-id": input.techContactId || admin,
    "billing-contact-id": input.billingContactId || admin,
    "invoice-option": "NoInvoice",
    "protect-privacy": input.privacyProtection ? "true" : "false",
    ns: input.nameservers?.length ? input.nameservers : defaultNameservers(),
    ...(input.tldAttributes ?? {}),
  };

  return classifyRegister(await rcCall("/api/domains/register.json", params, "POST"));
}

/**
 * Renew a domain.
 *
 * `exp-date` is not optional and not cosmetic: RC uses it to detect a duplicate
 * renewal. Sending the wrong one is how a domain gets renewed twice, so it is a
 * required argument here rather than something this function looks up for you —
 * the caller has just read the domain's details and knows the real value.
 */
export async function rcRenewDomain(args: {
  orderId: string;
  years: number;
  /** Current expiry as a Unix timestamp in SECONDS, from RC's own details call. */
  expiryEpochSeconds: number;
}): Promise<RenewOutcome> {
  if (!rcOrderingEnabled()) {
    return {
      kind: "hard_failure",
      reason: rcWriteConfigured()
        ? "domain ordering is switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)"
        : "ResellerClub credentials are not configured in this environment",
    };
  }

  /* Same reasoning as register: a truncated term is a term nobody agreed to. */
  const years = args.years;
  if (!Number.isInteger(years) || years < 1 || years > 10) {
    return { kind: "hard_failure", reason: `${args.years} is not a renewal period ResellerClub accepts (whole years, 1-10)` };
  }
  if (!Number.isFinite(args.expiryEpochSeconds) || args.expiryEpochSeconds <= 0) {
    return {
      kind: "hard_failure",
      reason: "a renewal needs the domain's current expiry — without it ResellerClub cannot tell this apart from a duplicate renewal",
    };
  }

  return classifyRenew(await rcCall("/api/domains/renew.json", {
    "order-id": args.orderId,
    years: String(years),
    "exp-date": String(Math.trunc(args.expiryEpochSeconds)),
    "invoice-option": "NoInvoice",
  }, "POST"));
}

export async function rcTransferDomain(args: {
  domainName: string;
  authCode: string;
  customerId: string;
  contactId: string;
}): Promise<TransferOutcome> {
  if (!rcOrderingEnabled()) {
    return {
      kind: "hard_failure",
      reason: rcWriteConfigured()
        ? "domain ordering is switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)"
        : "ResellerClub credentials are not configured in this environment",
    };
  }

  const name = args.domainName.trim().toLowerCase();
  if (!args.authCode.trim()) {
    return { kind: "transfer_rejected", reason: "the transfer needs the authorisation (EPP) code from the current registrar" };
  }

  return classifyTransfer(await rcCall("/api/domains/transfer.json", {
    "domain-name": name,
    "auth-code": args.authCode.trim(),
    "customer-id": args.customerId,
    "reg-contact-id": args.contactId,
    "admin-contact-id": args.contactId,
    "tech-contact-id": args.contactId,
    "billing-contact-id": args.contactId,
    "invoice-option": "NoInvoice",
  }, "POST"));
}

/* ── Reads that the writes depend on ────────────────────────────────────────── */

/**
 * The registrar's order id for a name we own.
 *
 * This is the recovery path for `registered_no_order_id`, and for the case the
 * engine hit on 7 Sep 2026 where a worker was torn down mid-registration: the
 * order exists upstream, our row does not know it, and the only way back is to
 * ask by name. A read, so it does not need the ordering gate.
 */
export async function rcOrderIdFor(domainName: string): Promise<LookupOutcome<string>> {
  const res = await rcCall("/api/domains/orderid.json", {
    "domain-name": domainName.trim().toLowerCase(),
  }, "GET");

  /* RC answers this one with a bare number, not an object, so a successful body
     parses to something that is not a Record. Handle it before classify sees it. */
  if (res.status === "success" && res.data == null) {
    return { kind: "not_found", reason: "ResellerClub answered with no order id" };
  }
  return classifyLookup(res, (d) => {
    const v = d.orderid ?? d.result ?? d.response;
    return v != null ? String(v) : null;
  });
}

export interface RcDomainDetails {
  orderId: string | null;
  domainName: string | null;
  /** Unix seconds, as RC reports it — the value `rcRenewDomain` needs. */
  expiryEpochSeconds: number | null;
  /** RC's own lifecycle word, e.g. "Active", "Expired", "Deleted". */
  status: string | null;
  nameservers: string[];
  privacyProtection: boolean | null;
  transferLock: boolean | null;
}

/**
 * Everything the sweep needs about one domain. Field names are RC's, which are
 * not the names anybody would choose; the mapping is here so the rest of the
 * app never sees `endtime` or `orderstatus`.
 */
export async function rcDomainDetails(domainName: string): Promise<LookupOutcome<RcDomainDetails>> {
  const res = await rcCall("/api/domains/details.json", {
    "domain-name": domainName.trim().toLowerCase(),
    "options": "All",
  }, "GET");

  return classifyLookup(res, (d) => {
    const num = (v: unknown): number | null => {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const nameservers = Object.keys(d)
      .filter((k) => /^ns\d+$/.test(k))
      .sort()
      .map((k) => String(d[k]))
      .filter((v) => v && v !== "undefined");

    const details: RcDomainDetails = {
      orderId: d.orderid != null ? String(d.orderid) : null,
      domainName: typeof d.domainname === "string" ? d.domainname : null,
      expiryEpochSeconds: num(d.endtime),
      status: typeof d.currentstatus === "string" ? d.currentstatus
            : typeof d.orderstatus === "string" ? d.orderstatus : null,
      nameservers,
      privacyProtection: d.isprivacyprotected != null ? String(d.isprivacyprotected) === "true" : null,
      transferLock: Array.isArray(d.orderstatus)
        ? (d.orderstatus as unknown[]).some((s) => String(s).toLowerCase().includes("transferlock"))
        : null,
    };
    /* An order id we cannot read means we cannot renew it later — that is a
       not_found, not a half-populated success. */
    return details.orderId ? details : null;
  });
}

/**
 * Point a domain at different nameservers. Changes where a live site resolves,
 * so it is gated like an order even though it costs nothing.
 */
export async function rcModifyNameservers(orderId: string, nameservers: string[]): Promise<RcRawResponse> {
  if (!rcOrderingEnabled()) {
    return { status: "error", message: "domain changes are switched off in this environment (DOMAIN_REGISTER_LIVE is not 1)" };
  }
  const clean = nameservers.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (clean.length < 2) {
    /* Every registry requires at least two. One is an outage waiting for the
       first time the host reboots. */
    return { status: "error", message: "a domain needs at least two nameservers" };
  }
  return rcCall("/api/domains/modify-ns.json", { "order-id": orderId, ns: clean }, "POST");
}
