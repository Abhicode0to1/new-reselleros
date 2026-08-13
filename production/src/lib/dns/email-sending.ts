/**
 * DNS checks for OUTBOUND email — can this domain actually send?
 *
 * `workspace-dns.ts` answers "can this domain RECEIVE mail on Google Workspace"
 * (MX, verification TXT). This answers the other half, which is what blocks
 * per-tenant sending today: `RESEND_FROM_OVERRIDE` is set in production precisely
 * because no tenant domain is verified with the email provider yet, so every
 * message goes out under a shared From. The code already passes
 * `from: tenant.email` — it is DNS, not code, that is missing.
 *
 * ─── WHY THE PROVIDER'S RECORDS ARE NOT HARDCODED ────────────────────────────
 * It is tempting to bake in "SPF must contain include:amazonses.com and there must
 * be a TXT at resend._domainkey". Providers change those, and a checker that
 * asserts last year's values reports a healthy domain as broken — or worse, a
 * broken one as healthy. So the expected include and DKIM selector are PARAMETERS,
 * defaulted for convenience and meant to be copied from whatever the provider's
 * dashboard currently shows.
 *
 * What IS hardcoded is the part that does not change: RFC rules that break mail
 * regardless of who you send through.
 *
 * ─── THE THREE FAILURES THAT ACTUALLY HAPPEN ─────────────────────────────────
 * 1. TWO SPF RECORDS. Adding a provider by publishing a second `v=spf1` record is
 *    the most common mistake there is. RFC 7208 §4.5 makes that a permerror, and
 *    a permerror means SPF fails for EVERY sender — including the mail that was
 *    working before. It looks like "I added a record and all my mail broke".
 *
 * 2. THE TEN-LOOKUP LIMIT. RFC 7208 §4.6.4 caps DNS-querying mechanisms at 10.
 *    A domain already on Google Workspace plus one or two other services is
 *    frequently at 8 or 9, so adding one more `include:` silently pushes it over
 *    and every check starts failing. Nothing warns you; the record still looks
 *    fine to a human.
 *
 * 3. A REVOKED DKIM KEY. A DKIM TXT with an empty `p=` is the published way to say
 *    "this key is revoked". The record exists, so a presence-only check passes,
 *    and every signature fails.
 */
import type { CheckState, DnsCheck } from "./workspace-dns";
import { normaliseTxt } from "./workspace-dns";

/** Mechanisms that cost a DNS lookup under RFC 7208 §4.6.4. */
const LOOKUP_MECHANISMS = ["include:", "a:", "mx:", "ptr:", "exists:", "redirect="];
/** The published cap. Exceeding it is a permerror, not a warning. */
export const SPF_LOOKUP_LIMIT = 10;

export interface SendingExpectations {
  /** e.g. "amazonses.com" — copy from the provider's dashboard. */
  spfInclude: string;
  /** DKIM selector, e.g. "resend" → looked up at `resend._domainkey.<domain>`. */
  dkimSelector: string;
  /** Human name, for the messages. */
  providerName: string;
}

/** Defaults for Resend at the time of writing. VERIFY against the dashboard. */
export const RESEND_DEFAULTS: SendingExpectations = {
  spfInclude:   "amazonses.com",
  dkimSelector: "resend",
  providerName: "Resend",
};

/** The `<selector>._domainkey.<domain>` name a DKIM lookup needs. */
export function dkimHost(domain: string, selector: string): string {
  return `${selector.trim()}._domainkey.${domain.trim()}`.toLowerCase();
}

/** The `_dmarc.<domain>` name. */
export function dmarcHost(domain: string): string {
  return `_dmarc.${domain.trim()}`.toLowerCase();
}

/**
 * Count the DNS-querying mechanisms in an SPF record.
 *
 * QUALIFIERS ARE STRIPPED FIRST. Every mechanism may carry `+`, `-`, `~` or `?`
 * (RFC 7208 §4.6.2), and all of them still cost a lookup. A first version matched
 * the bare token and only `+`, so `-mx`, `~a` and `?include:` were not counted.
 * That undercounts — the dangerous direction — because a domain genuinely at 11
 * lookups would be reported as within the limit while SPF was already returning a
 * permanent error for every sender.
 */
export function countSpfLookups(spf: string): number {
  let n = 0;
  for (const raw of spf.toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    // `redirect=` is a modifier, not a mechanism, so it never carries a qualifier.
    const token = raw.startsWith("redirect=") ? raw : raw.replace(/^[+\-~?]/, "");
    // `a` and `mx` cost a lookup even bare; `all`, `ip4:` and `ip6:` never do.
    if (token === "a" || token === "mx") { n++; continue; }
    if (LOOKUP_MECHANISMS.some((m) => token.startsWith(m))) n++;
  }
  return n;
}

/**
 * Is the SPF record fit to send through this provider?
 *
 * Deliberately reports the WORST problem, because an operator fixing a permerror
 * should not also be told the include is missing — the include cannot help while
 * the record is invalid.
 */
export function checkSendingSpf(txts: string[], expected: SendingExpectations): DnsCheck {
  const spfs = txts.map(normaliseTxt).filter((t) => t.toLowerCase().startsWith("v=spf1"));

  if (spfs.length === 0) {
    return {
      id: "spf-sending",
      label: "SPF record",
      state: "missing",
      detail: "No SPF record found.",
      fix: `Publish a TXT record on the domain: v=spf1 include:${expected.spfInclude} ~all — `
         + `or, if you already send through another service, add include:${expected.spfInclude} to the EXISTING record.`,
    };
  }

  if (spfs.length > 1) {
    return {
      id: "spf-sending",
      label: "SPF record",
      state: "fail",
      detail: `${spfs.length} SPF records found. RFC 7208 makes that a permanent error, and SPF then fails for EVERY sender — including mail that worked before.`,
      fix: "Merge them into ONE v=spf1 record containing every include, and delete the others.",
    };
  }

  const spf = spfs[0];
  const lookups = countSpfLookups(spf);

  if (lookups > SPF_LOOKUP_LIMIT) {
    return {
      id: "spf-sending",
      label: "SPF record",
      state: "fail",
      detail: `${lookups} DNS lookups, over the limit of ${SPF_LOOKUP_LIMIT} (RFC 7208 §4.6.4). Everything past the limit is ignored and SPF returns a permanent error.`,
      fix: "Remove services you no longer send through, or flatten some includes into ip4:/ip6: ranges.",
    };
  }

  const has = spf.toLowerCase().includes(expected.spfInclude.toLowerCase());
  if (!has) {
    return {
      id: "spf-sending",
      label: "SPF record",
      state: "fail",
      detail: `SPF exists but does not authorise ${expected.providerName} (no ${expected.spfInclude}).`,
      fix: `Add include:${expected.spfInclude} to the existing record — do NOT publish a second SPF record.`,
    };
  }

  // One lookup from the limit is worth saying out loud: the next service added
  // breaks everything, and nobody connects that to a change made weeks earlier.
  if (lookups === SPF_LOOKUP_LIMIT) {
    return {
      id: "spf-sending",
      label: "SPF record",
      state: "warn",
      detail: `Authorises ${expected.providerName}, but sits exactly on the ${SPF_LOOKUP_LIMIT}-lookup limit.`,
      fix: "Adding one more service will break SPF for every sender. Trim an unused include before that happens.",
    };
  }

  return {
    id: "spf-sending",
    label: "SPF record",
    state: "pass",
    detail: `Authorises ${expected.providerName} · ${lookups}/${SPF_LOOKUP_LIMIT} DNS lookups.`,
  };
}

/** Is the DKIM key published and usable? */
export function checkDkim(txts: string[], expected: SendingExpectations): DnsCheck {
  const joined = txts.map(normaliseTxt).filter((t) => t.length > 0);
  const rec = joined.find((t) => /(^|;)\s*(v=DKIM1|k=rsa|p=)/i.test(t));

  if (!rec) {
    return {
      id: "dkim",
      label: "DKIM key",
      state: "missing",
      detail: `No DKIM record at the ${expected.dkimSelector} selector.`,
      fix: `Publish the TXT record ${expected.providerName} shows you, at ${expected.dkimSelector}._domainkey on this domain.`,
    };
  }

  // `p=` with nothing after it is the published way to REVOKE a key. The record
  // exists, so a presence check passes while every signature fails.
  const p = /(^|;)\s*p\s*=\s*([^;]*)/i.exec(rec);
  if (!p || p[2].trim() === "") {
    return {
      id: "dkim",
      label: "DKIM key",
      state: "fail",
      detail: "The DKIM record has an empty p= value, which publicly marks the key as REVOKED. Every signature will fail.",
      fix: `Re-copy the full DKIM value from ${expected.providerName} — long keys are often truncated when pasted.`,
    };
  }

  return {
    id: "dkim",
    label: "DKIM key",
    state: "pass",
    detail: `Published at ${expected.dkimSelector}._domainkey.`,
  };
}

/**
 * DMARC. Not required to send, but it decides what receivers DO when alignment
 * fails, so a strict policy on a half-configured domain silently bins real mail.
 */
export function checkDmarc(txts: string[]): DnsCheck {
  const rec = txts.map(normaliseTxt).find((t) => t.toLowerCase().startsWith("v=dmarc1"));

  if (!rec) {
    return {
      id: "dmarc",
      label: "DMARC policy",
      state: "warn",
      detail: "No DMARC record. Mail still sends, but receivers have no instruction and nobody can spoof-protect this domain.",
      fix: "Start with v=DMARC1; p=none; rua=mailto:you@yourdomain — monitoring only, no delivery risk.",
    };
  }

  const policy = (/(^|;)\s*p\s*=\s*([a-z]+)/i.exec(rec)?.[2] ?? "none").toLowerCase();

  if (policy === "reject" || policy === "quarantine") {
    return {
      id: "dmarc",
      label: "DMARC policy",
      state: "warn",
      detail: `Policy is p=${policy}. Any message that fails SPF and DKIM alignment will be ${policy === "reject" ? "rejected outright" : "sent to spam"}.`,
      fix: "Confirm SPF and DKIM both pass above before relying on this. If either is failing, mail is being lost right now.",
    };
  }

  return {
    id: "dmarc",
    label: "DMARC policy",
    state: "pass",
    detail: `Published, p=${policy}.`,
  };
}

export interface SendingReport {
  domain: string;
  provider: string;
  checks: DnsCheck[];
  state: CheckState;
  /** True only when nothing blocks sending from this domain. */
  canSend: boolean;
}

/**
 * Compose the sending verdict.
 *
 * `canSend` deliberately ignores DMARC warnings: a missing DMARC record does not
 * stop mail leaving, and blocking the switchover on it would be wrong. SPF and
 * DKIM do stop it.
 */
export function sendingReport(
  domain: string,
  spfTxts: string[],
  dkimTxts: string[],
  dmarcTxts: string[],
  expected: SendingExpectations = RESEND_DEFAULTS,
): SendingReport {
  const spf = checkSendingSpf(spfTxts, expected);
  const dkim = checkDkim(dkimTxts, expected);
  const dmarc = checkDmarc(dmarcTxts);
  const checks = [spf, dkim, dmarc];

  const worst: CheckState =
    checks.some((c) => c.state === "fail")    ? "fail" :
    checks.some((c) => c.state === "missing") ? "missing" :
    checks.some((c) => c.state === "warn")    ? "warn" : "pass";

  return {
    domain,
    provider: expected.providerName,
    checks,
    state: worst,
    canSend: (spf.state === "pass" || spf.state === "warn") && dkim.state === "pass",
  };
}
