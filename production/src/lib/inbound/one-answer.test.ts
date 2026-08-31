import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentMaySendSeparateReply,
  type AutoQuoteOutcome,
} from "@/lib/quotes/auto-quote-for-lead";

/* ─────────────────────────────────────────────────────────────────────────────
   EK MAANG, EK JAWAB.

   31 Aug 2026, 17:54 — Pardeep ne screenshot bhej kar poochha: "do email ab bhi ek saath aa
   rahe hai, ye problem solve kyon nahi ho rahi". Inbox me:

     Re: mujhe 40 email ke liye quote chahiye google business starter monthly
     Your quote Q-ADPL-2026-27-0107 — ANUTECH DIGITAL PVT LTD          [PDF]

   Ye "do quotation" wala purana bug NAHI tha — quotation ek hi bana (Q-0107), guard ne kaam
   kiya. Galti ek level upar thi: `ingest.ts` do kaam `void` se chalata tha, saath-saath, aur
   dono me se kisi ko doosre ka pata nahi tha. Agent ne quote banne se PEHLE padha, isliye usne
   prose me jawab diya aur kuch attach nahi kiya; quote step ne apna subject likh kar mail
   bheja, aur Gmail ne use ALAG thread bana diya (is app me threading sirf subject se hoti hai).

   Yahan do cheezein pin ki gayi hain:

     1. NIYAM — har mumkin nateeje par grahak ko theek EK mail jata hai (ginti se, andaze se
        nahi).
     2. DHAANCHA — dono jagah wahi ek niyam poochha jata hai, aur `void` ki race wapas nahi
        aayi. Ye source par jaancha jata hai kyunki race ko unit test se pakadna nahi ja
        sakta: wo do promise ke timing ka maamla hai, aur test me wo timing dobara banti hi
        nahi. Isliye yahan ye jaancha jata hai ki AISA CODE hi maujood na ho.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

/** Comment hataao — warna is test ka apna hawala hi "code" ban kar ise pass kara dega. */
function code(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * Ek nateeje par grahak ko kitne mail jate hain.
 *
 * Quotation ka mail khud ek hai (jab bhi wo gaya ho), aur agent ka jawab doosra — par sirf
 * tab jab niyam ijaazat de. Ginti, kyunki "do email aa rahe hain" ki shikayat ginti ki hai.
 */
function customerMails(outcome: AutoQuoteOutcome): number {
  return (outcome.emailed ? 1 : 0) + (agentMaySendSeparateReply(outcome) ? 1 : 0);
}

describe("niyam — grahak ko theek ek mail", () => {
  it("quotation chali gayi → wahi jawab hai, agent chup", () => {
    const sent: AutoQuoteOutcome = { emailed: true, quoteId: "Q-ADPL-2026-27-0107" };
    expect(agentMaySendSeparateReply(sent)).toBe(false);
    expect(customerMails(sent)).toBe(1);
  });

  it("quotation nahi gayi → agent hi jawab deta hai", () => {
    /* Chaaron asli wajah, kyunki har ek ka apna raasta hai — aur chaaron par grahak ko jawab
       milna hi chahiye, warna wo lead neglected dikhti hai. */
    for (const reason of [
      "the term was not stated, so the price would be a guess",
      "over 50 seats — needs a person",
      "Q-ADPL-2026-27-0101 already covers this requirement",
      "the quotation email failed to send",
    ]) {
      const not: AutoQuoteOutcome = { emailed: false, reason };
      expect(agentMaySendSeparateReply(not), reason).toBe(true);
      expect(customerMails(not), reason).toBe(1);
    }
  });

  it("koi bhi nateeja do mail nahi de sakta", () => {
    /* Yahi wo jaanch hai jo screenshot ki shikayat ko seedha naapti hai. */
    const every: AutoQuoteOutcome[] = [
      { emailed: true, quoteId: "Q-1" },
      { emailed: false, reason: "kuch bhi" },
    ];
    for (const o of every) expect(customerMails(o)).toBe(1);
  });
});

describe("dhaancha — race wapas nahi aa sakti", () => {
  const ingest = code(read("lib", "inbound", "ingest.ts"));

  it("quote AWAIT hota hai, void nahi", () => {
    /* Purana code: `void autoQuoteForLead(admin, {`. Wahi ek shabd do jawab bana raha tha. */
    expect(ingest).not.toContain("void autoQuoteForLead");
    expect(ingest).toContain("await autoQuoteForLead(admin, {");
  });

  it("agent bhi await hota hai, aur usi chain ke andar", () => {
    expect(ingest).not.toContain("void runSalesAgentForLead");
    expect(ingest).toContain("await runSalesAgentForLead({");
  });

  it("webhook par bojh nahi badha — chain me ek hi bina-await promise", () => {
    /* Ye fix ki keemat wali jaanch hai. Dono kaam await karne ka matlab ye NAHI hona chahiye
       ki webhook unka intezaar kare — provider us par baitha hai. Isliye poora silsila ek hi
       `void (async () => …)()` ke andar hai. Ek se zyada hone lage to race ka darwaza phir
       khul gaya. */
    const chains = ingest.split("void (async () =>").length - 1;
    expect(chains, "ek hi background chain honi chahiye").toBe(1);
  });

  it("dono call site wahi EK niyam poochhte hain", () => {
    /* Do jagah apna-apna `if (x.emailed)` likhna hi wo drift hai jisse aaj ka din bana. */
    for (const [file, path] of [
      ["ingest", ["lib", "inbound", "ingest.ts"]],
      ["dispatcher", ["lib", "ai", "actions", "quote-dispatcher.ts"]],
    ] as const) {
      const src = code(read(...path));
      expect(src, `${file} niyam ko import nahi karta`)
        .toContain("agentMaySendSeparateReply");
      expect(src, `${file} me apna alag branch hai`)
        .not.toMatch(/if \(quot\w*\.emailed\)/);
    }
  });

  it("quotation ka mail grahak ke subject par jata hai", () => {
    /* Threading yahan sirf subject se hoti hai — koi In-Reply-To header nahi hai. Isliye
       `incomingSubject` na pahunchna hi "naya thread" ban jata hai. */
    expect(ingest).toContain("incomingSubject: subject");
    const send = code(read("lib", "quotes", "send-auto-quote.ts"));
    expect(send).toContain("replySubject(args.incomingSubject");
    expect(send, "purana standalone subject phir email par lag gaya")
      .not.toMatch(/subject: `Your quote/);
  });
});
