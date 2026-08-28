import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isExpiredSyncToken } from "./contacts";

/* ─────────────────────────────────────────────────────────────────────────────
   28 Aug 2026. Pardeep ne Google Contacts reconnect kiya, scope sahi aaya
   (`contacts` + `gmail.send` dono), `last_error` saaf ho gaya — aur phir bhi sync fail:

       People list failed: 400
       "Sync token is expired. Clear local cache and retry call without the sync token."
       reason: EXPIRED_SYNC_TOKEN

   Iska ilaaj code me PEHLE SE tha — `SyncTokenExpired` pakad kar poora pull dobara. Par wo
   sirf `res.status === 410` par chalta tha, aur Google ne **400** bheja. Yaani apne aap
   theek hone wala raasta ek number ki wajah se band tha, aur sync 13 din purane cursor par
   hamesha ke liye atka rehta.

   Sabse bura hissa nateeja nahi, uska CHEHRA tha: reconnect bilkul theek hua tha, par
   screen par wahi "sync nahi ho raha" — jisse lagta ki reconnect hi bekaar gaya.
   ───────────────────────────────────────────────────────────────────────────── */

/** Jo Google ne us din sach me bheja tha. */
const REAL_400 = JSON.stringify({
  error: {
    code: 400,
    message: "Sync token is expired. Clear local cache and retry call without the sync token.",
    status: "FAILED_PRECONDITION",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "EXPIRED_SYNC_TOKEN",
      domain: "people.googleapis.com",
    }],
  },
});

describe("isExpiredSyncToken", () => {
  it("400 + EXPIRED_SYNC_TOKEN ko pakadta hai — ASLI MAAMLA", () => {
    expect(isExpiredSyncToken(400, REAL_400)).toBe(true);
  });

  it("410 bhi pakadta hai — Google ka doc yahi kehta hai", () => {
    /* Purana vyavhaar hataya nahi gaya: dono me se koi bhi aa sakta hai, aur ek ko
       doosre ke liye chhod dena wahi bug hai jo ye test rok raha hai. */
    expect(isExpiredSyncToken(410, "")).toBe(true);
    expect(isExpiredSyncToken(410, "kuch aur")).toBe(true);
  });

  it("aam 400 ko NAHI pakadta", () => {
    /* Har 400 ko "cursor purana hai" maan lena bhi galat hota — tab ek asli galat request
       chup-chaap poore pull me badal jaati aur wajah kabhi saamne na aati. */
    expect(isExpiredSyncToken(400, JSON.stringify({
      error: { code: 400, message: "Invalid personFields mask path", status: "INVALID_ARGUMENT" },
    }))).toBe(false);
  });

  it("403 scope wale error ko NAHI pakadta", () => {
    /* Ye wo error hai jo permission na hone par aata hai (aaj subah 13 din se aa raha tha).
       Use cursor ka masla samajh lena asli wajah chhupa deta. */
    expect(isExpiredSyncToken(403, JSON.stringify({
      error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
    }))).toBe(false);
  });

  it("khaali body par shant rehta hai", () => {
    expect(isExpiredSyncToken(500, "")).toBe(false);
    expect(isExpiredSyncToken(200, "")).toBe(false);
  });
});

describe("sync ka recovery isi function se juda rahe", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "google", "contacts.ts"), "utf8");

  it("listConnections status ko khud nahi jaanchta", () => {
    /* Wahi galti dobara na aaye: `res.status === 410` seedha likhna hi wo bug tha. */
    expect(src).toContain("isExpiredSyncToken(res.status, body)");
    expect(src).not.toMatch(/if \(res\.status === 410\)/);
  });

  it("pakadne ke baad poora pull dobara hota hai", () => {
    /* Pakadna aadha kaam hai — uske baad cursor ke bina dobara maangna zaroori hai. */
    expect(src).toMatch(/SyncTokenExpired.*\n?.*listConnections\(accessToken, null\)/);
  });
});
