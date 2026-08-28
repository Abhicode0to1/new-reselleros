/**
 * Ek cron apni failure gin le aur kisi ko na bataye — 13 din tak Contacts isi tarah toota
 * raha.
 *
 * `google-contacts-sync` har 6 ghante chalta tha, har baar exception khaata tha, `last_error`
 * DB me likhta tha, aur phir **200 `{ok:true, failed:1}`** lauta deta tha. Cloud Logging me
 * 200 hai, Scheduler me green tick hai, aur asli haal ek column me pada hai jise koi nahi
 * khol raha. Naya health digest bhi ise nahi pakadta — wo 5xx aur stderr padhta hai, aur
 * yahan dono me kuch tha hi nahi.
 *
 * 28 Aug 2026 ko ginti ki: **16 me se 8 cron** failure gin rahe the aur chup the.
 *
 * Ilaaj HTTP status badalna nahi hai. Ek user ka sync fail hona poore cron ka fail hona nahi
 * hai — 500 lautane par Scheduler retry karega aur baaki nau user ka kaam dobara chalega. Jo
 * chahiye wo bas ek awaaz hai: stderr par ek `[cron/<naam>]` wali line, jise digest agli
 * subah utha le.
 *
 * Ye file wo line BANATI hai, likhti nahi — isliye ise bina console ko chhue test kiya ja
 * sakta hai. `reportCron` neeche use bolti hai.
 */

/**
 * Kaunsi key ka matlab "kuch nahi chala".
 *
 * `skipped` jaan-boojhkar ismein NAHI hai. Skip aksar sahi faisla hota hai — dunning me ek
 * invoice ka din nahi aaya, billing me subscription pehle se raised hai. Use failure ginne se
 * har raat ek jhoothi email jayegi, aur do hafte me ye digest bhi wahi anjaam paayega jo har
 * roz aane wali "sab theek hai" email ka hota hai.
 */
const FAILURE_KEYS = ["failed", "errors", "failures"] as const;

const MAX_SAMPLES = 2;
const MAX_SAMPLE_LEN = 80;
const MAX_LINE = 300;

/** Array ke ek element se padhne layak wajah nikalo. */
function reason(item: unknown): string | null {
  if (typeof item === "string") return item.trim() || null;
  if (item && typeof item === "object") {
    const m = (item as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
    const e = (item as { error?: unknown }).error;
    if (typeof e === "string" && e.trim()) return e.trim();
  }
  return null;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Cron ke nateeje se ek stderr line banao — ya `null`, agar kuch fail hi nahi hua.
 *
 * Ginti jodi nahi jaati. `failed: 2` aur `errors: [1]` do alag cheezein gin rahe hote hain
 * (birthday-greetings me ek send ka fail hai, doosra claim ka), aur unhe jod kar "3 failed"
 * likhna ek aisa aankda banata hai jo kisi bhi jagah nahi likha. Isliye dono alag dikhte hain.
 */
export function cronFailureLine(job: string, result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;

  const parts: string[] = [];
  const samples: string[] = [];

  for (const key of FAILURE_KEYS) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      parts.push(`${key}=${v}`);
    } else if (Array.isArray(v) && v.length > 0) {
      parts.push(`${key}=${v.length}`);
      for (const item of v) {
        if (samples.length >= MAX_SAMPLES) break;
        const why = reason(item);
        if (why) samples.push(clip(why, MAX_SAMPLE_LEN));
      }
    }
  }

  if (parts.length === 0) return null;

  const head = `[cron/${job}] ${parts.join(" ")}`;
  return clip(samples.length > 0 ? `${head} — ${samples.join(" · ")}` : head, MAX_LINE);
}

/**
 * Line banao aur stderr par likho. Nateeja wapas wahi lautata hai, taaki call site ek hi
 * line rahe: `return NextResponse.json(reportCron("billing", result))`.
 *
 * `console.error` isliye, `warn` nahi: Cloud Run dono ko stderr par bhejta hai, par digest ka
 * filter `logName:"stderr"` hai aur `console.warn` ka severity WARNING hota hai — ek hi
 * jagah do severity rakhne se filter kabhi na kabhi aadha ho jayega.
 */
export function reportCron<T>(job: string, result: T): T {
  const line = cronFailureLine(job, result);
  if (line) console.error(line);
  return result;
}
