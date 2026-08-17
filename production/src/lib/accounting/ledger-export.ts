/**
 * Getting a ledger out of ResellerOS and into somebody else's hands — a CA's Tally, or a
 * customer's WhatsApp.
 *
 * ─── WHY CSV AND XML, AND WHY NOT XLSX ──────────────────────────────────────
 * The brief asked for "Tally Excel / XML". Tally Prime imports **XML** and reads CSV; it
 * does not import .xlsx. Producing a real .xlsx would mean a new dependency (CLAUDE.md
 * §17: don't) to generate a format Tally cannot ingest — busywork that looks like a
 * feature. So:
 *
 *   CSV  — opens in Excel, which is what "Excel export" actually means to the CA who
 *          asked for it, and reuses lib/csv.ts (BOM, CRLF, formula-injection guard).
 *   XML  — Tally Prime's own import envelope, so the vouchers land as vouchers rather
 *          than as a spreadsheet somebody re-types.
 *
 * ─── THE XML IS DELIBERATELY LABELLED AS A DRAFT ────────────────────────────
 * Tally's import is unforgiving and its ledger names must already exist in the target
 * company — `<LEDGERNAME>` has to match Tally's spelling exactly or the voucher is
 * rejected on import, silently for the row. This generates a correct envelope with the
 * party name as we hold it; whether that string matches the CA's Tally is something only
 * the CA can confirm. The UI says so rather than implying a one-click merge.
 */
import { buildCSV } from "@/lib/csv";
import { rupee } from "@/lib/utils";
import type { LedgerStatement } from "./ledger";

export const LEDGER_CSV_HEADERS = [
  "Date", "Particulars", "Voucher Type", "Debit", "Credit", "Balance", "Dr/Cr",
] as const;

/**
 * The statement as CSV rows, opening balance included as its own line.
 *
 * The opening balance is a ROW, not a footnote. A CA importing this into a spreadsheet
 * sums the columns; if the opening sits outside the table the sum is wrong by exactly the
 * carried-forward amount and nothing says so.
 */
export function ledgerCsvRows(s: LedgerStatement): (string | number)[][] {
  const rows: (string | number)[][] = [];

  rows.push([
    s.period.from, "Opening Balance", "", "", "",
    Math.abs(s.openingBalance), s.openingSide ?? "",
  ]);

  for (const r of s.rows) {
    rows.push([
      r.date,
      r.narration ? `${r.reference} — ${r.narration}` : r.reference,
      r.voucher,
      r.debit || "",
      r.credit || "",
      Math.abs(r.balance),
      r.balanceSide ?? "",
    ]);
  }

  rows.push([
    s.period.to, "Closing Balance", "", s.totalDebit, s.totalCredit,
    Math.abs(s.closingBalance), s.closingSide ?? "",
  ]);
  return rows;
}

export function ledgerCsv(s: LedgerStatement): string {
  return buildCSV([...LEDGER_CSV_HEADERS], ledgerCsvRows(s));
}

/** `ledger-mary-corprotion-FY-2026-27.csv` — safe on every filesystem. */
export function ledgerFileName(partyName: string, s: LedgerStatement, ext: "csv" | "xml"): string {
  const slug = partyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "party";
  const period = s.period.label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `ledger-${slug}-${period}.${ext}`;
}

/* ─── TALLY XML ──────────────────────────────────────────────────────────── */

/** Tally wants DDMMYYYY with no separators. */
function tallyDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}${m}${y}`;
}

/**
 * XML-escape. Tally rejects the whole envelope on a stray `&`, and a customer called
 * "R&D Solutions" is not a hypothetical — so this runs on every interpolated value rather
 * than only on the ones that look risky.
 */
export function xmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Tally's voucher type for one of our documents.
 *
 * Only names Tally ships with by default. A custom voucher type that does not exist in
 * the target company is rejected at import, per row, quietly — so a Refund maps to
 * "Receipt" (reversed sign) rather than inventing "Refund Voucher".
 */
function tallyVoucherType(v: LedgerStatement["rows"][number]["voucher"]): string {
  switch (v) {
    case "Sales":       return "Sales";
    case "Purchase":    return "Purchase";
    case "Receipt":     return "Receipt";
    case "Refund":      return "Receipt";
    case "Payment":     return "Payment";
    case "Credit Note": return "Credit Note";
    case "Debit Note":  return "Debit Note";
  }
}

/**
 * Tally's sign convention, which is NOT ours.
 *
 * In a Tally XML `<ALLLEDGERENTRIES.LIST>`, a **negative** AMOUNT is a Debit to that
 * ledger and a positive one is a Credit. Getting this backwards produces an envelope that
 * imports cleanly and puts every figure on the wrong side — the worst possible outcome,
 * because nothing errors and the CA finds it while reconciling.
 */
function tallyAmount(debit: number, credit: number): number {
  return debit > 0 ? -debit : credit;
}

/**
 * A Tally Prime import envelope for one party's statement.
 *
 * The counter-ledger is intentionally generic — "Sundry Debtors" for a customer, "Sundry
 * Creditors" for a vendor — because those two exist in every Tally company. A specific
 * sales or purchase ledger name would be a guess about the CA's chart of accounts, and a
 * wrong guess rejects the row.
 */
export function ledgerTallyXml(
  s: LedgerStatement,
  partyName: string,
  companyName: string,
): string {
  const party = xmlEscape(partyName);
  const group = s.kind === "customer" ? "Sundry Debtors" : "Sundry Creditors";

  const vouchers = s.rows.map((r) => {
    const amount = tallyAmount(r.debit, r.credit);
    const narration = xmlEscape(
      [r.reference, r.narration].filter(Boolean).join(" — "),
    );
    return `      <VOUCHER VCHTYPE="${xmlEscape(tallyVoucherType(r.voucher))}" ACTION="Create">
        <DATE>${tallyDate(r.date)}</DATE>
        <VOUCHERTYPENAME>${xmlEscape(tallyVoucherType(r.voucher))}</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xmlEscape(r.reference)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>
        <NARRATION>${narration}</NARRATION>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${party}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${amount < 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
          <AMOUNT>${amount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${xmlEscape(group)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${amount < 0 ? "No" : "Yes"}</ISDEEMEDPOSITIVE>
          <AMOUNT>${-amount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>
      </VOUCHER>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${vouchers}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/* ─── WHATSAPP ───────────────────────────────────────────────────────────── */

/**
 * The message that goes with a statement.
 *
 * ─── IT STATES THE BALANCE IN WORDS, NOT JUST "SEE ATTACHED" ────────────────
 * A customer reading this on a phone should learn the one fact that matters without
 * opening anything: whether they owe money, how much, and for what period. "Please find
 * your ledger attached" makes them open a PDF to discover they owe ₹40,000, and the ones
 * who do not open it never find out.
 *
 * ─── AND IT SAYS THE RIGHT THING WHEN THEY OWE NOTHING ──────────────────────
 * A settled account gets "nothing outstanding", and a credit balance says WE hold their
 * money. Sending "₹0 Dr" or, worse, an amount with no side, to a customer who has paid in
 * full is how a reseller loses a renewal.
 */
export function ledgerWhatsAppText(args: {
  partyName: string;
  statement: LedgerStatement;
  sellerName?: string | null;
}): string {
  const { partyName, statement: s, sellerName } = args;
  const amount = rupee(Math.abs(s.closingBalance));

  const balanceLine =
    s.closingBalance === 0
      ? "*Nothing outstanding* — your account is fully settled. Thank you."
      : s.closingSide === "Dr"
        ? `Closing balance: *${amount} outstanding*.`
        : `Closing balance: *${amount} in your favour* — we are holding this as an advance against your next invoice.`;

  const sign = sellerName?.trim() ? `\n\n*${sellerName.trim()}*` : "";

  return `Namaste 🙏,

Here is the account statement for *${partyName}* — ${s.period.label}.

Opening balance: ${rupee(Math.abs(s.openingBalance))}${s.openingSide ? ` ${s.openingSide}` : ""}
Billed in this period: ${rupee(s.totalBilled)}
Received in this period: ${rupee(s.totalSettled)}

${balanceLine}

If anything does not match your books, tell us which entry and we will trace it.${sign}`;
}

/** wa.me link carrying that message. Phone may be blank — WhatsApp then asks who to send to. */
export function ledgerWhatsAppUrl(
  phone: string | null | undefined,
  text: string,
): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  const e164 = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${e164}?text=${encodeURIComponent(text)}`;
}
