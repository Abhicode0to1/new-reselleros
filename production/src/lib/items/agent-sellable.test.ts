import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentQuoteBlocker, headlineTier, AGENT_READS_KIND } from "./agent-sellable";

/* ─────────────────────────────────────────────────────────────────────────────
   26 Aug 2026 — Pardeep: "mene sales@anutech.in par ek email bheji hai wo app me receive
   nahi hue hai" … "jisne email bejha usko bhi koi reply nahi gaya".

   Us waqt catalogue khaali tha, aur app ne wajah khud likh di thi. Par uske peeche ek
   doosra roop khada tha, jise ye test rokta hai: ek Main plan jo SAVE ho jata hai aur jise
   AI kabhi quote nahi kar sakta, kyunki uska `msrp` 0 reh gaya.

   Har test neeche ek ASLI shakal par baitha hai — form kaise bharta hai, aur
   `loadSalesCatalog` kya maangta hai. Dono ke beech ki khaai hi bug thi.
   ───────────────────────────────────────────────────────────────────────────── */

describe("headlineTier — wahi value jo items.msrp banti hai", () => {
  it("annual pehle, monthly baad me", () => {
    expect(headlineTier({ annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 300, wholesale: 120 } }))
      .toEqual({ msrp: 270, wholesale: 110 });
  });

  it("annual na ho to monthly", () => {
    expect(headlineTier({ monthly: { msrp: 300, wholesale: 120 } }))
      .toEqual({ msrp: 300, wholesale: 120 });
  });

  it("USD kabhi headline nahi banta — YAHI POORA BUG THA", () => {
    /* USD ek apna alag number hai ($7/mo vs ₹136/mo), converted INR nahi — dekho
       ItemPrices ka comment. Use headline maan lena ek export daam ko ghar ke quote par
       chipka dena hota. Isliye jawab 0 hai, aur 0 ka matlab hai "AI ise nahi bech sakta" —
       jise guard pakadta hai, chup-chaap save nahi karta. */
    expect(headlineTier({ usd: { msrp: 7, wholesale: 5 } })).toEqual({ msrp: 0, wholesale: 0 });
  });

  it("khaali aur null par girta nahi", () => {
    expect(headlineTier({})).toEqual({ msrp: 0, wholesale: 0 });
    expect(headlineTier(null)).toEqual({ msrp: 0, wholesale: 0 });
    expect(headlineTier(undefined)).toEqual({ msrp: 0, wholesale: 0 });
  });
});

describe("agentQuoteBlocker — Main plan bina customer price ke ruk jaye", () => {
  it("theek bhara Main plan guzar jata hai", () => {
    expect(agentQuoteBlocker("main", { annual: { msrp: 270, wholesale: 110 } })).toBeNull();
  });

  it("wholesale 0 hone par bhi guzarta hai — cost anjaan hona rok nahi hai", () => {
    /* sales-agent.server.ts:94 — "A SKU whose wholesale is unknown is kept, with cost 0.
       The margin is only ever context." Yahan rok lagana AI ko ek bikne wala plan bechne
       se rok dena hota, sirf isliye ki khareed abhi bhari nahi. */
    expect(agentQuoteBlocker("main", { annual: { msrp: 270, wholesale: 0 } })).toBeNull();
  });

  it("SIRF USD bhara ho to rokta hai, aur USD ka naam leta hai", () => {
    const msg = agentQuoteBlocker("main", { usd: { msrp: 7, wholesale: 5 } });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/USD/);
    /* §24: sirf "nahi ho sakta" kaafi nahi — agla kadam bhi hona chahiye. */
    expect(msg).toMatch(/Annual/);
  });

  it("SIRF wholesale bhara ho to rokta hai, aur customer price ki baat karta hai", () => {
    const msg = agentQuoteBlocker("main", { annual: { msrp: 0, wholesale: 110 } });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/wholesale|khareed/i);
    expect(msg).toMatch(/customer price/i);
  });

  it("kuch bhara hi na ho to rokta hai", () => {
    expect(agentQuoteBlocker("main", {})).toBeTruthy();
    expect(agentQuoteBlocker("main", null)).toBeTruthy();
  });

  it("ADD-ON par msrp 0 ROK NAHI hai — aur ye sabse zaroori test hai", () => {
    /* Kai support SKU jaan-boojh kar msrp 0 rakhte hain aur asli figure
       `prices.annual_total` me rakhte hain — live catalogue par naapa gaya
       (sales-agent.server.ts:90). Purane 71 items me se 26 aise the.

       Agar guard inhe bhi roke, to ye ek SAHI tarike ko tod deta — aur wahi ek guard ka
       sabse aam nuksaan hai: wo galat cheez rokne ke chakkar me sahi cheez rok deta hai.
       Agent inhe padhta bhi nahi, kyunki wo `main` nahi hain. */
    expect(agentQuoteBlocker("addon", {})).toBeNull();
    expect(agentQuoteBlocker("addon", { usd: { msrp: 7, wholesale: 5 } })).toBeNull();
    expect(agentQuoteBlocker("addon", { annual: { msrp: 0, wholesale: 0 } })).toBeNull();
  });
});

describe("agent ki query se mel", () => {
  const agent = readFileSync(
    join(process.cwd(), "src", "lib", "ai", "sales-agent.server.ts"),
    "utf8",
  );

  it("agent wahi kind padhta hai jo ye file maanti hai", () => {
    /* Do jagah `main` likha hai — ek yahan, ek us query me. Agar wahan badle aur yahan na
       badle, to guard galat cheez rokega aur asli galti chup rahegi. */
    expect(AGENT_READS_KIND).toBe("main");
    expect(agent).toContain('.eq("kind", "main")');
  });

  it("agent msrp > 0 maangta hai — guard isi shart par khada hai", () => {
    /* Ye guard ki poori wajah hai. Ye line hat jaye aur guard reh jaye, to guard ek aisi
       cheez rok raha hoga jo ab rukni nahi chahiye. */
    expect(agent).toContain('.gt("msrp", 0)');
  });
});

describe("form isi function se guzarta hai", () => {
  const form = readFileSync(
    join(process.cwd(), "src", "components", "features", "items", "item-form.tsx"),
    "utf8",
  );
  const code = form.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("save se pehle blocker chalta hai", () => {
    expect(code).toContain("agentQuoteBlocker(data.kind, cleanPrices)");
  });

  it("guard aur save EK hi headline dekhte hain", () => {
    /* Pehle form ke andar `prices.annual ?? prices.monthly ?? blankTier` haath se likha
       tha — do jagah. Do copy ka matlab: ek din screen ek daam dikhaye aur DB me doosra
       jaye, aur guard teesra maane. */
    expect(code).toContain("headlineTier(cleanPrices)");
    expect(code).not.toMatch(/prices\.annual \?\? prices\.monthly/);
  });

  it("blocker ka jawab dikhaya jata hai, chup-chaap phenka nahi jata", () => {
    /* Ek guard jo faisla karke kuch na kahe, us bug se bura hai jise wo rok raha hai:
       button dabta hai aur kuch nahi hota. */
    expect(code).toMatch(/if \(blocker\) \{[\s\S]{0,80}alert\(blocker\)/);
  });
});
