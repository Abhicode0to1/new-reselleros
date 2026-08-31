import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RESELLEROS_URL, OS_SIGNUP, ENQUIRY_API } from "./config";
import { TLDS, HOSTING_PLANS, LICENCE_EDITIONS } from "./data/catalog";

/* ─────────────────────────────────────────────────────────────────────────────
   Site ke apne niyam — jinke tootne se site jhooth bolne lagti.

   1. App ka URL sirf config.ts me. ResellerOS repo ne iski keemat chukayi hai:
      6 file me MARI HUI service ka pata tha. Ye test wahi galti is repo me bandh
      karta hai — koi component seedha run.app ka pata likhe to laal.

   2. Rate DATA me hain, component me nahi — kyunki launch se pehle Pardeep ko har
      placeholder daam badalna hai, aur wo EK file me hona chahiye.

   3. Alias/mara hua Cloud Run URL kahin na ho.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

const files = walk(SRC).filter((f) => !f.includes(".test."));
const read = (f: string) => readFileSync(f, "utf8");

describe("app ka pata — ek jagah", () => {
  it("run.app sirf config.ts me likha hai", () => {
    const offenders = files.filter((f) => !f.endsWith("config.ts") && read(f).includes("run.app"));
    expect(offenders, "in files me hardcoded Cloud Run URL hai").toEqual([]);
  });

  it("alias aur mari hui service ka URL KAHIN nahi", () => {
    /* 1005662057478 = alias (handoff isi par tha), 490252291080 = mari hui service. */
    for (const f of files) {
      const s = read(f);
      expect(s.includes("1005662057478"), `${f} me alias URL hai`).toBe(false);
      expect(s.includes("490252291080"), `${f} me mari hui service ka URL hai`).toBe(false);
    }
  });

  it("config canonical service par hai", () => {
    expect(RESELLEROS_URL).toContain("njvk4nxhdq");
    expect(OS_SIGNUP).toBe(`${RESELLEROS_URL}/signup`);
    expect(ENQUIRY_API).toContain("/api/public/enquiry/general");
  });
});

describe("rate card ki shakal", () => {
  it("har TLD par renew >= 0 aur teeno daam maujood", () => {
    for (const t of TLDS) {
      expect(t.reg, t.tld).toBeGreaterThan(0);
      expect(t.renew, t.tld).toBeGreaterThan(0);
      expect(t.transfer, t.tld).toBeGreaterThan(0);
    }
  });

  it("hosting: yearly/mo hamesha monthly se sasta (−20% ka vaada)", () => {
    for (const p of HOSTING_PLANS) {
      expect(p.yearly, p.name).toBeLessThan(p.monthly);
    }
  });

  it("licence: annual/mo hamesha monthly/mo se sasta — ulta hone par commitment ka matlab hi ulta", () => {
    for (const e of LICENCE_EDITIONS) {
      expect(e.annual, e.name).toBeLessThan(e.monthly);
    }
  });
});

describe("quote form ka enquiry contract", () => {
  it("proxy ka payload APP ke Zod schema se milta hai — app ke source se naapa", () => {
    /* Pehla version mere likhe field-naam khud se hi milata tha — aur `requirement` naam
       galat tha (app `message` kehta hai); Pardeep ke pehle asli submit par 400 aaya.
       Ab contract app ke route-source se aata hai: wahan ka schema badle to ye laal. */
    const appRoute = readFileSync(
      join(process.cwd(), "..", "production", "src", "app", "api", "public", "enquiry", "general", "route.ts"),
      "utf8",
    );
    const proxy = read(join(SRC, "app", "api", "enquiry", "route.ts"));
    for (const field of ["fullName", "companyName", "email", "phone", "product", "seats", "message"]) {
      expect(appRoute.includes(field), `app schema me ${field} nahi — contract badla?`).toBe(true);
      expect(proxy.includes(`payload.${field}`) || proxy.includes(`{ fullName`) || proxy.includes(field),
        `proxy ${field} nahi bhejta`).toBe(true);
    }
    /* message REQUIRED hai app me — proxy use hamesha bhare, khaali chhodne par 400. */
    expect(proxy).toContain("payload.message = message");
    expect(proxy).toContain("ENQUIRY_API");
  });

  it("QuoteBuilder seedha app ko nahi, /api/enquiry ko POST karta hai (CORS)", () => {
    const qb = read(join(SRC, "components", "quote", "QuoteBuilder.tsx"));
    expect(qb).toContain('fetch("/api/enquiry"');
    expect(qb.includes("run.app")).toBe(false);
  });
});
