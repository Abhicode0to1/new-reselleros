import { describe, it, expect } from "vitest";
import { buildProductMatchPrompt, validateProductPick, type CatalogueChoice } from "./product-match-ai";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, live. Pardeep ne likha:

     "mujhe 40 email ke liye quote chahiye google workspace starter"

   Catalogue me naam hai "Google Workspace Business Starter". Ek shabd ki kami, aur
   `findProduct` ne kuch nahi mila — lead par teen baar likha gaya:

     "the mail did not name a product from this tenant's catalogue"

   Koi bhi insaan padh kar samajh jata ki wo kya maang rahe the. Pardeep ka sawaal wahi
   tha: "isme ai ka use kyo nahi karte, ye understanding to ai khud kar lega."

   Ab AI chunta hai — par SIRF list me se. Ye file usi lakeer par pehra deti hai.
   ───────────────────────────────────────────────────────────────────────────── */

const CAT: CatalogueChoice[] = [
  { id: "i1", name: "Google Workspace Business Starter" },
];

const MANY: CatalogueChoice[] = [
  { id: "i1", name: "Google Workspace Business Starter" },
  { id: "i2", name: "Google Workspace Business Standard" },
  { id: "i3", name: "Standard" },
];

describe("jawab list se bahar ho to MANA — yahi asli pehra hai", () => {
  it("aisa naam jo catalogue me nahi hai, null ban jata hai", () => {
    /* Model ne kuch bhi kaha ho — agar wo list me nahi hai, wo jawab nahi hai. */
    expect(validateProductPick({ product: "Microsoft 365 Business Premium" }, CAT)).toBeNull();
  });

  it("nazdeeki naam bhi nahi chalta — 'lagbhag' koi jawab nahi hota", () => {
    expect(validateProductPick({ product: "Google Workspace Starter" }, CAT)).toBeNull();
    expect(validateProductPick({ product: "Business Starter" }, CAT)).toBeNull();
  });

  it("null, khaali, aur bekaar shakl — sab null", () => {
    for (const raw of [
      { product: null }, { product: "" }, { product: "   " }, { product: 42 },
      {}, null, undefined, "Google Workspace Business Starter",
    ]) {
      expect(validateProductPick(raw as unknown, CAT)).toBeNull();
    }
  });

  it("catalogue khaali ho to kuch bhi maan-ne ko nahi", () => {
    expect(validateProductPick({ product: "Anything" }, [])).toBeNull();
  });
});

describe("hu-ba-hu naam mile to row lautata hai", () => {
  it("poora naam chalta hai", () => {
    expect(validateProductPick({ product: "Google Workspace Business Starter" }, CAT))
      .toEqual({ id: "i1", name: "Google Workspace Business Starter" });
  });

  it("chhota-bada akshar aur aas-paas ki jagah maaf hai — wo row nahi badalte", () => {
    expect(validateProductPick({ product: "  google workspace business starter " }, CAT)?.id).toBe("i1");
  });

  it("kai me se sahi wala chunta hai", () => {
    expect(validateProductPick({ product: "Google Workspace Business Standard" }, MANY)?.id).toBe("i2");
  });
});

describe("prompt me wahi likha ho jo validation lagu karti hai", () => {
  const p = buildProductMatchPrompt("mujhe 40 email ke liye quote chahiye google workspace starter", CAT);

  it("catalogue ke naam prompt me hote hain", () => {
    expect(p).toContain("Google Workspace Business Starter");
  });

  it("saaf kehta hai ki jawab list se hi aana chahiye", () => {
    expect(p).toMatch(/copied EXACTLY|only permitted answers/i);
    expect(p).toMatch(/never invent/i);
  });

  it("matlab par milaane ko kehta hai, spelling par nahi — asli maamla likha hai", () => {
    /* Bina iske model wahi sakhti dohra deta jo `findProduct` karta hai, aur ye fallback
       bemaani ho jata. */
    expect(p).toMatch(/Match on meaning, not spelling/i);
    expect(p).toContain("google workspace");
  });

  it("do me se ek chunne se MANA karta hai", () => {
    /* Ye wo lakeer hai jo 24 Aug wali galti dobara nahi hone deti: do asli product ke beech
       ka andaza ek asli quotation par galat daam ban jata hai. */
    expect(p).toMatch(/TWO catalogue entries could both fit.*answer null/is);
  });

  it("bahut lamba mail kaata jata hai", () => {
    const long = buildProductMatchPrompt("x".repeat(9000), CAT);
    expect(long.length).toBeLessThan(5000);
  });

  it("DAAM prompt me hai hi nahi — model ko keemat dikhti hi nahi", () => {
    /* Sabse zaroori: model sirf ye chunta hai ki KAUNSA product. Daam catalogue ki row se
       aata hai. Jo dikhta hi nahi, wo galat bhi nahi ho sakta.

       Jaanch AANKDE par hai, shabd par nahi. Pehli koshish me ye test mera apna nirdesh
       pakad kar laal hua tha — "a wrong price on a real quotation" me "price" likha hai,
       aur wo likha hona ACHHA hai. Aaj teesri baar meri jaanch mere hi likhe par lagi.

       `matchProductWithAi` catalogue me se sirf `{id, name}` bhejta hai — `msrp` aur
       `wholesale` ingest me chhaan kar hata diye jate hain. Ye us baat par pehra hai. */
    const p2 = buildProductMatchPrompt("kuch bhi", [
      { id: "i1", name: "Google Workspace Business Starter" },
    ]);
    /* Koi bhi paise jaisa aankda nahi — na 270, na 3240, na 3,240. */
    expect(p2).not.toMatch(/\d[\d,]{2,}/);
    /* Aur catalogue ke daam wale khaano ka naam bhi nahi. */
    expect(p2).not.toMatch(/\bmsrp\b|\bwholesale\b|\brupee\b|\bRs\b|₹/i);
  });
});
