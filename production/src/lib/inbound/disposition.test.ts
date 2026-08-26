import { describe, it, expect } from "vitest";
import { decideDisposition } from "./disposition";

describe("decideDisposition", () => {
  it("files a reply from an existing lead on that lead, whatever the classifier says", () => {
    /* THE REPORTED BUG. The route asked "is this an enquiry?" before "do we know this
       person?", so a mid-thread reply — "actually I need 20 users of Standard, not 50 of
       Starter" — was correctly judged "not a new enquiry" and filed under Spam / System.
       It was the most important message in the thread.

       `continuesOpenLead: true` 26 Aug 2026 ko juda, aur wo is test ko kamzor nahi karta:
       wo asli message THREAD KE BEECH KA REPLY tha, to reality me ye signal `true` hi
       aata (In-Reply-To header ya `Re:` prefix se — dekho thread-match.ts). Test ab wahi
       haalat banata hai jo us din thi, pehle se zyada theek. */
    const d = decideDisposition({ openLeadId: "L-MT4HUR6P", isEnquiry: false, continuesOpenLead: true });
    expect(d.action).toBe("append");
    expect(d.action === "append" && d.leadId).toBe("L-MT4HUR6P");
  });

  it("never SKIPS a message from someone we have an open lead with — koi bhi raasta le", () => {
    /* Ye is file ka sabse zaroori invariant hai, aur 26 Aug ke badlav ke baad iski shakl
       badli hai. Pehle ye "hamesha append" kehta tha. Ab jaane-pehchane sender ka mail do
       jagah ja sakta hai — purani lead par, ya nayi lead par — par **Spam me kabhi nahi**.

       Isliye assert ab `append` par nahi, `!== "skip"` par hai. Yahi wo cheez thi jo 22 Aug
       ko toota tha (zaroori message Spam me chala gaya), aur yahi bachani hai. Classifier
       ka har jawab aur thread ka har signal — sabhi sweep me. */
    for (const isEnquiry of [true, false, null, undefined]) {
      for (const continuesOpenLead of [true, false, undefined]) {
        const d = decideDisposition({ openLeadId: "L-1", isEnquiry, continuesOpenLead });
        expect(d.action, `isEnquiry=${String(isEnquiry)} continues=${String(continuesOpenLead)}`)
          .not.toBe("skip");
      }
    }
  });

  it("ek hi sender ka NAYA thread doosri lead banata hai — Pardeep ka maamla", () => {
    /* 26 Aug 2026: "ek email id se to customer mujhse kai baar quote maang sakta hai, kai
       reseller aise hain jo apne multiple clients ke liye quote maangte hain".

       Uske apne data me ye ho chuka tha: 18:08 aur 18:38 par do alag subject wale email,
       dono ek hi lead par jud gaye, aur lead ke seats overwrite hote rahe. */
    const d = decideDisposition({ openLeadId: "L-1", isEnquiry: true, continuesOpenLead: false });
    expect(d.action).toBe("create");
    expect(d.reason).toMatch(/second deal|fresh thread/i);
  });

  it("pata na chale to NAYI lead — aur classifier tab bhi nahi poochha jata", () => {
    /* Faisla Pardeep ka: chupi hui galti (do sauda ek lead me mil jana) dikhne wali galti
       (ek duplicate lead) se mehngi hai, aur duplicate ke liye Merge leads maujood hai.

       `isEnquiry: false` bhi saath hai jaan-boojhkar: wo `create` ko `skip` me badalna NAHI
       chahiye. Jaane-pehchane sender ka mail Spam me nahi jata. */
    const d = decideDisposition({ openLeadId: "L-1", isEnquiry: false });
    expect(d.action).toBe("create");
  });

  it("creates a lead for a genuine enquiry from a stranger", () => {
    expect(decideDisposition({ openLeadId: null, isEnquiry: true }).action).toBe("create");
  });

  it("skips non-sales mail from a stranger", () => {
    /* The case the classifier is actually for — a newsletter, a security alert, a
       receipt. This is what keeps the Inbox worth opening. */
    const d = decideDisposition({ openLeadId: null, isEnquiry: false });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/no open conversation/i);
  });

  it("treats an ABSENT classification as 'let the operator see it', not as spam", () => {
    /* isEnquiry: null means Gemini did not run — no key, a timeout, the breaker open.
       An absence is not a verdict. Filing mail as spam because the AI was down is how a
       real customer's first email disappears during an outage. */
    for (const missing of [null, undefined]) {
      const d = decideDisposition({ openLeadId: null, isEnquiry: missing });
      expect(d.action, String(missing)).toBe("create");
      expect(d.reason).toMatch(/did not run/i);
    }
  });

  it("treats a blank or whitespace lead id as no lead", () => {
    /* A "" from a maybeSingle() miss must not look like a match and produce an append
       against an empty id. */
    expect(decideDisposition({ openLeadId: "", isEnquiry: false }).action).toBe("skip");
    expect(decideDisposition({ openLeadId: "   ", isEnquiry: false }).action).toBe("skip");
  });

  it("always explains itself", () => {
    /* The reason is written into the row's status trail. "Why is this in Spam" was
       unanswerable before, which is why the report took a database query to diagnose. */
    const all = [
      decideDisposition({ openLeadId: "L-1", isEnquiry: false }),
      decideDisposition({ openLeadId: null, isEnquiry: true }),
      decideDisposition({ openLeadId: null, isEnquiry: false }),
      decideDisposition({ openLeadId: null, isEnquiry: null }),
    ];
    for (const d of all) expect(d.reason.length).toBeGreaterThan(20);
  });
});

describe("decideDisposition — our own address is never a customer", () => {
  /* A regression introduced on 23 Aug 2026 and caught by the operator within the hour:
     "ye lead kyo bani". Every reply on a thread arrives twice — once at the
     customer-facing address, once at the address we send FROM, because that address is
     in the thread. Making an absent classification resolve to `create` (so a real first
     email could not vanish during an outage) turned every echo of our own mail into a
     new lead named after our own domain. */

  it("skips mail from our own address even when it looks like an enquiry", () => {
    const d = decideDisposition({ senderIsOurs: true, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/our own address/i);
  });

  it("skips it whatever the classifier says, including when it did not run", () => {
    /* isEnquiry: null was the exact path that created the lead. */
    for (const isEnquiry of [true, false, null, undefined]) {
      expect(decideDisposition({ senderIsOurs: true, isEnquiry }).action, String(isEnquiry)).toBe("skip");
    }
  });

  it("does NOT append our own echo onto the open lead either", () => {
    /* Tempting, and wrong: the outgoing message is already recorded as sent
       (status reply_sent), so appending the echo duplicates the thread. */
    const d = decideDisposition({ senderIsOurs: true, openLeadId: "L-MT4HUR6P", isEnquiry: false });
    expect(d.action).toBe("skip");
  });

  it("leaves a genuine customer on the same domain alone", () => {
    /* senderIsOurs is an exact-address decision made by the caller, not a domain guess.
       A customer whose address merely resembles ours must still be handled normally. */
    const d = decideDisposition({ senderIsOurs: false, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("create");
  });

  it("treats an absent flag as 'not ours', so no caller silently opts out", () => {
    expect(decideDisposition({ openLeadId: null, isEnquiry: true }).action).toBe("create");
  });
});

describe("the operator testing the pipeline from their own address", () => {
  /* Task 4 of the money-spine work, 23 Aug 2026. The problem: `senderIsOurs` was added
     because Pardeep's own forwarded mail became a lead, and he needs to be able to test the
     enquiry→quote flow from that same address. Same sender, opposite intent.

     Intent is not visible in an address, so lib/inbound/self-test.ts requires it to be
     stated in the subject. This file only has to prove that saying so gets through and that
     NOT saying so still does not. */

  it("lets a marked self-test create a lead", () => {
    const d = decideDisposition({ senderIsOurs: true, isSelfTest: true, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("create");
  });

  it("still skips our own address when it is NOT a self-test", () => {
    /* The original bug. This assertion is the one that must never flip. */
    const d = decideDisposition({ senderIsOurs: true, isSelfTest: false, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("skip");
    expect(d.reason).toMatch(/our own addresses/);
  });

  it("skips our own address when isSelfTest is simply absent", () => {
    /* Every existing caller omits the flag. Absent must behave exactly as false, or adding
       the parameter would have silently changed the default for the whole pipeline. */
    const d = decideDisposition({ senderIsOurs: true, openLeadId: null, isEnquiry: true });
    expect(d.action).toBe("skip");
  });

  it("files a self-test onto an open lead when one exists, like any other sender", () => {
    /* Once past the guard it is an ordinary message, so the identity-before-classification
       ordering applies unchanged.

       Is test ki asli baat "hamesha append" nahi thi — wo ye thi ki **self-test ko koi
       khaas chhoot nahi milti**. 26 Aug 2026 ke baad wo baat aur saaf ho gayi: self-test
       bhi wahi thread ka niyam maanta hai jo baaki sab maante hain. Dono shakhaayein
       neeche pinned hain, taaki koi galti se self-test ke liye ek alag raasta na bana de. */
    const cont = decideDisposition({ senderIsOurs: true, isSelfTest: true, openLeadId: "L-1", isEnquiry: true, continuesOpenLead: true });
    expect(cont.action).toBe("append");

    const fresh = decideDisposition({ senderIsOurs: true, isSelfTest: true, openLeadId: "L-1", isEnquiry: true, continuesOpenLead: false });
    expect(fresh.action).toBe("create");
  });

  it("does not let the self-test flag rescue a message the classifier rejected", () => {
    /* `isSelfTest` buys passage through the OWN-ADDRESS rule and nothing else. A marked
       mail that Gemini says is not an enquiry is still not an enquiry. */
    const d = decideDisposition({ senderIsOurs: true, isSelfTest: true, openLeadId: null, isEnquiry: false });
    expect(d.action).toBe("skip");
  });
});
