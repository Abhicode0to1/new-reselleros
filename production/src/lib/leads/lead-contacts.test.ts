import { describe, expect, it } from "vitest";
import { cleanEmail, cleanPhone, contactBonus, extractContacts, nameFromEmail, parsePersonSearch, personIsGrounded, pickEmail, pickPhone, reachable, readContact, roleSnippets, type ContactResult } from "./lead-contacts";

describe("cleanPhone — Indian numbers only", () => {
  it.each([
    ["+91 98765 43210", "+919876543210"],
    ["098765-43210", "+919876543210"],
    ["9876543210", "+919876543210"],
    ["0091 9876543210", "+919876543210"],
    ["011-23456789", "01123456789"],
    ["0124 4567890", "01244567890"],
    ["+91 11 2345 6789", "01123456789"],
    ["1800 123 4567", "18001234567"],
  ])("%s → %s", (raw, want) => expect(cleanPhone(raw)).toBe(want));

  it.each(["12345", "+1 415 555 0100", "5876543210", "2019-2020"])("rejects %s", (raw) => expect(cleanPhone(raw)).toBeNull());
});

describe("cleanEmail", () => {
  it("keeps a real address, drops mailto and query", () => expect(cleanEmail("mailto:Info@Firm.co.in?subject=hi")).toBe("info@firm.co.in"));
  it.each(["logo@2x.png", "noreply@firm.com", "user@example.com", "abc@sentry.io", "not-an-email"])("drops %s", (e) => expect(cleanEmail(e)).toBeNull());
});

describe("extractContacts", () => {
  const html = `
    <html><head><style>.a{}</style><script>var x="bot@tracker.js"</script></head><body>
    <a href="mailto:hello@webagency.in">site by agency</a>
    <p>Write to info [at] glsconsultant [dot] com or call <a href="tel:+919811122233">+91 98111 22233</a></p>
    <p>Office: 0124-4567890 · GSTIN 06AABCG1234F1Z5 · PIN 122001</p>
    <img src="logo@2x.png">
    </body></html>`;
  const got = extractContacts(html, "glsconsultant.com");

  it("finds mailto, tel, obfuscated email and landline", () => {
    expect(got.emails).toContain("info@glsconsultant.com");
    expect(got.phones).toEqual(expect.arrayContaining(["+919811122233", "01244567890"]));
  });
  it("puts the company's own domain before the agency's", () => expect(got.emails[0]).toBe("info@glsconsultant.com"));
  it("does not read scripts, image names, GSTIN or PIN as contacts", () => {
    expect(got.emails.join()).not.toMatch(/tracker|2x\.png/);
    expect(got.phones.every((p) => p !== "122001")).toBe(true);
  });
});

describe("pick", () => {
  it("prefers own-domain role address", () =>
    expect(pickEmail(["rahul@gmail.com", "rahul@firm.in", "info@firm.in"], "firm.in")).toBe("info@firm.in"));
  it("prefers a mobile over landline and toll-free", () =>
    expect(pickPhone(["18001234567", "01123456789", "+919876543210"])).toBe("+919876543210"));
  it("returns null for nothing", () => { expect(pickEmail([], "x.in")).toBeNull(); expect(pickPhone([])).toBeNull(); });
});

describe("readContact", () => {
  it("reads the stored block", () => expect(readContact({ contact: { email: "a@b.in", phone: null, emails: [], phones: [], source_url: null, checked_at: "2026-09-28" } })?.email).toBe("a@b.in"));
  it("null when never checked", () => { expect(readContact({ mx_hosts: [] })).toBeNull(); expect(readContact(null)).toBeNull(); });
});

describe("reachable / contactBonus", () => {
  const c = (email: string | null, phone: string | null): ContactResult => ({ email, phone, emails: [], phones: [], source_url: null, checked_at: "x" });
  it("nothing found is not reachable", () => { expect(reachable(c(null, null))).toBe(false); expect(reachable(null)).toBe(false); });
  it("email or phone is reachable", () => { expect(reachable(c("a@b.in", null))).toBe(true); expect(reachable(c(null, "01123456789"))).toBe(true); });
  it("mobile > landline > email > none", () => {
    expect(contactBonus(c(null, "+919876543210"))).toBe(10);
    expect(contactBonus(c(null, "01123456789"))).toBe(6);
    expect(contactBonus(c("a@b.in", null))).toBe(4);
    expect(contactBonus(c(null, null))).toBe(0);
  });
});

describe("contact person", () => {
  it("nameFromEmail: first.last only", () => {
    expect(nameFromEmail("rahul.choudhary@crcllp.in")).toBe("Rahul Choudhary");
    expect(nameFromEmail("info@crcllp.in")).toBeNull();
    expect(nameFromEmail("rahul@crcllp.in")).toBeNull();
    expect(nameFromEmail(null)).toBeNull();
  });
  it("roleSnippets keeps text around role words only", () => {
    const s = roleSnippets("Welcome to our firm. We serve clients. CA Rahul Choudhary, Managing Partner, founded the firm in 2004. Contact us.");
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]).toContain("Rahul Choudhary");
  });
  it("personIsGrounded rejects invented or partial names", () => {
    const snips = ["CA Rahul Choudhary, Managing Partner, founded the firm"];
    expect(personIsGrounded("Rahul Choudhary", snips)).toBe(true);
    expect(personIsGrounded("CA Rahul Choudhary", snips)).toBe(true);
    expect(personIsGrounded("Amit Sharma", snips)).toBe(false);
    expect(personIsGrounded("Rahul", snips)).toBe(false);
  });
});

describe("parsePersonSearch", () => {
  const ok = '{"name": "Mr. Arvind Kumar Jain", "role": "Director", "source_url": "https://www.zaubacorp.com/company/X"}';
  it("keeps a named person with an allowed source", () => expect(parsePersonSearch(ok, "Empyreal Realty")?.name).toBe("Mr. Arvind Kumar Jain"));
  it("refuses LinkedIn and social sources", () =>
    expect(parsePersonSearch('{"name":"Arvind Jain","role":"CEO","source_url":"https://in.linkedin.com/in/arvind"}', "X")).toBeNull());
  it("refuses no source, null, one word, or the firm's own name", () => {
    expect(parsePersonSearch('{"name":"Arvind Jain","role":"CEO","source_url":null}', "X")).toBeNull();
    expect(parsePersonSearch('{"name":null}', "X")).toBeNull();
    expect(parsePersonSearch('{"name":"Arvind","source_url":"https://news.in/a"}', "X")).toBeNull();
    expect(parsePersonSearch('{"name":"Sarthak Advocates","source_url":"https://news.in/a"}', "Sarthak Advocates & Solicitors")).toBeNull();
  });
  it("reads JSON inside prose or a fence", () => expect(parsePersonSearch("Here:\n```json\n" + ok + "\n```", "Y")?.role).toBe("Director"));
});
