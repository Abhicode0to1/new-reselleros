/**
 * Parse Google Contacts CSV export.
 *
 * Google's CSV format (varies slightly by locale) typically has these columns:
 *   - Name / First Name / Last Name / Middle Name
 *   - E-mail 1 - Value / E-mail 2 - Value / ...
 *   - Phone 1 - Value / Phone 2 - Value / ...
 *   - Organization 1 - Name
 *   - Organization 1 - Title
 *   - Notes
 *   - Labels (categories, separated by ::: and ;)
 *
 * We're forgiving: accept missing columns, blank fields, alternate header casing.
 * Returns parsed rows + count of skipped (no-name).
 */
import { parseCsvLine, findColumn } from "@/lib/csv";

export interface ParsedContact {
  fullName:   string;
  email:      string | null;
  phone:      string | null;
  company:    string | null;
  title:      string | null;
  notes:      string | null;
  tags:       string[];
  rowIndex:   number;  // 1-based row position in the CSV (for "select all" UX)
}

export interface ParseResult {
  rows:       ParsedContact[];
  total:      number;
  skipped:    number;       // rows dropped (no name)
  warnings:   string[];
}

/* parseCsvLine, normHeader and findColumn moved to lib/csv.ts when the vendor licence
   reconciliation became a second reader of the same shapes. Two copies of "how do you
   split a quoted CSV line" is how two importers come to disagree about one file. */

export function parseGoogleContactsCsv(csv: string): ParseResult {
  const warnings: string[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { rows: [], total: 0, skipped: 0, warnings: ["CSV is empty"] };
  }

  const headers = parseCsvLine(lines[0]);

  // Best-effort column mapping — try common variants
  const colName        = findColumn(headers, ["Name", "Full Name", "Display Name"]);
  const colFirstName   = findColumn(headers, ["First Name", "Given Name"]);
  const colLastName    = findColumn(headers, ["Last Name", "Family Name", "Surname"]);
  const colEmail1      = findColumn(headers, ["E-mail 1 - Value", "Email 1 - Value", "Email", "E-mail"]);
  const colEmail2      = findColumn(headers, ["E-mail 2 - Value", "Email 2 - Value"]);
  const colPhone1      = findColumn(headers, ["Phone 1 - Value", "Phone Number"]);
  const colPhone2      = findColumn(headers, ["Phone 2 - Value"]);
  const colOrg1Name    = findColumn(headers, ["Organization 1 - Name", "Organization", "Company"]);
  const colOrg1Title   = findColumn(headers, ["Organization 1 - Title", "Title", "Job Title"]);
  const colNotes       = findColumn(headers, ["Notes"]);
  const colLabels      = findColumn(headers, ["Labels", "Categories", "Group Membership"]);

  if (colName < 0 && colFirstName < 0) {
    warnings.push("No 'Name' or 'First Name' column found — most rows will be skipped");
  }
  if (colEmail1 < 0 && colPhone1 < 0) {
    warnings.push("No 'Email' or 'Phone' columns found — imported contacts will lack contact info");
  }

  const rows: ParsedContact[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const get = (idx: number) => (idx >= 0 ? (fields[idx] ?? "").trim() : "");

    // Resolve full name
    let fullName = get(colName);
    if (!fullName) {
      const f = get(colFirstName);
      const l = get(colLastName);
      fullName = [f, l].filter(Boolean).join(" ").trim();
    }
    if (!fullName) {
      // Try to recover using email local-part
      const email = get(colEmail1);
      if (email) fullName = email.split("@")[0].replace(/[._-]+/g, " ");
    }
    if (!fullName) {
      skipped++;
      continue;
    }

    const email = (get(colEmail1) || get(colEmail2)).toLowerCase() || null;
    const phone = (get(colPhone1) || get(colPhone2)) || null;

    const labelsRaw = get(colLabels);
    const tags = labelsRaw
      ? labelsRaw.split(/[;,:]+/).map((t) => t.trim()).filter((t) => t && !/^\*/.test(t))
      : [];

    rows.push({
      fullName,
      email,
      phone,
      company: get(colOrg1Name)  || null,
      title:   get(colOrg1Title) || null,
      notes:   get(colNotes)     || null,
      tags,
      rowIndex: i,
    });
  }

  return {
    rows,
    total: lines.length - 1,
    skipped,
    warnings,
  };
}
