/**
 * Lead Heat Score, 0–100.
 *
 * ─── WHY THIS IS ARITHMETIC AND NOT AN AI CALL ──────────────────────────────
 * The brief called for a "Gemini Lead Heat Score" evaluating the company domain
 * (@tatamotors.com vs @gmail.com), seat potential and source quality. All three of
 * those are lookups and comparisons — there is no judgement in them for a model to
 * add. Sending them to Gemini would buy latency, cost, a per-render network
 * dependency, and a score that changes between two identical leads.
 *
 * The deciding fact: GEMINI_API_KEY is not set on this project. Every AI route here
 * falls back to a deterministic stub when it is missing (see
 * api/ai/draft-followup/route.ts:143). An "AI score" would therefore have been the
 * stub wearing an AI label — a failure converted into a plausible value, which is the
 * single pattern behind four separate bugs found in this codebase. So the score is
 * computed locally, it is called what it is, and every input is testable.
 *
 * If a model is ever genuinely useful here it is for the things arithmetic cannot
 * read — the tone of an email thread, whether "we're just exploring" means no. That
 * is a different feature, and it should be additive to this number, not a replacement
 * that cannot be reproduced.
 *
 * ─── THE SCORE ──────────────────────────────────────────────────────────────
 * Five weighted components, summing to 100. Every weight is a named constant so a
 * disagreement about priorities is a one-line change rather than an archaeology
 * exercise:
 *
 *     domain     30   a corporate domain is the strongest B2B signal available
 *     seats      25   seat count is the closest thing to deal size before pricing
 *     source     20   how the lead arrived predicts whether it closes
 *     stage      15   funnel progress — earned, not claimed
 *     freshness  10   a lead that has gone quiet is cooling regardless of the rest
 *
 * It is deliberately NOT a re-derivation of `intentTier` in heat.ts. That answers
 * "should I act on this today" from priority and staleness; this answers "how good is
 * this lead" from who they are. A high-score lead can be cold, and that combination —
 * good lead, going quiet — is the most valuable thing either signal can surface.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { daysSinceTouch } from "./heat";

export const WEIGHT = {
  domain:    30,
  seats:     25,
  source:    20,
  stage:     15,
  freshness: 10,
} as const;

/**
 * Free / consumer mail providers. A lead using one of these is not necessarily bad —
 * plenty of Indian SMEs run on Gmail — but it is not a company either, so it cannot
 * be scored as one. Kept explicit rather than "does the domain contain a brand" style
 * guessing.
 */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.in", "yahoo.co.in",
  "hotmail.com", "outlook.com", "live.com", "msn.com",
  "rediffmail.com", "rediff.com", "icloud.com", "me.com", "aol.com",
  "protonmail.com", "proton.me", "zohomail.in", "mail.com", "gmx.com",
  "yandex.com", "ymail.com", "inbox.com",
]);

/** Throwaway-address services. A real buyer does not use one. */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "yopmail.com", "trashmail.com",
  "sharklasers.com", "getnada.com", "dispostable.com",
]);

/**
 * Source quality, 0–1. Multiplied by WEIGHT.source.
 *
 * Ordered by what actually closes for a reseller: someone who asked for a trial or a
 * quote has already shown intent; a referral arrives pre-trusted; a bought list or a
 * scraped import is the coldest thing in the building. An UNRECOGNISED source scores
 * mid (0.5), not 0 — an unmapped label is our gap in the mapping, and scoring it zero
 * would quietly bury real leads from a new channel.
 */
const SOURCE_QUALITY: Readonly<Record<string, number>> = {
  referral:        1.00,
  "word-of-mouth": 1.00,
  trial:           0.95,
  "buy-page":      0.90,
  quote_request:   0.90,
  website:         0.75,
  "email-inbound": 0.75,
  inbound:         0.75,
  whatsapp:        0.70,
  google:          0.65,
  "google-import": 0.65,
  event:           0.60,
  partner:         0.60,
  linkedin:        0.55,
  manual:          0.50,
  csv:             0.35,
  import:          0.35,
  "cold-call":     0.25,
  list:            0.15,
  purchased:       0.10,
};
/** What an unmapped source scores. Neutral, not zero — see SOURCE_QUALITY. */
export const UNKNOWN_SOURCE_QUALITY = 0.5;

/** Seat bands. Reseller economics: 1 seat is admin, 250 seats is a different business. */
const SEAT_BANDS: ReadonlyArray<readonly [minSeats: number, fraction: number]> = [
  [100, 1.00],
  [50,  0.85],
  [25,  0.70],
  [10,  0.55],
  [5,   0.40],
  [1,   0.25],
];

/** Funnel progress. Won/lost are terminal and score as such. */
const STAGE_PROGRESS: Readonly<Record<string, number>> = {
  new:     0.10,
  contact: 0.35,
  demo:    0.60,
  trial:   0.80,
  quote:   1.00,
  won:     1.00,
  lost:    0.00,
};

export type HeatBand = "hot" | "warm" | "cold";

/** 🔥 80–100 · ☀️ 50–79 · ❄️ below 50. */
export const HOT_FROM  = 80;
export const WARM_FROM = 50;

export interface HeatScoreBreakdown {
  /** 0–100, integer. */
  score: number;
  band:  HeatBand;
  /** Points contributed by each component, integers that sum to `score`. */
  parts: { domain: number; seats: number; source: number; stage: number; freshness: number };
  /** Plain-language reason per component, for the badge tooltip. */
  reasons: string[];
  /** True when a component had no data — the score is then a floor, not a verdict. */
  incomplete: boolean;
}

/** The domain part of an email, lowercased. Null when there isn't one. */
export function emailDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.length > 0 && d.includes(".") ? d : null;
}

export type DomainClass = "corporate" | "consumer" | "disposable" | "unknown";

/**
 * Classify the lead's domain. `leads.domain` (captured at intake) is preferred over
 * the email's domain, because a rep may have recorded the company's real domain while
 * the contact wrote in from a personal address.
 */
export function classifyDomain(
  l: Pick<Lead, "domain" | "contact_email">,
): { klass: DomainClass; domain: string | null } {
  const explicit = l.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
  const fromEmail = emailDomainOf(l.contact_email);
  const domain = explicit && explicit.includes(".") ? explicit : fromEmail;

  if (!domain) return { klass: "unknown", domain: null };
  if (DISPOSABLE_DOMAINS.has(domain)) return { klass: "disposable", domain };
  if (CONSUMER_DOMAINS.has(domain))   return { klass: "consumer", domain };
  return { klass: "corporate", domain };
}

const DOMAIN_FRACTION: Readonly<Record<DomainClass, number>> = {
  corporate:  1.00,
  consumer:   0.35,
  disposable: 0.00,
  unknown:    0.20,
};

/** Normalise a source label so "Cold Call", "cold_call" and "cold-call" agree. */
function sourceKey(source: string | null | undefined): string {
  return (source ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function sourceQuality(source: string | null | undefined): number {
  const key = sourceKey(source);
  if (!key) return UNKNOWN_SOURCE_QUALITY;
  return SOURCE_QUALITY[key] ?? UNKNOWN_SOURCE_QUALITY;
}

function seatFraction(seats: number | null | undefined): number | null {
  if (typeof seats !== "number" || !Number.isFinite(seats) || seats <= 0) return null;
  for (const [min, fraction] of SEAT_BANDS) if (seats >= min) return fraction;
  return SEAT_BANDS[SEAT_BANDS.length - 1][1];
}

/**
 * Freshness, 0–1. Full marks for the first two days, then a straight decline to zero
 * at 14 days. Unknown age scores FULL, not zero: a lead imported five minutes ago has
 * no activity history, and starting it at zero would punish the newest leads hardest.
 */
const FRESH_FULL_DAYS = 2;
const FRESH_DEAD_DAYS = 14;
function freshnessFraction(days: number | null): number {
  if (days === null) return 1;
  if (days <= FRESH_FULL_DAYS) return 1;
  if (days >= FRESH_DEAD_DAYS) return 0;
  return (FRESH_DEAD_DAYS - days) / (FRESH_DEAD_DAYS - FRESH_FULL_DAYS);
}

export function heatBand(score: number): HeatBand {
  if (score >= HOT_FROM)  return "hot";
  if (score >= WARM_FROM) return "warm";
  return "cold";
}

/**
 * The score, with its working shown.
 *
 * Rounding: each component is rounded once and the total is their SUM, so the parts
 * always add up to the number on screen. Rounding the total independently would let a
 * tooltip say 29 + 25 + 15 + 15 + 10 next to a badge reading 95.
 */
export function heatScore(
  l: Pick<Lead, "domain" | "contact_email" | "seats" | "source" | "stage" | "updated_at" | "created_at">,
  lastActivityAt?: string | null,
  now: Date = new Date(),
): HeatScoreBreakdown {
  const { klass, domain } = classifyDomain(l);
  const seatFrac = seatFraction(l.seats);
  const days     = daysSinceTouch(l, lastActivityAt, now);

  const parts = {
    domain:    Math.round(WEIGHT.domain    * DOMAIN_FRACTION[klass]),
    seats:     Math.round(WEIGHT.seats     * (seatFrac ?? 0)),
    source:    Math.round(WEIGHT.source    * sourceQuality(l.source)),
    stage:     Math.round(WEIGHT.stage     * (STAGE_PROGRESS[l.stage ?? ""] ?? 0)),
    freshness: Math.round(WEIGHT.freshness * freshnessFraction(days)),
  };

  const score = parts.domain + parts.seats + parts.source + parts.stage + parts.freshness;

  const reasons: string[] = [];
  if (klass === "corporate")  reasons.push(`Company domain${domain ? ` (${domain})` : ""}`);
  if (klass === "consumer")   reasons.push(`Personal email${domain ? ` (${domain})` : ""} — not a company domain`);
  if (klass === "disposable") reasons.push(`Throwaway address (${domain}) — likely not a real buyer`);
  if (klass === "unknown")    reasons.push("No domain or email on record");

  if (seatFrac === null) reasons.push("No seat count — add one to score this properly");
  else                   reasons.push(`${l.seats} seats`);

  reasons.push(
    sourceKey(l.source)
      ? `Source: ${l.source}${SOURCE_QUALITY[sourceKey(l.source)] === undefined ? " (unmapped — scored neutral)" : ""}`
      : "No source recorded",
  );

  if (days !== null && days > FRESH_FULL_DAYS) reasons.push(`Quiet for ${days} days`);

  return {
    score,
    band: heatBand(score),
    parts,
    reasons,
    /* A missing seat count or domain means the score is a FLOOR, not a verdict — the
       badge says so, because a 45 that is really "we never asked how many seats" must
       not read the same as a 45 we measured. */
    incomplete: seatFrac === null || klass === "unknown",
  };
}

/** Badge presentation, so every surface renders the band identically. */
export function heatBadge(band: HeatBand): { emoji: string; label: string; kind: "danger" | "warning" | "info" } {
  if (band === "hot")  return { emoji: "🔥", label: "Hot",  kind: "danger" };
  if (band === "warm") return { emoji: "☀️", label: "Warm", kind: "warning" };
  return { emoji: "❄️", label: "Cold", kind: "info" };
}
