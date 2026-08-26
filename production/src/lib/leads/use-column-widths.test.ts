import { describe, it, expect } from "vitest";
import {
  widthAfterDrag, readStoredWidths, writeStoredWidths, autofitWidth, fitToContainer,
  coversAllColumns,
  MIN_COL_PX, MAX_AUTOFIT_PX, COL_WIDTH_KEY,
} from "./use-column-widths";

const start = { id: "email", startX: 500, startWidth: 200 };

describe("widthAfterDrag", () => {
  it("dahine kheenchne par chaudai badhti hai, utni hi jitna kheencha", () => {
    expect(widthAfterDrag(start, 560).valueOf()).toBe(260);
  });

  it("baayen kheenchne par ghatti hai", () => {
    expect(widthAfterDrag(start, 440)).toBe(140);
  });

  it("column ko kabhi gायab nahi hone deta", () => {
    /* Ye wo shakha hai jo sach me kaat sakti thi: bina clamp ke, pointer ko column ke
       baayen kinare se aage le jane par chaudai rinatmak ho jati aur browser use 0 maan
       leta — aur ek gायab column ko wapas laane ka koi tarika screen par hota hi nahi. */
    expect(widthAfterDrag(start, 0)).toBe(MIN_COL_PX);
    expect(widthAfterDrag(start, -9999)).toBe(MIN_COL_PX);
  });

  it("poora pixel deta hai, kyunki aadha pixel har render par hilta hai", () => {
    expect(Number.isInteger(widthAfterDrag(start, 500.6))).toBe(true);
  });
});

describe("autofitWidth — column utna hi jitna text", () => {
  it("sabse lambe text ke naap ka, padding ke saath", () => {
    expect(autofitWidth([80, 210, 140], 20)).toBe(230);
  });

  it("khaali column bhi padhne layak rehta hai", () => {
    /* Bina MIN ke ek khaali column 0px ka ho jata aur screen se gायab — aur use wapas
       laane ka koi tarika grip ke bina nahi bachta, kyunki grip hi gायab hota. */
    expect(autofitWidth([], 20)).toBe(MIN_COL_PX);
    expect(autofitWidth([2], 1)).toBe(MIN_COL_PX);
  });

  it("ek lamba email poori table nahi bigadta", () => {
    /* Bina MAX ke "accounts.payable@somelongcompanyname.co.in" apne column ko 600px kar
       deta aur baaki saare column screen se bahar chale jate. Uske aage text wrap hota
       hai — kata nahi. */
    expect(autofitWidth([2000], 20)).toBe(MAX_AUTOFIT_PX);
  });

  it("poora pixel deta hai", () => {
    /* measureText 137.42 jaisi value deta hai; aadha pixel gridlines par hilta dikhta hai. */
    expect(Number.isInteger(autofitWidth([137.42], 16.6))).toBe(true);
  });

  it("kam padne se behtar zyada — ceil, floor nahi", () => {
    /* Neeche gol karne par text ka aakhri akshar kat jata hai, aur wo theek wo cheez hai
       jise ye feature theek karne aaya tha. */
    expect(autofitWidth([100.1], 0)).toBe(101);
  });
});

describe("fitToContainer — bachi jagah baanto, par nichodo nahi", () => {
  it("chhote total ko box bharne tak badhata hai", () => {
    const out = fitToContainer({ a: 100, b: 100 }, 400);
    expect(out.a + out.b).toBe(400);
    expect(out.a).toBe(200);
  });

  it("anupaat rakhta hai — chauda column chauda hi rehta hai", () => {
    const out = fitToContainer({ a: 100, b: 300 }, 800);
    expect(out.a).toBe(200);
    expect(out.b).toBe(600);
  });

  it("aakhri column me hi round ka jodh daalta hai, taaki 1px ki lakeer na bache", () => {
    /* Har column alag round karne par yogfal 999 ya 1001 ho jata, aur wo ek pixel ki
       khaali lakeer table ke kinare par galti jaisi dikhti hai. */
    const out = fitToContainer({ a: 33, b: 33, c: 34 }, 1000);
    expect(Object.values(out).reduce((s, v) => s + v, 0)).toBe(1000);
  });

  it("content box se bada ho to CHHUTA NAHI — wahan scroll sahi jawab hai", () => {
    /* Nichodne ka matlab hota har cell ka ellipsis me badal jana — yaani wahi bug jise
       autofit theek karne aaya tha. */
    const wide = { a: 800, b: 800 };
    expect(fitToContainer(wide, 500)).toEqual(wide);
  });

  it("barabar hone par bhi kuch nahi badalta", () => {
    expect(fitToContainer({ a: 250, b: 250 }, 500)).toEqual({ a: 250, b: 250 });
  });

  it("bemani container par input waisa hi lautata hai", () => {
    /* Pehle render par `clientWidth` 0 ho sakti hai. Us par bhaag dene se Infinity
       chaudai banti aur poora table gायab ho jata. */
    expect(fitToContainer({ a: 100 }, 0)).toEqual({ a: 100 });
    expect(fitToContainer({}, 500)).toEqual({});
  });

  it("MIN_COL_PX se neeche kabhi nahi jata", () => {
    expect(fitToContainer({ a: 1, b: 10000 }, 10000).a).toBeGreaterThanOrEqual(MIN_COL_PX);
  });
});

describe("coversAllColumns — naya column purani chaudai me gum na ho", () => {
  const ORDER = ["select", "company", "owner", "actions"] as const;

  it("poori list par haan", () => {
    expect(coversAllColumns({ select: 40, company: 150, owner: 90, actions: 40 }, ORDER)).toBe(true);
  });

  it("EK column chhootne par bhi na — yahi wo bug tha", () => {
    /* Owner column bana, aur purani saheji hui list me wo nahi tha. Table ki chaudai us
       list ke yogfal se banti hai, to naye column ko 0px mili aur wo gायab raha. Ek bhi
       chhoot jaye to poori list chhod dena hi surakshit hai. */
    expect(coversAllColumns({ select: 40, company: 150, actions: 40 }, ORDER)).toBe(false);
  });

  it("khaali list par na — wahi raasta jo pehle din tha", () => {
    expect(coversAllColumns({}, ORDER)).toBe(false);
  });

  it("zyada column hone par bhi haan — hataye gaye column rok nahi bante", () => {
    /* Ulta haal: koi column HAT jaye (jaise `heat` hata tha). Purani list me uski chaudai
       padi rehti hai, par wo kisi ko nuksaan nahi karti — `<col>` uske liye banta hi
       nahi. Ise reject karna user ki kheenchi hui chaudai bina wajah phenk dena hota. */
    expect(coversAllColumns({ select: 40, company: 150, owner: 90, actions: 40, heat: 37 }, ORDER)).toBe(true);
  });

  it("khaali order par na — bina column ke \"sab dhak liya\" bemani hai", () => {
    expect(coversAllColumns({ a: 1 }, [])).toBe(false);
  });
});

/* ══ Padhna: jo bhi mile, list toot kar nahi girni chahiye ══════════════════ */

function fakeStore(value: string | null) {
  return {
    getItem: () => value,
    setItem: () => { /* noop */ },
  };
}

describe("readStoredWidths", () => {
  it("saheji hui chaudai lautata hai", () => {
    expect(readStoredWidths(fakeStore(JSON.stringify({ email: 220 })))).toEqual({ email: 220 });
  });

  it("kuch saheja hi nahi to khaali", () => {
    expect(readStoredWidths(fakeStore(null))).toEqual({});
  });

  it("kharab JSON par girta nahi", () => {
    expect(readStoredWidths(fakeStore("{not json"))).toEqual({});
  });

  it("array ya null ko object nahi maanta", () => {
    expect(readStoredWidths(fakeStore("[1,2,3]"))).toEqual({});
    expect(readStoredWidths(fakeStore("null"))).toEqual({});
  });

  it("har wo value girata hai jo `<col>` par column gायab kar deti", () => {
    /* localStorage user ke haath me hai. Ek chhedi hui entry se leads list ka error
       boundary me girna bemani hoga — aur `width: NaN` ya `-40` chup-chaap column
       mita deta hai, jo usse bhi bura hai. */
    const bad = JSON.stringify({ a: "220", b: -40, c: 0, d: null, e: NaN, g: 300 });
    expect(readStoredWidths(fakeStore(bad))).toEqual({ g: 300 });
  });

  it("MIN_COL_PX se chhoti par ASLI chaudai ko rakhta hai", () => {
    /* Wo bug jo 26 Aug 2026 ko naapa gaya: pehle storage ka floor bhi MIN_COL_PX tha, to
       checkbox (28px) aur heat (37px) reload par gir jate — aur wo do column % par wapas
       chale jate jabki baaki px par rehte. Aadha-% aadha-px table har render par hilta
       hai; poora point hi ye tha ki na hile. */
    expect(readStoredWidths(fakeStore(JSON.stringify({ select: 28 })))).toEqual({ select: 28 });
  });

  it("aadhe pixel ko poora karta hai", () => {
    /* getBoundingClientRect 27.725 jaisi value deta hai. Aadha pixel har render par
       ek-do px ka farak dikhata hai, jo gridlines par saaf najar aata hai. */
    expect(readStoredWidths(fakeStore(JSON.stringify({ select: 27.725 })))).toEqual({ select: 28 });
  });

  it("throw karne wale storage par bhi khaali lautata hai", () => {
    /* private mode me localStorage padhna hi throw karta hai. */
    const throwing = { getItem: () => { throw new Error("SecurityError"); } };
    expect(readStoredWidths(throwing)).toEqual({});
  });
});

describe("writeStoredWidths", () => {
  it("wahi chaabi aur JSON likhta hai jise readStoredWidths padh sake", () => {
    let key = "", val = "";
    writeStoredWidths({ email: 220 }, { setItem: (k, v) => { key = k; val = v; } });
    expect(key).toBe(COL_WIDTH_KEY);
    expect(readStoredWidths(fakeStore(val))).toEqual({ email: 220 });
  });

  it("storage ke throw karne par chup rehta hai", () => {
    /* Chaudai yaad na rehna ek asuvidha hai; uske liye poori screen girana nahi. */
    expect(() =>
      writeStoredWidths({ a: 100 }, { setItem: () => { throw new Error("QuotaExceeded"); } }),
    ).not.toThrow();
  });
});
