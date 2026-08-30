import { describe, it, expect } from "vitest";
import {
  headerMap, plainTextFromPayload, toIngestPayload, DEFAULT_QUERY,
  type GmailMessage, type GmailPart,
} from "./gmail-read";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/* ─────────────────────────────────────────────────────────────────────────────
   Ye us din likha gaya jab pata chala ki Apps Script forwarder do din se chup-chaap
   401 kha raha tha aur ek bhi enquiry app tak nahi pahunchi thi. Ab app khud Gmail
   padhta hai, aur padhne me sabse aasan galti YE hai: sirf upar wala hissa dekhna.

   Ek aam reply `multipart/alternative` hota hai, aur attachment wale mail me wo phir
   `multipart/mixed` ke andar hota hai. Top level par `body.data` khaali hota hai — to
   "kuch nahi mila" wala nateeja bilkul asli mail par aata hai, test wale par nahi.
   ───────────────────────────────────────────────────────────────────────────── */

describe("plainTextFromPayload — MIME ka ped", () => {
  it("seedha text/plain", () => {
    const p: GmailPart = { mimeType: "text/plain", body: { data: b64("mujhe 40 email chahiye") } };
    expect(plainTextFromPayload(p)).toBe("mujhe 40 email chahiye");
  });

  it("multipart/alternative — plain chunta hai, html nahi — ASLI MAAMLA", () => {
    const p: GmailPart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("100 email id chahiye") } },
        { mimeType: "text/html",  body: { data: b64("<div>100 email id chahiye</div>") } },
      ],
    };
    expect(plainTextFromPayload(p)).toBe("100 email id chahiye");
  });

  it("multipart/mixed ke andar alternative — attachment wala mail", () => {
    const p: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: b64("bill saath me hai") } },
        ] },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { data: b64("%PDF") } },
      ],
    };
    expect(plainTextFromPayload(p)).toBe("bill saath me hai");
  });

  it("attachment ka text/plain MESSAGE nahi hai", () => {
    /* Ek .txt attachment ka mimeType bhi text/plain hota hai. `filename` hi wo farq hai. */
    const p: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("asli sandesh") } },
        { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("ye attachment hai") } },
      ],
    };
    const out = plainTextFromPayload(p);
    expect(out).toContain("asli sandesh");
    expect(out).not.toContain("ye attachment hai");
  });

  it("sirf html ho to tag hatte hain, par line break bachte hain", () => {
    const p: GmailPart = {
      mimeType: "text/html",
      body: { data: b64("<p>40 seats chahiye</p><p>Regards,<br>Deepak</p>") },
    };
    const out = plainTextFromPayload(p);
    expect(out).toContain("40 seats chahiye");
    expect(out).toContain("Deepak");
    expect(out).not.toContain("<");
    /* Bina line break ke "chahiye" aur "Regards" jud jate — aur extractor prose padhta hai. */
    expect(out).toMatch(/40 seats chahiye\s*\n/);
  });

  it("&nbsp; jaise entity wapas akshar bante hain", () => {
    const p: GmailPart = { mimeType: "text/html", body: { data: b64("<p>A&nbsp;&amp;&nbsp;B</p>") } };
    expect(plainTextFromPayload(p)).toBe("A & B");
  });

  it("khaali / tooti hui cheez par crash nahi", () => {
    expect(plainTextFromPayload(null)).toBe("");
    expect(plainTextFromPayload(undefined)).toBe("");
    expect(plainTextFromPayload({ mimeType: "text/plain", body: {} })).toBe("");
  });

  it("apne aap ko lapetne wala ped anant tak nahi jata", () => {
    /* Bina bound ke ye stack tod deta. Cron ko ek kharab mail nahi giraana chahiye. */
    const deep: GmailPart = { mimeType: "multipart/mixed" };
    deep.parts = [deep];
    expect(() => plainTextFromPayload(deep)).not.toThrow();
  });
});

describe("headerMap — naam ka chhota-bada matlab nahi rakhta", () => {
  it("RFC 5322 ke hisaab se case-insensitive", () => {
    const msg: GmailMessage = { id: "x", payload: { headers: [
      { name: "From", value: "a@b.in" }, { name: "SUBJECT", value: "Quote" },
    ] } };
    const h = headerMap(msg);
    expect(h.get("from")).toBe("a@b.in");
    expect(h.get("subject")).toBe("Quote");
  });

  it("headers na ho to khaali map, crash nahi", () => {
    expect(headerMap({ id: "x" }).size).toBe(0);
    expect(headerMap(null).size).toBe(0);
  });
});

describe("toIngestPayload — wahi shakl jo forwarder bhejta tha", () => {
  const msg: GmailMessage = {
    id: "1a050aab596a5731",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From",       value: "Pardeep Sharma <pardeep.webmaster@gmail.com>" },
        { name: "To",         value: "sales@anutech.in" },
        { name: "Subject",    value: "mujhe 100 email id google workspace business starter ke quote chahiye" },
        { name: "Message-Id", value: "<CAJ=abc@mail.gmail.com>" },
        { name: "In-Reply-To", value: "<prev@mail.gmail.com>" },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64("mujhe 100 email id chahiye") } }],
    },
  };

  it("from / to / subject / text sahi nikalte hain", () => {
    const p = toIngestPayload(msg);
    expect(p.from).toBe("Pardeep Sharma <pardeep.webmaster@gmail.com>");
    expect(p.to).toBe("sales@anutech.in");
    expect(p.subject).toContain("100 email id");
    expect(p.text).toBe("mujhe 100 email id chahiye");
    expect(p.inReplyTo).toBe("<prev@mail.gmail.com>");
  });

  it("messageId GMAIL ka id hai, RFC Message-Id NAHI — ye sabse zaroori line hai", () => {
    /* Do wajah:
       1. Purana forwarder bhi yahi bhejta tha (`m.getId()`), to jo mail wo pehle daal
          chuka hai wo dobara nahi banega — cutover ke liye koi migration nahi chahiye.
       2. RFC wala Message-Id BHEJNE WALA chunta hai. Do alag mail ek hi le kar aa sakte
          hain, aur `inbound_emails.message_id` UNIQUE hai — takraav ek asli enquiry ko
          chup-chaap nigal leta. */
    expect(toIngestPayload(msg).messageId).toBe("1a050aab596a5731");
    expect(toIngestPayload(msg).messageId).not.toContain("@");
  });

  it("bahut lamba matn kaata jata hai", () => {
    const long: GmailMessage = { id: "z", payload: {
      mimeType: "text/plain", body: { data: b64("x".repeat(20000)) } } };
    expect(toIngestPayload(long, 8000).text).toHaveLength(8000);
  });

  it("kuch bhi na mile to khaali string, undefined nahi", () => {
    const bare = toIngestPayload({ id: "q" });
    expect(bare).toMatchObject({ from: "", to: "", subject: "", text: "", messageId: "q" });
  });
});

describe("DEFAULT_QUERY", () => {
  it("apne hi bheje hue mail ko bahar rakhta hai", () => {
    /* Ye wahi mailbox hai jisse app quote BHEJTA bhi hai. `-in:sent` ke bina har bheja
       hua quote wapas ek nayi enquiry ban kar aata — apne hi aap se. */
    expect(DEFAULT_QUERY).toContain("-in:sent");
  });

  it("draft aur chat bhi bahar hain, aur khidki ek din se badi hai", () => {
    expect(DEFAULT_QUERY).toContain("-in:draft");
    expect(DEFAULT_QUERY).toContain("-in:chats");
    /* Cron ek din band rahe to bhi kuch na khoye — cursor ki jagah khidki isliye hai. */
    expect(DEFAULT_QUERY).toMatch(/newer_than:(\d+)d/);
    expect(Number(/newer_than:(\d+)d/.exec(DEFAULT_QUERY)![1])).toBeGreaterThanOrEqual(2);
  });
});
