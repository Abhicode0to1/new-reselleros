import { describe, it, expect } from "vitest";
import {
  fitWithin, shouldReencode, asPngName, shrinkLogo,
  LOGO_MAX_EDGE, LOGO_SHRINK_FLOOR_BYTES, type ShrinkDeps,
} from "./shrink-logo";

/* ─────────────────────────────────────────────────────────────────────────────
   Naapa gaya 31 Aug 2026: ANUTECH ka logo 940 KB ka PNG hai, aur uske saath har quote ka
   PDF 938,046 byte ka banta tha — bina logo ke wahi PDF 4,540 byte ka. Yaani har quote email
   me ek megabyte, sirf ek 36pt oonche header ke liye.

   Doosri baat isse bhi zyada chupi hui thi: upload route webp aur svg dono leta hai, aur PDF
   renderer sirf PNG/JPEG banata hai. To jo tenant SVG upload karta, uska logo document par
   KABHI nahi aata — aur screen par kahin ye likha bhi nahi hota. Canvas se dobara PNG banane
   par wo bhi theek ho jata hai.

   Canvas jsdom me nahi hai, isliye dono browser kadam (`decode`/`encode`) inject hote hain.
   Faisla lene wala poora hissa yahan asli me chalta hai — sirf pixel kheenchna nakli hai.
   ───────────────────────────────────────────────────────────────────────────── */

const file = (name: string, type: string, size: number) =>
  ({ name, type, size } as File);

/** decode/encode ka nakli joda — encode kitne pixel maanga gaya, wo yaad rakhta hai. */
function deps(w: number, h: number, outBytes: number) {
  const seen: { width: number; height: number }[] = [];
  const d: ShrinkDeps = {
    decode: async () => ({ width: w, height: h, source: {} as CanvasImageSource }),
    encode: async (_s, width, height) => {
      seen.push({ width, height });
      /* ASLI Blob, nakli nahi. `{ size: n } as Blob` se `new File([blob])` uske content ko
         string bana kar 15 byte gin leta tha — yaani test File banane ko jaanch raha tha,
         mere code ko nahi. */
      return new Blob([new Uint8Array(outBytes)]);
    },
  };
  return { d, seen };
}

describe("fitWithin — aakar ghatana, badhana nahi", () => {
  it("bada logo lambi bhuja par 512 par aa jata hai", () => {
    expect(fitWithin(2048, 1024)).toEqual({ width: 512, height: 256 });
    expect(fitWithin(1024, 2048)).toEqual({ width: 256, height: 512 });
  });

  it("chhota logo waisa ka waisa — kabhi BADA nahi hota", () => {
    /* Upscale karna file bhi badhata hai aur dikhne me bhi kharab — dono se bachna hai. */
    expect(fitWithin(120, 60)).toEqual({ width: 120, height: 60 });
  });

  it("bahut patli patti par bhi kam se kam 1px — canvas 0 nahi leta", () => {
    const out = fitWithin(4000, 3);
    expect(out.width).toBe(LOGO_MAX_EDGE);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it("bekaar aakar par 0 — aur shrinkLogo use chhod deta hai", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("shouldReencode — teen alag wajah, teeno asli", () => {
  it("svg aur webp hamesha — chahe kitne bhi chhote hon", () => {
    /* YAHI wo surat hai jo aaj chup-chaap tooti hui hai: renderer inhe bana hi nahi sakta. */
    expect(shouldReencode("image/svg+xml", 900, 64)).toBe(true);
    expect(shouldReencode("image/webp", 900, 64)).toBe(true);
  });

  it("zaroorat se zyada pixel — chhoti file par bhi", () => {
    expect(shouldReencode("image/png", 5_000, LOGO_MAX_EDGE + 1)).toBe(true);
  });

  it("sahi aakar par bhaari file — 940 KB wala asli maamla", () => {
    expect(shouldReencode("image/png", 940_000, 400)).toBe(true);
  });

  it("pehle se chhota PNG — haath hi mat lagao", () => {
    expect(shouldReencode("image/png", LOGO_SHRINK_FLOOR_BYTES - 1, 400)).toBe(false);
    expect(shouldReencode("image/jpeg", 20_000, 300)).toBe(false);
  });
});

describe("asPngName", () => {
  it("extension badalta hai, naam nahi", () => {
    expect(asPngName("ChatGPT_Image.png")).toBe("ChatGPT_Image.png");
    expect(asPngName("brand.svg")).toBe("brand.png");
    expect(asPngName("logo")).toBe("logo.png");
  });
});

describe("shrinkLogo", () => {
  it("940 KB ka asli logo chhota ho kar PNG banta hai", async () => {
    const { d, seen } = deps(1536, 1024, 42_000);
    const out = await shrinkLogo(file("logo.png", "image/png", 940_000), d);
    expect(out.size).toBe(42_000);
    expect(out.type).toBe("image/png");
    expect(seen).toEqual([{ width: 512, height: 341 }]);
  });

  it("SVG PNG ban jata hai — chahe file BADI ho jaye", async () => {
    /* Ye jaan-boojh kar hai. SVG raster se lagbhag hamesha chhota hota hai, par renderer use
       bana hi nahi sakta — to bada-magar-dikhne-wala jeetta hai. */
    const { d } = deps(300, 300, 90_000);
    const out = await shrinkLogo(file("brand.svg", "image/svg+xml", 4_000), d);
    expect(out.type).toBe("image/png");
    expect(out.name).toBe("brand.png");
  });

  it("PNG agar bada ho jaye to purana hi rakha jata hai", async () => {
    const { d } = deps(1000, 1000, 300_000);
    const orig = file("logo.png", "image/png", 200_000);
    expect(await shrinkLogo(orig, d)).toBe(orig);
  });

  it("pehle se chhoti file ko chhua tak nahi jata", async () => {
    let encoded = false;
    const d: ShrinkDeps = {
      decode: async () => ({ width: 200, height: 100, source: {} as CanvasImageSource }),
      encode: async () => { encoded = true; return new Blob([new Uint8Array(1)]); },
    };
    const orig = file("small.png", "image/png", 12_000);
    expect(await shrinkLogo(orig, d)).toBe(orig);
    expect(encoded, "chhoti file par encode chalna hi nahi chahiye").toBe(false);
  });

  it("decode fail ho jaye to UPLOAD PHIR BHI CHALTA HAI", async () => {
    /* Sabse zaroori jaanch. Logo chhota karna ek sahulat hai, shart nahi — agar ye phenk de
       to owner apna logo hi nahi badal payega. */
    const d: ShrinkDeps = {
      decode: async () => { throw new Error("browser cannot decode this"); },
      encode: async () => new Blob([new Uint8Array(1)]),
    };
    const orig = file("weird.png", "image/png", 900_000);
    await expect(shrinkLogo(orig, d)).resolves.toBe(orig);
  });

  it("encode fail ho jaye to bhi wahi", async () => {
    const d: ShrinkDeps = {
      decode: async () => ({ width: 2000, height: 2000, source: {} as CanvasImageSource }),
      encode: async () => { throw new Error("toBlob returned null"); },
    };
    const orig = file("big.png", "image/png", 900_000);
    await expect(shrinkLogo(orig, d)).resolves.toBe(orig);
  });
});
