/**
 * The switch conversation: when a lead is already on somebody else's mail, and what we may offer.
 *
 * ─── THE OFFER THE BRIEF ASKED FOR ALREADY EXISTS, AND IS ALREADY AUTHORISED ─
 * The brief wanted trade-in incentives for customers leaving GoDaddy, Rediffmail, Hostinger or
 * a webmail host. The incentive it reached for is on the agent's authorised list already:
 * "Free migration of existing mail and data." That is the trade-in — it is real, it is ours to
 * give, and it costs the customer nothing to verify because it appears on the quotation.
 *
 * What was genuinely MISSING is that nothing connected the two. `identifyProvider` has known
 * since yesterday that a domain's MX says GoDaddy, and no reply changed because of it. So this
 * module does the one thing that is safe to do with that fact: it REORDERS what we lead with.
 * Same invariant as lib/ai/tone.ts — it chooses among authorised claims and never adds one.
 *
 * ─── AND THE REST OF THE OFFER CANNOT BE MADE ───────────────────────────────
 * "1st Month Free DNS Setup + Free Domain Security Lockdown (SPF/DKIM/DMARC) bilkul FREE".
 * Four claims. Each was measured before being refused:
 *
 * 1. "1ST MONTH FREE" IS NOT A PRICE THAT EXISTS. `lib/pricing/workspace.ts:13` is explicit —
 *    "NO hardcoded tier promos. Discounts go through the coupon / site-promo system
 *    (redeem_coupon / create_site_promo), not baked into pricing." So the answer is not "no",
 *    it is "that is a COUPON". A first-month-free offer is a real thing this platform can do,
 *    created by a person, with a code, an expiry and a record of who redeemed it. A sentence an
 *    AI writes into an email is none of those, and it is a discount the quote will not honour —
 *    the customer gets a promise in prose and an invoice that disagrees with it.
 *
 * 2. "FREE DNS SETUP" IS WORK WE CANNOT DO. Their DNS lives at their registrar, behind their
 *    login. We have no access and asking for it is asking a stranger for the keys to their
 *    domain in a first sales mail.
 *
 * 3. "FREE DOMAIN SECURITY LOCKDOWN (SPF/DKIM/DMARC)" IS THE DANGEROUS ONE, and not for
 *    compliance reasons. Every failure mode of that work is SILENT MAIL LOSS on a live
 *    business's domain:
 *
 *      · DMARC at enforcement (p=reject) with anything misconfigured makes legitimate mail
 *        vanish. Not bounce — vanish. The customer finds out weeks later when somebody says
 *        "I never got your invoice".
 *      · SPF permits TEN DNS lookups, total. Adding Google's include to a record that already
 *        has GoDaddy's, a CRM's and a mailer's can cross that line, and crossing it does not
 *        break the new sender — it breaks authentication for EVERYTHING the domain sends.
 *      · DKIM needs a key generated inside their Workspace admin console and the selector
 *        published at their registrar. There is no version of it we can do from outside.
 *
 *    So this is offering, for free, an operation whose worst case is a business quietly losing
 *    mail it does not know it is losing — offered by an agent that has seen one MX record. And
 *    `MIGRATION_CLAIMS_FORBIDDEN` already forbade "any MX, SPF, DKIM or DMARC value they should
 *    switch TO", written the day before this brief arrived.
 *
 * 4. "LEGACY PROVIDERS" IS THE FRAMING, AND IT NEEDED A GUARD RATHER THAN A RULE. See
 *    lib/ai/disparagement.ts: "Your legacy GoDaddy setup is outdated" passed every check on the
 *    draft path, because it is not a promise. That hole is closed in the same commit as this
 *    file.
 */
import { PROVIDER_BRANDS, type ProviderVerdict } from "@/lib/dns/domain-inspect";
import { AUTHORISED_CLAIMS, type AuthorisedClaim } from "./tone";

/**
 * Providers where "we would move you across" is the natural next sentence.
 *
 * Named as the mailbox hosts we are NOT — everything else in the signature table. Kept as an
 * exclusion rather than a list of competitors so that adding a new signature to
 * `PROVIDER_SIGNATURES` cannot silently leave a provider out of this conversation.
 */
const WE_SELL_THESE: readonly string[] = ["Google Workspace", "Microsoft 365", "Zoho Mail"];

/** A filtering layer is not a mailbox host, so it never decides whether this is a switch. */
const FILTERING_ONLY = /\bfiltering\b/i;

export interface SwitchProfile {
  /** True when their mail is somewhere we would be moving it FROM. */
  isSwitcher: boolean;
  /** The provider, when we recognise it. Null when we do not, or when it is one of ours. */
  from: string | null;
  /**
   * Already on a platform we sell, which is a RESELLER switch, not a mail migration.
   *
   * A different conversation and an important distinction: there is no data to move, so the
   * migration claim does not apply and offering it would be offering to do nothing.
   */
  samePlatform: boolean;
  /** Which authorised claims to lead with. A subset of AUTHORISED_CLAIMS, always. */
  leadWith: readonly AuthorisedClaim[];
}

/**
 * Read the switch situation off the MX verdict we already have.
 *
 * Unrecognised records and a missing MX both produce `isSwitcher: false`, deliberately. We do
 * not know what they are on, so "we will move you off it" is a sentence about a system we
 * cannot see — the same reason `identifyProvider` refuses to guess a provider in the first
 * place.
 */
export function switchProfile(verdict: ProviderVerdict): SwitchProfile {
  if (!verdict.known) {
    return { isSwitcher: false, from: null, samePlatform: false, leadWith: [] };
  }

  if (FILTERING_ONLY.test(verdict.provider)) {
    /* Only a filter is visible, so the mailbox host is unknown — see identifyProvider's own
       note about Mimecast in front of Microsoft 365. Unknown means no claim. */
    return { isSwitcher: false, from: null, samePlatform: false, leadWith: [] };
  }

  const samePlatform = WE_SELL_THESE.some((p) => verdict.provider.startsWith(p));
  if (samePlatform) {
    /* Their mail already runs on a platform we sell. Nothing to migrate, so lead with the two
       things that are about US rather than about moving: the invoice and the support. */
    return {
      isSwitcher: false,
      from: verdict.provider,
      samePlatform: true,
      leadWith: ["gst_invoice", "local_support"],
    };
  }

  return {
    isSwitcher: true,
    from: verdict.provider,
    samePlatform: false,
    /* Migration first, because it is the one thing on the authorised list that answers the
       question a switcher is actually asking. */
    leadWith: ["migration_included", "gst_invoice"],
  };
}

/**
 * What must not be offered to a switcher, with the reason attached.
 *
 * The reasons travel into the prompt because a bare prohibition invites a workaround, and
 * because a colleague reading the timeline should be able to see why the mail was plainer than
 * the brief they remember. Every entry here corresponds to a numbered item in this file's
 * header, where the measurement behind it is recorded.
 */
export const TRADE_IN_FORBIDDEN: readonly string[] = [
  "Do NOT offer a free month, a free first month, a free trial, or any period at no charge. " +
    "No such price exists — promotions on this platform are COUPONS with a code and an expiry, " +
    "created by a person, and a discount written into an email is one the quotation will not " +
    "honour. The customer would get a promise in prose and an invoice that disagrees with it.",
  "Do NOT offer to set up, configure, change, harden or 'lock down' their DNS, and do NOT offer " +
    "to configure SPF, DKIM or DMARC. Their DNS is behind their registrar login, which we do " +
    "not have, and asking a stranger for it in a first mail is not a thing we do.",
  "Do NOT describe any DNS or email-security work as free, included or bundled. The only thing " +
    "included is migration of their existing mail and data, which is already on your list.",
  "Do NOT say or imply that their current provider is old, insecure, unsupported or worse than " +
    "ours. You can see one MX record and nothing else — not their configuration, not their " +
    "support arrangement — and they chose that provider themselves.",
  "Do NOT name another customer, a client list or a logo as evidence that switching is safe.",
];

/**
 * The prompt block for a switcher. Observations and an ordering, never an offer.
 *
 * Returns an empty array when there is nothing to say — an unrecognised MX, a missing one, or a
 * provider we cannot identify — so an ordinary enquiry's prompt is untouched. A heading followed
 * by nothing is worse than no heading, the same call `observeDomain` makes.
 */
export function tradeInFacts(profile: SwitchProfile): string[] {
  /* ─── EVERY WORD BELOW IS CHECKED AGAINST THE DRAFT GUARDS, AND TWO FAILED ───
     The first version of this block said "Their mail runs on GoDaddy TODAY" and "of the things
     you MAY PROMISE". Both are tokens `findPromises` refuses — `today` as a date and `promise`
     as a guarantee — and both kinds are in RELEVANT_PROMISE_KINDS, so a model echoing either
     phrase would have had its reply held. That is not hypothetical for "today": the sentence is
     almost exactly what `inspectionFacts` tells the agent to state, so it is the phrasing most
     likely to come back out. It would have held every switcher's reply, which is how a feature
     ends up alive and dead at the same time (see maskAuthorisedSellingPoints).

     So this says "currently handled by", which is the wording inspectionFacts already uses —
     one phrasing for one fact rather than two that can drift — and "authorised list" rather
     than "promise". A test in trade-in.test.ts runs both guards over these lines. */
  if (!profile.isSwitcher) {
    if (!profile.samePlatform) return [];
    return [
      "THEY ARE ALREADY ON A PLATFORM WE SELL",
      `Their mail is currently handled by ${profile.from}, so this is a change of supplier and`,
      "NOT a migration — there is nothing to move. Do not offer to migrate their mail; offering",
      "to do nothing reads exactly like it. What is different about us is the invoice and who",
      "answers the phone, so lead with those.",
    ];
  }

  return [
    "THIS IS A SWITCH, AND THE TRADE-IN IS ALREADY ON YOUR LIST",
    `Their mail is currently handled by ${profile.from}. Of the claims on your authorised`,
    "list, lead with migration of their existing mail and data being included, then the GST",
    "invoice. That IS the switching incentive — it is real, it is ours to give, and it appears",
    "on the quotation so they can check it.",
    "This changes the ORDER only. It adds nothing to that list, and the limit of at most two",
    "still applies.",
    "",
    "WHAT YOU MAY NOT OFFER THEM:",
    ...TRADE_IN_FORBIDDEN.map((f) => `  - ${f}`),
  ];
}

/**
 * Every brand a draft could name, for tests and for the disparagement guard's own assertions.
 *
 * Re-exported rather than duplicated. Two lists of competitor names do not stay equal.
 */
export { PROVIDER_BRANDS };

/** Guard-rail for the tests: the claims this module may choose from, and no others. */
export const TRADE_IN_CLAIM_UNIVERSE = AUTHORISED_CLAIMS;
