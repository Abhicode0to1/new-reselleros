import { describe, it, expect } from "vitest";
import {
  logoMimeFromBytes, toBase64, logoDataUri, isRenderableLogo,
  LOGO_MAX_BYTES,
} from "./logo";

/* ─────────────────────────────────────────────────────────────────────────────
   Logo ka har GALAT roop yahan jaancha jata hai, kyunki har ek asli me ho sakta hai aur har
   ek ka nateeja EK hi hona chahiye — "logo nahi mila", exception nahi.

   Wajah: quote PDF `sendAutoQuote` ke andar bante hain, jo inbound-mail ke raaste par chalta
   hai. `<Image>` ke andar phenka gaya error poora quote rok deta — aur customer ko lagta ki
   app ne jawab hi nahi diya.

   Sabse asli khatra type ka hai: `api/settings/logo/route.ts:18` **webp aur svg** dono le
   leta hai, aur renderer sirf PNG/JPEG samajhta hai. Yaani aaj bhi koi tenant SVG upload kar
   sakta hai. Isliye jaanch server ke bataye Content-Type se nahi, ASLI BYTES se hoti hai.
   ───────────────────────────────────────────────────────────────────────────── */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
/* "<svg" — ek asli SVG ki shuruaat. Yahi wo file hai jo renderer ke andar phategi. */
const SVG = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20]);

function res(bytes: Uint8Array, init: { status?: number; length?: string | null } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    headers: { get: (k: string) => (k === "content-length" ? init.length ?? String(bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe("bytes se pehchan — Content-Type par bharosa nahi", () => {
  it("PNG aur JPEG pehchan me aate hain", () => {
    expect(logoMimeFromBytes(PNG)).toBe("image/png");
    expect(logoMimeFromBytes(JPEG)).toBe("image/jpeg");
  });

  it("SVG mana kar diya jata hai — YAHI WO SURAT HAI", () => {
    /* Upload route SVG lene deta hai. Agar ye null na de, to us tenant ka har quote
       renderer ke andar phat jayega, aur error 'image' ki baat karega, logo ki nahi. */
    expect(logoMimeFromBytes(SVG)).toBeNull();
  });

  it("chhoti/khaali file par bhi null — koi index error nahi", () => {
    expect(logoMimeFromBytes(new Uint8Array([]))).toBeNull();
    expect(logoMimeFromBytes(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("base64 bade logo par bhi tootta nahi", () => {
  it("100 KB se bada data RangeError nahi deta", () => {
    /* `String.fromCharCode(...bytes)` yahi par phatta hai — argument limit. Isliye chunk me
       hota hai, aur ye jaanch us chunking ko pakde rakhti hai. */
    const big = new Uint8Array(200_000).fill(65);
    const b64 = toBase64(big);
    expect(b64.length).toBeGreaterThan(200_000);
  });

  it("wahi nateeja jo Buffer deta hai", () => {
    expect(toBase64(PNG)).toBe(Buffer.from(PNG).toString("base64"));
  });
});

describe("logoDataUri — har galti ka ek hi jawab: null", () => {
  const fetchOf = (r: Response | Error) => (async () => {
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;

  it("PNG par data URI banta hai", async () => {
    const out = await logoDataUri("https://cdn.x/logo.png", fetchOf(res(PNG)));
    expect(out).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });

  it("SVG par null — bytes dekh kar, header dekh kar nahi", async () => {
    expect(await logoDataUri("https://cdn.x/logo.png", fetchOf(res(SVG)))).toBeNull();
  });

  it("404 par null", async () => {
    expect(await logoDataUri("https://cdn.x/gone.png", fetchOf(res(PNG, { status: 404 })))).toBeNull();
  });

  it("network gir jaye to null — exception bahar nahi jata", async () => {
    /* Yahi asli baat hai: ye function kabhi throw nahi karta. Agar kare, to quote nahi
       jayega. */
    const out = await logoDataUri("https://cdn.x/logo.png", fetchOf(new Error("ETIMEDOUT")));
    expect(out).toBeNull();
  });

  it("bada file mana — header se, aur header jhooth bole to bytes se", async () => {
    const declared = await logoDataUri("https://cdn.x/big.png",
      fetchOf(res(PNG, { length: String(LOGO_MAX_BYTES + 1) })));
    expect(declared, "content-length se rukna chahiye").toBeNull();

    const big = new Uint8Array(LOGO_MAX_BYTES + 10);
    big.set(PNG.subarray(0, 8));
    const lying = await logoDataUri("https://cdn.x/big.png", fetchOf(res(big, { length: null })));
    expect(lying, "header na ho to bhi bytes se rukna chahiye").toBeNull();
  });

  it("khaali / gair-http url par fetch hota hi nahi", async () => {
    let called = false;
    const spy = (async () => { called = true; return res(PNG); }) as unknown as typeof fetch;
    expect(await logoDataUri(null, spy)).toBeNull();
    expect(await logoDataUri("", spy)).toBeNull();
    /* `data:` aur `file:` — dono ko fetch karna bekaar ya khatarnaak hai. */
    expect(await logoDataUri("file:///etc/passwd", spy)).toBeNull();
    expect(called, "in me se kisi par bhi network nahi chhoona chahiye").toBe(false);
  });
});

describe("isRenderableLogo — wo rail jo URL ko renderer tak nahi jaane deti", () => {
  it("sirf data URI ko haan kehta hai", () => {
    expect(isRenderableLogo("data:image/png;base64,AAAA")).toBe(true);
  });

  it("http URL ko NAA — chahe wo bilkul sahi ho", () => {
    /* Agar koi naya call site seedha logo_url daal de, to document monogram dikhayega —
       chup-chaap renderer ke andar bina deadline ke network call nahi karega. */
    expect(isRenderableLogo("https://cdn.x/logo.png")).toBe(false);
    expect(isRenderableLogo(null)).toBe(false);
    expect(isRenderableLogo(undefined)).toBe(false);
  });
});
