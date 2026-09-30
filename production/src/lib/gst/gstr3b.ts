/**
 * GSTR-3B worksheet — the boxes, from the period's books.
 *
 * 3B is typed on the portal, one figure per box. This turns the period's rows into those
 * boxes so the owner copies numbers instead of computing them:
 *
 *   3.1(a)  outward taxable supplies (invoices net of credit/debit notes, plus tax on
 *           advances received less advances adjusted — GSTR-1 11A/11B), by head
 *   3.1(b)  zero-rated supplies — exports (GSTR-1 Table 6A / EXP): taxable value and the
 *           IGST on exports WITH payment (zero under LUT)
 *   3.2     of 3.1(a), inter-state supplies to UNREGISTERED persons, by place of supply
 *           (taxable value + IGST) — the portal auto-fills this from GSTR-1 B2CL/B2CS and
 *           it must match
 *   3.1(d)  inward supplies liable to reverse charge — imported services (Google Ireland,
 *           Meta, AWS): taxable value and the IGST the buyer pays HIMSELF, in cash
 *   4(A)(3) ITC on that reverse-charge tax (the same amount comes back as credit)
 *   4(A)(5) all other ITC — everything on a proper tax invoice from a GSTIN vendor,
 *           INCLUDING the s.17(5) blocked part (Circular 170/2022: report gross, then reverse)
 *   4(B)(1) ITC reversed — the s.17(5) part (staff welfare, business promotion…)
 *   net     tax payable in cash per head: RCM tax always in cash, plus whatever output
 *           tax the credit does not cover (no cross-head set-off modelled — the portal
 *           does IGST → CGST/SGST itself)
 *
 * Expenses on a kaccha bill or from a vendor with no GSTIN never reach the table: they
 * are not in GSTR-2B and cannot be claimed; `notIn2b` says how much that is.
 */

export interface Heads { igst: number; cgst: number; sgst: number }
const Z: Heads = { igst: 0, cgst: 0, sgst: 0 };
const add = (a: Heads, b: Heads): Heads => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });

export interface Gstr3bOutput {
  taxableValue: number;
  heads: Heads;
  /** Export (zero-rated) → 3.1(b), not 3.1(a). */
  zeroRated?: boolean;
  /** Inter-state supply to an unregistered person: its place of supply ("27-Maharashtra") → 3.2. */
  unregInterPos?: string | null;
}

export interface Gstr3bInput {
  /** Invoices + signed notes, and signed advance rows (11A positive, 11B negative). */
  output: Gstr3bOutput[];
  /** claimable ITC rows (bills + eligible expenses), by head */
  itc: Heads[];
  /** s.17(5) blocked ITC rows, by head — reported in 4(A)(5) and reversed in 4(B)(1) */
  blocked17: Heads[];
  /** GST on kaccha / no-GSTIN bills — never in the return */
  notIn2b: number;
  /** reverse-charge imports: ₹ value and self-assessed IGST */
  rcm: { amount: number; tax: number }[];
}

export interface Gstr3b {
  outTaxable: number; out: Heads;                // 3.1(a)
  zeroTaxable: number; zeroIgst: number;         // 3.1(b)
  /** 3.2 — inter-state supplies to unregistered persons, per place of supply, sorted by POS. */
  unregInter: { pos: string; taxable: number; igst: number }[];
  rcmTaxable: number; rcmTax: number;            // 3.1(d) — IGST
  itcRcm: number;                                // 4(A)(3)
  itcAll: Heads;                                 // 4(A)(5) gross (claimable + 17(5))
  rev17: Heads;                                  // 4(B)(1)
  itcNet: Heads;                                 // 4(C) = 4(A) − 4(B), by head (incl. RCM credit in IGST)
  pay: Heads;                                    // cash, per head
  notIn2b: number;
}

export function computeGstr3b(i: Gstr3bInput): Gstr3b {
  const domestic = i.output.filter((r) => !r.zeroRated);
  const zero = i.output.filter((r) => r.zeroRated);
  const outTaxable = domestic.reduce((s, r) => s + r.taxableValue, 0);
  const out = domestic.reduce((h, r) => add(h, r.heads), Z);
  const zeroTaxable = zero.reduce((s, r) => s + r.taxableValue, 0);
  const zeroIgst = zero.reduce((s, r) => s + r.heads.igst, 0);
  const byPos = new Map<string, { pos: string; taxable: number; igst: number }>();
  for (const r of domestic) {
    if (!r.unregInterPos) continue;
    const cur = byPos.get(r.unregInterPos) ?? { pos: r.unregInterPos, taxable: 0, igst: 0 };
    cur.taxable += r.taxableValue;
    cur.igst += r.heads.igst;
    byPos.set(r.unregInterPos, cur);
  }
  const unregInter = [...byPos.values()].filter((p) => p.taxable !== 0 || p.igst !== 0).sort((a, b) => a.pos.localeCompare(b.pos));
  /* Exports with payment: their IGST is output tax too — paid like any other. */
  const outAll = add(out, { igst: zeroIgst, cgst: 0, sgst: 0 });
  const rcmTaxable = i.rcm.reduce((s, r) => s + Math.max(0, r.amount), 0);
  const rcmTax = i.rcm.reduce((s, r) => s + Math.max(0, r.tax), 0);
  const itcClaim = i.itc.reduce((h, r) => add(h, r), Z);
  const rev17 = i.blocked17.reduce((h, r) => add(h, r), Z);
  const itcAll = add(itcClaim, rev17);
  const itcNet = { igst: itcClaim.igst + rcmTax, cgst: itcClaim.cgst, sgst: itcClaim.sgst };
  const cover = (o: number, c: number) => Math.max(0, o - c);
  const pay = {
    igst: rcmTax + cover(outAll.igst, itcNet.igst),
    cgst: cover(outAll.cgst, itcNet.cgst),
    sgst: cover(outAll.sgst, itcNet.sgst),
  };
  return { outTaxable, out, zeroTaxable, zeroIgst, unregInter, rcmTaxable, rcmTax, itcRcm: rcmTax, itcAll, rev17, itcNet, pay, notIn2b: Math.max(0, i.notIn2b) };
}

/** Rows for the worksheet CSV / table: [box, description, taxable, igst, cgst, sgst]. */
export function gstr3bRows(g: Gstr3b): (string | number)[][] {
  const rows: (string | number)[][] = [
    ["3.1(a)", "Outward taxable supplies (other than zero/nil/exempt)", g.outTaxable, g.out.igst, g.out.cgst, g.out.sgst],
  ];
  if (g.zeroTaxable !== 0 || g.zeroIgst !== 0) rows.push(["3.1(b)", "Outward zero-rated supplies (exports)", g.zeroTaxable, g.zeroIgst, 0, 0]);
  if (g.rcmTaxable > 0) rows.push(["3.1(d)", "Inward supplies liable to reverse charge (imported services)", g.rcmTaxable, g.rcmTax, 0, 0]);
  for (const p of g.unregInter) rows.push(["3.2", `Inter-state supplies to unregistered persons — POS ${p.pos}`, p.taxable, p.igst, "", ""]);
  if (g.itcRcm > 0) rows.push(["4(A)(3)", "ITC — inward supplies liable to reverse charge", "", g.itcRcm, 0, 0]);
  rows.push(["4(A)(5)", "ITC — all other ITC (gross, incl. s.17(5) part)", "", g.itcAll.igst, g.itcAll.cgst, g.itcAll.sgst]);
  if (g.rev17.igst + g.rev17.cgst + g.rev17.sgst > 0) rows.push(["4(B)(1)", "ITC reversed — s.17(5) (staff welfare, business promotion…)", "", g.rev17.igst, g.rev17.cgst, g.rev17.sgst]);
  rows.push(["4(C)", "Net ITC available", "", g.itcNet.igst, g.itcNet.cgst, g.itcNet.sgst]);
  rows.push(["Net", "Tax payable in cash (RCM always cash; per head, before IGST cross-set-off)", "", g.pay.igst, g.pay.cgst, g.pay.sgst]);
  if (g.notIn2b > 0) rows.push(["—", "GST on kaccha / no-GSTIN bills — not in the return, stays a cost", "", g.notIn2b, "", ""]);
  return rows;
}
