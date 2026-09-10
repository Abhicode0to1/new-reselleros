/**
 * Production ki sehat, aadmi ki bhasha me — cron ke liye.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 28 Aug 2026 ko production ke logs pehli baar khule aur ek ghante me TEEN bug nikle jo
 * hafton se chup-chaap chal rahe the: ek Gemini timeout jisne ek asli lead ka reply kha
 * liya, `inbound-purchase` jo 24 Aug se HAR request 401 kar raha tha (7 vendor invoice gaye),
 * aur dono webhook ka secret jo har request ke saath log me cleartext ja raha tha.
 *
 * Teeno ka ek hi lakshan tha: **kisi screen par kuch nahi.** Aur teeno isliye mile ki us din
 * kisi ne jaakar dekha. "Koi jaakar dekhega" ek plan nahi hai — cron hai.
 *
 * ─── FAISLA YAHAN HAI, ROUTE ME NAHI ────────────────────────────────────────
 * Route ko session/secret chahiye, isliye uska test nahi ban sakta. Isliye "logon ki dher
 * se kya kehna hai" ka poora faisla in pure functions me hai, aur route sirf laata-bhejta
 * hai. Aaj yahi teen baar ho chuka hai (contactsCardState, isExpiredSyncToken,
 * autonomyChangeReason) — aur pehli baar ek mutation ne sabit kiya tha ki inline wale ka
 * test khokhla tha.
 */

/** Ek log entry, utni hi jitni is faisle ko chahiye. */
export interface LogRow {
  timestamp: string;
  status?: number | null;
  url?: string | null;
  text?: string | null;
}

export interface Finding {
  /** Ginti — kitni baar. */
  count: number;
  /** Aakhri baar kab (ISO). Ginti "kitna" batati hai; ye batata hai "abhi bhi ho raha hai?" */
  last: string;
  /** Kya — path ya log line ka saaf roop. */
  what: string;
}

/**
 * ResellerClub ka wallet — jisme se HAR domain registration ka paisa jaata hai.
 *
 * 10 Sep 2026 ko joda gaya. Wallet khali ho to registration fail hoti hai — par
 * customer ka paisa hum pehle hi le chuke hote hain. Poore domain path ki sabse
 * buri shakl yahi hai: order paid, domain nahi, aur pata customer ko chalta hai,
 * hume nahi.
 *
 * `available: null` ka matlab "padh hi nahi paye" hai, "khali hai" nahi — aur ye
 * farq isi file ke banne ki wajah hai: 28 Aug ko teen bug hafton chhupe rahe the
 * kyunki "kuch nahi mila" aur "padh hi nahi paya" ek jaise dikhte the. Isliye
 * na-padh-pana bhi report hota hai, chupchaap nahi jaata.
 */
export interface WalletState {
  /** Kharch karne layak rupaye, ya null jab RC se padha hi na gaya. */
  available: number | null;
  /** Is se neeche ho to email bhejne layak hai. */
  floor: number;
  /** `available` null ho to kyun. */
  reason?: string;
}

/**
 * Wallet ke baare me kuch kehna hai ya nahi.
 *
 * `null` matlab jaancha hi nahi gaya (RC configured nahi) — us par chup rehna
 * sahi hai. Baaki do haalat bolne layak hain: padha nahi ja saka, ya floor se
 * neeche hai.
 */
export function walletWorthReporting(w: WalletState | null | undefined): boolean {
  if (!w) return false;
  if (w.available === null) return true;
  return w.available < w.floor;
}

export interface Digest {
  hours: number;
  serverErrors: Finding[];
  refused: Finding[];
  appErrors: Finding[];
  /** Secret abhi bhi URL me aa raha hai? 0 = nahi. */
  secretInUrl: number;
  /** Kitni line stack/JSON dump thi — chhupayi nahi, gini gayi. */
  noise: number;
  /** RC wallet ka haal, ya null jab jaancha hi nahi gaya. */
  wallet: WalletState | null;
  /** true jab kuch bhi kehne layak nahi mila. */
  clean: boolean;
}

/**
 * Secret ko report se bahar rakho.
 *
 * Ye khud wahi leak dohra sakta tha jise band karne ke liye aaj kaam hua — ek digest jo
 * secret ko email me bhej de, wo log se bhi bura hai, kyunki email aur aage jata hai.
 * Aur host hata dete hain: report me `/api/...` padhna aasan hai.
 */
export function scrub(url: string): string {
  return url
    .replace(/https?:[/][/][^/]+/g, "")
    .replace(/([?&](key|token|secret)=)[^&\s]+/gi, "$1***");
}

function tally(items: Array<{ ts: string; key: string }>): Finding[] {
  const m = new Map<string, { count: number; last: string }>();
  for (const { ts, key } of items) {
    const cur = m.get(key) ?? { count: 0, last: "" };
    cur.count += 1;
    if (ts > cur.last) cur.last = ts;
    m.set(key, cur);
  }
  return [...m.entries()]
    .map(([what, v]) => ({ what, count: v.count, last: v.last }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Kaun si app-line padhne layak hai.
 *
 * Multi-line stack aur JSON dump ko line-ke-hisaab se ginna report ko LOG bana deta hai —
 * pehle chalaye gaye 7-din wale run me top par `}` (36 baar) aur `{` (12 baar) aa gaye the.
 * Isliye do tarah ki line rakhi jaati hain: hamare apne `[label]` wale log, aur wo line jo
 * poora vaakya lagti hai (jaise Gemini ka "This model is currently experiencing high
 * demand"). Baaki chup-chaap girti nahi — `noise` me ginti jaati hai, kyunki "kuch chhupa
 * liya" aur "kuch nahi tha" ek jaise nahi dikhne chahiye.
 */
export function worthReading(line: string): boolean {
  return line.startsWith("[")
    || (line.length >= 30 && line.trim().split(/\s+/).filter(Boolean).length >= 4);
}

/** Lambi line ko chhota karo, par `[label]` poora rakho — wahi batata hai kahan se aayi. */
export function shorten(line: string): string {
  if (!line.startsWith("[")) return line.slice(0, 70);
  const end = line.indexOf("]");
  if (end < 0) return line.slice(0, 70);
  return `${line.slice(0, end + 1)} ${line.slice(end + 1).trim().slice(0, 56)}`.trim();
}

/** Secret abhi bhi URL se aa raha hai — is chetavni ka nishaan. */
const QUERY_SECRET_MARK = "INBOUND_REQUIRE_HEADER";

export function buildDigest(hours: number, rows: {
  http: LogRow[];
  stderr: LogRow[];
}, wallet: WalletState | null = null): Digest {
  const serverErrors = tally(rows.http
    .filter((r) => (r.status ?? 0) >= 500)
    .map((r) => ({ ts: r.timestamp, key: `${r.status} ${scrub(r.url ?? "")}`.trim() })));

  /* 401 alag se: ek public endpoint par thoda 401 normal hai, par EK HI path par lagatar
     401 hamesha kuch toota hua hota hai — 24 Aug ka purchase webhook theek isi shakl me
     mila tha. Query string hata dete hain taaki ek hi path ek hi line bane. */
  const refused = tally(rows.http
    .filter((r) => r.status === 401)
    .map((r) => ({ ts: r.timestamp, key: scrub(r.url ?? "").split("?")[0] })));

  const lines = rows.stderr
    .map((r) => ({ ts: r.timestamp, line: (r.text ?? "").trim() }))
    .filter((r) => r.line.length > 0 && !r.line.includes(QUERY_SECRET_MARK));

  const keep = lines.filter((r) => worthReading(r.line));
  const appErrors = tally(keep.map((r) => ({ ts: r.ts, key: shorten(r.line) })));
  const noise = lines.length - keep.length;

  const secretInUrl = rows.stderr.filter((r) => (r.text ?? "").includes(QUERY_SECRET_MARK)).length;

  return {
    hours,
    serverErrors,
    refused,
    appErrors,
    secretInUrl,
    noise,
    wallet,
    clean: serverErrors.length === 0 && refused.length === 0
        && appErrors.length === 0 && secretInUrl === 0
        && !walletWorthReporting(wallet),
  };
}

/** ISO → `28 Aug 21:18` IST. Report aadmi padhta hai, aur uske baaki sab din IST me hain. */
export function ist(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const d = new Date(t + 5.5 * 3600 * 1000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${mon} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Email ka body. Khaali digest par yahan aana hi nahi chahiye — route pehle rok deta hai. */
export function digestText(d: Digest, appUrl: string): string {
  const block = (title: string, rows: Finding[]) =>
    rows.length === 0 ? "" :
      `${title}\n` + rows.slice(0, 8)
        .map((f) => `  ${String(f.count).padStart(3)} ×  ${ist(f.last)}  ${f.what}`)
        .join("\n")
      + (rows.length > 8 ? `\n  (+ ${rows.length - 8} aur)` : "") + "\n\n";

  return [
    `ResellerOS — pichhle ${d.hours} ghante me kya bigda\n`,
    block("Server error (5xx):", d.serverErrors),
    block("Refuse hui request (401) — ek hi path par lagatar = kuch toota hai:", d.refused),
    block("App ne khud kya likha:", d.appErrors),
    d.noise > 0 ? `(+ ${d.noise} aur line — stack/JSON dump ke tukde, gini gayi par dikhayi nahi)\n\n` : "",
    d.secretInUrl > 0
      ? `⚠ Secret abhi bhi URL me aa raha hai — ${d.secretInUrl} baar. Bhejne wali script header par nahi aayi.\n\n`
      : "",
    walletWorthReporting(d.wallet)
      ? (d.wallet!.available === null
          /* Padha nahi ja saka. Ye bhi khabar hai — balance check khud toota
             hua hai, aur us par chup rehna is file ke maqsad ke khilaf hai. */
          ? `⚠ ResellerClub wallet ka balance padha nahi ja saka${d.wallet!.reason ? ` — ${d.wallet!.reason}` : ""}. Iska matlab khali NAHI hai; matlab pata nahi.\n\n`
          : `⚠ ResellerClub wallet kam hai — ₹${d.wallet!.available} bacha hai (floor ₹${d.wallet!.floor}). Wallet khatam hone par registration FAIL hoti hai, aur customer ka paisa hum pehle le lete hain. Top-up karo.\n\n`)
      : "",
    `Ginti "kitna" batati hai; "aakhri baar kab" batata hai ki abhi bhi ho raha hai ya nipat gaya.\n`,
    `App: ${appUrl}\n`,
  ].join("");
}
