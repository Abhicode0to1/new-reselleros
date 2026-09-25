import { describe, it, expect } from "vitest";
import { isEncryptedPdf } from "./pdf-check";

const pdf = (trailer: string) =>
  new TextEncoder().encode(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<${trailer}>>\n%%EOF`);

describe("isEncryptedPdf", () => {
  it("spots an /Encrypt reference in the trailer (how bank e-statements are protected)", () => {
    expect(isEncryptedPdf(pdf("/Size 6/Root 1 0 R/Encrypt 7 0 R/ID[<ab><cd>]"))).toBe(true);
  });
  it("spots an inline /Encrypt dictionary", () => {
    expect(isEncryptedPdf(pdf("/Size 6/Root 1 0 R/Encrypt<</Filter/Standard/V 2>>"))).toBe(true);
  });
  it("an ordinary PDF is not flagged", () => {
    expect(isEncryptedPdf(pdf("/Size 6/Root 1 0 R"))).toBe(false);
  });
  it("the word 'Encrypt' in page text alone is not enough", () => {
    expect(isEncryptedPdf(pdf("/Size 6/Root 1 0 R/Title(How we Encrypt data)"))).toBe(false);
  });
});
