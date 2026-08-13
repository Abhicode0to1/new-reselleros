import { describe, it, expect } from "vitest";
import {
  buildMimeMessage, buildGmailRaw, sanitiseHeaderValue,
  encodeHeaderValue, encodeAddressHeader, toBase64Url,
} from "./gmail-message";

const base = {
  to: "customer@example.in",
  from: "Anutech <billing@anutech.in>",
  subject: "Your renewal is due",
  text: "Hello, your subscription renews on 23 Jul 2027.",
};

/** Decode a base64 body section back to text, for asserting on content. */
const decode = (b64: string) => Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8");

describe("header injection — the reachable one", () => {
  it("strips CRLF from a subject, so a Bcc cannot be smuggled in", () => {
    // Reachable, not theoretical: subjects already carry customer-supplied text --
    // company names, quote titles, inbound email subjects echoed back.
    const msg = buildMimeMessage({
      ...base,
      subject: "Invoice ready\r\nBcc: attacker@example.com",
    });
    // The property that matters is that no HEADER was created — not that the
    // string disappears. Folding the newline to a space leaves the text as inert
    // subject content, which is right: over-stripping would mangle legitimate
    // subjects, and nothing is delivered to that address.
    expect(msg).not.toMatch(/^Bcc:/m);
    expect(msg).toMatch(/Subject: Invoice ready Bcc: attacker@example\.com/);
    // And it really is one header line, not two.
    expect(msg.split("\r\n").filter((l) => l.startsWith("Subject:"))).toHaveLength(1);
  });

  it("strips injection from every header, not just the subject", () => {
    const msg = buildMimeMessage({
      ...base,
      to: "victim@example.in\r\nBcc: attacker@evil.com",
      from: "Anutech\r\nX-Evil: 1 <billing@anutech.in>",
      replyTo: "reply@anutech.in\nCc: sneaky@evil.com",
    });
    expect(msg).not.toMatch(/^Bcc:/m);
    expect(msg).not.toMatch(/^Cc:/m);
    expect(msg).not.toMatch(/^X-Evil:/m);
  });

  it("strips a newline out of an attachment filename too", () => {
    // A PDF named after a customer's company name reaches this header.
    const msg = buildMimeMessage({
      ...base,
      attachments: [{ filename: "quote\r\nContent-Type: text/html.pdf", content: Buffer.from("x") }],
    });
    expect(msg).not.toMatch(/^Content-Type: text\/html\.pdf/m);
  });

  it("collapses the gap a stripped newline leaves, so it does not read as a typo", () => {
    expect(sanitiseHeaderValue("Renewal\r\n\r\n  due")).toBe("Renewal due");
  });
});

describe("non-ASCII headers", () => {
  it("encodes a subject with an em dash, which would otherwise arrive as mojibake", () => {
    const msg = buildMimeMessage({ ...base, subject: "Renewal — Anutech Digital" });
    expect(msg).toMatch(/Subject: =\?UTF-8\?B\?/);
    const b64 = /Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(msg)![1];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Renewal — Anutech Digital");
  });

  it("leaves a plain ASCII subject readable rather than encoding everything", () => {
    // Encoding unconditionally works but makes every header unreadable in logs.
    expect(encodeHeaderValue("Your renewal is due")).toBe("Your renewal is due");
  });

  it("encodes a non-ASCII display name but never the address itself", () => {
    // An encoded-word inside angle brackets is not a valid address.
    const h = encodeAddressHeader("Pardeep Śarmā <pardeep@anutech.in>");
    expect(h).toMatch(/^=\?UTF-8\?B\?.+\?= <pardeep@anutech\.in>$/);
    expect(h).toContain("<pardeep@anutech.in>");
  });

  it("passes a bare address through untouched", () => {
    expect(encodeAddressHeader("billing@anutech.in")).toBe("billing@anutech.in");
  });
});

describe("line endings and encoding", () => {
  it("uses CRLF, never a bare LF", () => {
    // A bare \n in the headers makes some servers treat the rest as body, and the
    // mail arrives with its headers shown as text.
    const msg = buildMimeMessage(base);
    expect(msg.includes("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(msg)).toBe(false);
  });

  it("produces base64URL for the Gmail raw field — no +, / or padding", () => {
    const raw = buildGmailRaw({ ...base, text: "a".repeat(500) + "?><~" });
    expect(raw).not.toMatch(/[+/=]/);
  });

  it("round-trips through base64url", () => {
    const original = "Renewal — ₹16,200 due";
    const decoded = Buffer.from(
      toBase64Url(original).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe(original);
  });

  it("wraps base64 payloads at 76 characters per RFC 2045", () => {
    const msg = buildMimeMessage({ ...base, text: "x".repeat(5000) });
    const bodyLines = msg.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l));
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const l of bodyLines) expect(l.length).toBeLessThanOrEqual(76);
  });
});

describe("structure follows the content", () => {
  it("text only → a plain text/plain message, not a pointless multipart", () => {
    // A multipart wrapper around a single part makes some clients show an empty
    // message.
    const msg = buildMimeMessage(base);
    expect(msg).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
    expect(msg).not.toMatch(/multipart/);
  });

  it("text + html → multipart/alternative", () => {
    const msg = buildMimeMessage({ ...base, html: "<p>Hello</p>" });
    expect(msg).toMatch(/Content-Type: multipart\/alternative; boundary="(.+)"/);
    expect(msg).toMatch(/Content-Type: text\/plain/);
    expect(msg).toMatch(/Content-Type: text\/html/);
  });

  it("attachments → multipart/mixed wrapping the alternative", () => {
    const msg = buildMimeMessage({
      ...base, html: "<p>Hi</p>",
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("PDFDATA") }],
    });
    expect(msg).toMatch(/Content-Type: multipart\/mixed/);
    expect(msg).toMatch(/Content-Type: multipart\/alternative/);
    expect(msg).toMatch(/Content-Disposition: attachment; filename="invoice\.pdf"/);
  });

  it("closes every boundary it opens", () => {
    // An unclosed boundary makes the message unparseable and the body vanishes.
    const msg = buildMimeMessage({
      ...base, html: "<p>Hi</p>",
      attachments: [{ filename: "a.pdf", content: Buffer.from("x") }],
    });
    for (const b of new Set([...msg.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]))) {
      expect(msg, b).toContain(`--${b}--`);
    }
  });

  it("carries the actual text through, decodable", () => {
    const msg = buildMimeMessage({ ...base, text: "Renewal — ₹16,200 due" });
    const b64 = msg.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    expect(decode(b64)).toContain("Renewal — ₹16,200 due");
  });

  it("defaults an attachment to application/pdf, since that is what this app sends", () => {
    const msg = buildMimeMessage({
      ...base, attachments: [{ filename: "q.pdf", content: Buffer.from("x") }],
    });
    expect(msg).toMatch(/Content-Type: application\/pdf; name="q\.pdf"/);
  });

  it("accepts a base64 string attachment as well as a Buffer", () => {
    const b64 = Buffer.from("hello").toString("base64");
    const msg = buildMimeMessage({ ...base, attachments: [{ filename: "a.txt", content: b64, contentType: "text/plain" }] });
    expect(msg).toContain(b64);
  });
});

describe("Reply-To", () => {
  it("is included when given and omitted when not", () => {
    expect(buildMimeMessage({ ...base, replyTo: "sales@anutech.in" }))
      .toMatch(/^Reply-To: sales@anutech\.in$/m);
    expect(buildMimeMessage(base)).not.toMatch(/^Reply-To:/m);
  });
});

describe("robustness", () => {
  it("does not throw on empty or odd input", () => {
    for (const input of [
      { ...base, subject: "", text: "" },
      { ...base, html: "" },
      { ...base, attachments: [] },
      { ...base, to: "", from: "" },
    ]) {
      expect(() => buildMimeMessage(input)).not.toThrow();
    }
  });

  it("is deterministic for the same input, so a retry is byte-identical", () => {
    expect(buildGmailRaw(base)).toBe(buildGmailRaw(base));
  });
});
