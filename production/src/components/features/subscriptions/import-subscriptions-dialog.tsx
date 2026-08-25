/**
 * ImportSubscriptionsDialog — bulk-import existing subscriptions from a CSV
 * (Zoho Billing "GWS_Subscription_Import" style), matching each row to a
 * customer by Customer Number.
 *
 * Migration mode: these are pre-existing live services, so they're inserted
 * directly as subscription rows (no fake quote/payment/invoice money-spine).
 *
 * Mapping → subscriptions:
 *   - customer        ← matched via Customer Number → customers.customer_number
 *   - plan            ← Item Name (normalised: "Google Workspace - X" → "Google Workspace X")
 *   - vendor          ← derived from plan (google / microsoft / zoho / other)
 *   - seats           ← Quantity
 *   - mrr (₹/month)   ← (Item Price × Quantity) ÷ period-months, where the period
 *                       is inferred from Start↔End dates (monthly→÷1, quarterly→÷3,
 *                       annual→÷12). Commitment is recorded as annual.
 *   - start_date      ← Start Date   (Excel serial OR date string → ISO)
 *   - renewal_date    ← End Date
 *   - domain          ← Domain Name
 *
 * MONEY-HONESTY: the dry-run preview shows each line's computed MRR + the total
 * MRR/ARR so the operator verifies the money before committing. Nothing is
 * written until "Import" is clicked.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { cn, rupee, formatDate } from "@/lib/utils";

interface ParsedSub {
  rowNum: number;
  customer_number: string;
  customer_id?: string;
  customer_name?: string;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  seats: number;
  mrr: number;
  periodMonths: number;
  start_date?: string;
  renewal_date?: string;
  domain?: string;
  error?: string;   // unmatched / invalid → skipped
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: () => void;
}

export function ImportSubscriptionsDialog({ open, onOpenChange, onImportComplete }: Props) {
  const { data: me } = useCurrentUser();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = React.useState<ParsedSub[] | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  // customer_number(lower) → { id, name }
  const [custMap, setCustMap] = React.useState<Map<string, { id: string; name: string }>>(new Map());

  React.useEffect(() => {
    if (!open) {
      setParsed(null); setFileName(null); setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("customers").select("id, name, customer_number");
      const m = new Map<string, { id: string; name: string }>();
      (data ?? []).forEach((c) => {
        if (c.customer_number) m.set(c.customer_number.trim().toLowerCase(), { id: c.id, name: c.name });
      });
      setCustMap(m);
    })();
  }, [open]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error("File too large (>8 MB)."); return; }
    setFileName(file.name);
    try {
      const text = await file.text();
      const rows = parseSubsCsv(text, custMap);
      if (rows.length === 0) { toast.error("No rows found (header + data needed)."); return; }
      setParsed(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read the file");
    }
  };

  const handleImport = async () => {
    if (!parsed || !me) return;
    const valid = parsed.filter((r) => !r.error && r.customer_id);
    if (valid.length === 0) { toast.error("No matched subscriptions to import."); return; }
    setImporting(true);
    try {
      const supabase = createClient();
      const payload = valid.map((r) => ({
        tenant_id: me.tenantId,
        customer_id: r.customer_id!,
        customer_name: r.customer_name ?? "",
        plan: r.plan,
        vendor: r.vendor,
        seats: r.seats,
        used: 0,
        mrr: r.mrr,
        start_date: r.start_date ?? null,
        renewal_date: r.renewal_date ?? null,
        status: "active" as const,
        domain: r.domain ?? null,
        outstanding_amount: 0,
        auto_renew: true,
      }));
      let inserted = 0;
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const { error } = await supabase.from("subscriptions").insert(chunk);
        if (error) throw error;
        inserted += chunk.length;
      }
      const skipped = parsed.length - valid.length;
      toast.success(`Imported ${inserted} subscription${inserted === 1 ? "" : "s"}` + (skipped > 0 ? ` · ${skipped} skipped` : ""));
      onImportComplete?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const matched = parsed?.filter((r) => !r.error && r.customer_id) ?? [];
  const unmatched = parsed?.filter((r) => r.error) ?? [];
  const totalMRR = matched.reduce((s, r) => s + r.mrr, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-3xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="refresh" size={18} className="text-amber" />
            Import subscriptions
          </DialogTitle>
          <DialogDescription className="break-words">
            CSV with <span className="font-mono text-2xs">Customer Number, Item Name, Quantity, Item Price, Start Date, End Date</span>.
            Each row attaches to a customer by Customer Number. MRR is computed from the price ÷ the period (from Start→End dates).
          </DialogDescription>
        </DialogHeader>

        {!parsed && (
          <div className="space-y-4">
            <label htmlFor="sub-csv-file" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-8 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
              "focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">Choose a CSV file</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB · import customers first (subs match by Customer Number)</p>
              <input ref={fileInputRef} id="sub-csv-file" type="file" accept=".csv,text/csv" onChange={handleFileChange} className="sr-only" />
            </label>
            {custMap.size === 0 && (
              <p className="text-xs text-rose">No customers with a Customer Number found yet — import customers (with the Customer Number column) first, else nothing will match.</p>
            )}
          </div>
        )}

        {parsed && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink min-w-0">
                <p className="font-semibold truncate">{fileName}</p>
                <p className="text-xs text-ink-3 mt-0.5 inline-flex items-center gap-2 flex-wrap">
                  <Badge kind="success" size="sm">{matched.length} matched</Badge>
                  {unmatched.length > 0 && <Badge kind="danger" size="sm">{unmatched.length} skipped</Badge>}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" icon="x"
                onClick={() => { setParsed(null); setFileName(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                Choose another file
              </Button>
            </div>

            {/* Money summary — verify before commit */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Subscriptions</div>
                <div className="text-sm font-semibold tabular-nums mt-0.5">{matched.length}</div>
              </div>
              <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total MRR</div>
                <div className="text-sm font-semibold tabular-nums mt-0.5 text-emerald">{rupee(totalMRR)}</div>
              </div>
              <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total ARR</div>
                <div className="text-sm font-semibold tabular-nums mt-0.5">{rupee(totalMRR * 12, { compact: true })}</div>
              </div>
            </div>

            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[280px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3 w-8">#</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Customer</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Plan</th>
                      <th className="p-2 text-right font-semibold text-ink-3">Seats</th>
                      <th className="p-2 text-right font-semibold text-ink-3">MRR</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Renewal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 300).map((r) => (
                      <tr key={r.rowNum} className={cn("border-b border-hairline last:border-0", r.error && "bg-rose/5")}>
                        <td className="p-2 text-ink-3 tabular-nums">{r.rowNum}</td>
                        <td className="p-2">
                          {r.error
                            ? <span className="text-rose inline-flex items-center gap-1"><Icon name="alert" size={11} />{r.customer_number}: {r.error}</span>
                            : <span className="text-ink">{r.customer_name}</span>}
                        </td>
                        <td className="p-2 text-ink-2">{r.plan}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.seats}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.error ? "—" : rupee(r.mrr)}</td>
                        <td className="p-2 text-ink-2">{r.renewal_date ? formatDate(r.renewal_date) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-ink-3">
              Matched subs import into <span className="font-semibold text-ink">{me?.tenantName ?? "your tenant"}</span> as <b>active</b>.
              Skipped = Customer Number not found (import that customer first).
              {parsed.length > 300 && <> Showing first 300 of {parsed.length} rows.</>}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>Cancel</Button>
          {parsed && matched.length > 0 && (
            <Button type="button" variant="primary" loading={importing} onClick={handleImport}>
              Import {matched.length} subscription{matched.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// CSV parsing + money/date derivation
// ============================================================
function nv(v: string | undefined): string {
  const t = (v ?? "").trim();
  if (!t || t.toLowerCase() === "-no value-") return "";
  return t;
}

/**
 * Parse a date cell → ISO yyyy-mm-dd. Handles:
 *   - Excel serial (e.g. 46200)
 *   - DD-MM-YYYY / DD/MM/YYYY (Indian, day-first) — with optional " HH:MM" time
 *   - YYYY-MM-DD (ISO)
 *   - 2-digit years (→ 20YY)
 * Day-first is assumed for ambiguous dd/mm (Indian convention).
 */
function toISODate(v: string): string | null {
  const s = nv(v);
  if (!s) return null;

  // Excel serial number
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Strip any time component, then split d/m/y on -, / or .
  const datePart = s.split(/[ T]/)[0];
  const m = datePart.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (m) {
    const a = m[1], b = m[2], c = m[3];
    let yyyy: string, mm: string, dd: string;
    if (a.length === 4) { yyyy = a; mm = b; dd = c; }          // YYYY-MM-DD
    else { dd = a; mm = b; yyyy = c.length <= 2 ? `20${c.padStart(2, "0")}` : c; }  // DD-MM-YYYY (Indian)
    const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    if (!isNaN(new Date(`${iso}T00:00:00Z`).getTime())) return iso;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function vendorFor(plan: string): ParsedSub["vendor"] {
  const p = plan.toLowerCase();
  if (p.includes("google")) return "google";
  if (p.includes("microsoft") || p.includes("m365") || p.includes("office")) return "microsoft";
  if (p.includes("zoho")) return "zoho";
  return "other";
}

function parseSubsCsv(text: string, custMap: Map<string, { id: string; name: string }>): ParsedSub[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row + at least one data row.");

  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const col = (aliases: string[]): number => {
    for (const a of aliases) { const i = header.indexOf(a); if (i >= 0) return i; }
    return -1;
  };
  const idxNum   = col(["customer_number", "customer number", "customer no"]);
  const idxItem  = col(["item name", "item_name", "plan", "product", "plan name"]);
  const idxQty   = col(["quantity", "qty", "seats"]);
  const idxPrice = col(["item price", "item_price", "price", "rate", "selling price"]);
  const idxStart = col(["start date", "start_date", "start"]);
  const idxEnd   = col(["end date", "end_date", "end", "renewal date", "expiry date"]);
  const idxDomain= col(["domain name", "domain_name", "domain"]);

  if (idxNum === -1) throw new Error("Couldn't find a 'Customer Number' column (needed to match the customer).");
  if (idxItem === -1) throw new Error("Couldn't find an 'Item Name' / plan column.");

  const rows: ParsedSub[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const rowNum = i + 1;
    const cell = (idx: number) => (idx >= 0 ? nv(cols[idx]) : "");

    const customer_number = cell(idxNum);
    const rawPlan = cell(idxItem);
    const plan = rawPlan.replace(/\s*-\s*/, " ").trim() || rawPlan;  // "Google Workspace - Business Starter" → "Google Workspace Business Starter"
    const seats = Math.max(0, Math.round(Number(cell(idxQty)) || 0));
    const price = Number(cell(idxPrice)) || 0;
    const start = toISODate(cell(idxStart));
    const end = toISODate(cell(idxEnd));

    // period in months (from Start↔End); MRR = (price × seats) / months.
    let periodMonths = 12;
    if (start && end) {
      const days = (Date.parse(end) - Date.parse(start)) / 86400000;
      periodMonths = Math.max(1, Math.round(days / 30.44));
    }
    const mrr = periodMonths > 0 ? Math.round((price * seats) / periodMonths) : 0;

    const match = custMap.get(customer_number.toLowerCase());
    const base: ParsedSub = {
      rowNum, customer_number,
      plan: plan || "—",
      vendor: vendorFor(plan),
      seats, mrr, periodMonths,
      start_date: start ?? undefined,
      renewal_date: end ?? undefined,
      domain: cell(idxDomain) || undefined,
    };
    if (!customer_number) { rows.push({ ...base, error: "no customer number" }); continue; }
    if (!match) { rows.push({ ...base, error: "customer not found" }); continue; }
    if (!plan || seats <= 0) { rows.push({ ...base, error: "missing plan/seats" }); continue; }
    rows.push({ ...base, customer_id: match.id, customer_name: match.name });
  }
  return rows;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
