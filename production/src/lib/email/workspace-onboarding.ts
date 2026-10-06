/**
 * After a Google Workspace purchase — what the customer does next, and what the person who
 * owns the lead does next (R-120, 2 Oct 2026).
 *
 * Pardeep: "related employee ko lead handle karne ke proper email aana chahiye … customer
 * email chala jana chahiye … company ka email setup karne ka kya process hai". Until then the
 * customer got three lines ("we will contact you") and only the tenant inbox got the action
 * list; the employee the lead was dealt to (R-111) heard nothing.
 *
 * Pure text builders — the webhook and the simulated checkout both send these, so a test
 * buy shows exactly what a real buyer receives. DNS facts match lib/dns/workspace-dns.ts
 * (MX: smtp.google.com priority 1; SPF include:_spf.google.com), which is what the app's DNS
 * checker verifies afterwards.
 */

export interface SetupFacts {
  domain: string;
  seats: string | number;
  tierName: string;
  /** Who the customer is dealing with — a person, not "the team". */
  contactName: string;
  contactPhone?: string;
}

/** The customer's step-by-step: who does what, in order, with the exact DNS values. */
export function customerSetupSteps(f: SetupFacts): string {
  const d = f.domain || "your domain";
  const who = f.contactName || "our team";
  return `HOW YOUR COMPANY EMAIL GETS SET UP (${f.tierName}, ${f.seats} users)

  1. VERIFY ${d} — you, 5 minutes
     ${who} sends you one TXT record (it starts "google-site-verification=").
     Add it in the DNS of ${d} wherever the domain is managed (GoDaddy, Hostinger,
     Cloudflare …). Not sure where? Reply with the name of your domain company and we
     will tell you, or give us access and we add it.

  2. CREATE YOUR USERS — us, same day
     Send us the list: name and the address each person wants (rahul@${d}).
     We create every mailbox and send each person a first-login link.

  3. SWITCH YOUR MAIL — we tell you when, you change one setting
     In the DNS of ${d}, replace the old MX records with ONE record:
        MX   ${d}   →   smtp.google.com   priority 1
     Remove every old MX row — two providers at once means mail goes missing.
     We switch after office hours so nothing is lost.

  4. STOP SPAM-FOLDER PROBLEMS — us, with one record from you
     SPF:   TXT  ${d}   v=spf1 include:_spf.google.com ~all   (only ONE spf record)
     DKIM:  we generate the key in the Google admin and send you the TXT to add
     DMARC: TXT  _dmarc.${d}   v=DMARC1; p=none; rua=mailto:postmaster@${d}

  5. MOVE YOUR OLD MAIL — us, free
     Old mail, folders, contacts and calendars come across overnight.

  6. CHECK — us, Day 7
     A short call to make sure every mailbox sends, receives and is not in spam.

You do not need to buy anything else or touch the Google admin yourself — ${who} does it
with you. Reply to this email at any step.`;
}

export interface OwnerFacts extends SetupFacts {
  orderId: string;
  company: string;
  customerName: string;
  customerEmail: string;
  amount: string;
  appBase: string;
  quoteId: string;
  leadId?: string | null;
}

/** For the employee who owns the lead — what to do now, and the links to do it. */
export function leadOwnerNextSteps(f: OwnerFacts): string {
  const d = f.domain || "the customer's domain";
  return `New paid order — it is yours (you own this lead).

COMPANY   ${f.company}
CONTACT   ${f.customerName} <${f.customerEmail}>${f.contactPhone ? `  ·  ${f.contactPhone}` : ""}
PLAN      ${f.tierName} · ${f.seats} users
DOMAIN    ${d}
PAID      ${f.amount}
ORDER     ${f.orderId}

YOUR NEXT STEPS (the customer has the same list from their side)
  1. Today: call or WhatsApp ${f.customerName || "the customer"} — introduce yourself as their contact.
  2. Google Reseller Console: create the customer for ${d}, add ${f.seats} ${f.tierName} licences.
  3. Send them the google-site-verification TXT record; check it with the DNS checker in the app.
  4. Collect the user list, create the mailboxes, send first-login links.
  5. After office hours: MX to smtp.google.com (priority 1), SPF, DKIM, DMARC.
  6. Migrate old mail; Day 7 health-check call.
  Mark the provisioning row done in the app when the seats are live.

Order in the app:  ${f.appBase}/quotes/${f.quoteId}${f.leadId ? `\nLead:              ${f.appBase}/leads?lead=${f.leadId}` : ""}
Online orders:     ${f.appBase}/online-orders`;
}
