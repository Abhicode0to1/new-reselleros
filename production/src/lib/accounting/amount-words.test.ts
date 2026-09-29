import { describe, it, expect } from "vitest";
import { amountInIndianWords, magnitudeWarning } from "./amount-words";

describe("amountInIndianWords", () => {
  it("reads the two numbers that got mixed up as clearly different", () => {
    expect(amountInIndianWords(50_00_000)).toBe("50 lakh");
    expect(amountInIndianWords(5_00_000)).toBe("5 lakh");
  });

  it("lakh with decimals, crore, hazaar and small amounts", () => {
    expect(amountInIndianWords(5_90_000)).toBe("5.9 lakh");
    expect(amountInIndianWords(53_10_000)).toBe("53.1 lakh");
    expect(amountInIndianWords(1_20_00_000)).toBe("1.2 crore");
    expect(amountInIndianWords(85_000)).toBe("85 hazaar");
    expect(amountInIndianWords(999)).toBe("999 rupaye");
  });
});

describe("magnitudeWarning", () => {
  it("a slipped zero against the lead's budget is flagged, both ways", () => {
    expect(magnitudeWarning(5_00_000, 50_00_000, "lead ka budget")).toMatch(/5 lakh.*50 lakh/);
    expect(magnitudeWarning(5_00_00_000, 50_00_000, "lead ka budget")).toMatch(/5 crore/);
  });

  it("a negotiated price is not a mistake", () => {
    expect(magnitudeWarning(45_00_000, 50_00_000, "lead ka budget")).toBeNull();
    expect(magnitudeWarning(1_20_00_000, 50_00_000, "lead ka budget")).toBeNull();
  });

  it("no reference, no warning", () => {
    expect(magnitudeWarning(5_00_000, null, "x")).toBeNull();
    expect(magnitudeWarning(0, 50_00_000, "x")).toBeNull();
  });
});
