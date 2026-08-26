import { describe, it, expect } from "vitest";
import {
  waitState, waitBand, waitLabel, waitPriority, OUTBOUND_KINDS,
} from "./waiting";

const NOW = new Date("2026-08-26T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

/* ══ ANSWERED vs WAITING — do alag cheezein ════════════════════════════════ */

describe("jawab de diya vs jawab baaki", () => {
  it("jawab de diya to KITNI DER LAGI batata hai, ab kitni der hui ye nahi", () => {
    /* Lead 3 din pehle aayi, jawab 4 minute me chala gaya. Ye ek achha record hai —
       "3 din" dikhana use ek alarm bana deta jo wo nahi hai. */
    const s = waitState(ago(3 * 24 * 60), ago(3 * 24 * 60 - 4), NOW);
    expect(s).toEqual({ kind: "answered", minutes: 4 });
  });

  it("jawab nahi gaya to KAB SE RUKI HAI batata hai", () => {
    const s = waitState(ago(90), null, NOW);
    expect(s).toEqual({ kind: "waiting", minutes: 90, band: "late" });
  });

  it("stage se koi matlab nahi — sirf jawab gaya ya nahi", () => {
    /* Ye jaan-boojh kar stage-mukt hai. Ek `quote` stage wali lead bhi jawab ka intezaar
       kar sakti hai, aur ek `new` lead ka jawab ja chuka ho sakta hai. */
    expect(waitState(ago(10), null, NOW).kind).toBe("waiting");
    expect(waitState(ago(10), ago(5), NOW).kind).toBe("answered");
  });
});

/* ══ BANDS — seedhe us study ke bindu se ═══════════════════════════════════ */

describe("waitBand — 5 aur 30 minute study ke apne bindu hain", () => {
  it("5 minute tak fresh", () => {
    expect(waitBand(0)).toBe("fresh");
    expect(waitBand(5)).toBe("fresh");
  });

  it("6 se 30 minute slipping — yahi wo khidki hai jisme 21 guna ka farak hai", () => {
    expect(waitBand(6)).toBe("slipping");
    expect(waitBand(30)).toBe("slipping");
  });

  it("31 minute se 24 ghante tak late", () => {
    expect(waitBand(31)).toBe("late");
    expect(waitBand(24 * 60)).toBe("late");
  });

  it("24 ghante ke baad cold", () => {
    /* Industry ka average 42 ghante hai — yaani `cold` aam haalat hai, apwad nahi. */
    expect(waitBand(24 * 60 + 1)).toBe("cold");
    expect(waitBand(42 * 60)).toBe("cold");
  });
});

/* ══ SORT — "jise action chahiye pehle" ════════════════════════════════════ */

describe("waitPriority", () => {
  it("ruki hui lead HAR jawab-di-gayi lead se upar", () => {
    /* 1 minute se ruki hui lead bhi us lead se upar aati hai jiska jawab 40 ghante me
       gaya tha — kyunki intezaar khatm karna ek KAAM hai, beeta waqt ek RECORD. */
    const waiting1m = waitState(ago(1), null, NOW);
    const answered40h = waitState(ago(50 * 60), ago(10 * 60), NOW);
    expect(waitPriority(waiting1m)).toBeGreaterThan(waitPriority(answered40h));
  });

  it("zyada der se ruki hui lead pehle", () => {
    expect(waitPriority(waitState(ago(300), null, NOW)))
      .toBeGreaterThan(waitPriority(waitState(ago(30), null, NOW)));
  });

  it("jinka waqt pata nahi wo sabse aakhir", () => {
    expect(waitPriority({ kind: "unknown" })).toBeLessThan(waitPriority({ kind: "answered", minutes: 0 }));
  });

  it("poori list par lagakar kram sahi aata hai", () => {
    const rows = [
      { id: "answered-fast", s: waitState(ago(600), ago(597), NOW) },
      { id: "waiting-2d",    s: waitState(ago(2880), null, NOW) },
      { id: "no-date",       s: waitState(null, null, NOW) },
      { id: "waiting-10m",   s: waitState(ago(10), null, NOW) },
    ];
    const order = [...rows].sort((a, b) => waitPriority(b.s) - waitPriority(a.s)).map((r) => r.id);
    expect(order).toEqual(["waiting-2d", "waiting-10m", "answered-fast", "no-date"]);
  });
});

/* ══ LABEL ════════════════════════════════════════════════════════════════ */

describe("waitLabel", () => {
  it("minute, ghanta, din — jo bada ho wahi", () => {
    expect(waitLabel(0)).toBe("0m");
    expect(waitLabel(59)).toBe("59m");
    expect(waitLabel(60)).toBe("1h");
    expect(waitLabel(23 * 60 + 59)).toBe("23h");
    expect(waitLabel(24 * 60)).toBe("1d");
    expect(waitLabel(42 * 60)).toBe("1d");
  });

  it("ghante ke aage minute nahi dikhata", () => {
    /* "3h 47m" ek cell me do baar padhna padta hai, aur us 47 se koi faisla nahi badalta. */
    expect(waitLabel(3 * 60 + 47)).toBe("3h");
  });
});

/* ══ EDGES — wo shakhayen jo chup-chaap galat ho sakti thin ════════════════ */

describe("gayab ya kharab waqt", () => {
  it("bina created_at ke andaza nahi lagata", () => {
    for (const bad of [null, undefined, "", "kal"]) {
      expect(waitState(bad, null, NOW).kind).toBe("unknown");
    }
  });

  it("kharab reply timestamp par bhi jhooth nahi bolta", () => {
    /* `answered` ke saath NaN minute dikhana "NaN m" chhapta hai — usse behtar hai kuch
       na kehna. */
    expect(waitState(ago(60), "not-a-date", NOW).kind).toBe("unknown");
  });

  it("bhavishya ka timestamp rinatmak intezaar nahi banata", () => {
    /* Server aur browser ki ghadi me farak aam hai. "-3m se ruki hai" bug jaisa padhta hai. */
    const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const s = waitState(future, null, NOW);
    expect(s.kind === "waiting" && s.minutes).toBe(0);
  });

  it("jawab lead se pehle ka ho to 0 minute, rinatmak nahi", () => {
    const s = waitState(ago(10), ago(20), NOW);
    expect(s).toEqual({ kind: "answered", minutes: 0 });
  });
});

describe("OUTBOUND_KINDS", () => {
  it("`note` ko jawab nahi ginta", () => {
    /* Apne liye likhi hui note customer tak nahi pahunchti. Use jawab ginne se har
       lead "answered" dikhti aur ye poora column jhooth bol deta. */
    expect(OUTBOUND_KINDS).not.toContain("note");
  });

  it("`email_in` ko jawab nahi ginta", () => {
    /* Wo customer ka bheja hua mail hai — hamara jawab nahi. Ise ginna intezaar ko
       khatm dikha deta theek us waqt jab wo shuru hota hai. */
    expect(OUTBOUND_KINDS).not.toContain("email_in");
  });

  it("call, whatsapp, email aur quote — ye chaaro customer tak pahunchte hain", () => {
    for (const k of ["call", "whatsapp", "email", "quote"]) {
      expect(OUTBOUND_KINDS).toContain(k);
    }
  });
});
