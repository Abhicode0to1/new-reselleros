import { describe, it, expect } from "vitest";
import { suggestCategory } from "./expenses";

/* ─────────────────────────────────────────────────────────────────────────────
   29 Aug 2026. Pardeep ne screen par pakda: ek GADDE ki category "Travel" chuni gayi thi.

   Wajah product ke naam me thi. Amazon ka poora title 180+ akshar ka hai aur usme kahin
   "Travel" aata hai; Travel wala rule table me doosre number par hai aur pehla match jeet
   jata hai. Nateeja: ek gadda safar ka kharcha ban kar seedha P&L ke galat khaate me.

   Is function ka apna purana test kehta hai ki uske patterns "written for text an OPERATOR
   TYPES" hain. Wo sach tha — aur wahi jad thi. Operator likhta hai "cab to client"
   (16 akshar). Amazon likhta hai 180.
   ───────────────────────────────────────────────────────────────────────────── */

/** Bilkul wahi title jo us din bill se nikla tha. */
const MATTRESS =
  "NEXTGO Single Bed Cotton Mattress 2.5 x 6.5 Feet | Foldable Lightweight Tufted Ruyi " +
  "Gadi with 1 Pillow & Zipper Cover | Guest Bachelor Travel Floor Sleeping Mattress | " +
  "Blend Pink Multi Color";

describe("suggestCategory — product ke naam me aaye aam shabd", () => {
  it("gadde ko Travel NAHI banata — ASLI MAAMLA", () => {
    expect(suggestCategory(MATTRESS, { source: "product" })).not.toBe("Travel");
  });

  it("lamba title bina `source` ke bhi Travel nahi banta", () => {
    /* Har call site ko `source` yaad rakhna ek waada hai, pehra nahi. 60 akshar se lamba
       text apne aap product maana jata hai — kyunki koi operator itna lamba note nahi
       likhta. */
    expect(suggestCategory(MATTRESS)).not.toBe("Travel");
  });

  it("aur ye teen bhi wahi jaal the", () => {
    for (const t of [
      "Storite PU Leather Card holder Slim Wallet with Zipper Cover for Men and Women Travel",
      "Office Chair with Adjustable Table Arm Rest and Lumbar Cover Support for Long Stay",
      "Smart WiFi Water Heater with Power Saving Mode and Data Sync App Support Register",
    ]) {
      /* Sirf ek baat par zid: TRAVEL nahi. Kaunsi category sahi hai ye har naam par alag
         hai aur wo faisla is test ka nahi — "wifi" wala heater Internet & Phone bhi ho
         sakta hai aur Utilities bhi, aur dono me se koi bhi Travel se behtar hai. */
      expect(suggestCategory(t, { source: "product" }), t).not.toBe("Travel");
    }
  });
});

describe("suggestCategory — operator ka apna note pehle jaisa hi chale", () => {
  it("chhote note me `travel` ab bhi Travel hai", () => {
    /* Ye poore fix ki shart hai: gadda theek karne ke chakkar me asli travel note ka
       tootna is se bura hota. */
    expect(suggestCategory("travel to client")).toBe("Travel");
    expect(suggestCategory("Travel reimbursement")).toBe("Travel");
  });

  it("baaki chhote note bhi waise hi", () => {
    expect(suggestCategory("cab to client")).toBe("Travel");
    expect(suggestCategory("office rent August")).toBe("Office Rent");
    /* "team lunch" JAAN-BOOJHKAR Staff Welfare nahi hai — wo client ka khana bhi ho sakta
       hai, aur CATEGORY_KEYWORDS me wahi likha hai. Maine pehle ise Staff Welfare maan kar
       test likha tha, aur code ne mujhe galat sabit kiya. */
    expect(suggestCategory("team lunch")).toBe("Business Promotion");
    expect(suggestCategory("staff lunch")).toBe("Staff Welfare");
    expect(suggestCategory("AWS bill")).toBe("Hosting");
    expect(suggestCategory("printer ink cartridge")).toBe("Office Supplies");
  });

  it("khaali text par null — pehle jaisa", () => {
    expect(suggestCategory("")).toBeNull();
    expect(suggestCategory("   ")).toBeNull();
  });
});

describe("suggestCategory — PAKKE shabd lambe naam me bhi chalte hain", () => {
  it("lambe title me bhi uber/ola/irctc Travel hi hai", () => {
    /* Kamzor shabd anadekhe hote hain, poora rule nahi. Ek asli safar ka bill lamba ho
       to bhi pakda jana chahiye. */
    expect(suggestCategory(
      "Uber India Systems Private Limited — trip receipt for the ride taken on 23 August",
      { source: "product" },
    )).toBe("Travel");
  });

  it("lambe product naam me laptop ab bhi Equipment hai", () => {
    expect(suggestCategory(
      "Dell Latitude 5450 Business Laptop 14 inch FHD Intel Core Ultra 7 with 16GB RAM 512GB SSD",
      { source: "product" },
    )).toBe("Equipment");
  });

  it("lambe naam me hosting ke pakke shabd bhi chalte hain", () => {
    expect(suggestCategory(
      "Amazon Web Services India Private Limited — monthly cloud hosting and server usage charges",
      { source: "product" },
    )).toBe("Hosting");
  });
});
