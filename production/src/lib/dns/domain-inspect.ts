/**
 * Looking at a customer's own domain — what their mail runs on today.
 *
 * Pure. The DNS query is in domain-inspect.server.ts; what may be asked, what may be concluded,
 * and what may be said about it are decided here.
 *
 * ─── REPORT WHAT IS. NEVER PRESCRIBE WHAT TO CHANGE. ────────────────────────
 * That single line is the whole safety design, and it is the line the existing record guard
 * already draws from the other side. `verifyNoInventedRecords` (lib/ai/support-agent.ts) refuses
 * any draft naming a concrete DNS record value that was not handed in as authorised, because —
 * in its own words — a wrong MX read out to a customer takes their mail down and they will
 * follow it exactly, since we said it.
 *
 * An OBSERVED record is the opposite case and it is safe: "your mail is on Hostinger today" is
 * something the customer can confirm in thirty seconds, and it is already true whether we say it
 * or not. So a lookup makes the agent MORE able to be useful and no more able to break anything,
 * provided the direction is respected: we may say what their records are, and we may never say
 * what to replace them with. Target values come from the customer's own admin console, which is
 * exactly where the support agent's prompt already sends them.
 *
 * ─── AND THE MIGRATION SENTENCE IN THE BRIEF WAS THE PART TO REFUSE ─────────
 * The brief paired the lookup with: "Hum aapke purane saare emails ko Google Workspace mein
 * bina kisi data loss ke 2 ghante mein migrate kar denge."
 *
 * Three claims in one sentence and none of them ours to make. "2 ghante" is a duration for work
 * whose length depends entirely on how many mailboxes there are and how big they are — five
 * accounts and fifty with 20GB each are not the same afternoon. "bina kisi data loss" is a
 * guarantee about somebody else's IMAP server. And both are commitments made by a machine in the
 * company's name.
 *
 * `findPromises` did not catch that sentence, which is how the hole in its DATE_RE was found and
 * closed on 25 Aug 2026 — it needed the preposition first ("in 2 hours") and this puts the number
 * first with a Hindi unit. So the guard catches it now, and this module's own
 * `MIGRATION_CLAIMS_FORBIDDEN` says the same thing to the model before it ever writes it.
 */

/** Hostname fragments that identify a mail provider, longest-first so the specific wins. */
const PROVIDER_SIGNATURES: readonly { match: string; name: string }[] = [
  // Google — several shapes over the years.
  { match: "aspmx.l.google.com", name: "Google Workspace" },
  { match: "googlemail.com", name: "Google Workspace" },
  { match: "google.com", name: "Google Workspace" },
  // Microsoft.
  { match: "mail.protection.outlook.com", name: "Microsoft 365" },
  { match: "outlook.com", name: "Microsoft 365" },
  { match: "hotmail.com", name: "Microsoft (consumer)" },
  // Zoho.
  { match: "zoho.com", name: "Zoho Mail" },
  { match: "zohomail", name: "Zoho Mail" },
  // The Indian hosts a small business is most likely to already be on.
  { match: "hostinger", name: "Hostinger" },
  { match: "secureserver.net", name: "GoDaddy" },
  { match: "godaddy", name: "GoDaddy" },
  { match: "bigrock", name: "BigRock" },
  { match: "resellerclub", name: "ResellerClub" },
  { match: "hostgator", name: "HostGator" },
  { match: "bluehost", name: "Bluehost" },
  { match: "rediffmailpro", name: "Rediffmail Pro" },
  { match: "rediff", name: "Rediffmail" },
  { match: "cpanel", name: "a cPanel host" },
  // Filtering layers that sit IN FRONT of the real provider — see identifyProvider.
  { match: "mimecast", name: "Mimecast (filtering)" },
  { match: "proofpoint", name: "Proofpoint (filtering)" },
  { match: "barracuda", name: "Barracuda (filtering)" },
];

/**
 * A domain we are willing to look up.
 *
 * Rejects far more than it needs to, on purpose. This value comes from a customer's message, so
 * it is untrusted input that becomes a network lookup — and while a DNS query is not an HTTP
 * fetch, the same discipline applies: an IP literal, a bare hostname, `localhost` or an internal
 * suffix has no business being resolved on our behalf, and refusing them costs nothing because
 * no real customer's domain looks like that.
 */
export function normaliseDomain(raw: string | null | undefined): string | null {
  let d = (raw ?? "").trim().toLowerCase();
  if (!d) return null;

  /* Strip a scheme, a path, an @ and a trailing dot — people paste all four. */
  d = d.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^.*@/, "").replace(/\.$/, "");
  /* And a port. */
  d = d.replace(/:\d+$/, "");

  if (d.length < 4 || d.length > 253) return null;
  /* Must be a real registrable name: at least one dot, letters in the TLD. */
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  if (!/\.[a-z]{2,}$/.test(d)) return null;
  /* An IPv4 literal passes the shape test above — exclude it explicitly. */
  if (/^\d+(\.\d+)+$/.test(d)) return null;

  const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".test", ".invalid", ".example", ".onion"];
  if (BLOCKED_SUFFIXES.some((s) => d.endsWith(s))) return null;
  if (d === "localhost") return null;

  return d;
}

/**
 * The provider BRAND NAMES this module can recognise, for guards that need to spot one in prose.
 *
 * Derived from PROVIDER_SIGNATURES rather than written out again, because two lists of
 * competitor names do not stay equal — add a signature and the disparagement guard would go on
 * being blind to the brand it now recognises. The parenthetical qualifiers ("(filtering)",
 * "(consumer)") are stripped and the generic "a cPanel host" is reduced to the word that
 * actually appears in a sentence.
 *
 * "Webmail" is appended by hand: it is not an MX signature — no MX record says "webmail" — but
 * it is what customers and briefs call this whole category, so a guard reading prose needs it.
 */
export const PROVIDER_BRANDS: readonly string[] = [
  ...new Set(
    PROVIDER_SIGNATURES.map((p) =>
      p.name
        .replace(/\s*\([^)]*\)\s*/g, "")
        .replace(/^an?\s+/i, "")
        .replace(/\s+host$/i, "")
        .trim(),
    ),
  ),
  "webmail",
].filter((n) => n.length > 2);

export interface MxRecord {
  exchange: string;
  priority: number;
}

export type ProviderVerdict =
  | { known: true; provider: string; alsoFiltering: string | null }
  /** Records exist but match nothing we recognise. */
  | { known: false; reason: "unrecognised" }
  /** No MX at all — which is usually a typo, not a company without email. */
  | { known: false; reason: "no_mx" };

/**
 * Who runs this domain's mail, from its MX hosts.
 *
 * ─── UNRECOGNISED IS AN ANSWER, NOT A FALLBACK ──────────────────────────────
 * There is no "probably" here. Guessing a provider is the same class of mistake as guessing a
 * product from a bare "Standard" — it produces a confident sentence about somebody's
 * infrastructure that a machine invented, and the customer has no reason to doubt it. So the
 * only outcomes are "this is Hostinger", "records exist and I do not recognise them", and "no
 * records found".
 *
 * A FILTERING layer complicates it honestly: Mimecast in front of Microsoft 365 means the MX
 * says Mimecast and the mailboxes are still Microsoft's. Reporting the filter as the provider
 * would be wrong, so both are named and the sentence says which is which.
 */
export function identifyProvider(mx: readonly MxRecord[]): ProviderVerdict {
  if (mx.length === 0) return { known: false, reason: "no_mx" };

  const hosts = mx.map((r) => r.exchange.toLowerCase());
  const hits = PROVIDER_SIGNATURES.filter((s) => hosts.some((h) => h.includes(s.match)));
  if (hits.length === 0) return { known: false, reason: "unrecognised" };

  const filtering = hits.find((h) => h.name.includes("(filtering)"));
  const mailbox = hits.find((h) => !h.name.includes("(filtering)"));

  if (mailbox) {
    return { known: true, provider: mailbox.name, alsoFiltering: filtering?.name ?? null };
  }
  /* Only a filter matched. Say so rather than calling the filter their mail provider — the
     mailboxes are somewhere behind it and we cannot see where from here. */
  return { known: true, provider: filtering!.name, alsoFiltering: null };
}

/**
 * What the agent may state about the lookup, as finished sentences.
 *
 * Written by the app, handed to the model, the same discipline as the net-cost block and the
 * telecaller's price list. Every sentence is an observation the customer can verify.
 */
export function inspectionFacts(input: {
  domain: string;
  verdict: ProviderVerdict;
  mx: readonly MxRecord[];
}): string[] {
  const lines: string[] = [];

  if (!input.verdict.known && input.verdict.reason === "no_mx") {
    /* NOT "you have no email". A missing MX on the domain somebody typed is far more often a
       typo — sharmatraders.in against sharmatraders.co.in — than a company without mail. Asking
       is the only honest move, and it is also the useful one. */
    lines.push(
      `No mail records were found for ${input.domain}. That usually means the domain is spelt ` +
      "differently from the one their mail runs on — ask them to confirm it rather than telling " +
      "them they have no email.",
    );
    return lines;
  }

  if (!input.verdict.known) {
    lines.push(
      `${input.domain} has mail records, but they do not match any provider this app ` +
      "recognises. Do NOT guess who it is — ask them who runs their email today.",
    );
    return lines;
  }

  lines.push(`${input.domain}'s mail is currently handled by ${input.verdict.provider}.`);
  if (input.verdict.alsoFiltering) {
    lines.push(
      `${input.verdict.alsoFiltering} sits in front of it, so their mail is filtered before it ` +
      `reaches ${input.verdict.provider}.`,
    );
  }
  lines.push(
    "You may state that as an observation of their public DNS records. You may NOT tell them " +
    "what to change any record to — exact values come from their own admin console.",
  );

  return lines;
}

/**
 * What the model must not turn the lookup into.
 *
 * Named explicitly because the brief did exactly this, and because a model handed a technical
 * observation reaches naturally for a technical promise to go with it.
 */
export const MIGRATION_CLAIMS_FORBIDDEN: readonly string[] = [
  "how long a migration will take — not in hours, not in days, not 'quickly'. It depends on how " +
    "many mailboxes there are and how big they are, and you have been told neither",
  "that no data will be lost — that is a guarantee about their current mail server, which you " +
    "cannot see and do not control",
  "that the migration happens with no downtime, or during business hours, or overnight",
  "any MX, SPF, DKIM or DMARC value they should switch TO — only what they have now",
  "who their DNS host should be, or that their current provider is bad",
];
