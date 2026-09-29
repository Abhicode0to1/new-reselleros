/**
 * S34 — the IndiaMART key screen (/marketing/indiamart): what the owner sees about the saved
 * CRM key and the last pull, kept here so the page and the API share one rulebook and the
 * wording is tested without a browser.
 *
 * ─── THE KEY NEVER COMES BACK ────────────────────────────────────────────────
 * GET /api/leads/indiamart answers "is a key saved, is it encrypted, what are its last 4
 * characters" — never the key. `keyLast4` refuses a value too short for four characters to
 * be a small fraction of it, so a mistyped 6-character "key" is not two-thirds displayed.
 * (The route used to send `maskSecret()`, which shows the FIRST four and last two of a key
 * stored in the clear — more than this screen needs.)
 *
 * ─── WHY pullSummary MATCHES ON THE CRON'S OWN WORDS ─────────────────────────
 * indiamart_sync_state keeps only `last_ok` + a free-text `last_error`. The two failures the
 * owner can act on are told apart by the strings lib/leads/indiamart.server.ts writes
 * ("rate limited: …", "IndiaMART rejected the CRM key …"); the test pins both, so changing
 * that text there fails here instead of quietly downgrading the advice to "kuch galat hua".
 */
import { z } from "zod";
import { formatIstDate, istParts } from "@/lib/dates/ist";
import { RATE_LIMIT_BACKOFF_MINUTES } from "./indiamart";

/** The cron's Cloud Scheduler line (scripts/setup-cloud-scheduler.sh): `*\/15 8-21 * * *`, Asia/Kolkata. */
export const PULL_SCHEDULE_TEXT = "har 15 minute, subah 8 baje se raat 9:45 tak (IST)";

/** Where the owner finds the key — shown on the screen, and what the save error points to. */
export const KEY_SOURCE_TEXT = "IndiaMART Seller panel → Lead Manager → CRM API key";

export const crmKeySchema = z.object({
  crm_key: z.string().trim()
    .min(16, "Ye IndiaMART CRM key jaisi nahi lagti — Lead Manager se poori key copy karo")
    .max(200, "Key bahut lambi hai — sirf CRM key paste karo, poora link ya message nahi"),
});
export type CrmKeyInput = z.infer<typeof crmKeySchema>;

/** Shape of GET /api/leads/indiamart (minus the `ok` envelope). */
export interface IndiamartKeyStatus {
  configured: boolean;
  /** true = sealed with SECRETS_MASTER_KEY; false = saved in the clear (deployment has no master key). */
  encrypted: boolean;
  /** Last 4 characters, or null when not shown (no key, too short, or could not be opened). */
  key_last4: string | null;
  last_run_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
  /** Leads created by the LAST pull (not a running total). */
  last_imported: number | null;
  /** Every IndiaMART enquiry ever turned into a lead for this company. */
  total_imported: number | null;
}

/** Last four characters of a key, only when the key is long enough for that to reveal little. */
export function keyLast4(plain: string | null | undefined): string | null {
  const k = (plain ?? "").trim();
  return k.length >= 16 ? k.slice(-4) : null;
}

/** "29 Sep 2026, 2:15 pm" in IST, whatever the browser's zone. */
export function istDateTime(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "—";
  const { hour, minute } = istParts(d);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${formatIstDate(d)}, ${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

export type PullTone = "neutral" | "success" | "warning" | "danger";
export interface PullSummary { tone: PullTone; title: string; detail: string }

/** One line of "is it working, and do I need to do anything" for the status card. */
export function pullSummary(s: Pick<IndiamartKeyStatus, "configured" | "last_run_at" | "last_ok" | "last_error" | "last_imported">): PullSummary {
  if (!s.configured) {
    return {
      tone: "neutral",
      title: "Key save nahi hai — IndiaMART leads apne aap nahi aa rahi",
      detail: `Neeche CRM key save karo. Uske baad app ${PULL_SCHEDULE_TEXT} nayi enquiries leads mein daalega.`,
    };
  }
  if (!s.last_run_at) {
    return {
      tone: "neutral",
      title: "Key saved — pehla pull abhi hona hai",
      detail: `Agle run mein pichhle 24 ghante ki enquiries aayengi. Pull ${PULL_SCHEDULE_TEXT} chalta hai.`,
    };
  }
  const when = istDateTime(s.last_run_at);
  if (s.last_ok) {
    const n = s.last_imported ?? 0;
    return {
      tone: "success",
      title: `Chal raha hai — last pull ${when}`,
      detail: n === 0 ? "Us pull mein koi nayi enquiry nahi thi." : `Us pull mein ${n} nayi ${n === 1 ? "lead bani" : "leads bani"}.`,
    };
  }
  const err = s.last_error ?? "";
  if (/^rate limited/i.test(err)) {
    return {
      tone: "warning",
      title: `IndiaMART ne thodi der rukne ko kaha (${when})`,
      detail: `Kuch karna nahi hai — app ${RATE_LIMIT_BACKOFF_MINUTES} minute baad khud dobara try karega.`,
    };
  }
  if (/rejected the CRM key/i.test(err)) {
    return {
      tone: "danger",
      title: `IndiaMART ne key reject ki (${when})`,
      detail: `${KEY_SOURCE_TEXT} se nayi key copy karke neeche "Key badlo" se save karo. Abhi save ki hai to agle pull mein check hogi.`,
    };
  }
  return {
    tone: "danger",
    title: `Last pull fail hua (${when})`,
    detail: `${err || "Wajah record nahi hui."} Agla pull khud try karega; baar-baar ho to key dobara save karo.`,
  };
}
