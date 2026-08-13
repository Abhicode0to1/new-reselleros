import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { decryptTenantSecrets, sealTenantSecrets, SECRET_COLUMNS } from "./tenant-secrets";
import { encryptSecret, isEncrypted } from "./vault";

const KEY = crypto.randomBytes(32).toString("base64");
let original: string | undefined;
beforeEach(() => { original = process.env.SECRETS_MASTER_KEY; process.env.SECRETS_MASTER_KEY = KEY; });
afterEach(() => { if (original === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = original; });

describe("decryptTenantSecrets", () => {
  it("opens every credential field", () => {
    const row = { tenant_id: "t1", razorpay_key_secret: encryptSecret("rzp_secret"), gemini_api_key: encryptSecret("AQ.key") };
    expect(decryptTenantSecrets(row)).toMatchObject({ razorpay_key_secret: "rzp_secret", gemini_api_key: "AQ.key" });
  });

  it("leaves configuration fields alone", () => {
    // Decrypting everything would try to open razorpay_mode and gemini_model.
    const row = { razorpay_mode: "test", gemini_model: "gemini-2.5-flash", razorpay_key_id: "rzp_test_abc" };
    expect(decryptTenantSecrets(row)).toEqual(row);
  });

  it("passes legacy plaintext through", () => {
    const row = { razorpay_key_secret: "plain_secret", gemini_api_key: "AQ.plain" };
    expect(decryptTenantSecrets(row)).toEqual(row);
  });

  it("handles a mixed row — some encrypted, some not", () => {
    // Exactly the state during migration: one secret re-saved, others not yet.
    const row = { razorpay_key_secret: encryptSecret("sealed"), gemini_api_key: "still_plain" };
    expect(decryptTenantSecrets(row)).toEqual({ razorpay_key_secret: "sealed", gemini_api_key: "still_plain" });
  });

  it("returns null for a missing row", () => {
    expect(decryptTenantSecrets(null)).toBeNull();
    expect(decryptTenantSecrets(undefined)).toBeNull();
  });

  it("leaves null and empty fields as they are", () => {
    const row = { razorpay_key_secret: null, gemini_api_key: "" };
    expect(decryptTenantSecrets(row)).toEqual(row);
  });
});

describe("sealTenantSecrets", () => {
  it("encrypts credential fields and leaves config alone", () => {
    const { row, storedInClear } = sealTenantSecrets({
      razorpay_key_id: "rzp_test_abc", razorpay_key_secret: "s3cret", razorpay_mode: "test",
    });
    expect(storedInClear).toEqual([]);
    expect(row.razorpay_key_id).toBe("rzp_test_abc");
    expect(row.razorpay_mode).toBe("test");
    expect(isEncrypted(row.razorpay_key_secret as string)).toBe(true);
  });

  it("does not double-wrap an already-encrypted value", () => {
    // Re-saving a form that echoes back a stored value must be a no-op.
    const already = encryptSecret("s3cret");
    const { row } = sealTenantSecrets({ razorpay_key_secret: already });
    expect(row.razorpay_key_secret).toBe(already);
  });

  it("REPORTS fields it had to store in the clear", () => {
    // Storing a secret unencrypted must never look identical to sealing it.
    delete process.env.SECRETS_MASTER_KEY;
    const { row, storedInClear } = sealTenantSecrets({ razorpay_key_secret: "s3cret", razorpay_mode: "test" });
    expect(storedInClear).toEqual(["razorpay_key_secret"]);
    expect(row.razorpay_key_secret).toBe("s3cret");
  });

  it("skips empty values", () => {
    const { row, storedInClear } = sealTenantSecrets({ razorpay_key_secret: "", gemini_api_key: null });
    expect(storedInClear).toEqual([]);
    expect(row).toEqual({ razorpay_key_secret: "", gemini_api_key: null });
  });

  it("round-trips through seal then decrypt", () => {
    const { row } = sealTenantSecrets({ whatsapp_app_secret: "meta_app_secret", whatsapp_verify_token: "tok" });
    expect(decryptTenantSecrets(row)).toEqual({ whatsapp_app_secret: "meta_app_secret", whatsapp_verify_token: "tok" });
  });

  it("covers every credential column the app stores", () => {
    // A credential missing from SECRET_COLUMNS is stored in the clear while
    // everything looks normal — the exact state the vault exists to end.
    for (const col of SECRET_COLUMNS) {
      const { row } = sealTenantSecrets({ [col]: "value-" + col });
      expect(isEncrypted(row[col] as string), `${col} was not sealed`).toBe(true);
    }
  });
});
