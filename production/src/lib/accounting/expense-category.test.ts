import { describe, it, expect } from "vitest";
import { expenseCategoryError } from "./expense-category";

/* ─────────────────────────────────────────────────────────────────────────────
   29 Aug 2026, browser me pakda gaya. Amazon ka asli tax invoice upload kiya gaya, AI ne
   sab theek padha — vendor "Coca Industries", GSTIN 23EZFPS9892N2Z7, bill TLTK-4450,
   ₹1,938, GST ₹295.63, HSN 9404 (har aankda Amazon ki apni CSV se milaya gaya) — aur
   "Save expense" dabane par KUCH NAHI HUA.

   Wajah: schema `category` HAMESHA maangta tha, par wo khaana sirf simple mode me render
   hota hai. Bill upload karte hi form itemise mode me chala jata hai aur khaana gायab ho
   jata hai. React Hook Form ek aise field par ruk raha tha jo screen par tha hi nahi:

     · koi error message nahi (jis field par error hai wo render nahi hota)
     · koi toast nahi
     · button chalu dikhta hai
     · network par ek request tak nahi

   CLAUDE.md §24: "koi dead end nahi". Yahan dead end bhi tha aur chup bhi.
   ───────────────────────────────────────────────────────────────────────────── */

describe("expenseCategoryError — itemise mode", () => {
  it("item par category ho to rukavat NAHI — ASLI MAAMLA", () => {
    /* Bill upload wala raasta yahi hai, aur yahi teen hafte se chup-chaap rukа hua tha. */
    expect(expenseCategoryError({
      itemised: true, formCategory: "", itemCategories: ["Travel"],
    })).toBeNull();
  });

  it("kai line me se EK ki category kaafi hai", () => {
    /* Save par pehli category hi poore kharche ki ban-ti hai, isliye har line par zid
       karna sirf rukavat banata — aur aam taur par sab ek hi khaate ka hota hai. */
    expect(expenseCategoryError({
      itemised: true, itemCategories: [null, "", "Office Supplies", undefined],
    })).toBeNull();
  });

  it("kisi bhi line par category na ho to ROKTA hai, aur batata hai KAHAN", () => {
    const msg = expenseCategoryError({ itemised: true, itemCategories: ["", null] });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/item/i);
  });

  it("upar wali category itemise mode me nahi bachati", () => {
    /* Ye theek wo bharam hai jo bug ke ulat taraf hota: form me purani value padi ho aur
       hum use "chal jayega" maan lein, jabki save par item ki category hi jaati hai. */
    expect(expenseCategoryError({
      itemised: true, formCategory: "Travel", itemCategories: ["", ""],
    })).toBeTruthy();
  });
});

describe("expenseCategoryError — simple mode", () => {
  it("category ho to rukavat nahi", () => {
    expect(expenseCategoryError({ itemised: false, formCategory: "Hosting" })).toBeNull();
  });

  it("khaali ho to rokta hai, aur batata hai KAHAN", () => {
    const msg = expenseCategoryError({ itemised: false, formCategory: "" });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/upar|Category/i);
  });

  it("sirf space, ya ek akshar — dono khaali hi hain", () => {
    expect(expenseCategoryError({ itemised: false, formCategory: "   " })).toBeTruthy();
    expect(expenseCategoryError({ itemised: false, formCategory: "A" })).toBeTruthy();
  });

  it("item ki category simple mode me nahi bachati", () => {
    expect(expenseCategoryError({
      itemised: false, formCategory: "", itemCategories: ["Travel"],
    })).toBeTruthy();
  });
});

describe("expenseCategoryError — sandesh khud ek raasta ho", () => {
  it("har sandesh me 'ab kya karein' hota hai, sirf 'nahi ho sakta' nahi", () => {
    /* §24. Ek "Category required" wala sandesh us user ke liye bekaar hai jise wo khaana
       dikh hi nahi raha — isiliye ye bug itni der chhupa raha. */
    for (const o of [
      { itemised: true,  itemCategories: [] },
      { itemised: false, formCategory: "" },
    ] as const) {
      const msg = expenseCategoryError(o)!;
      expect(msg.length).toBeGreaterThan(30);
      expect(msg).toMatch(/chuniye/);
    }
  });

  it("null par crash nahi, aur chup bhi nahi", () => {
    /* Khaamoshi hi wo bug thi. `null` par `null` lautana use dobara paida kar deta. */
    expect(expenseCategoryError(null)).toBeTruthy();
    expect(expenseCategoryError(undefined)).toBeTruthy();
  });
});
