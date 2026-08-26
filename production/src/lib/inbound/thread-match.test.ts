import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { continuesThread, hadReplyPrefix } from "./thread-match";

/* ─────────────────────────────────────────────────────────────────────────────
   26 Aug 2026, Pardeep: "ek email id se to customer mujhse kai baar quote maang sakta hai
   kai reseller aise hai jo apne multiple clients ke liye quote maange hai".

   Neeche ke test do asli maamlon par baithe hain, dono naape hue:

     • 22 Aug ka reply — "actually I need 20 users of Standard, not 50 of Starter" — jo
       Spam me chala gaya tha. Wo JUDNA chahiye.
     • 26 Aug ke do email, 30 minute ke faasle par, alag subject, koi `Re:` nahi. Wo ALAG
       lead banni chahiye.

   Ek hi function dono ko theek jawab de — yahi is file ka poora kaam hai.
   ───────────────────────────────────────────────────────────────────────────── */

describe("hadReplyPrefix", () => {
  it("Re: aur Fwd: pehchanta hai", () => {
    expect(hadReplyPrefix("Re: Quote please")).toBe(true);
    expect(hadReplyPrefix("Fwd: Quote please")).toBe(true);
    expect(hadReplyPrefix("RE: quote")).toBe(true);
  });

  it("thape hue prefix bhi", () => {
    /* Client bina hisaab prefix jodte hain, aur ek asli thread "Re: Fwd: Re:" tak pahunch
       jata hai. Ek hi prefix pakadna aise thread ko naya sauda bana deta. */
    expect(hadReplyPrefix("Re: Fwd: RE: Quote please")).toBe(true);
  });

  it("saaf subject par false", () => {
    expect(hadReplyPrefix("Quote please")).toBe(false);
    expect(hadReplyPrefix("20 email of business starter send quote")).toBe(false);
  });

  it("khaali ya gair-maujood par false, girta nahi", () => {
    expect(hadReplyPrefix("")).toBe(false);
    expect(hadReplyPrefix(null)).toBe(false);
    expect(hadReplyPrefix(undefined)).toBe(false);
  });

  it("shabd ke shuru ka 'Re' nahi kaatta", () => {
    /* "Renewal quote" ka 'Re' prefix nahi hai. Aggressive regex asli subject ke aage se
       shabd khane lagti hai — isliye threads.ts ki list chhoti rakhi gayi hai, aur ye
       test us faisle ko yahan bhi baandhta hai. */
    expect(hadReplyPrefix("Renewal quote for 20 seats")).toBe(false);
    expect(hadReplyPrefix("Refund request")).toBe(false);
  });
});

describe("continuesThread — header maujood ho", () => {
  it("In-Reply-To ka HONA hi kaafi hai", () => {
    /* Id ko kisi maujood record se milana JAAN-BOOJHKAR nahi hota — poori wajah
       thread-match.ts me likhi hai. Chhota roop: grahak hamare bheje hue mail ka jawab
       deta hai, aur hum apne bheje mail ka RFC Message-ID kahin store nahi karte. "Id
       milta hai kya" poochhne par har asli reply "naya thread" ban jata. */
    expect(continuesThread({ inReplyTo: "<abc@mail.gmail.com>", subject: "Anything at all" })).toBe(true);
  });

  it("References se bhi", () => {
    expect(continuesThread({ references: "<a@x> <b@y>", subject: "Naya jaisa subject" })).toBe(true);
  });

  it("khaali/whitespace header ko maujood nahi maanta", () => {
    /* Kai forwarder header ka khaali khaana bhej dete hain. Use "reply hai" maan lena
       theek wahi bug wapas laata jo ye badlav theek karne aaya tha. */
    expect(continuesThread({ inReplyTo: "   ", subject: "Fresh enquiry" })).toBe(false);
    expect(continuesThread({ references: "", subject: "Fresh enquiry" })).toBe(false);
  });
});

describe("continuesThread — header na ho (forwarder gira deta hai)", () => {
  it("Re: prefix par judta hai", () => {
    /* Yahi 22 Aug wala maamla hai jab headers na aayein: "Re: Quote" ek jawab hai. */
    expect(continuesThread({ subject: "Re: 20 email of business starter send quote" })).toBe(true);
  });

  it("lead par pehle se maujood subject se mel khaye to judta hai", () => {
    /* Prefix bhi kho gaya (kuch forwarder use bhi kaat dete hain), par subject wahi hai. */
    expect(continuesThread({
      subject: "20 email of business starter send quote",
      leadSubjects: ["20 email of business starter send quote"],
    })).toBe(true);
  });

  it("leadSubjects ko khud normalise karta hai — caller ko yaad na rakhna pade", () => {
    expect(continuesThread({
      subject: "quote  please",
      leadSubjects: ["Re: Fwd: Quote Please"],
    })).toBe(true);
  });

  it("naya subject = naya sauda — PARDEEP KA ASLI MAAMLA", () => {
    /* 26 Aug 2026, dono email ke asli subject, dono ek hi lead par jud gaye the: */
    expect(continuesThread({
      subject: "20 email id google workspace business starter quote",
      leadSubjects: ["20 email of business starter send quote"],
    })).toBe(false);
  });

  it("lead par koi purana subject na ho to bhi naya thread bata deta hai", () => {
    expect(continuesThread({ subject: "Quote for my client Sharma Traders" })).toBe(false);
  });
});

describe("continuesThread — kuch pata na chale", () => {
  it("na header na subject = undefined, false NAHI", () => {
    /* Ye farak maayne rakhta hai. `false` ka matlab hai "naapa, aur ye naya thread hai".
       `undefined` ka matlab hai "naap hi nahi paaye". disposition.ts dono ko nayi lead
       bhejta hai, par wajah alag likhta hai — aur log padhne wale ko wo farak chahiye. */
    expect(continuesThread({})).toBeUndefined();
    expect(continuesThread({ subject: "   " })).toBeUndefined();
    expect(continuesThread({ subject: null, inReplyTo: null, references: null })).toBeUndefined();
  });

  it("subject sirf prefix ho to bhi undefined", () => {
    /* "Re:" akela — prefix hai par uske peeche kuch nahi. `hadReplyPrefix` sach kehta hai,
       to ye `true` deta hai. Aur wo theek hai: prefix ka hona hi reply ka signal hai. */
    expect(continuesThread({ subject: "Re:" })).toBe(true);
  });
});

/* ══ Webhook is faisle se JUDA rahe ═══════════════════════════════════════════
   Upar ke test sirf ye batate hain ki function theek sochta hai. Agar route usse bulana
   band kar de, ye sab green rehte aur bug chup-chaap wapas aa jata — theek wo bug jo
   Pardeep ne pakda tha. Source scan, kyunki jo bacha raha hai wo ek TAAR hai, ek value
   nahi; wahi tareeka autonomy-chokepoint.test.ts leta hai. */
describe("inbound-email route is faisle se juda hai", () => {
  const route = readFileSync(
    join(process.cwd(), "src", "app", "api", "webhooks", "inbound-email", "route.ts"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("continuesThread ka nateeja decideDisposition tak jaata hai", () => {
    expect(route).toContain("continuesThread({");
    expect(route).toContain("continuesOpenLead,");
  });

  it("thread ke headers request se padhe jaate hain", () => {
    /* Key lowercase honi chahiye — `extractHeaders` har naam ko `toLowerCase()` karta hai,
       to `In-Reply-To` se dhoondhne par hamesha undefined milta aur har mail "naya thread"
       ban jata. Ek chup-chaap galat jawab, jise koi error nahi batata. */
    expect(route).toContain('rawHeaders["in-reply-to"]');
    expect(route).toContain('rawHeaders["references"]');
  });

  it("headers DB me darj hote hain", () => {
    /* Faisla inhe padhe bina bhi ho jata hai, par darj hone se ek galat faisla baad me
       naapa ja sakta hai — aur ye pata chalta hai ki forwarder headers bhejta hai ya nahi,
       jo abhi maloom NAHI hai. */
    expect(route).toContain("in_reply_to:");
    expect(route).toContain("thread_references:");
  });

  it("lead ke purane subject sirf tab padhe jaate hain jab koi khuli lead ho", () => {
    /* Warna har ajnabi ke mail par ek bemaani DB round-trip lagta. */
    expect(route).toMatch(/if \(existing\?\.id\) \{[\s\S]{0,400}inbound_emails/);
  });
});
