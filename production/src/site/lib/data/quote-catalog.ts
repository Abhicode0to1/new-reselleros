/**
 * Quote-builder catalogue — everything a multi-line quote can contain, in the
 * shape the "Anutech Quote" handoff uses. Prices come from the repo's own data
 * where it exists (LICENCE_EDITIONS, HOSTING_PLANS, TLDS in catalog.ts) so the
 * quote can never disagree with the rest of the site; support tiers and the
 * three domain "actions" are defined here (not elsewhere in the repo) from the
 * handoff, all in WHOLE RUPEES (CLAUDE.md §13).
 *
 * `annual` / `monthly` are ₹ per `per`-unit per period. Domain / SSL / onsite
 * lines bill once a year (cycle "yr") — never ×12. Domain products carry a
 * `domainField` that selects the reg / renew / transfer column of the chosen
 * extension, so the rate follows the TLD the customer picks.
 */
import { LICENCE_EDITIONS, HOSTING_PLANS, TLDS, type Tld } from "./catalog";

export interface QuoteProduct {
  name: string;      // stable id
  label: string;     // shown
  vendor: string;    // category
  tags: string;      // keyword search haystack
  note: string;
  annual: number;    // ₹/unit, annual commitment
  monthly: number;   // ₹/unit, flexible monthly
  per: string;       // "seat" | "site" | "domain" | "certificate" | "account" | "visit"
  cycle: "mo" | "yr"; // billing cadence for the amount shown
  domain?: boolean;
  domainField?: keyof Pick<Tld, "reg" | "renew" | "transfer">;
}

const LABEL: Record<string, string> = {
  "GW Business Starter": "Google Workspace Business Starter",
  "GW Business Standard": "Google Workspace Business Standard",
  "GW Business Plus": "Google Workspace Business Plus",
  "M365 Business Basic": "Microsoft 365 Business Basic",
  "M365 Business Standard": "Microsoft 365 Business Standard",
  "Zoho Workplace": "Zoho Workplace Standard",
};
const TAGS: Record<string, string> = {
  "GW Business Starter": "gmail meet drive docs sheets slides calendar gemini 30gb",
  "GW Business Standard": "gmail meet recordings shared drives 2tb esignature",
  "GW Business Plus": "vault ediscovery compliance endpoint 5tb audit retention",
  "M365 Business Basic": "outlook teams onedrive exchange webmail sharepoint",
  "M365 Business Standard": "outlook desktop word excel powerpoint teams webinars onedrive",
  "Zoho Workplace": "writer sheet show cliq zoho mail workdrive india cheapest",
};

const vendorOf = (name: string) => name.startsWith("GW ") ? "Google Workspace" : name.startsWith("M365 ") ? "Microsoft 365" : "Zoho Workplace";

const editions: QuoteProduct[] = LICENCE_EDITIONS.map((e) => ({
  name: e.name, label: LABEL[e.name] ?? e.name, vendor: vendorOf(e.name),
  tags: TAGS[e.name] ?? "", note: e.note, annual: e.annual, monthly: e.monthly, per: "seat", cycle: "mo",
}));

const domains: QuoteProduct[] = [
  { name: "Domain registration", label: "Domain registration", vendor: "Domains", tags: "domain registration register new name in com net org dns whois", note: "A new name on the extension you pick — first year.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "reg" },
  { name: "Domain renewal", label: "Domain renewal", vendor: "Domains", tags: "domain renewal renew expiry extend keep", note: "Extend an existing name by one year.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "renew" },
  { name: "Domain transfer", label: "Domain transfer in", vendor: "Domains", tags: "domain transfer move switch registrar epp code", note: "Move a name to us — no fee, adds a year.", annual: 0, monthly: 0, per: "domain", cycle: "yr", domain: true, domainField: "transfer" },
];

const hosting: QuoteProduct[] = HOSTING_PLANS.map((h) => ({
  name: `Hosting ${h.name}`, label: `Web hosting — ${h.name}`, vendor: "Web hosting",
  tags: `cpanel litespeed nvme hosting website ${h.who} mumbai bengaluru`, note: `${h.who} · ${h.lines[0]}`,
  annual: h.yearly, monthly: h.monthly, per: "site", cycle: "mo",
}));

const ssl: QuoteProduct[] = [
  { name: "SSL Positive", label: "Positive SSL — DV", vendor: "SSL & security", tags: "ssl certificate https dv secure padlock", note: "Single domain · issued same day.", annual: 899, monthly: 899, per: "certificate", cycle: "yr" },
  { name: "SSL Wildcard", label: "Wildcard SSL — DV", vendor: "SSL & security", tags: "ssl certificate https wildcard subdomains secure", note: "Unlimited subdomains on one domain.", annual: 4499, monthly: 4499, per: "certificate", cycle: "yr" },
];

const support: QuoteProduct[] = [
  { name: "Support Standard", label: "Support — Standard", vendor: "Support", tags: "support whatsapp help desk included free standard", note: "Included with every order · WhatsApp, Mon–Sat 10–19 IST.", annual: 0, monthly: 0, per: "account", cycle: "yr" },
  { name: "Support Priority", label: "Support — Priority", vendor: "Support", tags: "support priority sla escalation phone urgent response", note: "1-hour first response, 7 days · named engineer.", annual: 999, monthly: 1199, per: "account", cycle: "mo" },
  { name: "Support Onsite Delhi", label: "Onsite visit — Delhi NCR", vendor: "Support", tags: "support onsite visit delhi ncr engineer setup training", note: "Engineer at your office · setup or team training.", annual: 2499, monthly: 2499, per: "visit", cycle: "yr" },
  { name: "Support Managed Admin", label: "Managed admin", vendor: "Support", tags: "support managed admin console users offboarding audit", note: "We run the admin console — users, policies, offboarding.", annual: 1499, monthly: 1799, per: "account", cycle: "mo" },
];

export const QUOTE_PRODUCTS: readonly QuoteProduct[] = [...editions, ...domains, ...hosting, ...ssl, ...support];

/** Category order for the filter, with live counts. */
export const QUOTE_CATEGORIES: readonly string[] = ["Google Workspace", "Microsoft 365", "Zoho Workplace", "Domains", "Web hosting", "SSL & security", "Support"];

/** The extensions the domain picker offers — real reg/renew/transfer from TLDS. */
export const QUOTE_TLDS: readonly Tld[] = TLDS;
