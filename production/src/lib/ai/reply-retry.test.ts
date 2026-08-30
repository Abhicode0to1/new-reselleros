import { describe, it, expect } from "vitest";
import {
  shouldRetryReply, RETRY_AFTER_MINUTES, MAX_RETRIES, GIVE_UP_AFTER_HOURS,
  type RetryCandidate,
} from "./reply-retry";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, 19:47. Pardeep ne "monthly" likha — theek wahi shabd jiska app intezaar
   kar raha tha, kyunki quote annual maan kar bana tha aur isiliye bheja nahi gaya tha.

     reply.send / failed — "Gemini ne 15 second me jawab nahi diya, dobara koshish ke baad bhi"

   Gemini timeout hua. Webhook jawab de kar ja chuka tha. Uske baad us lead ko kisi ne
   dobara nahi dekha. Jisne wahi kiya jo usse kaha gaya tha, use chuppi mili — aur ek bana
   hua quote anbheja pada rah gaya.

   Kharabi kshanik thi. Kuchh minute baad wahi call chal gayi hoti. Kami ye thi ki wo call
   karne wala koi nahi tha.
   ───────────────────────────────────────────────────────────────────────────── */

const NOW = "2026-08-30T14:30:00.000Z";
const minsAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

const cand = (over: Partial<RetryCandidate> = {}): RetryCandidate => ({
  leadId: "L-MTFW5XKZ",
  failedAt: minsAgo(10),
  failures: 1,
  resolvedAt: null,
  lastCustomerMessageAt: minsAgo(11),
  humanTookOver: false,
  isJunk: false,
  ...over,
});

describe("asli maamla — dobara koshish honi chahiye", () => {
  it("kshanik fail, kisi ne jawab nahi diya → RETRY", () => {
    const v = shouldRetryReply(cand(), NOW);
    expect(v.retry).toBe(true);
    expect(v.detail).toMatch(/nothing has answered since/);
  });
});

describe("kab NAHI karni chahiye", () => {
  it("turant nahi — jo cheez abhi vyast hai, wo ek minute me khaali nahi hoti", () => {
    const v = shouldRetryReply(cand({ failedAt: minsAgo(1) }), NOW);
    expect(v.retry).toBe(false);
    expect(v.reason).toBe("too_soon");
  });

  it(`${RETRY_AFTER_MINUTES} minute ki seema par retry shuru hota hai`, () => {
    expect(shouldRetryReply(cand({ failedAt: minsAgo(RETRY_AFTER_MINUTES - 1) }), NOW).retry).toBe(false);
    expect(shouldRetryReply(cand({ failedAt: minsAgo(RETRY_AFTER_MINUTES + 1) }), NOW).retry).toBe(true);
  });

  it("bahut purana ho to nahi — der se aaya jawab chuppi se bura hai", () => {
    const v = shouldRetryReply(cand({ failedAt: minsAgo(GIVE_UP_AFTER_HOURS * 60 + 30) }), NOW);
    expect(v.retry).toBe(false);
    expect(v.reason).toBe("too_old");
  });

  it(`${MAX_RETRIES} baar fail hone ke baad haath rok leta hai`, () => {
    const v = shouldRetryReply(cand({ failures: MAX_RETRIES }), NOW);
    expect(v.retry).toBe(false);
    expect(v.reason).toBe("gave_up");
    /* Wajah insaan ko bhejti hai, chup nahi hoti — teen baar fail hona ab kshanik nahi hai. */
    expect(v.detail).toMatch(/a person should look/);
  });

  it("insaan ne lead sambhal li → nahi", () => {
    /* Wahi asool jo shouldNudge ka hai: kisi chalte hue insaan ke upar se bolna, us chuppi
       se bura hai jise ye theek kar raha hai. */
    expect(shouldRetryReply(cand({ humanTookOver: true }), NOW).reason).toBe("human_took_over");
  });

  it("junk lead par nahi", () => {
    expect(shouldRetryReply(cand({ isJunk: true }), NOW).reason).toBe("lead_is_junk");
  });

  it("jawab dene ko koi sandesh hi na ho to nahi", () => {
    expect(shouldRetryReply(cand({ lastCustomerMessageAt: null }), NOW).reason).toBe("nothing_to_answer");
  });
});

describe("katar khud saaf hoti hai — koi table mitani nahi padti", () => {
  it("fail ke BAAD koi jawab chala gaya → lead katar se nikal jati hai", () => {
    /* Yahi wo cheez hai jo bina nayi table ke kaam chalati hai: safalta ke baad lead is
       query se mel khana hi band kar deti hai. */
    const v = shouldRetryReply(cand({ failedAt: minsAgo(10), resolvedAt: minsAgo(6) }), NOW);
    expect(v.retry).toBe(false);
    expect(v.reason).toBe("already_resolved");
  });

  it("safalta fail se PEHLE ki ho to wo maayne nahi rakhti", () => {
    /* Purani safalta katar se nahi nikalti — warna ek hi purani safal reply har aage aane
       wali kharabi ko hamesha ke liye dhak deti. */
    const v = shouldRetryReply(cand({ failedAt: minsAgo(10), resolvedAt: minsAgo(40) }), NOW);
    expect(v.retry).toBe(true);
  });
});

describe("ASLI LOOP — 30 Aug 2026 ko ye mera hi bug tha", () => {
  /* Retry cron chalu hone ke ek ghante ke andar: lead L-MTFW5XKZ har 5 minute par dobara
     chala — 20:45, 20:50, 20:55, 21:00, 21:05, 21:10, 21:15 — aur har baar agent ne
     soch-samajh kar insaan ko saunp diya (`held`).

     Mera code sirf `did` ko "nateeja" maanta tha. `held` uske liye kuch hua hi nahi tha,
     isliye 19:47 wali fail hamesha sabse nayi rahi, aur MAX_RETRIES — jo sirf fail ginta
     tha — 1 se hila hi nahi.

     Kuch bheja nahi gaya (handover kisi ko mail nahi karta), to customer ko takleef nahi
     hui — par har 5 minute par tenant ka Gemini quota jalta raha.

     Aur handover koi "lagbhag ho gaya tha" wali cheez nahi hai. Wo agent ka faisla hai ki
     yahan INSAAN chahiye. Use dobara chalana bekaar nahi, GALAT hai — ek sahi faisle se
     behas karna hai. */

  it("handover ke baad retry NAHI — yahi loop rokti hai", () => {
    const v = shouldRetryReply(
      cand({ failedAt: minsAgo(90), resolvedAt: minsAgo(5) }), NOW);
    expect(v.retry).toBe(false);
    expect(v.reason).toBe("already_resolved");
    /* Wajah dono surat batati hai, kyunki dono ka matlab ek hai: aage kuch karna nahi. */
    expect(v.detail).toMatch(/handed it to a person/);
  });

  it("saat baar handover hone par bhi ek baar bhi retry nahi", () => {
    /* Wo asli kram, waise ka waisa. Har baar handover fail se NAYA hai, to har baar rukna
       chahiye — pehle koi bhi nahi rukta tha. */
    for (const heldMinsAgo of [31, 26, 21, 16, 11, 6, 1]) {
      const v = shouldRetryReply(
        cand({ failedAt: minsAgo(90), resolvedAt: minsAgo(heldMinsAgo) }), NOW);
      expect(v.retry, `held ${heldMinsAgo} min ago`).toBe(false);
    }
  });
});

describe("kharab aankde par crash nahi", () => {
  it("na padhne layak timestamp par mana, na ki dhamaka", () => {
    const v = shouldRetryReply(cand({ failedAt: "kuch bhi" }), NOW);
    expect(v.retry).toBe(false);
    expect(v.reason).toBe("bad_timestamp");
  });
});
