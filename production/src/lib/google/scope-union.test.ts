import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  unionScopes, scopesLost, scopeLossMessage, CONTACTS_SCOPE, GMAIL_SEND_SCOPE,
} from "./scope-union";

/* ─────────────────────────────────────────────────────────────────────────────
   26 Aug 2026. Pardeep ka Google Contacts sync 11 din chup-chaap band tha, aur wo screen
   par kahin nahi dikha — pakda tab gaya jab `user_google_tokens.last_error` padhi gayi
   aur usme People API ka 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT nikla.

   Wajah: Contacts aur Gmail ek hi row likhte hain, aur Gmail consent ne contacts grant
   dhak diya. `include_granted_scopes: "true"` guard PEHLE SE maujood tha (08 Aug), Gmail
   flow uske baad bana (13 Aug) — phir bhi hua, kyunki wo flag Google se UMEED hai, aur
   consent screen par checkbox untick ho sakta hai.

   Neeche ke test asli naap par baithe hain — 15 Aug ko sync chal raha tha, aur ab jo
   scopes DB me hain wo bilkul ye hain.
   ───────────────────────────────────────────────────────────────────────────── */

/** Jo aaj Pardeep ke row me hai — send-only. */
const SEND_ONLY = `openid email ${GMAIL_SEND_SCOPE}`;
/** Jo 08–15 Aug ke beech tha, jab sync chal raha tha. */
const CONTACTS_ONLY = `openid email ${CONTACTS_SCOPE}`;

describe("unionScopes — jo mila hua hai wo maango bhi", () => {
  it("Gmail connect karte waqt contacts bhi maangta hai — ASLI MAAMLA", () => {
    const asked = unionScopes(SEND_ONLY, CONTACTS_ONLY);
    expect(asked).toContain(GMAIL_SEND_SCOPE);
    expect(asked).toContain(CONTACTS_SCOPE);
  });

  it("ulti disha me bhi — Contacts dobara connect karna bhejna na tode", () => {
    const asked = unionScopes(CONTACTS_ONLY, SEND_ONLY);
    expect(asked).toContain(CONTACTS_SCOPE);
    expect(asked).toContain(GMAIL_SEND_SCOPE);
  });

  it("dohrata nahi", () => {
    const asked = unionScopes(SEND_ONLY, SEND_ONLY);
    expect(asked.split(/\s+/).filter((s) => s === GMAIL_SEND_SCOPE)).toHaveLength(1);
    expect(asked.split(/\s+/).length).toBe(3);
  });

  it("pehli baar connect — kuch pehle se nahi, to jo maanga wahi", () => {
    expect(unionScopes(SEND_ONLY, null)).toBe(SEND_ONLY);
    expect(unionScopes(SEND_ONLY, "")).toBe(SEND_ONLY);
    expect(unionScopes(SEND_ONLY, undefined)).toBe(SEND_ONLY);
  });

  it("kram sthir rakhta hai", () => {
    /* Ye value DB me likhi jaati hai. Badalta kram har reconnect par ek jhootha "badal
       gaya" dikhata, aur diff padhne wale ka waqt khata. */
    expect(unionScopes(SEND_ONLY, CONTACTS_ONLY)).toBe(unionScopes(SEND_ONLY, CONTACTS_ONLY));
    expect(unionScopes(SEND_ONLY, CONTACTS_ONLY).startsWith("openid email")).toBe(true);
  });

  it("bikhri hui whitespace par bhi tootta nahi", () => {
    expect(unionScopes("  a   b ", " b  c ")).toBe("a b c");
  });
});

describe("scopesLost — chup-chaap gaya hua grant pakdo", () => {
  it("contacts ka gir jana pakadta hai — YAHI 11 din chhupa raha", () => {
    expect(scopesLost(CONTACTS_ONLY, SEND_ONLY)).toEqual([CONTACTS_SCOPE]);
  });

  it("ulta nuksaan bhi pakadta hai", () => {
    expect(scopesLost(SEND_ONLY, CONTACTS_ONLY)).toEqual([GMAIL_SEND_SCOPE]);
  });

  it("union bacha ho to kuch nahi khoya", () => {
    const both = unionScopes(SEND_ONLY, CONTACTS_ONLY);
    expect(scopesLost(CONTACTS_ONLY, both)).toEqual([]);
    expect(scopesLost(both, both)).toEqual([]);
  });

  it("pehli baar connect par kuch khoya hua nahi hai", () => {
    expect(scopesLost(null, SEND_ONLY)).toEqual([]);
    expect(scopesLost("", SEND_ONLY)).toEqual([]);
  });

  it("openid/email ke aane-jaane par shor nahi machata", () => {
    /* Sirf wo do scope dekhi jaati hain jinse feature chalta hai. `openid` gir jane par
       koi integration nahi tootta, aur us par chetavni dena ek asli chetavni ko shor me
       dabana hota. */
    expect(scopesLost(`openid email ${GMAIL_SEND_SCOPE}`, GMAIL_SEND_SCOPE)).toEqual([]);
  });

  it("naya token khaali aaye to bhi nuksaan bata deta hai", () => {
    expect(scopesLost(CONTACTS_ONLY, null)).toEqual([CONTACTS_SCOPE]);
  });
});

describe("scopeLossMessage — §24: kya hua, kyun, ab kya", () => {
  it("kuch nahi khoya to null — koi jhoothi chetavni nahi", () => {
    expect(scopeLossMessage([])).toBeNull();
  });

  it("naam leta hai, wajah deta hai, aur agla kadam batata hai", () => {
    const m = scopeLossMessage([CONTACTS_SCOPE]) ?? "";
    expect(m).toMatch(/Contacts/);
    expect(m).toMatch(/untick/i);          // kyun hua
    expect(m).toMatch(/[Dd]obara connect/); // ab kya karein
  });

  it("dono khoye ho to dono ka naam", () => {
    const m = scopeLossMessage([CONTACTS_SCOPE, GMAIL_SEND_SCOPE]) ?? "";
    expect(m).toMatch(/Contacts/);
    expect(m).toMatch(/Gmail/);
  });
});

/* ══ Routes is bachaav se jude rahein ════════════════════════════════════════ */
describe("connect aur callback isi function se guzarte hain", () => {
  const read = (p: readonly string[]) =>
    readFileSync(join(process.cwd(), ...p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("dono connect route union maangte hain", () => {
    /* Ek taraf lagana aadha kaam hai: phir Contacts dobara connect karna Gmail ko tod
       dega — wahi bug, doosri disha me. */
    for (const p of [
      ["src", "app", "api", "integrations", "google-gmail", "connect", "route.ts"],
      ["src", "app", "api", "integrations", "google-contacts", "connect", "route.ts"],
    ]) {
      expect(read(p), p.join("/")).toContain("unionScopes(");
    }
  });

  it("purani scopes ADMIN client se padhi jaati hain — user client se nahi", () => {
    /* Ye test pehli koshish ke fail hone ke baad juda, aur wo fail chup-chaap thi.
       Maine ye query pehle user client (`supabase`) se likhi thi. Naapa gaya 26 Aug 2026:

           user_google_tokens → RLS ON, policies 0

       Zero policy ke saath user client us table se KUCH nahi padh sakta, aur khaali lautata
       hai — error nahi. To `prior.scopes` hamesha khaali, union hamesha no-op, aur route
       "chalta hua" dikhta rahega jabki wo apne hi maqsad ke ulat kaam karega: consent grant
       sankuchit kar dega.

       Browser me pakda gaya, test se nahi — contacts connect ka scope param me `contacts`
       tha aur `gmail.send` nadarad. Isliye ab ye source par pinned hai.

       `.eq("user_id", user.id)` hi suraksha hai (admin ke saath RLS nahi hota), aur wo
       neeche wale assert me shamil hai. */
    for (const p of [
      ["src", "app", "api", "integrations", "google-gmail", "connect", "route.ts"],
      ["src", "app", "api", "integrations", "google-contacts", "connect", "route.ts"],
    ]) {
      const src = read(p);
      expect(src, p.join("/")).toMatch(
        /createAdminClient\(\)\s*\n?\s*\.from\("user_google_tokens"\)/,
      );
      /* Bina is filter ke admin read kisi bhi user ki row de sakta hai. */
      expect(src, p.join("/")).toContain('.eq("user_id", user.id)');
    }
  });

  it("gmail callback nuksaan ko DB me likhta hai, chup nahi rehta", () => {
    const cb = read(["src", "app", "api", "integrations", "google-gmail", "callback", "route.ts"]);
    expect(cb).toContain("scopesLost(");
    /* `last_error: null` wapas aana matlab nuksaan phir chup ho gaya — 11 din wala haal. */
    expect(cb).toContain("last_error: lossNote");
    expect(cb).not.toContain("last_error: null");
  });
});
