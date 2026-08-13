import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyMetaSignature, signatureRefusalReason } from "./webhook-signature";

const SECRET = "meta_app_secret_abc123";
const BODY = JSON.stringify({ entry: [{ id: "123", changes: [{ field: "messages" }] }] });
const sign = (body: string, secret: string) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("verifyMetaSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyMetaSignature(BODY, sign(BODY, SECRET), SECRET)).toEqual({ ok: true });
  });

  // ── The defect this was written for ──────────────────────────────────────
  it("REFUSES when no app secret is configured", () => {
    // Production has no whatsapp_app_secret, and the old route skipped the check
    // entirely in that case — so anyone with the URL and a tenant id could inject
    // inbound messages. Nothing verifiable means nothing trusted.
    for (const secret of [undefined, null, "", "   "]) {
      expect(verifyMetaSignature(BODY, sign(BODY, SECRET), secret)).toEqual({ ok: false, reason: "not_configured" });
    }
  });

  it("refuses a request with no signature header", () => {
    for (const header of [undefined, null, "", "  "]) {
      expect(verifyMetaSignature(BODY, header, SECRET)).toEqual({ ok: false, reason: "missing_header" });
    }
  });

  it("refuses a signature made with the wrong secret", () => {
    expect(verifyMetaSignature(BODY, sign(BODY, "wrong_secret"), SECRET)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses when the body was altered after signing", () => {
    // The whole point of the HMAC: the signature must cover the payload.
    const tampered = JSON.stringify({ entry: [{ id: "999", changes: [{ field: "messages" }] }] });
    expect(verifyMetaSignature(tampered, sign(BODY, SECRET), SECRET)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a signature of the right shape but wrong value", () => {
    expect(verifyMetaSignature(BODY, "sha256=" + "a".repeat(64), SECRET)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a bare hex digest with no sha256= prefix", () => {
    const bare = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(verifyMetaSignature(BODY, bare, SECRET)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("never throws on hostile header input", () => {
    for (const header of ["sha256=", "sha256", "🙂", "sha256=" + "z".repeat(200), "\0\0"]) {
      expect(() => verifyMetaSignature(BODY, header, SECRET)).not.toThrow();
      expect(verifyMetaSignature(BODY, header, SECRET).ok).toBe(false);
    }
  });

  it("is sensitive to whitespace in the body — the RAW bytes must be passed", () => {
    // Re-serialising parsed JSON changes spacing and key order and will never
    // match, which is why the route signs over the raw request text.
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyMetaSignature(reserialised, sign(BODY, SECRET), SECRET).ok).toBe(false);
  });

  it("tolerates surrounding whitespace on the header itself", () => {
    expect(verifyMetaSignature(BODY, `  ${sign(BODY, SECRET)}  `, SECRET)).toEqual({ ok: true });
  });
});

describe("signatureRefusalReason", () => {
  it("explains each refusal in operator language", () => {
    expect(signatureRefusalReason("not_configured")).toContain("no app secret");
    expect(signatureRefusalReason("missing_header")).toContain("x-hub-signature-256");
    expect(signatureRefusalReason("mismatch")).toContain("did not match");
  });

  it("says WHY not-configured is a refusal and not a pass", () => {
    // The line someone will read when they wonder why their webhook 401s.
    expect(signatureRefusalReason("not_configured")).toContain("unauthenticated write access");
  });
});
