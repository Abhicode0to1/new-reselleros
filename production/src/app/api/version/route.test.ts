import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "./route";

/* ─────────────────────────────────────────────────────────────────────────────
   26 Aug 2026 ko bana, kyunki "deploy aa gaya?" ka jawab teen baar kahin se nahi mila
   aur ek baar mera andaza galat nikla.

   Do cheezein pinned hain, aur doosri zyada zaroori hai:
     1. jawab me SHA aata hai (warna route bemaani hai)
     2. jawab me secret NAHI aata (kyunki route public hai)
   ───────────────────────────────────────────────────────────────────────────── */

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

async function body() {
  const res = await GET();
  return { res, json: await res.json() as Record<string, unknown> };
}

describe("/api/version", () => {
  it("build ka SHA aur id lautata hai", async () => {
    process.env.BUILD_SHA = "ce7d5c5";
    process.env.BUILD_ID = "abc-123";
    const { json } = await body();
    expect(json.sha).toBe("ce7d5c5");
    expect(json.buildId).toBe("abc-123");
  });

  it("build-arg na mile to 'dev' — khaali string nahi", async () => {
    /* `sha: ""` dekhkar aadmi sochta hai kuch toota hai. `dev` ek jawab hai. */
    delete process.env.BUILD_SHA;
    delete process.env.BUILD_ID;
    const { json } = await body();
    expect(json.sha).toBe("dev");
    expect(json.buildId).toBeNull();
  });

  it("whitespace-only value ko bhi 'dev' maanta hai", async () => {
    /* Docker me `--build-arg=BUILD_SHA=` khaali ya space bhej sakta hai. */
    process.env.BUILD_SHA = "   ";
    const { json } = await body();
    expect(json.sha).toBe("dev");
  });

  it("cache nahi hone deta — stale version wahi bharam hai jise ye theek karne aaya", async () => {
    const { res } = await body();
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(res.headers.get("CDN-Cache-Control")).toMatch(/no-store/);
  });

  it("SIRF teen field — aur yahi is test ka asli kaam hai", async () => {
    /* Route public hai. Ek din kisi ko lagega "yahan tenant count bhi daal dete hain" ya
       "env dump kar dete hain, debug me kaam aayega". Ye test us din bolega.
       Naya field jodna hai to ise JAAN-BOOJHKAR badalna padega, jo poora point hai. */
    process.env.BUILD_SHA = "x";
    const { json } = await body();
    expect(Object.keys(json).sort()).toEqual(["buildId", "node", "sha"]);
  });

  it("koi secret jawab me nahi jata, chahe env me pada ho", async () => {
    /* Asli naam use kiye gaye hain — yahi wo variable hain jo Cloud Run par is service par
       set hain (cloudbuild.yaml ka comment inhe ginta hai). */
    process.env.SUPABASE_SERVICE_ROLE_KEY = "SECRET-service-role";
    process.env.CRON_SECRET = "SECRET-cron";
    process.env.RESEND_API_KEY = "SECRET-resend";
    process.env.INBOUND_EMAIL_SECRET = "SECRET-inbound";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "SECRET-google";
    process.env.VAPID_PRIVATE_KEY = "SECRET-vapid";

    const { json } = await body();
    const dump = JSON.stringify(json);
    expect(dump).not.toMatch(/SECRET-/);
  });
});

describe("build ka SHA image me pahunchta hai", () => {
  const read = (p: readonly string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

  it("cloudbuild BUILD_SHA build-arg bhejta hai", () => {
    /* Iske bina route hamesha "dev" kehta rahega — chalta hua, aur bekaar. */
    expect(read(["..", "cloudbuild.yaml"])).toContain("--build-arg=BUILD_SHA=$SHORT_SHA");
  });

  it("Dockerfile use runner stage me ENV banata hai", () => {
    const df = read(["Dockerfile"]);
    expect(df).toMatch(/ARG BUILD_SHA/);
    expect(df).toMatch(/ENV BUILD_SHA=\$BUILD_SHA/);
  });

  it("ARG `npm run build` ke BAAD hai — warna har commit cache tod deta", () => {
    /* Ye asli kharcha hai, khoobsurti nahi: SHA har commit par badalta hai. `RUN npm run
       build` se pehle rakhne par har deploy poora rebuild karta — minute se lambi baat.
       Isliye ye order ek test se baandha gaya hai, comment se nahi. */
    const df = read(["Dockerfile"]);
    expect(df.indexOf("ARG BUILD_SHA")).toBeGreaterThan(df.indexOf("RUN npm run build"));
  });

  it("BUILD_SHA ko NEXT_PUBLIC_ nahi banaya gaya", () => {
    /* NEXT_PUBLIC_ hone par ye poore client bundle me chala jata — server-only cheez ko
       browser me bhejne ka koi faayda nahi. */
    expect(read(["Dockerfile"])).not.toMatch(/NEXT_PUBLIC_BUILD_SHA/);
  });
});
