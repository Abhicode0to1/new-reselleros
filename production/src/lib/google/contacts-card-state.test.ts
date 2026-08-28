import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contactsCardState, canSyncWithScopes, RECONSENT_FALLBACK_REASON,
  type ContactsStatus,
} from "./contacts-card-state";
import { CONTACTS_SCOPE, GMAIL_SEND_SCOPE, CONTACTS_SCOPE_MISSING_MESSAGE } from "./scope-union";

/* ─────────────────────────────────────────────────────────────────────────────
   28 Aug 2026. Ye file ek MUTATION KE GREEN REHNE se bani.

   Card ka faisla page me inline tha aur uska test source par grep karta tha. Maine
   `needsReconsent` ko `false` kar diya — poora feature mar gaya — aur 30 me se 30 test
   green rahe. Grep source ko pin karta hai, vyavhaar ko nahi.

   Neeche ke test asli payload par baithe hain, us row se banaye gaye jo us din DB me thi.
   ───────────────────────────────────────────────────────────────────────────── */

/** Jo 28 Aug 13:03 par asli haalat thi: token hai, contacts scope nahi. */
const AFTER_BROKEN_RECONNECT: ContactsStatus = {
  configured: true,
  connected: true,
  can_sync: false,
  email: "sales@anutech.in",
  last_synced_at: "2026-08-15T12:30:00.000Z",
  last_error: CONTACTS_SCOPE_MISSING_MESSAGE,
};

describe("contactsCardState — bina permission wale token ko 'ready' nahi kehta", () => {
  it("ASLI MAAMLA: token hai, sync nahi ho sakta → needs_reconsent", () => {
    const s = contactsCardState(AFTER_BROKEN_RECONNECT);
    expect(s.kind).toBe("needs_reconsent");
  });

  it("us haalat me wajah dikhati hai, email/last-sync nahi", () => {
    /* Purana card "sales@anutech.in · synced 15 Aug" dikhata tha — sach, aur bekaar.
       Us line ki jagah wahi hai jahan agla kadam likha ho (§24). */
    const s = contactsCardState(AFTER_BROKEN_RECONNECT);
    if (s.kind !== "needs_reconsent") throw new Error("galat kind");
    expect(s.reason).toBe(CONTACTS_SCOPE_MISSING_MESSAGE);
    expect(s).not.toHaveProperty("email");
    expect(s).not.toHaveProperty("lastSyncedAt");
  });

  it("server ne wajah na bheji ho to bhi dead-end nahi — fallback me agla kadam hai", () => {
    const s = contactsCardState({ ...AFTER_BROKEN_RECONNECT, last_error: null });
    if (s.kind !== "needs_reconsent") throw new Error("galat kind");
    expect(s.reason).toBe(RECONSENT_FALLBACK_REASON);
    expect(s.reason).toMatch(/[Rr]econnect/);
  });

  it("sab theek ho to ready, email aur last-sync ke saath", () => {
    const s = contactsCardState({ ...AFTER_BROKEN_RECONNECT, can_sync: true });
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") throw new Error("galat kind");
    expect(s.email).toBe("sales@anutech.in");
    expect(s.lastSyncedAt).toBe("2026-08-15T12:30:00.000Z");
  });

  it("juda hi nahi → disconnected", () => {
    expect(contactsCardState({ configured: true, connected: false }).kind).toBe("disconnected");
    /* can_sync true aa jaye par connected false ho to bhi disconnected — kram maayne
       rakhta hai, warna ek adhoori row "ready" ban jaati. */
    expect(contactsCardState({ configured: true, connected: false, can_sync: true }).kind)
      .toBe("disconnected");
  });

  it("OAuth keys nahi → unconfigured, aur connected hone par bhi wahi", () => {
    expect(contactsCardState({ configured: false, connected: true, can_sync: true }).kind)
      .toBe("unconfigured");
    expect(contactsCardState(null).kind).toBe("unconfigured");
    expect(contactsCardState(undefined).kind).toBe("unconfigured");
    expect(contactsCardState({}).kind).toBe("unconfigured");
  });

  it("can_sync gayab ho to 'ready' NAHI maanta — chup-chaap haan sabse bura jawab hai", () => {
    /* Purana server naya UI ke saath (deploy ke beech me), ya field ka naam badal jaye:
       dono me `can_sync` undefined aata hai. Us waqt "ready" maan lena theek wahi bug
       dobara khol dega. */
    const s = contactsCardState({ configured: true, connected: true, email: "x@y.in" });
    expect(s.kind).toBe("needs_reconsent");
  });
});

describe("canSyncWithScopes — server aur UI ek hi tarah tay karein", () => {
  it("28 Aug ka asli scope string false deta hai", () => {
    expect(canSyncWithScopes("rt", `openid email ${GMAIL_SEND_SCOPE}`)).toBe(false);
  });

  it("contacts ho to true", () => {
    expect(canSyncWithScopes("rt", `openid email ${CONTACTS_SCOPE}`)).toBe(true);
  });

  it("refresh token ke bina scope bekaar hai", () => {
    /* Access token ek ghante me mar jata hai; bina refresh token cron kabhi nahi chalega.
       "Kaam hoga" ka matlab kal bhi kaam hoga. */
    expect(canSyncWithScopes(null, `openid email ${CONTACTS_SCOPE}`)).toBe(false);
    expect(canSyncWithScopes("", `openid email ${CONTACTS_SCOPE}`)).toBe(false);
  });
});

describe("card is function se juda rahe", () => {
  it("settings page faisla khud nahi karta", () => {
    /* Ye grep hai, aur grep ki seema upar likhi hai — par ek cheez ye pakka karta hai:
       faisla wapas page me inline na chala jaye, jahan uska test nahi ban sakta. */
    const src = readFileSync(join(process.cwd(), "src", "app", "(app)", "settings", "page.tsx"), "utf8");
    expect(src).toContain("contactsCardState(status)");
    /* Purani inline shakl wapas na aaye. */
    expect(src).not.toContain("const canSync = Boolean(status?.can_sync)");
  });
});
