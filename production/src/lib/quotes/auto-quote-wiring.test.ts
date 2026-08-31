import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Does the auto-quote actually run on BOTH webhook branches?

   This file exists because of a bug no other test could see. On 23 Aug 2026 a live
   self-test mail — "quotation for 50 Google Workspace Business Starter users on annual
   billing" — arrived from an address that already had an open lead. The webhook appended
   it (correctly), the extractor rewrote the lead (seats 20 → 50, plan Standard → Starter),
   and NO QUOTE WAS DRAFTED, because the quote block sat inside the CREATE branch alone.

   Every decision was individually right and covered: planQuoteFromEnquiry had 17
   assertions, decideAutoSend had 17, the extractor had 83. Not one of them looks at where
   the functions are CALLED. The auto-reply had been wired to both branches in the same
   sitting and the auto-quote to one, and the suite stayed green.

   So this is a source scan, like autonomy-chokepoint.test.ts, and for the same reason:
   the failure mode is a missing call site, which reads plainly in the source and not at
   all in a mock.
   ───────────────────────────────────────────────────────────────────────────── */

const WEBHOOK = readFileSync(
  join(process.cwd(), "src", "lib", "inbound", "ingest.ts"),
  "utf8",
);
const code = WEBHOOK.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Where the append branch ends — everything after is the create branch. */
const APPEND_END = code.indexOf('appendedToLead: existing.id');

/* ─────────────────────────────────────────────────────────────────────────────
   ⚠️ THIS BLOCK CHANGED SHAPE ON 31 AUG 2026, AND THAT IS THE POINT.

   It used to assert that the quote and the AI reply were each called TWICE — once per
   branch — because twice they had been wired to one branch only. Counting call sites is a
   guard against forgetting, and forgetting was never the real problem: having two places to
   remember was.

   Both branches now run the same list of steps (`afterLeadWritten`), so each step is called
   exactly ONCE. "Twice" is now the failure, not the pass. If you are here because a test
   went red after you added a step, add it inside that function — not to a branch.
   ───────────────────────────────────────────────────────────────────────────── */
describe("lead ban-ne ke BAAD ke kadam ek hi jagah likhe hain", () => {
  it("auto-quote ek hi baar — dono branch usi ek raaste se guzarte hain", () => {
    const calls = code.match(/autoQuoteForLead\(admin, \{/g) ?? [];
    expect(calls.length, `autoQuoteForLead ${calls.length} baar likha hai; ek hona chahiye`)
      .toBe(1);
  });

  it("AI sales agent bhi ek hi baar", () => {
    /* Ye `runAutoReply` tha 24 Aug tak. Ab agent hai — SWAP, addition nahi: do drafter ek
       customer ko jawab likhein to `auto` par uske paas do email jaate hain. */
    const calls = code.match(/runSalesAgentForLead\(\{/g) ?? [];
    expect(calls.length, `runSalesAgentForLead ${calls.length} baar likha hai; ek hona chahiye`)
      .toBe(1);
  });

  it("follow-up task bhi ek hi baar", () => {
    const calls = code.match(/createFollowUpTask\(admin,/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it("dono branch afterLeadWritten bulate hain", () => {
    expect(APPEND_END).toBeGreaterThan(0);
    expect(code.slice(0, APPEND_END), "APPEND branch — yahi baar-baar chhooti hai")
      .toContain("afterLeadWritten({");
    expect(code.slice(APPEND_END), "CREATE branch").toContain("afterLeadWritten({");
  });

  it("shouldRequoteOnReply sirf APPEND branch par poochha jata hai", () => {
    /* Ek naye lead ke paas tulna karne ko kuch hai hi nahi, isliye wahan ye gate bematlab
       hai. Reply par yahi ek paanch-message wali baat-cheet ko paanch GST document ban-ne se
       rokta hai. Isiliye ye gate branch me hai aur uska NATEEJA shared function me jata hai —
       kadam saanjhe, faisla apna. */
    expect(code.slice(0, APPEND_END)).toContain("shouldRequoteOnReply(");
    expect(code.slice(APPEND_END)).not.toContain("shouldRequoteOnReply(");
  });

  it("purana auto-reply kahin nahi bacha", () => {
    /* Aadha-adhoora swap: ek branch agent par, doosri purane par — to purane thread wale
       customer ko alag system milta, aur `auto` par do email. */
    expect(code).not.toMatch(/runAutoReply\(\{/);
  });
});


describe("no second copy of the money arithmetic", () => {
  it("the webhook does not build a quote row itself any more", () => {
    /* 130 lines used to sit inline, including next_document_number and the quotes insert.
       Copying them into the append branch would have left two versions of money arithmetic
       to keep in step — which is how the two paths end up disagreeing by a rupee. */
    expect(code).not.toContain('p_doc_type: "quote"');
    expect(code).not.toMatch(/from\("quotes"\)\s*\.insert/);
  });

  it("the shared function is the only place that allocates a quote number", () => {
    const lib = readFileSync(
      join(process.cwd(), "src", "lib", "quotes", "auto-quote-for-lead.ts"),
      "utf8",
    );
    expect(lib).toContain('p_doc_type: "quote"');
  });
});

describe("mail EK hi tarike se padhi jati hai — 31 Aug ka asli sabak", () => {
  /* ─────────────────────────────────────────────────────────────────────────
     Wahi galti, teesri shakl me. 30 Aug ko AI product fallback joda gaya kyunki "google
     workspace starter" catalogue ke "Google Workspace Business Starter" se nahi milta tha.
     Wo fallback sirf CREATE branch me laga.

     31 Aug ko asli reply aayi: "mujhe 48 email id google workspace starter ke liye qutoe
     chahiye monthly par" — seats, product aur term, teeno. App ne daam bata diya, quotation
     ka vaada bhi kar diya, aur draft kuch nahi kiya.

     Do baar "dono jagah bulao" wala pehra lagane ke baad saaf hua ki pehra kaafi nahi hai:
     asli dikkat ye thi ki mail DO alag tariko se padhi jati thi. Ab ek hi tarika hai —
     `readEnquiryFacts` — aur ye block usi ko pakde rakhta hai.
     ───────────────────────────────────────────────────────────────────────── */
  it("readEnquiryFacts do baar bulaya jata hai — har branch ek baar", () => {
    const calls = code.match(/readEnquiryFacts\(admin, \{/g) ?? [];
    expect(calls.length, `readEnquiryFacts ${calls.length} baar bulaya gaya, 2 hona chahiye`)
      .toBe(2);
  });

  it("APPEND branch par bhi — yahi wo taraf hai jo baar-baar chhooti hai", () => {
    expect(APPEND_END).toBeGreaterThan(0);
    expect(code.slice(0, APPEND_END)).toContain("readEnquiryFacts(admin, {");
  });

  it("CREATE branch par bhi", () => {
    expect(code.slice(APPEND_END)).toContain("readEnquiryFacts(admin, {");
  });

  it("webhook khud na extractEntities bulata hai, na resolveProduct", () => {
    /* Yahi wo darwaza hai jise band rakhna hai. Ek branch me seedha extractor bula lena
       wapas do tarike bana deta hai, aur agli capability phir ek hi taraf lagegi. */
    expect(code).not.toContain("extractEntities(");
    expect(code).not.toContain("resolveProduct(");
    expect(code).not.toContain("matchProductWithAi(");
  });

  it("poore src me resolveProduct sirf EK jagah se bulaya jata hai", () => {
    /* Puri repo par ginti, sirf is file par nahi — warna koi doosra caller chup-chaap apna
       raasta bana lega aur ye poora kaam wapas wahin pahunch jayega. */
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const f = join(dir, e);
        if (statSync(f).isDirectory()) { walk(f); continue; }
        if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
        if (f.endsWith("resolve-product.ts")) continue;
        const src = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/\bresolveProduct\(/.test(src)) hits.push(f);
      }
    };
    const root = join(process.cwd(), "src");
    walk(root);
    /* Path ko `join` se hi banaya jata hai — Windows par separator ulta hota hai, aur use
       haath se badalna hi is jaanch ko kisi doosri machine par lal kar deta. */
    expect(hits.map((h) => h.slice(root.length + 1)))
      .toEqual([join("lib", "inbound", "read-enquiry.ts")]);
  });

  it("append branch reply ka product lead ke purane plan se PEHLE dekhta hai", () => {
    /* Doosra aadha hissa: `priced.find(c => c.name === lf.plan)` ek exact string compare hai
       us free text par jo pehle save hua tha — is lead par "Google Workspace", jo kisi
       catalogue row se kabhi nahi milega. */
    expect(code.slice(0, APPEND_END))
      .toMatch(/replyItem \?\? priced\.find\(\(c\) => c\.name === lf\.plan\)/);
  });
});
