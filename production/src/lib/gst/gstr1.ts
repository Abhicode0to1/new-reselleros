/**
 * GSTR-1 section builder — pure functions, no React, no Supabase.
 *
 * The GST page hands in the period's issued documents (invoices + credit/debit notes)
 * and gets back the tables the return is made of: B2B, B2CL, B2CS, CDNR, CDNUR and the
 * HSN summary, plus a Portal-JSON payload and Offline-Tool CSV rows for each.
 *
 * ─── WHAT WAS WRONG BEFORE (27 Sep 2026) ─────────────────────────────────────
 *   · B2CL cut-off was ₹2,50,000. Notification 12/2024-CT dropped it to ₹1,00,000 for
 *     supplies from 1 Aug 2024, so an inter-state B2C invoice of ₹1.5L went into the B2CS
 *     total instead of its own B2CL line — a return that does not match the invoices.
 *   · Credit/debit notes were counted in the page totals but then "not included — enter
 *     under CDNR on the portal" by hand. They belong in CDNR (registered buyer) / CDNUR
 *     (unregistered, inter-state, over the B2CL cut-off) or netted into B2CS.
 *   · HSN table used one SAC for every rupee. Catalogue items carry their own `hsn`, so a
 *     hosting or hardware line was reported under the SaaS code.
 *   · The Portal JSON carried a made-up GSTIN (`07AAAAA0000A1Z5`) and zero tax in every
 *     line. It is now the company's own GSTIN (the caller refuses to export without one)
 *     and the tax is split into IGST / CGST / SGST.
 */
import { SAAS_HSN, SAAS_HSN_LABEL } from "./hsn";
import { GST_STATE_BY_CODE } from "@/lib/utils";

/** Inter-state B2C invoice above this value gets its own B2CL line (₹1L since 1 Aug 2024). */
export const B2CL_THRESHOLD = 100_000;

export type Gstr1DocType = "invoice" | "credit_note" | "debit_note";

/** One issued document. Notes come in SIGNED (credit note negative) — the GST page
 *  already carries them that way so the period totals net correctly. */
export interface Gstr1Doc {
  id: string;
  date: string;                  // YYYY-MM-DD
  docType: Gstr1DocType;
  customerName: string;
  customerGstin: string | null;
  customerStateCode: string | null;
  customerState: string | null;
  amount: number;                // GST-inclusive document value (signed for notes)
  taxableValue: number;          // signed for notes
  gst: number;                   // total tax (signed for notes)
  taxRate: number;
  interState: boolean;
  /** Per-line HSN/SAC share of the taxable value. Missing → whole document under SAAS_HSN. */
  lines?: { hsn: string; description?: string; taxable: number }[];
}

export interface Seller { stateCode: string | null; state: string | null; gstin?: string | null }

export interface TaxHeads { igst: number; cgst: number; sgst: number }

/** Inter-state → all IGST; intra-state → CGST + SGST (remainder into SGST so they sum exactly). */
export function gstSplit(r: { gst: number; interState: boolean }): TaxHeads {
  if (r.interState) return { igst: r.gst, cgst: 0, sgst: 0 };
  const cgst = Math.trunc(r.gst / 2);
  return { igst: 0, cgst, sgst: r.gst - cgst };
}

/** Offline Tool date: DD-MMM-YYYY. */
export function gstDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  const mon = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m)];
  return `${d}-${mon}-${y}`;
}
/** Portal JSON date: DD-MM-YYYY. */
export function jsonDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

/** Place of supply → { code, name } or null when genuinely unknown.
 *  B2B is authoritative from the GSTIN's first 2 digits; else the customer's state;
 *  else (intra-state B2C) the seller's own state. */
export function posFor(
  d: Pick<Gstr1Doc, "customerGstin" | "customerStateCode" | "customerState" | "interState">, seller: Seller,
): { code: string; name: string } | null {
  if (d.customerGstin && d.customerGstin.length >= 2) {
    const code = d.customerGstin.slice(0, 2);
    return { code, name: GST_STATE_BY_CODE[code] ?? d.customerState ?? "" };
  }
  if (d.customerStateCode) {
    const code = d.customerStateCode.padStart(2, "0");
    return { code, name: d.customerState ?? GST_STATE_BY_CODE[code] ?? "" };
  }
  if (!d.interState && seller.stateCode) {
    const code = seller.stateCode.padStart(2, "0");
    return { code, name: seller.state ?? GST_STATE_BY_CODE[code] ?? "" };
  }
  return null;
}

// ─── Section row shapes ─────────────────────────────────────────────────────

export interface B2bRow { gstin: string; name: string; id: string; date: string; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
export interface B2clRow { id: string; date: string; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
export interface B2csRow { pos: string; interState: boolean; rate: number; taxable: number; heads: TaxHeads }
export interface CdnrRow { gstin: string; name: string; id: string; date: string; noteType: "C" | "D"; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
export interface CdnurRow { id: string; date: string; noteType: "C" | "D"; value: number; pos: string; rate: number; taxable: number; heads: TaxHeads }
export interface HsnRow { hsn: string; description: string; rate: number; value: number; taxable: number; heads: TaxHeads }

export interface Gstr1Sections {
  b2b: B2bRow[];
  b2cl: B2clRow[];
  b2cs: B2csRow[];
  cdnr: CdnrRow[];
  cdnur: CdnurRow[];
  hsn: HsnRow[];
  /** B2C documents with no resolvable place of supply — not in any table. */
  skipped: string[];
  /** Unregistered small notes folded into B2CS (they have no table of their own). */
  notesNettedIntoB2cs: number;
}

const addHeads = (a: TaxHeads, b: TaxHeads): TaxHeads => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });
const posStr = (p: { code: string; name: string }) => `${p.code}-${p.name}`;

/**
 * Per-line HSN shares of a document, in rupees. Lines are given as weights (qty × rate);
 * the document's own taxable value is prorated across them so the HSN table always adds
 * up to the invoice total, whatever discount or proration the invoice carried.
 */
export function hsnLines(
  taxableValue: number,
  items: { hsn: string | null | undefined; description?: string; weight: number }[] | null | undefined,
): { hsn: string; description?: string; taxable: number }[] {
  const usable = (items ?? []).filter((i) => i.weight > 0);
  const totalW = usable.reduce((s, i) => s + i.weight, 0);
  if (!usable.length || totalW <= 0) return [{ hsn: SAAS_HSN, description: SAAS_HSN_LABEL, taxable: taxableValue }];
  const out: { hsn: string; description?: string; taxable: number }[] = [];
  let assigned = 0;
  usable.forEach((i, idx) => {
    const last = idx === usable.length - 1;
    const share = last ? taxableValue - assigned : Math.round((taxableValue * i.weight) / totalW);
    assigned += share;
    out.push({ hsn: (i.hsn ?? "").trim() || SAAS_HSN, description: i.description, taxable: share });
  });
  return out;
}

export function buildGstr1(docs: Gstr1Doc[], seller: Seller): Gstr1Sections {
  const b2b: B2bRow[] = [];
  const b2cl: B2clRow[] = [];
  const cdnr: CdnrRow[] = [];
  const cdnur: CdnurRow[] = [];
  const b2csMap = new Map<string, B2csRow>();
  const hsnMap = new Map<string, HsnRow>();
  const skipped: string[] = [];
  let notesNettedIntoB2cs = 0;

  for (const d of docs) {
    const pos = posFor(d, seller);
    const heads = gstSplit(d);
    const isNote = d.docType !== "invoice";
    const noteType: "C" | "D" = d.docType === "credit_note" ? "C" : "D";

    // HSN summary (Table 12) — signed, so it nets the same way 3B does.
    const lines = d.lines?.length ? d.lines : [{ hsn: SAAS_HSN, description: SAAS_HSN_LABEL, taxable: d.taxableValue }];
    const lineTax = (share: number) => (d.taxableValue ? Math.round((d.gst * share) / d.taxableValue) : 0);
    for (const ln of lines) {
      const key = `${ln.hsn}|${d.taxRate}`;
      const cur = hsnMap.get(key) ?? { hsn: ln.hsn, description: ln.hsn === SAAS_HSN ? SAAS_HSN_LABEL : (ln.description ?? ""), rate: d.taxRate, value: 0, taxable: 0, heads: { igst: 0, cgst: 0, sgst: 0 } };
      const tax = lines.length === 1 ? d.gst : lineTax(ln.taxable);
      cur.taxable += ln.taxable;
      cur.value += ln.taxable + tax;
      cur.heads = addHeads(cur.heads, gstSplit({ gst: tax, interState: d.interState }));
      if (!cur.description && ln.description) cur.description = ln.description;
      hsnMap.set(key, cur);
    }

    if (d.customerGstin) {
      const p = pos ? posStr(pos) : "";
      if (isNote) cdnr.push({ gstin: d.customerGstin, name: d.customerName, id: d.id, date: d.date, noteType, value: Math.abs(d.amount), pos: p, rate: d.taxRate, taxable: Math.abs(d.taxableValue), heads: abs(heads) });
      else b2b.push({ gstin: d.customerGstin, name: d.customerName, id: d.id, date: d.date, value: d.amount, pos: p, rate: d.taxRate, taxable: d.taxableValue, heads });
      continue;
    }
    if (!pos) { skipped.push(d.id); continue; }
    const p = posStr(pos);
    const large = d.interState && Math.abs(d.amount) > B2CL_THRESHOLD;
    if (large) {
      if (isNote) cdnur.push({ id: d.id, date: d.date, noteType, value: Math.abs(d.amount), pos: p, rate: d.taxRate, taxable: Math.abs(d.taxableValue), heads: abs(heads) });
      else b2cl.push({ id: d.id, date: d.date, value: d.amount, pos: p, rate: d.taxRate, taxable: d.taxableValue, heads });
      continue;
    }
    // B2CS — consolidated per place of supply + rate; small unregistered notes net here (signed).
    if (isNote) notesNettedIntoB2cs++;
    const key = `${p}|${d.taxRate}`;
    const cur = b2csMap.get(key) ?? { pos: p, interState: d.interState, rate: d.taxRate, taxable: 0, heads: { igst: 0, cgst: 0, sgst: 0 } };
    cur.taxable += d.taxableValue;
    cur.heads = addHeads(cur.heads, heads);
    b2csMap.set(key, cur);
  }

  return { b2b, b2cl, b2cs: [...b2csMap.values()], cdnr, cdnur, hsn: [...hsnMap.values()], skipped, notesNettedIntoB2cs };
}

function abs(h: TaxHeads): TaxHeads { return { igst: Math.abs(h.igst), cgst: Math.abs(h.cgst), sgst: Math.abs(h.sgst) }; }

// ─── GST Offline Tool CSVs (one file per section, standard templates) ───────

export const GSTR1_HEADERS = {
  b2b:   ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
  b2cl:  ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
  b2cs:  ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
  cdnr:  ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
  cdnur: ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
  hsn:   ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
} as const;

export type CsvRow = (string | number)[];

export function gstr1Csv(s: Gstr1Sections): Record<keyof typeof GSTR1_HEADERS, CsvRow[]> {
  return {
    b2b:   s.b2b.map((r) => [r.gstin, r.name, r.id, gstDate(r.date), r.value, r.pos, "N", "", "Regular B2B", "", r.rate, r.taxable, 0]),
    b2cl:  s.b2cl.map((r) => [r.id, gstDate(r.date), r.value, r.pos, "", r.rate, r.taxable, 0, ""]),
    b2cs:  s.b2cs.map((r) => ["OE", r.pos, "", r.rate, r.taxable, 0, ""]),
    cdnr:  s.cdnr.map((r) => [r.gstin, r.name, r.id, gstDate(r.date), r.noteType, r.pos, "N", "Regular B2B", r.value, "", r.rate, r.taxable, 0]),
    cdnur: s.cdnur.map((r) => ["B2CL", r.id, gstDate(r.date), r.noteType, r.pos, "B2CL", r.value, "", r.rate, r.taxable, 0]),
    hsn:   s.hsn.map((r) => [r.hsn, r.description, "OTH-OTHERS", 0, r.value, r.rate, r.taxable, r.heads.igst, r.heads.cgst, r.heads.sgst, 0]),
  };
}

// ─── Portal JSON (GSTR1 upload schema) ──────────────────────────────────────

const itm = (num: number, r: { rate: number; taxable: number; heads: TaxHeads }) => ({
  num, itm_det: { rt: r.rate, txval: r.taxable, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0 },
});
const posCode = (pos: string) => pos.slice(0, 2);

/** Portal JSON. `gstin` must be the company's real GSTIN — the caller refuses without one.
 *  `fp` is the return period MMYYYY. */
export function gstr1Json(s: Gstr1Sections, gstin: string, fp: string) {
  const byCtin = <T extends { gstin: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.gstin, [...(m.get(r.gstin) ?? []), r]);
    return [...m.entries()];
  };
  const byPos = <T extends { pos: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(posCode(r.pos), [...(m.get(posCode(r.pos)) ?? []), r]);
    return [...m.entries()];
  };
  return {
    gstin, fp, version: "GSTR1_v3.0.4",
    b2b: byCtin(s.b2b).map(([ctin, rows]) => ({
      ctin,
      inv: rows.map((r) => ({ inum: r.id, idt: jsonDate(r.date), val: r.value, pos: posCode(r.pos), rchrg: "N", inv_typ: "R", itms: [itm(1, r)] })),
    })),
    b2cl: byPos(s.b2cl).map(([pos, rows]) => ({
      pos, inv: rows.map((r) => ({ inum: r.id, idt: jsonDate(r.date), val: r.value, itms: [itm(1, r)] })),
    })),
    b2cs: s.b2cs.map((r) => ({
      sply_ty: r.interState ? "INTER" : "INTRA", rt: r.rate, typ: "OE", pos: posCode(r.pos),
      txval: r.taxable, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0,
    })),
    cdnr: byCtin(s.cdnr).map(([ctin, rows]) => ({
      ctin,
      nt: rows.map((r) => ({ ntty: r.noteType, nt_num: r.id, nt_dt: jsonDate(r.date), pos: posCode(r.pos), rchrg: "N", inv_typ: "R", val: r.value, itms: [itm(1, r)] })),
    })),
    cdnur: s.cdnur.map((r) => ({
      typ: "B2CL", ntty: r.noteType, nt_num: r.id, nt_dt: jsonDate(r.date), pos: posCode(r.pos), val: r.value, itms: [itm(1, r)],
    })),
    hsn: {
      data: s.hsn.map((r, i) => ({
        num: i + 1, hsn_sc: r.hsn, desc: r.description, uqc: "OTH", qty: 0,
        val: r.value, txval: r.taxable, iamt: r.heads.igst, camt: r.heads.cgst, samt: r.heads.sgst, csamt: 0,
      })),
    },
  };
}
