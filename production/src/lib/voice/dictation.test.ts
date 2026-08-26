import { describe, it, expect } from "vitest";
import { appendSpoken, dictationErrorMessage, dictationSupported } from "./dictation";

/* Web Speech API node me chalti hi nahi, isliye jo bhi cheez bina browser ke naapi ja
   sakti thi wo `dictation.ts` me alag rakhi gayi — aur wahi yahan test hoti hai. Hook
   (`use-dictation.ts`) me sirf browser ka jod-tod bacha hai. */

describe("dictationSupported", () => {
  it("dono naam pehchanta hai — Chrome ka prefixed bhi", () => {
    expect(dictationSupported({ SpeechRecognition: () => {} })).toBe(true);
    expect(dictationSupported({ webkitSpeechRecognition: () => {} })).toBe(true);
  });

  it("jahan API nahi hai wahan false — Firefox, aur server par", () => {
    /* Ye button dikhane ka faisla karta hai. Ek button jo dabane par "ye browser support
       nahi karta" kehta ho, wo button hi nahi hona chahiye. */
    expect(dictationSupported({})).toBe(false);
    expect(dictationSupported(undefined)).toBe(false);
    expect(dictationSupported(null)).toBe(false);
  });

  it("aisi property ko nahi maanta jo function na ho", () => {
    /* Koi extension `window.SpeechRecognition = true` set kar sakta hai; use maan lene par
       `new C()` crash karta hai. */
    expect(dictationSupported({ SpeechRecognition: true })).toBe(false);
  });
});

describe("appendSpoken — bola hua text jodna", () => {
  it("khaali box par aage space nahi lagata", () => {
    expect(appendSpoken("", "20 seats chahiye")).toBe("20 seats chahiye");
  });

  it("pehle se likhe text ke baad ek space ke saath jodta hai", () => {
    expect(appendSpoken("Deepak ne kaha", "March me budget")).toBe("Deepak ne kaha March me budget");
  });

  it("do space nahi banata jab text pehle se space par khatam ho", () => {
    expect(appendSpoken("Deepak ne kaha ", "March")).toBe("Deepak ne kaha March");
    expect(appendSpoken("line\n", "aage")).toBe("line\naage");
  });

  it("API se aaye aage-peechhe ke space khud hata deta hai", () => {
    /* SpeechRecognition aksar "  March me budget " jaisa deta hai. */
    expect(appendSpoken("Deepak", "  March  ")).toBe("Deepak March");
  });

  it("khaali sunayi dene par text ko chhuta nahi", () => {
    for (const nothing of ["", "   ", "\n"]) {
      expect(appendSpoken("Deepak ne kaha", nothing)).toBe("Deepak ne kaha");
    }
  });
});

describe("dictationErrorMessage", () => {
  it("mic ki ijazat na milne par AGLA KADAM batata hai, sirf 'nahi hua' nahi", () => {
    /* Sabse aam gadbad — aur iska hal app ke andar hai hi nahi, wo browser ki setting
       hai. Isliye sandesh me wo jagah batani padti hai (CLAUDE.md §24). */
    for (const code of ["not-allowed", "service-not-allowed"]) {
      expect(dictationErrorMessage(code)).toMatch(/browser|address bar/i);
    }
  });

  it("user ke khud rokne par kuch nahi kehta", () => {
    /* `aborted` tab aata hai jab user ne button dobara dabaya. Uspar error dikhana ek
       aisi khabar hai jo khabar nahi hai. */
    expect(dictationErrorMessage("aborted")).toBe("");
  });

  it("anjaan code par bhi kaam ka raasta deta hai", () => {
    expect(dictationErrorMessage("some-new-code-2027")).toMatch(/type/i);
  });

  it("asli code SANDESH KE SAATH deta hai, chhupata nahi", () => {
    /* 26 Aug 2026: Pardeep ke Chrome me permission `Allow` hone ke BAAD bhi mic nahi
       chala, aur aam-bhasha wale sandesh se ye pata hi nahi chala ki wajah kya thi —
       device nahi mila, network, ya kuch aur. Har sambhavna ek round maangti. Code brackets
       me aane se agli hi koshish khud jawab de deti hai. */
    expect(dictationErrorMessage("audio-capture")).toContain("(audio-capture)");
    expect(dictationErrorMessage("network")).toContain("(network)");
    expect(dictationErrorMessage("not-allowed")).toContain("(not-allowed)");
  });

  it("par `aborted` par bemani brackets nahi chhapta", () => {
    /* Uska sandesh khaali hai (user ne khud roka), to "(aborted)" akela dikhna ek
       error jaisa lagta jo error nahi hai. */
    expect(dictationErrorMessage("aborted")).toBe("");
  });

  it("har jaana-maana code apna alag sandesh deta hai", () => {
    const codes = ["not-allowed", "no-speech", "audio-capture", "network"];
    const msgs = codes.map(dictationErrorMessage);
    expect(new Set(msgs).size).toBe(codes.length);
    for (const m of msgs) expect(m.length).toBeGreaterThan(10);
  });
});
