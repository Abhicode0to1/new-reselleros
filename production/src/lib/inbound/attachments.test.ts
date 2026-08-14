import { describe, it, expect } from "vitest";
import {
  extractAttachments,
  pickBillAttachment,
  isReadableAttachment,
  mimeFromFilename,
  MAX_ATTACHMENT_BYTES,
} from "./attachments";

const B64 = "JVBERi0xLjQKJeLjz9M=";   // a tiny "%PDF-1.4" header, base64

describe("extractAttachments — one shape per provider", () => {
  it("reads Postmark's Attachments[]", () => {
    const got = extractAttachments({
      Attachments: [{ Name: "invoice.pdf", Content: B64, ContentType: "application/pdf", ContentLength: 1234 }],
    });
    expect(got).toEqual([
      { filename: "invoice.pdf", mimeType: "application/pdf", base64: B64, url: null, size: 1234 },
    ]);
  });

  it("reads Mailgun's attachments[] — a URL, not bytes", () => {
    const got = extractAttachments({
      attachments: [{ url: "https://api.mailgun.net/v3/domains/x/messages/y/attachments/0", name: "bill.pdf", "content-type": "application/pdf", size: 900 }],
    });
    expect(got[0].url).toContain("mailgun");
    // The module must NOT fetch. Bytes stay null and the caller decides.
    expect(got[0].base64).toBeNull();
  });

  it("reads a generic filename/content/contentType shape", () => {
    const got = extractAttachments({
      attachments: [{ filename: "bill.pdf", content: B64, contentType: "application/pdf" }],
    });
    expect(got[0].filename).toBe("bill.pdf");
    expect(got[0].base64).toBe(B64);
  });

  it("strips a data: URI prefix", () => {
    // Passing a full data URI to Gemini as raw base64 fails with an unhelpful error.
    const got = extractAttachments({
      attachments: [{ filename: "b.pdf", content: `data:application/pdf;base64,${B64}`, contentType: "application/pdf" }],
    });
    expect(got[0].base64).toBe(B64);
  });

  it("falls back to the filename when the provider omits a mime type", () => {
    const got = extractAttachments({ attachments: [{ filename: "scan.PDF", content: B64 }] });
    expect(got[0].mimeType).toBe("application/pdf");
  });

  it("skips entries with neither bytes nor a URL", () => {
    const got = extractAttachments({
      attachments: [{ filename: "empty.pdf", contentType: "application/pdf" }, { filename: "ok.pdf", content: B64, contentType: "application/pdf" }],
    });
    expect(got).toHaveLength(1);
    expect(got[0].filename).toBe("ok.pdf");
  });

  it("returns [] for a payload with no attachments, and does not throw on junk", () => {
    expect(extractAttachments({})).toEqual([]);
    expect(extractAttachments({ attachments: "not-an-array" })).toEqual([]);
    expect(extractAttachments({ attachments: [null, 42, "x"] })).toEqual([]);
  });
});

describe("isReadableAttachment / mimeFromFilename", () => {
  it("accepts what Gemini can actually read", () => {
    for (const m of ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"]) {
      expect(isReadableAttachment(m)).toBe(true);
    }
  });
  it("rejects everything else", () => {
    for (const m of ["text/calendar", "application/zip", "message/rfc822", "", null]) {
      expect(isReadableAttachment(m)).toBe(false);
    }
  });
  it("maps extensions, case-insensitively", () => {
    expect(mimeFromFilename("a.PDF")).toBe("application/pdf");
    expect(mimeFromFilename("a.jpeg")).toBe("image/jpeg");
    expect(mimeFromFilename("a.docx")).toBe("");
    expect(mimeFromFilename(null)).toBe("");
  });
});

describe("pickBillAttachment — choosing the bill, not the logo", () => {
  const pdf   = { filename: "invoice.pdf", mimeType: "application/pdf", base64: B64, url: null, size: 5000 };
  const logo  = { filename: "logo.png",    mimeType: "image/png",       base64: B64, url: null, size: 900 };
  const ics   = { filename: "cal.ics",     mimeType: "text/calendar",   base64: B64, url: null, size: 100 };

  it("prefers the PDF even when an image comes first", () => {
    // Vendors routinely attach a signature or logo image alongside the invoice.
    // "First attachment" would read the logo and produce a nonsense bill.
    expect(pickBillAttachment([logo, pdf])?.filename).toBe("invoice.pdf");
  });

  it("falls back to an image when there is no PDF", () => {
    expect(pickBillAttachment([logo])?.filename).toBe("logo.png");
  });

  it("ignores types Gemini cannot read", () => {
    expect(pickBillAttachment([ics])).toBeNull();
  });

  it("refuses anything over the size cap rather than uploading it first", () => {
    const huge = { ...pdf, size: MAX_ATTACHMENT_BYTES + 1 };
    expect(pickBillAttachment([huge])).toBeNull();
    expect(pickBillAttachment([huge, logo])?.filename).toBe("logo.png");
  });

  it("allows an attachment whose size the provider did not report", () => {
    expect(pickBillAttachment([{ ...pdf, size: null }])?.filename).toBe("invoice.pdf");
  });

  it("returns null for an empty list", () => {
    expect(pickBillAttachment([])).toBeNull();
  });
});
