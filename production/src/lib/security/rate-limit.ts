/**
 * Rate limiter — poore app ka PEHLA (audit A3, 1 Sep 2026).
 *
 * Us din tak 153 routes me 429 sirf teen jagah tha (vault PIN). 18 public
 * endpoints khule the: /api/public/agent/chat har message par PAID Gemini
 * jalata hai, /api/public/enquiry/* email + auto-quote bhejta hai, aur
 * expense-claim ka 4-digit PIN bina kisi ginti ke brute-force ho sakta tha
 * (10,000 koshish = pakka). Enquiry route ka apna comment kehta tha:
 * "Rate limit TODO: bolt on at the edge later" — edge kabhi aaya nahi.
 *
 * ─── DESIGN: fixed-window, in-memory, PER-INSTANCE ──────────────────────────
 * Ye Cloud Armor/Cloudflare ka badla nahi hai — Cloud Run ke N instances me
 * har ek ki apni ginti hai (wahi seemā jo gemini.ts ke circuit-breaker par
 * likhi hai). Iska matlab: asli seema `limit × instances` tak dheeli ho
 * sakti hai. Wo bhi anant se bahut chhota hai, aur yahi is file ka kaam
 * hai: kharcha BOUNDED karna, perfect fairness nahi.
 *
 * Middleware (edge-runtime) se bhi chalta hai, isliye yahan sirf Map aur
 * Date.now() — koi node:crypto/fs nahi.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/* Memory ka tala: ~50k khaali hone par sabse purane aadha saaf. Ek hamla
   jitni entries banata hai unhe hi ginta rehna khud ek DoS hota. */
const MAX_KEYS = 50_000;

function prune(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size < MAX_KEYS) return;
  let toDrop = Math.floor(buckets.size / 2);
  for (const k of buckets.keys()) {
    if (toDrop-- <= 0) break;
    buckets.delete(k);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** 429 ke saath bhejne ke liye — poore second me. */
  retryAfterSec: number;
  remaining: number;
}

/**
 * Ek koshish gino. `key` me route-class + pehchan dono hon
 * (jaise "public:103.25.1.9" ya "claim-pin:CLM-123").
 */
export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  prune(now);

  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, retryAfterSec: 0, remaining: opts.limit - 1 };
  }

  b.count += 1;
  if (b.count > opts.limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  return { ok: true, retryAfterSec: 0, remaining: opts.limit - b.count };
}

/** Test/dev ke liye — production code ise kabhi na bulaye. */
export function resetRateLimiter(): void {
  buckets.clear();
}

/**
 * How many entries OUR OWN infrastructure appends to `x-forwarded-for`.
 *
 * 1 for a Cloud Run service reached directly (deploy.sh: `gcloud run deploy`,
 * no load balancer) — Google appends the connecting IP and nothing else.
 * Set XFF_TRUSTED_HOPS=2 if an external Application Load Balancer is ever put
 * in front: the ALB appends `<client-ip>,<load-balancer-ip>`, so the client
 * moves one place further from the end.
 */
const TRUSTED_HOPS = Math.max(1, Number(process.env.XFF_TRUSTED_HOPS ?? "1") || 1);

/**
 * Request ka asli IP — `x-forwarded-for` ke DAAYE se, baaye se nahi.
 *
 * ─── YE PEHLE GALAT THA ──────────────────────────────────────────
 * Purana comment kehta tha "PEHLI entry hi client hai". Google ke apne
 * dastavez iske ulat hain: agar request me pehle se `x-forwarded-for` hai to
 * infrastructure usme APPEND karta hai —
 *     X-Forwarded-For: <existing-value>,<client-ip>,<load-balancer-ip>
 * — aur "the load balancer does not verify any IP addresses that precede the
 * client-ip". Matlab `[0]` wahi hai jo BHEJNE WALE ne likha. Koi bhi
 * `curl -H "x-forwarded-for: 1.2.3.4"` bhej kar apna IP badal sakta tha.
 *
 * Iska asar do jagah tha, dono me chup-chaap:
 *   · middleware ka public-API rate limit — har request par naya nakli IP =
 *     nayi balti = koi seema nahi.
 *   · attendance ka office-IP darwaza, jiska comment daawa karta tha
 *     "the browser can't forge it".
 *
 * Imaandar client ke liye kuch nahi badla: wo XFF bhejta hi nahi, to list me
 * ek hi entry hoti hai aur pehli = aakhri. Sirf jhooth bolne wale par asar.
 */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      /* Sirf utna hi bharosa jitna humara apna infra likhta hai. Client kitni
         bhi entries aage jod de, ginti daaye se hoti hai. */
      const idx = Math.max(0, parts.length - TRUSTED_HOPS);
      return parts[idx] ?? parts[parts.length - 1];
    }
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * /api/public/* aur signup ke liye ek hi jagah tay ki hui seemayein.
 * Number chune hue hain, nape hue nahi — asli traffic aane par inhe
 * naap kar kasna/dheela karna (tab tak "bahut" ka matlab "anant nahi").
 */
export function publicApiLimit(pathname: string): { limit: number; windowMs: number } | null {
  if (!pathname.startsWith("/api/public/") && pathname !== "/api/auth/signup") return null;

  // AI chat: har message Gemini hai. Ek insaan ki asli baat-cheet ~1 msg/8s
  // se tez nahi hoti.
  if (pathname.startsWith("/api/public/agent/")) return { limit: 30, windowMs: 5 * 60_000 };

  // Likhne wale (lead/email/auto-quote/checkout/trial/signup): ek IP se
  // itne form asli insaan nahi bharta.
  if (
    pathname.startsWith("/api/public/enquiry/") ||
    pathname.startsWith("/api/public/checkout/") ||
    pathname.startsWith("/api/public/trial/") ||
    pathname === "/api/auth/signup"
  ) {
    return { limit: 10, windowMs: 10 * 60_000 };
  }

  // PIN/token जांच — brute-force ka raasta. Sabse kasa hua.
  if (pathname.startsWith("/api/public/expense-claim")) return { limit: 15, windowMs: 15 * 60_000 };

  // Baaki public GET/POST (catalog, promo, coupons, quote-accept…):
  // udaar par bounded.
  return { limit: 120, windowMs: 5 * 60_000 };
}

/**
 * `clientIp` ka null-wala roop — audit log ke liye, jahan "unknown" likhne se
 * behtar hai khaali chhod dena. Wahi daaye-se-ginti, wahi bharosa.
 */
export function clientIpOrNull(headers: Headers): string | null {
  const ip = clientIp(headers);
  return ip === "unknown" ? null : ip;
}
