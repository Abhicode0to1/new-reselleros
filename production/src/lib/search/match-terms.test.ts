import { describe, it, expect } from "vitest";
import { matchesAllTerms } from "./keywords";

describe("matchesAllTerms — the palette's filter (2 Oct 2026)", () => {
  it("finds a row by a word in it, any case", () => {
    expect(matchesAllTerms(["Muskaan Dentals", "info@muskaandentals.com"], "muskaan")).toBe(true);
  });
  it("does NOT fuzzy-match letters scattered across the row", () => {
    expect(matchesAllTerms(["Sachin Kumar", "Taksh IT Solutions", "sales@takshitsolutions.com", "+919560602339"], "Muskaan")).toBe(false);
  });
  it("every word must match, in any field", () => {
    expect(matchesAllTerms(["Muskaan Dentals", "Dr. Suresh Ahlawat"], "suresh dentals")).toBe(true);
    expect(matchesAllTerms(["Muskaan Dentals", "Dr. Suresh Ahlawat"], "suresh excel")).toBe(false);
  });
  it("a phone number matches however it is written", () => {
    expect(matchesAllTerms(["+919494947304"], "94949 47304")).toBe(true);
    expect(matchesAllTerms(["+919494947304"], "9494947304")).toBe(true);
    expect(matchesAllTerms(["+91 94949 47304"], "9494947304")).toBe(true);
  });
  it("an empty query matches everything", () => {
    expect(matchesAllTerms(["x"], "  ")).toBe(true);
  });
});
