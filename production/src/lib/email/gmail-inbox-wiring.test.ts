import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GMAIL_READ_SCOPES, GMAIL_SEND_SCOPES } from "@/lib/google/oauth";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026. Enquiries do din tak app me nahi aayi. Wajah code me nahi thi — wo
   Gmail ke andar baithi ek Apps Script thi, jo purana `?key=` secret bhej rahi thi,
   har baar 401 kha rahi thi, aur mail par phir bhi `erp-sent` laga deti thi. Andar se
   sab "delivered" dikh raha tha.

   Ab app khud mailbox padhta hai. Ye file un cheezon par zid karti hai jinke bina wahi
   khaamoshi wapas aa sakti hai — kyunki ek aisi cron jo "0 mail" kehti rahe, bilkul waisi
   hi dikhti hai jaisi ek chalti hui cron.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");
const CRON = readFileSync(join(SRC, "app", "api", "cron", "gmail-inbox", "route.ts"), "utf8");
const CONNECT = readFileSync(
  join(SRC, "app", "api", "integrations", "google-gmail", "connect", "route.ts"), "utf8");

describe("consent me padhne ka scope maanga jata hai", () => {
  it("GMAIL_READ_SCOPES readonly hai — modify NAHI", () => {
    /* readonly label/archive/delete nahi kar sakta. Forwarder ko `modify` chahiye tha
       kyunki label hi uski yaadaasht thi; ye yaad database me rakhta hai
       (`inbound_emails.message_id` UNIQUE). Mailbox par likhna hi wo kaam tha jo galat
       hua tha — aur ab uski zaroorat hi nahi. */
    expect(GMAIL_READ_SCOPES).toContain("gmail.readonly");
    expect(GMAIL_READ_SCOPES).not.toContain("gmail.modify");
    expect(GMAIL_READ_SCOPES).not.toContain("https://mail.google.com/");
  });

  it("connect route DONO maangta hai — bhejna aur padhna", () => {
    /* Sirf send maanga to cron har minute "koi account padh nahi sakta" bolti rahegi
       aur enquiry kabhi nahi aayegi. */
    expect(CONNECT).toContain("GMAIL_READ_SCOPES");
    expect(CONNECT).toContain("GMAIL_SEND_SCOPES");
  });

  it("purane grant ko union karta hai, badalta nahi", () => {
    /* 26 Aug 2026: Gmail connect ne contacts ka grant dhak diya aur sync 11 din chup-chaap
       403 deta raha. Padhne ka scope jodte waqt wahi dobara nahi hona chahiye. */
    expect(CONNECT).toContain("unionScopes");
  });

  it("send aur read alag constant hain, taaki consent screen sach bole", () => {
    expect(GMAIL_SEND_SCOPES).toContain("gmail.send");
    expect(GMAIL_SEND_SCOPES).not.toContain("gmail.readonly");
  });
});

describe("cron chup nahi rah sakti", () => {
  it("reportCron se bolti hai", () => {
    /* CLAUDE.md ka cron niyam: jo failure ginta hai wo bolta bhi hai. */
    expect(CRON).toContain("reportCron");
  });

  it("scope na ho to ok:false deti hai — '0 mail' nahi", () => {
    /* Yahi wo halat hai jo aaj asli hai: account juda hua hai par sirf bhejne ke liye.
       Agar ye khaali safalta lauta de, to ye theek us khaamoshi ki nakal hai jise ye
       feature khatam karne aaya tha. */
    expect(CRON).toMatch(/readable\.length === 0/);
    expect(CRON).toMatch(/ok:\s*false/);
  });

  it("scope wale sandesh me 'ab kya karein' hai (§24)", () => {
    expect(CRON).toMatch(/Reconnect/i);
  });

  it("cap lagta hai to wo GINA jata hai", () => {
    /* Ek chup-chaap cap "sab ho gaya" jaisa padha jata hai — theek us run par jab nahi
       hua. `deferred` isliye report me hai. */
    expect(CRON).toContain("MAX_PER_RUN");
    expect(CRON).toContain("deferred");
  });
});

describe("pipeline dobara nahi likhi gayi", () => {
  it("cron wahi ingestInboundEmail bulati hai jo webhook bulata hai", () => {
    /* Do copy hone ka matlab hota: ek ko fix milta, doosre ko nahi, aur ek hi mail ka
       nateeja is baat par nirbhar hota ki wo kis raaste aaya. */
    expect(CRON).toContain('from "@/lib/inbound/ingest"');
    expect(CRON).toContain("ingestInboundEmail");
  });

  it("webhook bhi wahi function bulata hai", () => {
    const hook = readFileSync(
      join(SRC, "app", "api", "webhooks", "inbound-email", "route.ts"), "utf8");
    expect(hook).toContain("ingestInboundEmail");
  });

  it("cron Gmail par kuch LIKHTI nahi — koi label, koi delete", () => {
    expect(CRON).not.toMatch(/addLabel|modify|labelIds.*add|messages\/.*\/(trash|delete)/);
  });
});
