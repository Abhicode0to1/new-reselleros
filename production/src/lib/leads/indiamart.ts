/**
 * S34 — IndiaMART Lead Manager "pull API": the request, and a defensive parser for the reply.
 *
 * ─── ⚠ UNVERIFIED AGAINST A LIVE KEY ────────────────────────────────────────
 * Written to IndiaMART's documented v2 pull API:
 *   GET https://mapi.indiamart.com/wservce/crm/crmListing/v2/
 *       ?glusr_crm_key=<key>&start_time=<DD-Mon-YYYY HH:MM:SS>&end_time=<…>
 *   → { CODE, STATUS, MESSAGE, TOTAL_RECORDS, RESPONSE: [ { UNIQUE_QUERY_ID, QUERY_TYPE,
 *       QUERY_TIME, SENDER_NAME, SENDER_MOBILE, SENDER_EMAIL, SENDER_COMPANY, SENDER_CITY,
 *       SENDER_STATE, SUBJECT, QUERY_PRODUCT_NAME, QUERY_MESSAGE, … } ] }
 * Nothing in this repo had ever called it, and no key was available while building, so the
 * field names and time format come from the docs, not from a real response. Isiliye parser
 * har field ko optional maanta hai: jo samajh nahi aata use chhod deta hai aur ginta hai,
 * poora batch nahi girata. The first live run should be checked by eye (lead notes carry the
 * raw query id) before anyone trusts it.
 *
 * Times are IST on both sides — IndiaMART is an Indian service and QUERY_TIME has no zone.
 */
import { normalizeWaPhone } from "@/lib/marketing/whatsapp-broadcast";

export const INDIAMART_ENDPOINT = "https://mapi.indiamart.com/wservce/crm/crmListing/v2/";
/** IndiaMART refuses a window longer than this (docs: 7 days). */
export const MAX_WINDOW_DAYS = 7;
/** Overlap each pull with the previous one — dedupe by query id makes overlap free. */
export const OVERLAP_MINUTES = 10;
/** Back-off after IndiaMART says "too many requests" (docs ask for ≥ 5 min between calls). */
export const RATE_LIMIT_BACKOFF_MINUTES = 15;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** A moment as IndiaMART wants it: IST, `DD-Mon-YYYY HH:MM:SS`. */
export function indiamartTime(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${pad(ist.getUTCDate())}-${MONTHS[ist.getUTCMonth()]}-${ist.getUTCFullYear()} `
    + `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
}

/** The pull window: from a little before the last pull's end (or 24 h back), capped at 7 days. */
export function pullWindow(lastEnd: Date | null, now: Date): { start: Date; end: Date } {
  const floor = now.getTime() - MAX_WINDOW_DAYS * 86_400_000 + 60_000;
  const want = lastEnd ? lastEnd.getTime() - OVERLAP_MINUTES * 60_000 : now.getTime() - 86_400_000;
  return { start: new Date(Math.max(floor, want)), end: now };
}

export function indiamartUrl(key: string, start: Date, end: Date): string {
  const q = new URLSearchParams({
    glusr_crm_key: key,
    start_time: indiamartTime(start),
    end_time: indiamartTime(end),
  });
  return `${INDIAMART_ENDPOINT}?${q.toString()}`;
}

export interface IndiamartLead {
  queryId: string;
  /** ISO timestamp, or null when QUERY_TIME was missing / unreadable. */
  queryTime: string | null;
  queryType: string | null;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  product: string | null;
  subject: string | null;
  message: string | null;
}

export type IndiamartParse =
  | { ok: true; leads: IndiamartLead[]; skipped: number }
  | { ok: false; kind: "rate_limited" | "auth" | "error"; message: string };

const str = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  return s || null;
};

/** "2026-09-28 10:15:30" (IST) → ISO. Anything else → null, never a guessed date. */
export function queryTimeToIso(v: unknown): string | null {
  const s = str(v);
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function email(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function oneLead(raw: unknown): IndiamartLead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const queryId = str(r.UNIQUE_QUERY_ID);
  if (!queryId || !/^[A-Za-z0-9_-]{1,64}$/.test(queryId)) return null;
  return {
    queryId,
    queryTime: queryTimeToIso(r.QUERY_TIME),
    queryType: str(r.QUERY_TYPE),
    name: str(r.SENDER_NAME),
    company: str(r.SENDER_COMPANY),
    email: email(r.SENDER_EMAIL) ?? email(r.SENDER_EMAIL_ALT),
    phone: normalizeWaPhone(str(r.SENDER_MOBILE)) ?? normalizeWaPhone(str(r.SENDER_PHONE)),
    altPhone: normalizeWaPhone(str(r.SENDER_MOBILE_ALT)) ?? normalizeWaPhone(str(r.SENDER_PHONE_ALT)),
    city: str(r.SENDER_CITY),
    state: str(r.SENDER_STATE),
    pincode: str(r.SENDER_PINCODE),
    product: str(r.QUERY_PRODUCT_NAME) ?? str(r.QUERY_MCAT_NAME),
    subject: str(r.SUBJECT),
    message: str(r.QUERY_MESSAGE),
  };
}

/**
 * Parse whatever came back. Never throws.
 *
 * CODE 200 = leads; 204 = "no leads in this window" (success, empty). 429 or a message about
 * hitting the API too often = back off. 401/403 or "invalid key" = the key is wrong — that
 * needs the owner, not a retry. Anything else is an error with IndiaMART's own message.
 */
export function parseIndiamartResponse(json: unknown, httpStatus = 200): IndiamartParse {
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const code = body ? Number(body.CODE ?? body.code ?? NaN) : NaN;
  const message = (body && (str(body.MESSAGE) ?? str(body.message))) ?? "";

  if (httpStatus === 429 || code === 429 || /once in every|too many|frequen/i.test(message)) {
    return { ok: false, kind: "rate_limited", message: message || "IndiaMART rate limit" };
  }
  if (httpStatus === 401 || httpStatus === 403 || code === 401 || code === 403 || /invalid.*key|key.*invalid|unauthori/i.test(message)) {
    return { ok: false, kind: "auth", message: message || "IndiaMART rejected the CRM key" };
  }
  if (code === 204 || (/no lead/i.test(message) && !Array.isArray(body?.RESPONSE))) {
    return { ok: true, leads: [], skipped: 0 };
  }
  if (!body || httpStatus >= 400 || (Number.isFinite(code) && code !== 200)) {
    return { ok: false, kind: "error", message: message || `IndiaMART responded ${Number.isFinite(code) ? code : httpStatus}` };
  }
  const rows = Array.isArray(body.RESPONSE) ? body.RESPONSE : [];
  const leads: IndiamartLead[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const raw of rows) {
    const l = oneLead(raw);
    if (!l) { skipped++; continue; }
    if (seen.has(l.queryId)) continue;   // same enquiry twice in one reply
    seen.add(l.queryId);
    leads.push(l);
  }
  return { ok: true, leads, skipped };
}

const QUERY_TYPE_LABEL: Record<string, string> = {
  W: "Direct enquiry", B: "Buy lead", P: "Phone call (PNS)", BIZ: "Catalog enquiry", V: "Catalog enquiry",
};

/**
 * The lead id: `L-IM-<first 8 of tenant>-<query id>`. Deterministic, so a retry after a crash
 * mid-run produces the same id — and leads.id is global, so the tenant part keeps two companies
 * that got the same enquiry apart.
 */
export function indiamartLeadId(tenantId: string, queryId: string): string {
  return `L-IM-${tenantId.replace(/-/g, "").slice(0, 8).toUpperCase()}-${queryId}`;
}

/** Arguments for import_indiamart_lead (see migration 20260928151000). */
export function indiamartImportArgs(tenantId: string, l: IndiamartLead) {
  const where = [l.city, l.state, l.pincode].filter(Boolean).join(", ");
  const notes = [
    `IndiaMART ${QUERY_TYPE_LABEL[l.queryType ?? ""] ?? (l.queryType ? `enquiry (${l.queryType})` : "enquiry")} · query ${l.queryId}`,
    l.product ? `Product: ${l.product}` : null,
    l.subject && l.subject !== l.product ? `Subject: ${l.subject}` : null,
    l.message ? `Message: ${l.message.slice(0, 2000)}` : null,
    where ? `Location: ${where}` : null,
    l.altPhone && l.altPhone !== l.phone ? `Alt phone: ${l.altPhone}` : null,
  ].filter(Boolean).join("\n");
  return {
    p_tenant_id: tenantId,
    p_query_id: l.queryId,
    p_lead_id: indiamartLeadId(tenantId, l.queryId),
    p_company: l.company,
    p_contact_name: l.name,
    p_email: l.email,
    p_phone: l.phone,
    p_state: l.state,
    p_notes: notes,
    p_query_time: l.queryTime,
    p_query_type: l.queryType,
  };
}
